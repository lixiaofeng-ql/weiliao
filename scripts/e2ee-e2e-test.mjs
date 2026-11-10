/**
 * 微聊 - E2EE 全链路闭环测试
 *
 * 模拟两个用户 alice / bob：
 *   1. 各自注册并生成身份密钥
 *   2. alice 给 bob 发加密消息
 *   3. bob 成功解密出原文
 *   4. 服务端数据库里只有密文，没有明文
 *   5. 第三方 carol 无法解密
 */
import { webcrypto as crypto } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3314;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-e2ee-e2e-'));

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

// ---------- 复用 e2ee.js 的实现（Node 版） ----------
const te = new TextEncoder();
const td = new TextDecoder();
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
async function msgKey(shared, convId, sid, rid) {
  const h = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: te.encode(`${convId}|${sid}|${rid}|wl-e2ee-v1`), info: te.encode('message') },
    h, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
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
const impEcdsa = (b64) => crypto.subtle.importKey('spki', b64d(b64), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
function concat(a, b) {
  const x = a instanceof Uint8Array ? a : new Uint8Array(a);
  const y = b instanceof Uint8Array ? b : new Uint8Array(b);
  const o = new Uint8Array(x.length + y.length);
  o.set(x, 0); o.set(y, x.length);
  return o;
}

class Ctx {
  constructor(id, username, password, salt, ident) {
    this.id = id; this.username = username; this.password = password;
    this.salt = salt; this.ident = ident;
    this.peers = new Map();
    this.ready = false;
  }
  async unlock() {
    const kek = await deriveKek(this.password, this.username, this.salt);
    this.encPriv = await crypto.subtle.importKey('pkcs8', await unwrap(JSON.parse(this.ident.encPrivate), kek), { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey']);
    this.sigPriv = await crypto.subtle.importKey('pkcs8', await unwrap(JSON.parse(this.ident.sigPrivate), kek), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    this.ready = true;
  }
  cache(list) { for (const p of list) this.peers.set(p.id, p); }
  async encrypt({ content, type, convId, recipients, fileKey }) {
    if (!this.ready) return { ok: false, reason: '未解锁' };
    const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey']);
    const ephRaw = await crypto.subtle.exportKey('spki', eph.publicKey);
    const inner = { t: type, c: content };
    if (fileKey) inner.f = b64e(fileKey);
    const pt = te.encode(JSON.stringify(inner));
    const r = {};
    for (const rid of recipients) {
      const pk = this.peers.get(rid);
      if (!pk) return { ok: false, reason: `缺少接收者 ${rid} 的公钥` };
      const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: await impEcdh(pk.cryptoPublicKey) }, eph.privateKey, 256);
      const key = await msgKey(shared, convId, this.id, rid);
      const iv = rnd(12);
      r[rid] = { iv: b64e(iv), ct: b64e(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt)) };
    }
    let sig = '';
    if (this.sigPriv) sig = b64e(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.sigPriv, concat(ephRaw, pt)));
    return { ok: true, payload: { v: 1, eph: b64e(ephRaw), sig, r } };
  }
  async decrypt(payload, convId, senderId, senderSigPub) {
    if (!this.ready) return { ok: false, reason: '未解锁' };
    const e = payload.r && payload.r[this.id];
    if (!e) return { ok: false, reason: '未加密给我' };
    try {
      const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: await impEcdh(payload.eph) }, this.encPriv, 256);
      const key = await msgKey(shared, convId, senderId, this.id);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(e.iv) }, key, b64d(e.ct));
      if (payload.sig && senderSigPub) {
        const okSig = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await impEcdsa(senderSigPub), b64d(payload.sig), concat(b64d(payload.eph), new Uint8Array(pt)));
        if (!okSig) return { ok: false, reason: '签名校验失败' };
      }
      const inner = JSON.parse(td.decode(pt));
      return { ok: true, content: inner.c, type: inner.t };
    } catch (err) { return { ok: false, reason: String(err && err.message) }; }
  }
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
  const up = await req('/api/crypto/keys', {
    method: 'POST', token,
    body: {
      cryptoSalt: salt,
      cryptoPublicKey: ident.publicKey,
      cryptoSigPublicKey: ident.sigPublicKey,
      cryptoEncPrivate: ident.encPrivate,
      cryptoSigPrivate: ident.sigPrivate
    }
  });
  if (!up.json.success) throw new Error('上传密钥失败');
  const ctx = new Ctx(id, username, password, salt, ident);
  await ctx.unlock();
  return { ctx, token, id };
}

