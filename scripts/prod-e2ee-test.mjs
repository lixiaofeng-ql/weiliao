/**
 * 微聊 - 生产链路（本地后端 + Cloudflare 隧道 + GitHub Pages）E2EE 验证
 *
 * 走真实线上地址：隧道域名 → 后端 → 数据库
 * 检查数据库中是否只有密文。
 */
import { webcrypto as crypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CFG = fs.readFileSync(path.resolve('client/public/config.js'), 'utf8');
const bases = [...CFG.matchAll(/'(https?:\/\/[^']+)'/g)].map((m) => m[1].replace(/\/$/, ''));
const BASE = bases[0];
const DB = path.resolve('server/data/db.json');

let pass = 0, fail = 0;
const failures = [];
function ok(n) { pass++; console.log(`  ✓ ${n}`); }
function bad(n, d) { fail++; failures.push(`${n}: ${d}`); console.log(`  ✗ ${n} — ${d}`); }

async function req(p, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

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
  return { iv: b64e(iv), ct: b64e(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, bytes)) };
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

async function run() {
  console.log('\n=== 微聊 生产链路 E2EE 验证 ===\n');
  console.log('目标后端: ' + BASE + '\n');

  const sfx = Date.now().toString(36);
  const PWD = 'pass123456';

  async function setup(username) {
    const reg = await req('/api/auth/register', { method: 'POST', body: { username, password: PWD, nickname: username } });
    if (!reg.json.success) throw new Error('注册失败: ' + JSON.stringify(reg.json));
    const token = reg.json.token;
    const id = reg.json.user.id;
    const salt = Buffer.from(rnd(16)).toString('hex');
    const kek = await deriveKek(PWD, username, salt);
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

  const A = await setup('prod_a_' + sfx);
  const B = await setup('prod_b_' + sfx);
  ok('通过生产地址注册并生成密钥');

  // 建立好友
  await req('/api/friends/request', { method: 'POST', body: { username: 'prod_b_' + sfx }, token: A.token });
  const fr = await req('/api/friends', { token: B.token });
  const reqId = fr.json.requests?.[0]?.id;
  await req('/api/friends/respond', { method: 'POST', body: { friendshipId: reqId, accept: true }, token: B.token });
  ok('通过生产地址建立好友');

  const convId = `dm:${[A.id, B.id].sort().join(':')}`;
  const SECRET = '生产链路机密-' + sfx;

  // 加密消息
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
  await req('/api/messages', {
    method: 'POST', token: A.token,
    body: { toType: 'dm', toId: B.id, content: JSON.stringify({ v: 1, eph: b64e(ephRaw), sig: '', r }), type: 'text', cipher: 1 }
  });
  ok('通过生产地址发送加密消息');

  // B 解密
  const bBlob = (await req('/api/crypto/me', { token: B.token })).json.crypto;
  const bKek = await deriveKek(PWD, B.username, bBlob.cryptoSalt);
  const bPriv = await unwrap(JSON.parse(bBlob.cryptoEncPrivate), bKek);
  const bKey = await crypto.subtle.importKey('pkcs8', bPriv, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);

  const msgs = (await req('/api/messages?conversationId=' + encodeURIComponent(convId), { token: B.token })).json.messages;
  const m = msgs.find((x) => x.cipher === 1);
  if (!m) { bad('接收方取到密文消息', '未找到'); return; }
  ok('接收方取到密文消息');

  const payload = JSON.parse(m.content);
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: await impEcdh(payload.eph) }, bKey, 256
  );
  const key = await msgKey(shared, convId, A.id, B.id);
  const plain = Buffer.from(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64d(payload.r[B.id].iv) }, key, b64d(payload.r[B.id].ct)
  )).toString('utf8');
  JSON.parse(plain).c === SECRET ? ok('接收方成功解密原文') : bad('接收方成功解密原文', plain);

  // 数据库检查
  const dbRaw = fs.readFileSync(DB, 'utf8');
  dbRaw.includes(SECRET) ? bad('生产数据库无明文', '发现明文！') : ok('生产数据库无明文');
  dbRaw.includes(payload.eph) ? ok('数据库存的是加密载荷') : bad('数据库存的是加密载荷', '未找到载荷');

  // 会话预览
  const convs = (await req('/api/conversations', { token: B.token })).json.conversations;
  const prev = convs.find((c) => c.conversationId === convId)?.lastMessage;
  prev === '[加密消息]' ? ok('会话预览为 [加密消息]') : bad('会话预览为 [加密消息]', String(prev));

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  if (fail) failures.forEach((f) => console.log('  ! ' + f));

  // 清理测试账号
  const db = JSON.parse(dbRaw);
  db.users = db.users.filter((u) => u.username !== 'prod_a_' + sfx && u.username !== 'prod_b_' + sfx);
  db.messages = db.messages.filter((m) => m.from !== A.id && m.from !== B.id);
  db.friendships = db.friendships.filter((f) => f.userId !== A.id && f.userId !== B.id && f.friendId !== A.id && f.friendId !== B.id);
  db.sessions = db.sessions.filter((s) => s.userId !== A.id && s.userId !== B.id);
  fs.writeFileSync(DB, JSON.stringify(db, null, 2), 'utf8');

  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('异常:', e); process.exit(1); });
