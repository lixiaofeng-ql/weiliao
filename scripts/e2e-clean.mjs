/**
 * 端到端回归测试（完全隔离，不影响生产数据）
 *   node scripts/e2e-clean.mjs
 *
 * 做法：在 3311 端口 + 临时数据目录上启动一份全新服务端，跑完整 e2e 后自动清理。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 3311;
const BASE = `http://127.0.0.1:${PORT}`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weiliao-test-'));
const dataDir = path.join(tmpDir, 'data');
const uploadDir = path.join(tmpDir, 'uploads');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

console.log('[1/4] 启动隔离服务端 (端口 ' + PORT + ')');
const server = spawn('node', ['src/index.js'], {
  cwd: path.join(ROOT, 'server'),
  env: {
    ...process.env,
    PORT: String(PORT),
    WL_DATA_DIR: dataDir,
    WL_UPLOAD_DIR: uploadDir
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let ready = false;
for (let i = 0; i < 40; i++) {
  await sleep(400);
  try {
    const r = await fetch(BASE + '/api/online');
    if (r.status) { ready = true; break; }
  } catch { /* retry */ }
}
if (!ready) {
  console.error('服务端启动失败:\n' + serverLog);
  server.kill();
  process.exit(1);
}

console.log('[2/4] 运行测试...\n');
const res = spawnSync('node', [path.join(ROOT, 'scripts', 'e2e-test.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, BASE, RESET: '1' },
  timeout: 180000
});

const out = (res.stdout || '') + (res.stderr || '');
console.log(out);

console.log('[3/4] 清理...');
server.kill();
await sleep(800);
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('[4/4] 完成');
process.exit(res.status || 0);
