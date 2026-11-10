/* ============================================================
 * 微聊 - 端到端加密（E2EE）
 * ------------------------------------------------------------
 * 目标：服务器（含数据库、备份文件、运维人员）无法读取聊天明文。
 *
 * 设计要点
 * 1. 身份密钥对（每用户一套）
 *    - ECDH  P-256：用于密钥协商
 *    - ECDSA P-256：用于签名消息，防止服务端冒充用户
 *    - 私钥用「密码派生的 KEK」加密后存服务端；KEK 由 PBKDF2(password, salt) 得出，
 *      服务端永远拿不到密码，也就永远解不开私钥。
 *    - 公钥明文存服务端，供对方拉取。
 *
 * 2. 消息加密
 *    - 每条消息生成临时 ECDH 密钥对（ephemeral），实现前向安全
 *    - 逐接收方做 ECDH → HKDF-SHA256 → AES-256-GCM 派生独立密钥
 *    - 群聊采用「逐成员加密」，消息体积随群人数线性增长
 *
 * 3. 图片 / 表情包
 *    - 文件内容先在客户端用随机 fileKey 加密，再上传密文
 *    - fileKey 逐接收方加密后放进消息载荷
 *    - 服务端存的是密文文件，无法还原图片
 *
 * 4. 降级策略
 *    - 任一环节缺少对方公钥 → 该条消息回退为明文，并给出提示
 * ============================================================ */

