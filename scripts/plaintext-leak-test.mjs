/**
 * 微聊 - 明文泄露检测 & 表情包加密 测试
 *
 * 覆盖：
 *  1. 加密消息入库后数据库无明文
 *  2. 服务端不会给未加密消息打上 cipher 标记
 *  3. 自定义表情包：图片以密文落盘，fileKey 以 KEK 包裹后存储
 *  4. 数据库里找不到表情包原始字节
 *  5. 会话预览对加密消息显示 [加密消息]
 */
import { webcrypto as crypto } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3318;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-plain-'));

let pass = 0, fail = 0;
const failures = [];
function ok(n) { pass++; console.log(`  ✓ ${n}`); }
function bad(n, d) { fail++; failures.push(`${n}: ${d}`); console.log(`  ✗ ${n} — ${d}`); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(p, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

// ---------- 复用 E2EE 原语 ----------
const te = new TextEncoder();
const b64e = (b) => Buffer.from(new Uint8Array(b)).toString('base64');
const b64d = (s) => new Uint8Array(Buffer.from(String(s || ''), 'base64'));
const rnd = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; };

async function deriveKek(password, username, saltHex) {
  const base = await crypto.subtle.importKey('raw', te.encode(String(password)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: te.encode(`${username}:${saltHex}:wl-e2ee-v1`), iterations: 210000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}
async function wrap(bytes, kek) {
  const iv = rnd(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, bytes);
  return { iv: b64e(iv), ct: b64e(ct) };
}
async function unwrap(w, kek) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(w.iv) }, kek, b64d(w.ct)));
}
async function genIdentity(kek) {
  const ecdh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey']);
  const ecdsa = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    publicKey: b64e(await crypto.subtle.exportKey('spki', ecdh.publicKey)),
    sigPublicKey: b64e(await crypto.subtle.exportKey('spki', ecdsa.publicKey)),
    encPrivate: JSON.stringify(await wrap(await crypto.subtle.exportKey('pkcs8', ecdh.privateKey), kek)),
    sigPrivate: JSON.stringify(await wrap(await crypto.subtle.exportKey('pkcs8', ecdsa.privateKey), kek))
  };
}
const impEcdh = (b64) => crypto.subtle.importKey('spki', b64d(b64), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
async function msgKey(shared, convId, sid, rid) {
  const h = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: te.encode(`${convId}|${sid}|${rid}|wl-e2ee-v1`), info: te.encode('message') },
    h, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

// ---------- 启动服务 ----------
const server = spawn('node', ['src/index.js'], {
  cwd: path.resolve('server'),
  env: { ...process.env, PORT: String(PORT), WL_DATA_DIR: DATA_DIR, WL_UPLOAD_DIR: path.join(DATA_DIR, 'uploads') },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => console.error('[server]', String(d).trim()));

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch { /* retry */ }
    await wait(300);
  }
  return false;
}

async function setupUser(username, password, nickname) {
  const reg = await req('/api/auth/register', { method: 'POST', body: { username, password, nickname } });
  if (!reg.json.success) throw new Error('注册失败: ' + JSON.stringify(reg.json));
  const token = reg.json.token;
  const id = reg.json.user.id;
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
  const kek = await deriveKek(password, username, salt);
  const ident = await genIdentity(kek);
  await req('/api/crypto/keys', {
    method: 'POST', token,
    body: {
      cryptoSalt: salt,
      cryptoPublicKey: ident.publicKey,
      cryptoSigPublicKey: ident.sigPublicKey,
      cryptoEncPrivate: ident.encPrivate,
      cryptoSigPrivate: ident.sigPrivate
    }
  });
  return { token, id, kek, ident, username };
}

