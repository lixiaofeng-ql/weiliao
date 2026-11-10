/**
 * 微聊 - 线上部署版本 E2EE 验证
 *
 * 直接从 GitHub Pages 下载已发布的 client/public/e2ee.js，
 * 在 Node 里跑真实的加密/解密往返，确保线上跑的就是加密版。
 *
 * 每个用户加载一份独立的 e2ee.js 实例（模拟每个浏览器标签页），
 * 避免共享模块状态互相污染。
 *
 * 覆盖：
 *  1. 线上 e2ee.js 存在关键能力（wrapFileKey / unwrapFileKey / state.kek）
 *  2. 生成身份 → 上传服务端 → 重新 unlock 解出私钥
 *  3. 加密消息 → 上传 → 接收方解密还原原文
 *  4. 第三方（无授权）解密失败
 *  5. 线上表情包加密：fileKey 包裹 + 图片加密 + 解密还原
 */
import { webcrypto as crypto } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3319;
const BASE = `http://localhost:${PORT}`;
const PAGES = 'https://lixiaofeng-ql.github.io/weiliao';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-live-'));

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

let cachedCode = null;
/** 加载线上部署的 e2ee.js，返回一个独立实例（模拟一个浏览器标签页） */
async function newE2EEInstance() {
  if (!cachedCode) {
    const res = await fetch(`${PAGES}/e2ee.js?t=${Date.now()}`);
    if (!res.ok) throw new Error('下载 e2ee.js 失败: HTTP ' + res.status);
    cachedCode = await res.text();
  }
  const win = { crypto, TextEncoder, TextDecoder, console };
  win.window = win;
  win.globalThis = win;
  // eslint-disable-next-line no-new-func
  new Function('window', 'globalThis', 'crypto', 'TextEncoder', 'TextDecoder', 'console', cachedCode)(
    win, win, crypto, TextEncoder, TextDecoder, console
  );
  return { e2ee: win.E2EE, code: cachedCode };
}