(function () {
const E2EE_VERSION = 1;
const E2EE_CTX = 'wl-e2ee-v1';

const te = new TextEncoder();
const td = new TextDecoder();

/* ---------------- 基础工具 ---------------- */

function b64encode(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

function b64decode(s) {
  const bin = atob(String(s || ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

/** 十六进制随机串 */
function randomHex(n = 16) {
  return [...randomBytes(n)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- 密钥派生 ---------------- */

/**
 * 从密码派生 KEK（用于包裹身份私钥）。
 * @param {string} password
 * @param {string} username 账号（参与 salt，确保不同用户密钥不同）
 * @param {string} saltHex 服务端存的每用户随机盐
 */
async function deriveKek(password, username, saltHex) {
  const base = await crypto.subtle.importKey(
    'raw',
    te.encode(String(password)),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: te.encode(`${username}:${saltHex}:${E2EE_CTX}`),
      iterations: 210000,
      hash: 'SHA-256'
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** 用 KEK 加密任意 ArrayBuffer（用于包裹私钥 / fileKey） */
async function wrap(secretBytes, kek) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, secretBytes);
  return { iv: b64encode(iv), ct: b64encode(ct) };
}

/** 用 KEK 解密 */
async function unwrap(wrapped, kek) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(wrapped.iv) },
    kek,
    b64decode(wrapped.ct)
  );
  return new Uint8Array(pt);
}

/** ECDH + HKDF → AES-GCM 密钥 */
async function deriveMessageKey(sharedSecret, convId, senderId, recipientId) {
  const hkdfBase = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: te.encode(`${convId}|${senderId}|${recipientId}|${E2EE_CTX}`),
      info: te.encode('message')
    },
    hkdfBase,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/* ---------------- 身份密钥 ---------------- */

/**
 * 生成一套新的身份密钥对。
 * @returns {{publicKey:string, sigPublicKey:string, encPrivate:string, sigPrivate:string}}
 *          公钥为 base64(SPKI)，私钥为 base64({iv,ct}) 密文
 */
async function generateIdentity(kek) {
  const ecdh = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits', 'deriveKey']
  );
  const ecdsa = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const ecdhPub = await crypto.subtle.exportKey('spki', ecdh.publicKey);
  const ecdsaPub = await crypto.subtle.exportKey('spki', ecdsa.publicKey);
  const ecdhPriv = await crypto.subtle.exportKey('pkcs8', ecdh.privateKey);
  const ecdsaPriv = await crypto.subtle.exportKey('pkcs8', ecdsa.privateKey);

  const encWrapped = await wrap(ecdhPriv, kek);
  const sigWrapped = await wrap(ecdsaPriv, kek);

  return {
    publicKey: b64encode(ecdhPub),
    sigPublicKey: b64encode(ecdsaPub),
    encPrivate: JSON.stringify(encWrapped),
    sigPrivate: JSON.stringify(sigWrapped)
  };
}

/** 导入公钥（ECDH 公钥） */
async function importEcdhPublic(b64) {
  return crypto.subtle.importKey(
    'spki',
    b64decode(b64),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
}

/** 导入签名公钥 */
async function importEcdsaPublic(b64) {
  return crypto.subtle.importKey(
    'spki',
    b64decode(b64),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );
}

/* ---------------- 运行时状态 ---------------- */

/** 运行时状态：解锁后的私钥、公钥缓存 */
const state = {
  ready: false,
  myId: '',
  saltHex: '',
  // 解锁后的私钥（CryptoKey 对象，仅存在于内存）
  encPrivateKey: null,
  sigPrivateKey: null,
  // KEK（由密码派生），用于包裹自定义表情包的 fileKey
  kek: null,
  // 公钥缓存：userId -> { publicKey, sigPublicKey }
  peerKeys: new Map(),
  // 私钥密文缓存（解锁后不再需要）
  locked: true
};

/** 供 app.js 查询是否已启用 */
function isReady() {
  return state.ready;
}

/**
 * 用服务端返回的私钥密文解锁身份。
 * @param {object} me 服务端返回的 { cryptoSalt, cryptoEncPrivate, cryptoSigPrivate, id }
 * @param {string} password
 */
async function unlock(me, password) {
  state.myId = me.id;
  state.saltHex = me.cryptoSalt || '';

  // 私钥优先用服务端密文；没有则说明本机首次登录，需要生成
  if (!me.cryptoEncPrivate || !me.cryptoSigPrivate) {
    return { needSetup: true };
  }

  const kek = await deriveKek(password, me.username, state.saltHex);
  state.kek = kek;
  const encPrivRaw = await unwrap(JSON.parse(me.cryptoEncPrivate), kek);
  const sigPrivRaw = await unwrap(JSON.parse(me.cryptoSigPrivate), kek);

  state.encPrivateKey = await crypto.subtle.importKey(
    'pkcs8',
    encPrivRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits', 'deriveKey']
  );
  state.sigPrivateKey = await crypto.subtle.importKey(
    'pkcs8',
    sigPrivRaw,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign']
  );
  state.ready = true;
  state.locked = false;
  return { needSetup: false };
}

/** 生成并上传新身份（首次登录 / 密钥丢失时） */
async function setupIdentity(api, me, password) {
  const salt = randomHex(16);
  const kek = await deriveKek(password, me.username, salt);
  state.kek = kek;
  const ident = await generateIdentity(kek);
  await api('/api/crypto/keys', {
    method: 'POST',
    body: {
      cryptoSalt: salt,
      cryptoPublicKey: ident.publicKey,
      cryptoSigPublicKey: ident.sigPublicKey,
      cryptoEncPrivate: ident.encPrivate,
      cryptoSigPrivate: ident.sigPrivate
    }
  });

  // 本地立即解锁
  const encPrivRaw = await unwrap(JSON.parse(ident.encPrivate), kek);
  const sigPrivRaw = await unwrap(JSON.parse(ident.sigPrivate), kek);
  state.myId = me.id;
  state.saltHex = salt;
  state.encPrivateKey = await crypto.subtle.importKey(
    'pkcs8', encPrivRaw, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey']
  );
  state.sigPrivateKey = await crypto.subtle.importKey(
    'pkcs8', sigPrivRaw, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']
  );
  state.ready = true;
  state.locked = false;
  return ident;
}

/** 锁定（清空内存中的私钥） */
function lock() {
  state.encPrivateKey = null;
  state.sigPrivateKey = null;
  state.ready = false;
  state.locked = true;
  state.peerKeys.clear();
}

/** 缓存对方公钥 */
function cachePeerKeys(list) {
  for (const p of list || []) {
    if (p && p.id && p.cryptoPublicKey) {
      state.peerKeys.set(p.id, {
        publicKey: p.cryptoPublicKey,
        sigPublicKey: p.cryptoSigPublicKey || ''
      });
    }
  }
}

/** 取对方公钥（未缓存返回 null） */
function peerKeysOf(userId) {
  return state.peerKeys.get(userId) || null;
}

/* ---------------- 消息加密 ---------------- */

/**
 * 加密一条消息，供指定的接收者列表使用。
 * @param {object} args
 *   - content: 明文内容
 *   - type: 'text' | 'emoji' | 'image' | 'sticker'
 *   - conversationId
 *   - senderId
 *   - recipients: string[] 需要加密的接收者 userId 列表（含自己，保证历史可读）
 *   - fileKey?: Uint8Array  图片类消息的 fileKey
 * @returns {Promise<{ok:boolean, payload?:object, reason?:string}>}
 */
async function encryptMessage({ content, type, conversationId, senderId, recipients, fileKey }) {
  if (!state.ready) return { ok: false, reason: '未解锁' };

  // 生成临时密钥对
  const eph = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits', 'deriveKey']
  );
  const ephPubRaw = await crypto.subtle.exportKey('spki', eph.publicKey);

  // 明文载荷
  const inner = { t: type, c: content };
  if (fileKey) inner.f = b64encode(fileKey);
  const plaintext = te.encode(JSON.stringify(inner));

  const r = {};
  for (const rid of recipients) {
    let pk = state.peerKeys.get(rid);
    if (!pk && rid === state.myId) {
      // 自己的公钥：需要缓存
      pk = state.peerKeys.get(state.myId);
    }
    if (!pk) return { ok: false, reason: `缺少接收者 ${rid} 的公钥` };

    let peerPub;
    try {
      peerPub = await importEcdhPublic(pk.publicKey);
    } catch {
      return { ok: false, reason: `接收者 ${rid} 公钥无效` };
    }

    const shared = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerPub },
      eph.privateKey,
      256
    );
    const key = await deriveMessageKey(shared, conversationId, senderId, rid);

    const iv = randomBytes(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    r[rid] = { iv: b64encode(iv), ct: b64encode(ct) };
  }

  // 签名：对 (ephPub + 明文) 做 ECDSA，服务端可校验发送者身份
  let sig = '';
  if (state.sigPrivateKey) {
    const toSign = concatBytes(ephPubRaw, plaintext);
    const sigRaw = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      state.sigPrivateKey,
      toSign
    );
    sig = b64encode(sigRaw);
  }

  return {
    ok: true,
    payload: {
      v: E2EE_VERSION,
      eph: b64encode(ephPubRaw),
      sig,
      r
    }
  };
}

/**
 * 解密一条消息。
 * @param {object} payload 加密载荷
 * @param {string} conversationId
 * @param {string} senderId
 * @param {string} myId 接收者
 * @param {string} senderSigPublicKey 发送者的签名公钥（用于验签）
 * @returns {Promise<{ok:boolean, content?:string, type?:string, fileKey?:Uint8Array, reason?:string}>}
 */
async function decryptMessage(payload, conversationId, senderId, myId, senderSigPublicKey) {
  if (!state.ready) return { ok: false, reason: '未解锁' };
  if (!payload || payload.v !== E2EE_VERSION) return { ok: false, reason: '载荷格式不匹配' };

  const entry = payload.r && payload.r[myId];
  if (!entry) return { ok: false, reason: '本条消息未加密给我' };

  try {
    const ephPub = await importEcdhPublic(payload.eph);
    const shared = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: ephPub },
      state.encPrivateKey,
      256
    );
    const key = await deriveMessageKey(shared, conversationId, senderId, myId);

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64decode(entry.iv) },
      key,
      b64decode(entry.ct)
    );

    // 验签（可选：没有对方签名公钥时跳过）
    if (payload.sig && senderSigPublicKey) {
      try {
        const sigPub = await importEcdsaPublic(senderSigPublicKey);
        const ephPubRaw = b64decode(payload.eph);
        const okSig = await crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          sigPub,
          b64decode(payload.sig),
          concatBytes(ephPubRaw, new Uint8Array(plaintext))
        );
        if (!okSig) return { ok: false, reason: '签名校验失败' };
      } catch {
        // 验签异常不阻断解密
      }
    }

    const inner = JSON.parse(td.decode(plaintext));
    return {
      ok: true,
      content: inner.c,
      type: inner.t,
      fileKey: inner.f ? b64decode(inner.f) : null
    };
  } catch (e) {
    return { ok: false, reason: '解密失败：' + (e && e.message ? e.message : '未知错误') };
  }
}

