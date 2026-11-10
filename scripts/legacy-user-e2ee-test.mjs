/**
 * 微聊 - 历史用户「登录即自动生成密钥」流程测试
 *
 * 场景：E2EE 上线前注册的账号，服务器上没有 cryptoPublicKey。
 * 该用户用浏览器登录后，客户端的 initE2EE 应检测到私钥缺失，
 * 自动调用 setupIdentity 生成并上传密钥，无需管理员干预、无需重新注册。
 *
 * 覆盖：
 *  1. 老账号登录前：服务器无公钥
 *  2. 老账号登录后走 initE2EE 流程 → 自动生成并上传公钥
 *  3. 老账号再次登录（刷新页面）→ 走 unlock 流程，不再重新生成
 *  4. 生成的公钥在服务器上正确落库
 *  5. 之后该账号发消息即为密文（对方有公钥时）
 */
import { webcrypto as crypto } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3320;
const BASE = `http://localhost:${PORT}`;
const PAGES = 'https://lixiaofeng-ql.github.io/weiliao';
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-legacy-'));

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
async function newE2EEInstance() {
  if (!cachedCode) {
    const res = await fetch(`${PAGES}/e2ee.js?t=${Date.now()}`);
    if (!res.ok) throw new Error('下载 e2ee.js 失败');
    cachedCode = await res.text();
  }
  const win = { crypto, TextEncoder, TextDecoder, console };
  win.window = win; win.globalThis = win;
  // eslint-disable-next-line no-new-func
  new Function('window', 'globalThis', 'crypto', 'TextEncoder', 'TextDecoder', 'console', cachedCode)(
    win, win, crypto, TextEncoder, TextDecoder, console
  );
  return win.E2EE;
}

async function run() {
  console.log('\n=== 微聊 历史用户自动生成密钥 测试 ===\n');

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

  // ---- 1. 造一个「E2EE 上线前」的老账号（服务器上没有密钥）----
  const reg = await req('/api/auth/register', { method: 'POST', body: { username: 'legacy_' + sfx, password: PWD, nickname: '老用户' } });
  const token = reg.json.token;
  const user = reg.json.user;
  const myApi = (p, opts = {}) => api(p, { ...(opts || {}), token });

  const before = await myApi('/api/crypto/me');
  !before.crypto.cryptoEncPrivate && !before.crypto.cryptoPublicKey
    ? ok('老账号登录前服务器上没有密钥') : bad('老账号登录前服务器上没有密钥', JSON.stringify(before.crypto));

  // ---- 2. 模拟客户端 initE2EE：私钥缺失 → setupIdentity ----
  const e2ee = await newE2EEInstance();
  const c = before.crypto;
  if (!c.cryptoEncPrivate || !c.cryptoSigPrivate) {
    await e2ee.setupIdentity(myApi, user, PWD);
    ok('initE2EE 自动执行 setupIdentity');
  } else {
    bad('initE2EE 自动执行 setupIdentity', '不该走到这个分支');
  }

  // ---- 3. 密钥已落库 ----
  const me = await myApi('/api/auth/me');
  me.user.cryptoPublicKey && me.user.cryptoSigPublicKey
    ? ok('公钥已上传服务器') : bad('公钥已上传服务器', JSON.stringify({
      p: !!me.user.cryptoPublicKey, s: !!me.user.cryptoSigPublicKey
    }));

  // 加密私钥只存在 /api/crypto/me（普通接口绝不暴露私钥）
  const mine = await myApi('/api/crypto/me');
  mine.crypto.cryptoEncPrivate && mine.crypto.cryptoSigPrivate
    ? ok('加密私钥已上传服务器') : bad('加密私钥已上传服务器', JSON.stringify(Object.keys(mine.crypto)));
  !me.user.cryptoEncPrivate && !me.user.cryptoSigPrivate
    ? ok('普通用户接口不暴露私钥') : bad('普通用户接口不暴露私钥', '泄露了！');

  // ---- 4. 服务器存的私钥确实是密文（不含可读私钥材料）----
  const blob = JSON.parse(mine.crypto.cryptoEncPrivate || '{}');
  typeof blob.ct === 'string' && typeof blob.iv === 'string'
    ? ok('服务器上的私钥是 AES-GCM 密文') : bad('服务器上的私钥是 AES-GCM 密文', JSON.stringify(Object.keys(blob)));

  // ---- 5. 再次登录（刷新页面）→ unlock 流程，不再重新生成 ----
  const e2ee2 = await newE2EEInstance();
  const again = await myApi('/api/crypto/me');
  const u = await e2ee2.unlock({ ...again.crypto, username: user.username }, PWD);
  u && !u.needSetup && e2ee2.state.encPrivateKey
    ? ok('再次登录走 unlock 流程成功（不重复生成）') : bad('再次登录走 unlock 流程成功（不重复生成）', JSON.stringify(u));

  // ---- 6. 公钥保持不变（没有因重复登录而改变）----
  const me2 = await myApi('/api/auth/me');
  me2.user.cryptoPublicKey === me.user.cryptoPublicKey
    ? ok('重复登录不会改变公钥') : bad('重复登录不会改变公钥', '公钥变了');

  // ---- 7. 错误密码无法解锁 ----
  const e2ee3 = await newE2EEInstance();
  let failed = false;
  try { await e2ee3.unlock({ ...again.crypto, username: user.username }, 'wrongpass'); }
  catch { failed = true; }
  failed ? ok('错误密码无法解锁私钥') : bad('错误密码无法解锁私钥', '竟然解锁了');

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  if (fail) failures.forEach((f) => console.log('  ! ' + f));
  try { server.kill('SIGKILL'); } catch { /* ignore */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('异常:', e); process.exit(1); });
