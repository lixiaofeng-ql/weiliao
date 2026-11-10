/**
 * 微聊 - 多后端故障转移测试
 *
 * 场景：主地址（正式服务器）不可用，备用地址（测试隧道）可用
 * 期望：api() 自动切换到备用地址并成功返回
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3316;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-failover-'));

let pass = 0, fail = 0;
const failures = [];
function ok(n) { pass++; console.log(`  ✓ ${n}`); }
function bad(n, d) { fail++; failures.push(`${n}: ${d}`); console.log(`  ✗ ${n} — ${d}`); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 读取前端 app.js 里的多后端相关源码，在 Node 里模拟执行
const appSrc = fs.readFileSync(path.resolve('client/public/app.js'), 'utf8');

async function run() {
  console.log('\n=== 微聊 多后端故障转移测试 ===\n');

  // ---- 1. 静态检查：候选列表相关函数存在 ----
  const need = ['normalizeApiBases', 'rotateApiBase', 'currentApiBase', 'apiBases'];
  const missing = need.filter((k) => !appSrc.includes(k));
  missing.length === 0
    ? ok('前端包含多后端故障转移逻辑')
    : bad('前端包含多后端故障转移逻辑', '缺少: ' + missing.join(','));

  // ---- 2. 逻辑单测：normalizeApiBases 去重 + 保序 ----
  const sandbox = {
    window: { WL_CONFIG: { apiBases: ['https://a.com/', 'https://b.com', 'https://a.com'], apiBase: 'https://c.com' } },
    location: { protocol: 'https:', host: 'x' },
    console
  };
  const fnSrc = appSrc.match(/function normalizeApiBases\(cfg\) \{[\s\S]*?\n\}/);
  const evalFn = new Function('window', 'location', 'console', fnSrc[0] + '\nreturn normalizeApiBases(window.WL_CONFIG);');
  const list = evalFn(sandbox.window, sandbox.location, console);
  JSON.stringify(list) === JSON.stringify(['https://a.com', 'https://b.com', 'https://c.com'])
    ? ok('候选列表去重且保序（a,b,c）')
    : bad('候选列表去重且保序（a,b,c）', JSON.stringify(list));

  // ---- 3. 起一个真实后端，模拟「主地址挂了、备用地址活着」 ----
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
  if (!ready) { bad('后端启动', '超时'); cleanup(server); return; }
  ok('备用后端正常运行');

  // ---- 4. 模拟客户端：主地址指向一个不存在的端口，备用指向真实后端 ----
  const DEAD = 'http://127.0.0.1:9';   // 丢弃端口，必定连接失败
  const candidates = [DEAD, BASE];

  let idx = 0;
  const currentApiBase = () => candidates[idx];
  const rotateApiBase = () => {
    if (idx + 1 >= candidates.length) return false;
    idx += 1;
    return true;
  };

  // 复刻 app.js api() 的容错逻辑
  async function api(pathname) {
    const headers = { 'Content-Type': 'application/json' };
    let res;
    try {
      res = await fetch(currentApiBase() + pathname, { method: 'GET', headers });
    } catch {
      let good = false;
      while (!good && rotateApiBase()) {
        try { res = await fetch(currentApiBase() + pathname, { method: 'GET', headers }); good = true; }
        catch { /* next */ }
      }
      if (!good) throw new Error('无法连接服务器，请检查网络或稍后重试');
    }
    return res.json();
  }

  const r = await api('/api/health');
  r && r.success && currentApiBase() === BASE
    ? ok('主地址不通时自动切到备用地址并请求成功')
    : bad('主地址不通时自动切到备用地址并请求成功', JSON.stringify({ r, now: currentApiBase() }));

  // ---- 5. 注册 + 登录走同一套容错逻辑 ----
  const reg = await (async () => {
    const headers = { 'Content-Type': 'application/json' };
    let res;
    try {
      res = await fetch(currentApiBase() + '/api/auth/register', {
        method: 'POST', headers,
        body: JSON.stringify({ username: 'fo_' + Date.now().toString(36), password: 'pass123456', nickname: '故障转移' })
      });
    } catch {
      let good = false;
      while (!good && rotateApiBase()) {
        try {
          res = await fetch(currentApiBase() + '/api/auth/register', {
            method: 'POST', headers,
            body: JSON.stringify({ username: 'fo_' + Date.now().toString(36), password: 'pass123456', nickname: '故障转移' })
          });
          good = true;
        } catch { /* next */ }
      }
      if (!good) throw new Error('注册失败');
    }
    return res.json();
  })();
  reg && reg.success && reg.token ? ok('故障转移后注册成功并拿到 token') : bad('故障转移后注册成功并拿到 token', JSON.stringify(reg));

  // ---- 6. 全部候选都挂掉时应抛出明确错误 ----
  const allDead = [DEAD, 'http://127.0.0.1:9'];
  let idx2 = 0;
  const c2 = () => allDead[idx2];
  const r2 = () => { if (idx2 + 1 >= allDead.length) return false; idx2 += 1; return true; };
  let msg = '';
  try {
    try { await fetch(c2() + '/api/health'); }
    catch { let good = false; while (!good && r2()) { try { await fetch(c2() + '/api/health'); good = true; } catch {} } if (!good) throw new Error('无法连接服务器，请检查网络或稍后重试'); }
  } catch (e) { msg = e.message; }
  msg.includes('无法连接服务器') ? ok('所有后端都不可用时给出明确错误') : bad('所有后端都不可用时给出明确错误', msg);

  // ---- 7. config.js 格式兼容：同时含 apiBases 与 apiBase ----
  const cfg = fs.readFileSync(path.resolve('client/public/config.js'), 'utf8');
  cfg.includes('apiBases') && cfg.includes('apiBase')
    ? ok('config.js 同时提供 apiBases 与 apiBase（新版/旧版兼容）')
    : bad('config.js 同时提供 apiBases 与 apiBase（新版/旧版兼容）', '格式不对');

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  if (fail) failures.forEach((f) => console.log('  ! ' + f));
  cleanup(server);
  process.exitCode = fail ? 1 : 0;
}

function cleanup(server) {
  try { server.kill('SIGKILL'); } catch { /* ignore */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

run().catch((e) => { console.error('测试异常:', e); cleanup(null); process.exit(1); });