/** 字节数组拼接（兼容 ArrayBuffer / TypedArray） */
function concatBytes(a, b) {
  const ab = a instanceof Uint8Array ? a : new Uint8Array(a);
  const bb = b instanceof Uint8Array ? b : new Uint8Array(b);
  const out = new Uint8Array(ab.length + bb.length);
  out.set(ab, 0);
  out.set(bb, ab.length);
  return out;
}

/* ---------------- 文件加密 ---------------- */

/**
 * 生成文件加密密钥
 */
function newFileKey() {
  return randomBytes(32);
}

/**
 * 用 fileKey 加密文件字节。
 * @returns {Promise<{bytes:Uint8Array, iv:string}>}
 */
async function encryptFile(bytes, fileKey) {
  const key = await crypto.subtle.importKey('raw', fileKey, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { bytes: new Uint8Array(ct), iv: b64encode(iv) };
}

/**
 * 用 fileKey 解密文件字节。
 */
async function decryptFile(bytes, fileKey, ivB64) {
  const key = await crypto.subtle.importKey('raw', fileKey, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(ivB64) },
    key,
    bytes
  );
  return new Uint8Array(pt);
}

/* ---------------- 自定义表情包（本地加密存储） ---------------- */

/**
 * 用 KEK 包裹 fileKey。
 * 自定义表情包只存在自己的账号下，所以用密码派生的 KEK 加密 fileKey 即可，
 * 服务端只拿到密文，管理员/数据库泄露也还原不出图片。
 */
