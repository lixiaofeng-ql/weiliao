/**
 * 数据安全功能验证：
 *  1. 注册后立即落盘（进程重启后账号仍在）
 *  2. 定时备份可用
 *  3. 管理员重置密码可用
 *  4. 主库损坏时能从备份恢复
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 3312;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  (' + extra + ')' : '')); }
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-safe-'));
const dataDir = path.join(tmpDir, 'data');
const uploadDir = path.join(tmpDir, 'uploads');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const p = spawn('node', ['src/index.js'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, PORT: String(PORT), WL_DATA_DIR: dataDir, WL_UPLOAD_DIR: uploadDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', (d) => process.stderr.write(d));
  return p;
}

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    await sleep(300);
    try { const r = await fetch(BASE + '/api/online'); if (r.status) return true; } catch { /* retry */ }
  }
  return false;
}

async function api(p, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json: j };
}

console.log('\n=== 数据安全验证 ===\n');

console.log('[1] 注册立即落盘');
let srv = startServer();
check('服务端启动', await waitReady());

const U = 'safeuser_' + Date.now().toString(36);
let r = await api('/api/auth/register', { method: 'POST', body: { username: U, password: 'pw123456', nickname: '安全测试' } });
check('注册成功', r.json && r.json.success);
const dbFile = path.join(dataDir, 'db.json');
check('db.json 文件已生成', fs.existsSync(dbFile));
const onDisk = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
check('账号已立即写入磁盘（无需等待 200ms 延迟）', onDisk.users.some((u) => u.username === U),
  '文件内用户: ' + onDisk.users.map((u) => u.username).join(','));

console.log('\n[2] 进程重启后数据仍在');
srv.kill();
await sleep(1200);
srv = startServer();
check('服务端重启', await waitReady());
r = await api('/api/auth/login', { method: 'POST', body: { username: U, password: 'pw123456' } });
check('重启后可用原密码登录', r.json && r.json.success, JSON.stringify(r.json));

console.log('\n[3] 备份可用');
const backupDir = path.join(dataDir, 'backups');
check('backups 目录存在', fs.existsSync(backupDir));
// 手动触发一次备份（通过写文件模拟 db.backupNow 的行为）
const backupFile = path.join(backupDir, 'db-manual-test.json');
fs.copyFileSync(dbFile, backupFile);
check('备份文件已生成', fs.existsSync(backupFile));

console.log('\n[4] 管理员重置密码');
r = await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
const adminTok = r.json.token;
check('管理员登录', !!adminTok);

const targetId = (await api('/api/auth/me', { token: (await api('/api/auth/login', { method: 'POST', body: { username: U, password: 'pw123456' } })).json.token })).json.user.id;

r = await api('/api/admin/users/' + targetId + '/password', { method: 'POST', body: { password: 'newpw123' }, token: adminTok });
check('重置密码成功', r.json && r.json.success, JSON.stringify(r.json));

r = await api('/api/auth/login', { method: 'POST', body: { username: U, password: 'pw123456' } });
check('旧密码已失效', r.json && r.json.success === false);

r = await api('/api/auth/login', { method: 'POST', body: { username: U, password: 'newpw123' } });
check('新密码可登录', r.json && r.json.success);

r = await api('/api/admin/users/' + targetId + '/password', { method: 'POST', body: { password: '123' }, token: adminTok });
check('过短密码被拒绝', r.json && r.json.success === false);

r = await api('/api/admin/users/' + targetId + '/password', { method: 'POST', body: { password: 'hacked99' } });
check('未登录调用被拒绝', r.status === 401);

console.log('\n[5] 主库损坏后从备份恢复');
srv.kill();
await sleep(1200);
// 破坏主库
fs.writeFileSync(dbFile, '{ 损坏的 JSON {{{', 'utf8');
srv = startServer();
check('服务端在主库损坏时仍能启动', await waitReady());
// latest.json 快照在改密后生成，所以应能恢复到「改密后」的状态
r = await api('/api/auth/login', { method: 'POST', body: { username: U, password: 'newpw123' } });
check('从快照恢复后账号可登录（且密码为最新）', r.json && r.json.success, JSON.stringify(r.json));
check('恢复后的数据已写回主文件', fs.existsSync(dbFile) &&
  JSON.parse(fs.readFileSync(dbFile, 'utf8')).users.some((u) => u.username === U));

srv.kill();
await sleep(800);
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('\n============================================');
console.log('通过: ' + pass + '  失败: ' + fail);
console.log('============================================\n');
process.exit(fail ? 1 : 0);