async function run() {
  console.log('\n=== 微聊 线上部署版 E2EE 验证 ===\n');

  const first = await newE2EEInstance();
  if (!first.e2ee) { bad('线上 e2ee.js 加载', 'E2EE 未挂载'); return; }
  ok('线上 e2ee.js 加载成功');

  // ---- 1. 关键能力存在 ----
  const caps = {
    'wrapFileKey': typeof first.e2ee.wrapFileKey === 'function',
    'unwrapFileKey': typeof first.e2ee.unwrapFileKey === 'function',
    'encryptMessage': typeof first.e2ee.encryptMessage === 'function',
    'decryptMessage': typeof first.e2ee.decryptMessage === 'function',
    'encryptFile': typeof first.e2ee.encryptFile === 'function',
    'decryptFile': typeof first.e2ee.decryptFile === 'function'
  };
  const missing = Object.entries(caps).filter(([, v]) => !v).map(([k]) => k);
  missing.length === 0 ? ok('线上版具备全部加解密能力')
    : bad('线上版具备全部加解密能力', '缺少: ' + missing.join(','));
  /state\.kek/.test(first.code) ? ok('线上版含 KEK 状态（表情包加密）') : bad('线上版含 KEK 状态（表情包加密）', '未找到 state.kek');

  // ---- 启动本地服务端 ----
  const server = spawn('node', ['src/index.js'], {
    cwd: path.resolve('server'),
    env: { ...process.env, PORT: String(PORT), WL_DATA_DIR: DATA_DIR, WL_UPLOAD_DIR: path.join(DATA_DIR, 'uploads') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => console.error('[server]', String(d).trim()));

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) { ready = true; break; } } catch { /* retry */ }
    await wait(300);
  }
  if (!ready) { bad('服务端启动', '超时'); return; }
  ok('服务端启动');

  const api = async (p, opts = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
    const r = await fetch(BASE + p, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    return r.json();
  };

  const sfx = Date.now().toString(36);
  const PWD = 'pass123456';

  /** 注册一个用户，并返回独立的「浏览器实例」 */
  async function newUser(tag) {
    const username = 'live_' + tag + '_' + sfx;
    const reg = await req('/api/auth/register', { method: 'POST', body: { username, password: PWD, nickname: username } });
    if (!reg.json.success) throw new Error('注册失败 ' + username);
    const token = reg.json.token;
    const user = reg.json.user;
    const { e2ee } = await newE2EEInstance();
    const myApi = (p, opts = {}) => api(p, { ...(opts || {}), token });
    await e2ee.setupIdentity(myApi, user, PWD);
    return { token, user, username, e2ee, myApi };
  }

  const A = await newUser('a');
  const B = await newUser('b');
  const C = await newUser('c');
  ok('三个用户各自用独立实例生成身份密钥');

  // ---- 2. 公钥已上传服务端 ----
  const meA = await api('/api/auth/me', { token: A.token });
  const meB = await api('/api/auth/me', { token: B.token });
  meA.user.cryptoPublicKey && meA.user.cryptoSigPublicKey
    ? ok('身份公钥已上传服务端') : bad('身份公钥已上传服务端', '缺失');

  // ---- 3. 重新 unlock 能恢复私钥（模拟刷新页面后解锁）----
  const aBlob = await api('/api/crypto/me', { token: A.token });
  const unlocked = await A.e2ee.unlock({ ...aBlob.crypto, username: A.username }, PWD);
  unlocked && !unlocked.needSetup && A.e2ee.state.encPrivateKey
    ? ok('刷新后可用密码重新解锁私钥') : bad('刷新后可用密码重新解锁私钥', JSON.stringify(unlocked));

  // ---- 4. A 缓存双方公钥 ----
  A.e2ee.cachePeerKeys([
    { id: A.user.id, cryptoPublicKey: meA.user.cryptoPublicKey, cryptoSigPublicKey: meA.user.cryptoSigPublicKey },
    { id: B.user.id, cryptoPublicKey: meB.user.cryptoPublicKey, cryptoSigPublicKey: meB.user.cryptoSigPublicKey }
  ]);

  const convId = `dm:${[A.user.id, B.user.id].sort().join(':')}`;
  const SECRET = '线上验证密文-' + sfx;

  // ---- 5. 线上实现加密消息 ----
  const enc = await A.e2ee.encryptMessage({
    content: SECRET,
    type: 'text',
    conversationId: convId,
    senderId: A.user.id,
    recipients: [A.user.id, B.user.id]
  });
  enc.ok ? ok('线上实现加密消息成功') : bad('线上实现加密消息成功', enc.reason);

  await req('/api/messages', {
    method: 'POST', token: A.token,
    body: { toType: 'dm', toId: B.user.id, content: JSON.stringify(enc.payload), type: 'text', cipher: 1 }
  });
  ok('密文消息已发送');

  // ---- 6. 数据库无明文 ----
  await wait(600);
  const dbRaw = fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8');
  dbRaw.includes(SECRET) ? bad('数据库无明文', '发现明文！') : ok('数据库无明文');

  // ---- 7. B 独立实例解锁并解密 ----
  const bBlob = await api('/api/crypto/me', { token: B.token });
  await B.e2ee.unlock({ ...bBlob.crypto, username: B.username }, PWD);
  B.e2ee.cachePeerKeys([
    { id: A.user.id, cryptoPublicKey: meA.user.cryptoPublicKey, cryptoSigPublicKey: meA.user.cryptoSigPublicKey }
  ]);

  const msgs = (await api('/api/messages?conversationId=' + encodeURIComponent(convId), { token: B.token })).messages;
  const m = msgs.find((x) => x.cipher === 1);
  m ? ok('接口返回消息带 cipher=1') : bad('接口返回消息带 cipher=1', '未找到');

  const dec = await B.e2ee.decryptMessage(
    JSON.parse(m.content), convId, A.user.id, B.user.id, meA.user.cryptoSigPublicKey
  );
  dec.ok && dec.content === SECRET ? ok('接收方用线上实现成功解密原文')
    : bad('接收方用线上实现成功解密原文', JSON.stringify(dec).slice(0, 160));

  // ---- 8. 第三方 C 无法解密 ----
  const cBlob = await api('/api/crypto/me', { token: C.token });
  await C.e2ee.unlock({ ...cBlob.crypto, username: C.username }, PWD);
  let cDecrypted = false;
  try {
    const cRes = await C.e2ee.decryptMessage(JSON.parse(m.content), convId, A.user.id, C.user.id, '');
    cDecrypted = !!(cRes.ok && cRes.content === SECRET);
  } catch { cDecrypted = false; }
  cDecrypted ? bad('第三方无法解密', 'C 竟然解开了！') : ok('第三方无法解密');

  // ---- 9. 线上表情包加密：KEK 包裹 fileKey + 图片加密 ----
  const rawImg = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from('LIVE-STICKER-MARK-' + sfx)]);
  const fileKey = A.e2ee.newFileKey();
  const fe = await A.e2ee.encryptFile(new Uint8Array(rawImg), fileKey);
  const up = await req('/api/upload/enc', { method: 'POST', token: A.token, body: { data: A.e2ee.bytesToB64(fe.bytes) } });
  const wrapped = await A.e2ee.wrapFileKey(fileKey);
  wrapped.error ? bad('线上 wrapFileKey 包裹 fileKey', wrapped.error)
    : ok('线上 wrapFileKey 包裹 fileKey');

  const st = await req('/api/stickers', {
    method: 'POST', token: A.token,
    body: { url: up.json.url, name: '线上表情', fileKeyIv: wrapped.keyIv, fileKeyCt: wrapped.keyCt, fileIv: fe.iv }
  });
  st.json.success ? ok('加密表情包记录保存') : bad('加密表情包记录保存', JSON.stringify(st.json));

  // 落盘文件是密文
  const onDisk = fs.readFileSync(path.join(DATA_DIR, 'uploads', path.basename(up.json.url)));
  onDisk.includes(Buffer.from('LIVE-STICKER-MARK')) ? bad('线上表情包落盘为密文', '发现明文标记！') : ok('线上表情包落盘为密文');

  // 数据库里不是裸 fileKey
  const dbObj = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8'));
  const rec = dbObj.stickers.find((x) => x.id === st.json.sticker.id);
  rec && rec.fileKeyCt && !JSON.stringify(rec).includes(A.e2ee.bytesToB64(fileKey))
    ? ok('数据库中 fileKey 为包裹密文') : bad('数据库中 fileKey 为包裹密文', JSON.stringify(rec));

  // 用 KEK 解开 → 解密图片 → 还原
  const unw = await A.e2ee.unwrapFileKey(rec.fileKeyIv, rec.fileKeyCt);
  const plainImg = Buffer.from(await A.e2ee.decryptFile(onDisk, unw.fileKey, fe.iv));
  plainImg.equals(rawImg) ? ok('线上表情包可完整还原') : bad('线上表情包可完整还原', '还原失败');

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  if (fail) failures.forEach((f) => console.log('  ! ' + f));
  try { server.kill('SIGKILL'); } catch { /* ignore */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
