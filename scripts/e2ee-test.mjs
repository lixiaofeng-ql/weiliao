/**
 * 微聊 - 端到端加密（E2EE）核心逻辑测试
 *
 * 在 Node 里跑浏览器 WebCrypto 实现的等价版本，
 * 验证：
 *   1. 密钥生成与密码解锁
 *   2. 双人加解密闭环
 *   3. 群聊逐成员加密（每人拿到不同密钥）
 *   4. 第三方无法解密
 *   5. 密文篡改被 GCM 拒绝
 *   6. 签名校验
 */
import { webcrypto as crypto } from 'node:crypto';

const te = new TextEncoder();
const td = new TextDecoder();

// ============ 从 client/public/e2ee.js 同步的实现（去掉浏览器专有 API） ============
const E2EE_VERSION = 1;
const E2EE_CTX = 'wl-e2ee-v1';

function b64encode(buf) {
  const bytes = new Uint8Array(buf);
  return Buffer.from(bytes).toString('base64');
}
function b64decode(s) {
  return new Uint8Array(Buffer.from(String(s || ''), 'base64'));
}
function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}
async function deriveKek(password, username, saltHex) {
  const base = await crypto.subtle.importKey('raw', te.encode(String(password)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: te.encode(`${username}:${saltHex}:${E2EE_CTX}`), iterations: 210000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
async function wrap(secretBytes, kek) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, secretBytes);
  return { iv: b64encode(iv), ct: b64encode(ct) };
}
async function unwrap(wrapped, kek) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(wrapped.iv) }, kek, b64decode(wrapped.ct));
  return new Uint8Array(pt);
}
async function deriveMessageKey(sharedSecret, convId, senderId, recipientId) {
  const hkdfBase = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: te.encode(`${convId}|${senderId}|${recipientId}|${E2EE_CTX}`), info: te.encode('message') },
    hkdfBase,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