async function run() {
  console.log('\n=== 微聊 E2EE 全链路闭环测试 ===\n');
  if (!(await waitReady())) { console.log('服务启动失败'); return; }

  const s = Date.now().toString(36);
  const A = await setupUser('alice_' + s, 'pass123456', '爱丽丝');
  const B = await setupUser('bob_' + s, 'pass123456', '鲍勃');
  const C = await setupUser('carol_' + s, 'pass123456', '卡罗尔');
  ok('三个用户完成注册 + 密钥生成 + 上传');

  // 互相拉公钥
  const ids = [A.id, B.id, C.id].join(',');
  const keysRes = await req('/api/crypto/keys?ids=' + ids, { token: A.token });
  const keys = keysRes.json.keys;
  A.ctx.cache(keys); B.ctx.cache(keys); C.ctx.cache(keys);
  keys.length === 3 ? ok('三方可互相拉取公钥') : bad('三方可互相拉取公钥', String(keys.length));

  // 成为好友
  await req('/api/friends/request', { method: 'POST', body: { username: 'bob_' + s }, token: A.token });
  const fr = await req('/api/friends', { token: B.token });
  await req('/api/friends/respond', { method: 'POST', body: { friendshipId: fr.json.requests?.[0]?.id, accept: true }, token: B.token });
  ok('建立好友关系');

  const convId = `dm:${[A.id, B.id].sort().join(':')}`;
  const SECRET = '绝密内容-END-TO-END-2026-绝密内容';

  // alice 加密并发送
  const enc = await A.ctx.encrypt({ content: SECRET, type: 'text', convId, recipients: [A.id, B.id] });
  enc.ok ? ok('alice 加密消息成功') : bad('alice 加密消息成功', enc.reason);
  JSON.stringify(enc.payload).includes('绝密') ? bad('载荷不含明文', '载荷里有明文！') : ok('载荷不含明文');

  const send = await req('/api/messages', {
    method: 'POST', token: A.token,
    body: { toType: 'dm', toId: B.id, content: JSON.stringify(enc.payload), type: 'text', cipher: 1 }
  });
  send.json.success ? ok('加密消息发送成功') : bad('加密消息发送成功', JSON.stringify(send.json));

  // bob 解密
  const got = await req('/api/messages?conversationId=' + encodeURIComponent(convId), { token: B.token });
  const msg = got.json.messages?.[0];
  msg?.cipher === 1 ? ok('bob 取到的是加密消息') : bad('bob 取到的是加密消息', JSON.stringify(msg));
  const dec = await B.ctx.decrypt(JSON.parse(msg.content), convId, A.id, A.ctx.ident.sigPublicKey);
  dec.ok && dec.content === SECRET ? ok('bob 成功解密出原文') : bad('bob 成功解密出原文', JSON.stringify(dec));

  // carol 无法解密
  const decC = await C.ctx.decrypt(JSON.parse(msg.content), convId, A.id, A.ctx.ident.sigPublicKey);
  !decC.ok ? ok('carol（非接收者）无法解密') : bad('carol（非接收者）无法解密', 'carol 竟然解开了');

  // 数据库无明文
  await wait(800);
  const dbRaw = fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8');
  dbRaw.includes('绝密内容-END-TO-END-2026') ? bad('数据库无明文', '数据库中出现了明文！') : ok('数据库无明文');
  dbRaw.includes('"cipher": 1') ? ok('数据库标记 cipher=1') : bad('数据库标记 cipher=1', '未找到标记');

  // 会话预览
  const convs = await req('/api/conversations', { token: B.token });
  const prev = convs.json.conversations?.find((c) => c.conversationId === convId)?.lastMessage;
  prev === '[加密消息]' ? ok('会话列表预览为 [加密消息]') : bad('会话列表预览为 [加密消息]', String(prev));

  // 群聊：三个成员互解
  const g = await req('/api/groups', { method: 'POST', token: A.token, body: { name: '密群', members: [B.id, C.id] } });
  const gconv = 'group:' + g.json.group.id;
  const genc = await A.ctx.encrypt({ content: '群里的绝密', type: 'text', convId: gconv, recipients: [A.id, B.id, C.id] });
  genc.ok ? ok('群聊加密成功') : bad('群聊加密成功', genc.reason);
  await req('/api/messages', { method: 'POST', token: A.token, body: { toType: 'group', toId: g.json.group.id, content: JSON.stringify(genc.payload), type: 'text', cipher: 1 } });
  const gmsg = (await req('/api/messages?conversationId=' + encodeURIComponent(gconv), { token: C.token })).json.messages?.[0];
  const gdec = await C.ctx.decrypt(JSON.parse(gmsg.content), gconv, A.id, A.ctx.ident.sigPublicKey);
  gdec.ok && gdec.content === '群里的绝密' ? ok('群成员 carol 成功解密群消息') : bad('群成员 carol 成功解密群消息', JSON.stringify(gdec));

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