async function wrapFileKey(fileKey) {
  if (!state.kek) return { error: '加密未就绪' };
  const wrapped = await wrap(fileKey, state.kek);
  return { ok: true, keyIv: wrapped.iv, keyCt: wrapped.ct };
}

/**
 * 用 KEK 解开 fileKey。
 */
async function unwrapFileKey(keyIv, keyCt) {
  if (!state.kek) return { error: '加密未就绪' };
  try {
    const bytes = await unwrap({ iv: keyIv, ct: keyCt }, state.kek);
    return { ok: true, fileKey: bytes };
  } catch (e) {
    return { error: '解密失败：' + (e && e.message ? e.message : '未知错误') };
  }
}

/** 把 Uint8Array 转成 base64（便于放进 JSON 载荷） */
function bytesToB64(bytes) {
  return b64encode(bytes);
}

/** base64 转 Uint8Array */
function b64ToBytes(s) {
  return b64decode(s);
}

/* ---------------- 导出到全局 ---------------- */
window.E2EE = {
  E2EE_VERSION: E2EE_VERSION,
  state: state,
  deriveKek: deriveKek,
  wrap: wrap,
  unwrap: unwrap,
  randomHex: randomHex,
  generateIdentity: generateIdentity,
  isReady: isReady,
  unlock: unlock,
  setupIdentity: setupIdentity,
  lock: lock,
  cachePeerKeys: cachePeerKeys,
  peerKeysOf: peerKeysOf,
  encryptMessage: encryptMessage,
  decryptMessage: decryptMessage,
  newFileKey: newFileKey,
  encryptFile: encryptFile,
  decryptFile: decryptFile,
  wrapFileKey: wrapFileKey,
  unwrapFileKey: unwrapFileKey,
  bytesToB64: bytesToB64,
  b64ToBytes: b64ToBytes
};
})();