async function generateIdentity(kek) {
  const ecdh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey']);
  const ecdsa = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const ecdhPub = await crypto.subtle.exportKey('spki', ecdh.publicKey);
  const ecdsaPub = await crypto.subtle.exportKey('spki', ecdsa.publicKey);
  const ecdhPriv = await crypto.subtle.exportKey('pkcs8', ecdh.privateKey);
  const ecdsaPriv = await crypto.subtle.exportKey('pkcs8', ecdsa.privateKey);
  return {
    publicKey: b64encode(ecdhPub),
    sigPublicKey: b64encode(ecdsaPub),
    encPrivate: JSON.stringify(await wrap(ecdhPriv, kek)),
    sigPrivate: JSON.stringify(await wrap(ecdsaPriv, kek))
  };
}
async function importEcdhPublic(b64) {
  return crypto.subtle.importKey('spki', b64decode(b64), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}
async function importEcdsaPublic(b64) {
  return crypto.subtle.importKey('spki', b64decode(b64), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
}
function concatBytes(a, b) {
  const ab = a instanceof Uint8Array ? a : new Uint8Array(a);
  const bb = b instanceof Uint8Array ? b : new Uint8Array(b);
  const out = new Uint8Array(ab.length + bb.length);
  out.set(ab, 0); out.set(bb, ab.length);
  return out;
}

// 全局运行时状态（模拟前端）
const st = {
  myId: '', saltHex: '',
  encPrivateKey: null, sigPrivateKey: null,
  peerKeys: new Map(), ready: false
};

async function unlock(me, password) {
  st.myId = me.id;
  st.saltHex = me.cryptoSalt || '';
  if (!me.cryptoEncPrivate || !me.cryptoSigPrivate) return { needSetup: true };
  const kek = await deriveKek(password, me.username, st.saltHex);
  const encPrivRaw = await unwrap(JSON.parse(me.cryptoEncPrivate), kek);
  const sigPrivRaw = await unwrap(JSON.parse(me.cryptoSigPrivate), kek);
  st.encPrivateKey = await crypto.subtle.importKey('pkcs8', encPrivRaw, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey']);
  st.sigPrivateKey = await crypto.subtle.importKey('pkcs8', sigPrivRaw, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  st.ready = true;
  return { needSetup: false };
}
function cachePeerKeys(list) {
  for (const p of list || []) {
    if (p && p.id && p.cryptoPublicKey) st.peerKeys.set(p.id, { publicKey: p.cryptoPublicKey, sigPublicKey: p.cryptoSigPublicKey || '' });
  }
}
async function encryptMessage({ content, type, conversationId, senderId, recipients, fileKey }) {
  if (!st.ready) return { ok: false, reason: '未解锁' };
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey']);
  const ephPubRaw = await crypto.subtle.exportKey('spki', eph.publicKey);
  const inner = { t: type, c: content };
  if (fileKey) inner.f = b64encode(fileKey);
  const plaintext = te.encode(JSON.stringify(inner));
  const r = {};
  for (const rid of recipients) {
    const pk = st.peerKeys.get(rid);
    if (!pk) return { ok: false, reason: `缺少接收者 ${rid} 的公钥` };
    let peerPub;
    try { peerPub = await importEcdhPublic(pk.publicKey); } catch { return { ok: false, reason: '公钥无效' }; }
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, eph.privateKey, 256);
    const key = await deriveMessageKey(shared, conversationId, senderId, rid);
    const iv = randomBytes(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
    r[rid] = { iv: b64encode(iv), ct: b64encode(ct) };
  }
  let sig = '';
  if (st.sigPrivateKey) {
    const sigRaw = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, st.sigPrivateKey, concatBytes(ephPubRaw, plaintext));
    sig = b64encode(sigRaw);
  }
  return { ok: true, payload: { v: E2EE_VERSION, eph: b64encode(ephPubRaw), sig, r } };
}
async function decryptMessage(payload, conversationId, senderId, myId, senderSigPublicKey) {
  if (!st.ready) return { ok: false, reason: '未解锁' };
  if (!payload || payload.v !== E2EE_VERSION) return { ok: false, reason: '载荷格式不匹配' };
  const entry = payload.r && payload.r[myId];
  if (!entry) return { ok: false, reason: '本条消息未加密给我' };
  try {
    const ephPub = await importEcdhPublic(payload.eph);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: ephPub }, st.encPrivateKey, 256);
    const key = await deriveMessageKey(shared, conversationId, senderId, myId);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(entry.iv) }, key, b64decode(entry.ct));
    if (payload.sig && senderSigPublicKey) {
      try {
        const sigPub = await importEcdsaPublic(senderSigPublicKey);
        const okSig = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, sigPub, b64decode(payload.sig), concatBytes(b64decode(payload.eph), new Uint8Array(plaintext)));
        if (!okSig) return { ok: false, reason: '签名校验失败' };
      } catch { /* 验签异常不阻断解密 */ }
    }
    const inner = JSON.parse(td.decode(plaintext));
    return { ok: true, content: inner.c, type: inner.t, fileKey: inner.f ? b64decode(inner.f) : null };
  } catch (e) {
    return { ok: false, reason: '解密失败：' + (e && e.message ? e.message : '未知') };
  }
}
async function encryptFile(bytes, fileKey) {
  const key = await crypto.subtle.importKey('raw', fileKey, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { bytes: new Uint8Array(ct), iv: b64encode(iv) };
}
async function decryptFile(bytes, fileKey, ivB64) {
  const key = await crypto.subtle.importKey('raw', fileKey, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(ivB64) }, key, bytes);
  return new Uint8Array(pt);
}

// ============ 测试 ============
let pass = 0, fail = 0;
const failures = [];
function ok(n) { pass++; console.log(`  ✓ ${n}`); }
function bad(n, d) { fail++; failures.push(`${n}: ${d}`); console.log(`  ✗ ${n} — ${d}`); }

/** 为某个用户建立独立的运行时状态（模拟多设备登录） */
function newCtx() {
  return { myId: '', saltHex: '', encPrivateKey: null, sigPrivateKey: null, peerKeys: new Map(), ready: false };
}