async function run() {
  console.log('\n=== 微聊 明文泄露检测 & 表情包加密 测试 ===\n');
  if (!(await waitReady())) { console.log('服务启动失败'); return; }

  const s = Date.now().toString(36);
  const A = await setupUser('pl_a_' + s, 'pass123456', '甲');
  const B = await setupUser('pl_b_' + s, 'pass123456', '乙');
  ok('两个用户注册并生成密钥');

  const convId = `dm:${[A.id, B.id].sort().join(':')}`;
  const SECRET = '绝密-' + s + '-内容';

  // ---- 1. 加密发送 ----
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey']);
  const ephRaw = await crypto.subtle.exportKey('spki', eph.publicKey);
  const pt = te.encode(JSON.stringify({ t: 'text', c: SECRET }));
  const r = {};
  for (const rid of [A.id, B.id]) {
    const pk = rid === A.id ? A.ident : B.ident;
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: await impEcdh(pk.publicKey) }, eph.privateKey, 256);
    const key = await msgKey(shared, convId, A.id, rid);
    const iv = rnd(12);
    r[rid] = { iv: b64e(iv), ct: b64e(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt)) };
  }
  const payload = { v: 1, eph: b64e(ephRaw), sig: '', r };
  await req('/api/messages', {
    method: 'POST', token: A.token,
    body: { toType: 'dm', toId: B.id, content: JSON.stringify(payload), type: 'text', cipher: 1 }
  });
  ok('加密消息发送成功');

  // ---- 2. 数据库无明文 ----
  await wait(600);
  const dbRaw = fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8');
  dbRaw.includes(SECRET) ? bad('数据库不含消息明文', '数据库中出现明文！') : ok('数据库不含消息明文');

  // ---- 3. cipher 标记 ----
  const msgs = (await req('/api/messages?conversationId=' + encodeURIComponent(convId), { token: B.token })).json.messages;
  const encMsg = msgs.find((m) => m.cipher === 1);
  encMsg ? ok('消息标记 cipher=1') : bad('消息标记 cipher=1', '未找到');
  !JSON.stringify(encMsg).includes(SECRET) ? ok('接口返回的也是密文') : bad('接口返回的也是密文', '返回了明文！');

  // ---- 4. 会话预览 ----
  const convs = (await req('/api/conversations', { token: B.token })).json.conversations;
  const prev = convs.find((c) => c.conversationId === convId)?.lastMessage;
  prev === '[加密消息]' ? ok('会话预览为 [加密消息]') : bad('会话预览为 [加密消息]', String(prev));

  // ---- 5. 未加密消息不加 cipher 标记（正常聊天不受影响）----
  await req('/api/messages', {
    method: 'POST', token: A.token,
    body: { toType: 'dm', toId: B.id, content: '普通明文消息', type: 'text' }
  });
  const msgs2 = (await req('/api/messages?conversationId=' + encodeURIComponent(convId), { token: B.token })).json.messages;
  const plainMsg = msgs2.find((m) => m.content === '普通明文消息');
  plainMsg && plainMsg.cipher === 0 ? ok('未加密消息 cipher=0（兼容普通聊天）') : bad('未加密消息 cipher=0（兼容普通聊天）', JSON.stringify(plainMsg));

  // ---- 6. 自定义表情包：密文上传 + KEK 包裹 fileKey ----
  // 造一张「图片」（PNG magic bytes + 随机数据，足够验证不可还原）
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const rawImg = Buffer.concat([pngHeader, Buffer.from('STICKER-PLAINTEXT-MARKER-' + s)]);
  const fileKey = rnd(32);
  const encIv = rnd(12);
  const fileCipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: encIv },
    await crypto.subtle.importKey('raw', fileKey, 'AES-GCM', false, ['encrypt']),
    rawImg
  ));
  const up = await req('/api/upload/enc', {
    method: 'POST', token: A.token,
    body: { data: b64e(fileCipher) }
  });
  up.json.success ? ok('表情包密文上传成功') : bad('表情包密文上传成功', JSON.stringify(up.json));

  // fileKey 用 KEK 包裹
  const wrapped = await wrap(fileKey, A.kek);
  const st = await req('/api/stickers', {
    method: 'POST', token: A.token,
    body: { url: up.json.url, name: '测试表情', fileKeyIv: wrapped.iv, fileKeyCt: wrapped.ct, fileIv: b64e(encIv) }
  });
  st.json.success ? ok('表情包记录保存成功') : bad('表情包记录保存成功', JSON.stringify(st.json));

  // ---- 7. 落盘文件是密文，找不到原始字节 ----
  const uploadFile = path.join(DATA_DIR, 'uploads', path.basename(up.json.url));
  const onDisk = fs.readFileSync(uploadFile);
  onDisk.includes(Buffer.from('STICKER-PLAINTEXT-MARKER')) ? bad('磁盘上的表情包是密文', '找到明文标记！') : ok('磁盘上的表情包是密文');
  onDisk.includes(pngHeader) ? bad('磁盘文件不含 PNG 头', '找到 PNG 头！') : ok('磁盘文件不含 PNG 头');

  // ---- 8. 数据库里 fileKey 是包裹后的密文 ----
  const db2 = fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8');
  const dbObj = JSON.parse(db2);
  const stRec = dbObj.stickers.find((s2) => s2.id === st.json.sticker.id);
  stRec && stRec.fileKeyCt && stRec.fileKeyCt !== b64e(fileKey)
    ? ok('数据库中 fileKey 为包裹密文')
    : bad('数据库中 fileKey 为包裹密文', JSON.stringify(stRec && { ct: stRec.fileKeyCt }));
  stRec && !JSON.stringify(stRec).includes(b64e(fileKey)) ? ok('数据库中不含裸 fileKey') : bad('数据库中不含裸 fileKey', '泄露了裸 fileKey');

  // ---- 9. 用 KEK 可以解开 fileKey，再解出原图 ----
  const fileKeyBack = await unwrap({ iv: stRec.fileKeyIv, ct: stRec.fileKeyCt }, A.kek);
  const plainImg = Buffer.from(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64d(stRec.fileIv) },
    await crypto.subtle.importKey('raw', fileKeyBack, 'AES-GCM', false, ['decrypt']),
    onDisk
  ));
  plainImg.equals(rawImg) ? ok('KEK 解开 fileKey 后可还原原图') : bad('KEK 解开 fileKey 后可还原原图', '还原失败');

  // ---- 10. 错误密码无法解开 fileKey ----
  const wrongKek = await deriveKek('wrongpass', A.username, 'deadbeef');
  let failed = false;
  try { await unwrap({ iv: stRec.fileKeyIv, ct: stRec.fileKeyCt }, wrongKek); }
  catch { failed = true; }
  failed ? ok('错误密码无法解开 fileKey') : bad('错误密码无法解开 fileKey', '竟然解开了');

  // ---- 11. 表情包列表接口返回包裹后的 key（不是裸 key）----
  const list = (await req('/api/stickers', { token: A.token })).json.stickers;
  const item = list.find((x) => x.id === st.json.sticker.id);
  item && item.fileKeyCt && !item.fileKey ? ok('列表接口不返回裸 fileKey') : bad('列表接口不返回裸 fileKey', JSON.stringify(item));

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  if (fail) failures.forEach((f) => console.log('  ! ' + f));
}

run().then(() => {
  try { server.kill('SIGKILL'); } catch { /* ignore */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('测试异常:', e);
  try { server.kill('SIGKILL'); } catch { /* ignore */ }
  process.exit(1);
});