async function run() {
  console.log('\n=== 微聊 E2EE 端到端加密 测试 ===\n');

  // 1. 密钥生成
  const saltA = 'a'.repeat(32), saltB = 'b'.repeat(32);
  const kekA = await deriveKek('pass123456', 'alice', saltA);
  const kekB = await deriveKek('pass123456', 'bob', saltB);
  const identA = await generateIdentity(kekA);
  const identB = await generateIdentity(kekB);
  identA.publicKey && identA.encPrivate ? ok('生成身份密钥对') : bad('生成身份密钥对', JSON.stringify(identA));

  // 2. 私钥确实是密文（不含 PKCS8 头）
  const encPriv = b64decode(JSON.parse(identA.encPrivate).ct);
  encPriv[0] !== 0x30 ? ok('私钥以密文存储（服务端不可读）') : bad('私钥以密文存储', '密文以 PKCS8 头开头，说明是明文');

  // 3. 错误密码无法解锁
  const wrongKek = await deriveKek('wrongpassword', 'alice', saltA);
  let wrongFailed = false;
  try { await unwrap(JSON.parse(identA.encPrivate), wrongKek); } catch { wrongFailed = true; }
  wrongFailed ? ok('错误密码无法解密私钥') : bad('错误密码无法解密私钥', '竟然解开了');

  // 4. 正确密码可解锁
  const meA = { id: 'u_1', username: 'alice', cryptoSalt: saltA, cryptoEncPrivate: identA.encPrivate, cryptoSigPrivate: identA.sigPrivate };
  const ctxA = newCtx();
  const savedSt = st.myId, savedSalt = st.saltHex, savedEnc = st.encPrivateKey, savedSig = st.sigPrivateKey, savedPeers = st.peerKeys, savedReady = st.ready;

  Object.assign(st, ctxA);
  const unlockA = await unlock(meA, 'pass123456');
  unlockA.needSetup === false && st.ready ? ok('正确密码成功解锁身份') : bad('正确密码成功解锁身份', JSON.stringify(unlockA));

  // 建立公钥缓存（自己 + 对方）
  cachePeerKeys([
    { id: 'u_1', cryptoPublicKey: identA.publicKey, cryptoSigPublicKey: identA.sigPublicKey },
    { id: 'u_2', cryptoPublicKey: identB.publicKey, cryptoSigPublicKey: identB.sigPublicKey }
  ]);

  // 5. 双人加解密闭环
  const convId = 'dm:u_1:u_2';
  const enc = await encryptMessage({
    content: '这是一条绝密消息',
    type: 'text',
    conversationId: convId,
    senderId: 'u_1',
    recipients: ['u_1', 'u_2']
  });
  enc.ok ? ok('加密消息成功') : bad('加密消息成功', enc.reason);

  // 服务端视角：载荷里没有明文
  const payloadStr = JSON.stringify(enc.payload);
  payloadStr.includes('绝密') ? bad('服务端载荷不含明文', '载荷中出现了明文！') : ok('服务端载荷不含明文');

  // bob 解密
  Object.assign(st, { myId: 'u_2', saltHex: saltB, encPrivateKey: null, sigPrivateKey: null, peerKeys: new Map(), ready: false });
  const meB = { id: 'u_2', username: 'bob', cryptoSalt: saltB, cryptoEncPrivate: identB.encPrivate, cryptoSigPrivate: identB.sigPrivate };
  await unlock(meB, 'pass123456');
  cachePeerKeys([
    { id: 'u_1', cryptoPublicKey: identA.publicKey, cryptoSigPublicKey: identA.sigPublicKey },
    { id: 'u_2', cryptoPublicKey: identB.publicKey, cryptoSigPublicKey: identB.sigPublicKey }
  ]);
  const dec = await decryptMessage(enc.payload, convId, 'u_1', 'u_2', identA.sigPublicKey);
  dec.ok && dec.content === '这是一条绝密消息'
    ? ok('接收方成功解密出原文')
    : bad('接收方成功解密出原文', JSON.stringify(dec));

  // 6. 第三方无法解密
  const saltC = 'c'.repeat(32);
  const kekC = await deriveKek('pass123456', 'carol', saltC);
  const identC = await generateIdentity(kekC);
  Object.assign(st, { myId: 'u_3', saltHex: saltC, encPrivateKey: null, sigPrivateKey: null, peerKeys: new Map(), ready: false });
  await unlock({ id: 'u_3', username: 'carol', cryptoSalt: saltC, cryptoEncPrivate: identC.encPrivate, cryptoSigPrivate: identC.sigPrivate }, 'pass123456');
  cachePeerKeys([{ id: 'u_1', cryptoPublicKey: identA.publicKey, cryptoSigPublicKey: identA.sigPublicKey }]);
  const dec3 = await decryptMessage(enc.payload, convId, 'u_1', 'u_3', identA.sigPublicKey);
  !dec3.ok ? ok('第三方无法解密（非接收者）') : bad('第三方无法解密', '第三方竟然解开了');

  // 7. 密文篡改被拒
  Object.assign(st, { myId: 'u_2', saltHex: saltB, encPrivateKey: null, sigPrivateKey: null, peerKeys: new Map(), ready: false });
  await unlock(meB, 'pass123456');
  cachePeerKeys([{ id: 'u_1', cryptoPublicKey: identA.publicKey, cryptoSigPublicKey: identA.sigPublicKey }]);
  const tampered = JSON.parse(JSON.stringify(enc.payload));
  const ctBytes = b64decode(tampered.r.u_2.ct);
  ctBytes[0] ^= 0xff;
  tampered.r.u_2.ct = b64encode(ctBytes);
  const decT = await decryptMessage(tampered, convId, 'u_1', 'u_2', identA.sigPublicKey);
  !decT.ok ? ok('密文被篡改后解密失败') : bad('密文被篡改后解密失败', '篡改后竟然解开了');

  // 8. 签名校验：签名错误应被识别
  const decBadSig = await decryptMessage(enc.payload, convId, 'u_1', 'u_2', identB.sigPublicKey);
  !decBadSig.ok ? ok('签名不匹配时被拒绝') : bad('签名不匹配时被拒绝', '用错误的签名公钥竟然解开了');

  // 9. 群聊逐成员加密：每人密钥不同
  Object.assign(st, { myId: 'u_1', saltHex: saltA, encPrivateKey: null, sigPrivateKey: null, peerKeys: new Map(), ready: false });
  await unlock(meA, 'pass123456');
  cachePeerKeys([
    { id: 'u_1', cryptoPublicKey: identA.publicKey, cryptoSigPublicKey: identA.sigPublicKey },
    { id: 'u_2', cryptoPublicKey: identB.publicKey, cryptoSigPublicKey: identB.sigPublicKey },
    { id: 'u_3', cryptoPublicKey: identC.publicKey, cryptoSigPublicKey: identC.sigPublicKey }
  ]);
  const gconv = 'group:g_1';
  const genc = await encryptMessage({
    content: '群里的秘密',
    type: 'text',
    conversationId: gconv,
    senderId: 'u_1',
    recipients: ['u_1', 'u_2', 'u_3']
  });
  genc.ok ? ok('群聊加密成功') : bad('群聊加密成功', genc.reason);
  genc.payload.r.u_1.ct !== genc.payload.r.u_2.ct && genc.payload.r.u_2.ct !== genc.payload.r.u_3.ct
    ? ok('群成员各自使用独立密钥') : bad('群成员各自使用独立密钥', '不同成员的密文相同');

  // 每个成员都能解开
  let groupOk = true;
  const memberIds = ['u_1', 'u_2', 'u_3'];
  const memberNames = { u_1: 'alice', u_2: 'bob', u_3: 'carol' };
  const memberIdents = { u_1: identA, u_2: identB, u_3: identC };
  const memberSalts = { u_1: saltA, u_2: saltB, u_3: saltC };
  for (const uid of memberIds) {
    Object.assign(st, { myId: uid, saltHex: memberSalts[uid], encPrivateKey: null, sigPrivateKey: null, peerKeys: new Map(), ready: false });
    await unlock({
      id: uid,
      username: memberNames[uid],
      cryptoSalt: memberSalts[uid],
      cryptoEncPrivate: memberIdents[uid].encPrivate,
      cryptoSigPrivate: memberIdents[uid].sigPrivate
    }, 'pass123456');
    cachePeerKeys([
      { id: 'u_1', cryptoPublicKey: identA.publicKey, cryptoSigPublicKey: identA.sigPublicKey },
      { id: 'u_2', cryptoPublicKey: identB.publicKey, cryptoSigPublicKey: identB.sigPublicKey },
      { id: 'u_3', cryptoPublicKey: identC.publicKey, cryptoSigPublicKey: identC.sigPublicKey }
    ]);
    const d = await decryptMessage(genc.payload, gconv, 'u_1', uid, identA.sigPublicKey);
    if (!d.ok || d.content !== '群里的秘密') { groupOk = false; }
  }
  groupOk ? ok('群聊全体成员均能解密') : bad('群聊全体成员均能解密', '有成员解密失败');

  // 11. fileKey 随消息加密传递
  // 先切回 u_1 作为发送方（上一轮群聊测试结束时状态是 u_3）
  Object.assign(st, { myId: 'u_1', saltHex: saltA, encPrivateKey: null, sigPrivateKey: null, peerKeys: new Map(), ready: false });
  await unlock(meA, 'pass123456');
  cachePeerKeys([
    { id: 'u_1', cryptoPublicKey: identA.publicKey, cryptoSigPublicKey: identA.sigPublicKey },
    { id: 'u_2', cryptoPublicKey: identB.publicKey, cryptoSigPublicKey: identB.sigPublicKey }
  ]);
  const fileKey = randomBytes(32);
  const plainFile = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
  const encFile = await encryptFile(plainFile, fileKey);
  const rawHasPng = encFile.bytes[0] === 0x89 && encFile.bytes[1] === 0x50;
  !rawHasPng ? ok('文件加密后不再是明文图片') : bad('文件加密后不再是明文图片', '密文仍以 PNG 头开头');
  const decFile = await decryptFile(encFile.bytes, fileKey, encFile.iv);
  Buffer.compare(Buffer.from(decFile), Buffer.from(plainFile)) === 0
    ? ok('文件解密还原原图') : bad('文件解密还原原图', '字节不一致');

  const fkMsg = await encryptMessage({
    content: '/uploads/enc_abc.bin',
    type: 'image',
    conversationId: convId,
    senderId: 'u_1',
    recipients: ['u_1', 'u_2'],
    fileKey
  });
  fkMsg.ok ? ok('含 fileKey 的消息加密成功') : bad('含 fileKey 的消息加密成功', fkMsg.reason);
  Object.assign(st, { myId: 'u_2', saltHex: saltB, encPrivateKey: null, sigPrivateKey: null, peerKeys: new Map(), ready: false });
  await unlock(meB, 'pass123456');
  cachePeerKeys([{ id: 'u_1', cryptoPublicKey: identA.publicKey, cryptoSigPublicKey: identA.sigPublicKey }]);
  const dFk = await decryptMessage(fkMsg.payload, convId, 'u_1', 'u_2', identA.sigPublicKey);
  dFk.ok && dFk.fileKey && Buffer.compare(Buffer.from(dFk.fileKey), Buffer.from(fileKey)) === 0
    ? ok('fileKey 随消息加密传递并正确取出') : bad('fileKey 随消息加密传递并正确取出', JSON.stringify({ ok: dFk.ok, reason: dFk.reason }));

  // 12. 缺少对方公钥时应明确失败（而不是静默降级）
  Object.assign(st, { myId: 'u_1', saltHex: saltA, encPrivateKey: null, sigPrivateKey: null, peerKeys: new Map(), ready: false });
  await unlock(meA, 'pass123456');
  cachePeerKeys([{ id: 'u_1', cryptoPublicKey: identA.publicKey, cryptoSigPublicKey: identA.sigPublicKey }]);
  const noKey = await encryptMessage({
    content: 'x', type: 'text', conversationId: convId, senderId: 'u_1', recipients: ['u_1', 'u_2']
  });
  !noKey.ok && noKey.reason.includes('公钥') ? ok('缺少公钥时明确报错') : bad('缺少公钥时明确报错', JSON.stringify(noKey));

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  if (fail) failures.forEach((f) => console.log('  ! ' + f));
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('测试异常:', e); process.exit(1); });
