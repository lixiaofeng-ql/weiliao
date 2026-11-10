/**
 * 微聊 - 看门狗/自启动脚本的 config.js 生成测试
 *
 * 背景：watchdog.ps1 的 Write-Config 曾经把 apiBases 候选列表写丢了，
 * 导致前端丢失故障转移能力（failover-test 会失败）。
 * 本测试实跑 PowerShell 函数，确保产出的 config.js 同时包含：
 *   - apiBases（候选数组，且 [0] 是保留的原主地址）
 *   - apiBase（兼容旧版）
 *   - wsBase
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const failures = [];
function ok(n) { pass++; console.log(`  ✓ ${n}`); }
function bad(n, d) { fail++; failures.push(`${n}: ${d}`); console.log(`  ✗ ${n} — ${d}`); }

const root = path.resolve('.');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-cfg-'));

console.log('\n=== 微聊 config.js 生成脚本 测试 ===\n');

// ---------- 1. 静态检查：两个脚本都必须写 apiBases ----------
for (const f of ['scripts/watchdog.ps1', 'scripts/auto-start.ps1']) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  src.includes('apiBases') ? ok(`${f} 写入 apiBases`) : bad(`${f} 写入 apiBases`, '未找到');
  src.includes('apiBase:') ? ok(`${f} 同时写入 apiBase`) : bad(`${f} 同时写入 apiBase`, '未找到');
  src.includes('wsBase') ? ok(`${f} 写入 wsBase`) : bad(`${f} 写入 wsBase`, '未找到');
}

// ---------- 2. 实跑 watchdog 的 Write-Config ----------
const wdSrc = fs.readFileSync(path.join(root, 'scripts/watchdog.ps1'), 'utf8');
const cfgPath = path.join(tmp, 'config.js');

const OLD_PRIMARY = 'https://prod.example.com';
const NEW_TUNNEL = 'https://new-tunnel-abc.trycloudflare.com';

// 造一份带旧 apiBases 的旧配置（模拟「正式服务器固定地址 + 隧道地址变化」）
fs.writeFileSync(cfgPath, `window.WL_CONFIG = {\n  apiBases: [\n    '${OLD_PRIMARY}',\n    'https://old-tunnel.trycloudflare.com'\n  ],\n  apiBase: '${OLD_PRIMARY}',\n  wsBase: 'wss://old-tunnel.trycloudflare.com/ws'\n};\n`, 'utf8');

// 抽取 Write-Config 函数体，改成可在 PowerShell 里独立调用
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let depth = 0;
  const i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return null;
}
const writeConfigFn = extractFn(wdSrc, 'Write-Config');

if (!writeConfigFn) {
  bad('抽取 Write-Config 函数', '未找到');
} else {
  // 组装一个临时 PowerShell 脚本：定义函数 → 调用它
  const psPath = path.join(tmp, 'run.ps1');
  const ps = [
    '$ErrorActionPreference = "Stop"',
    `$cfg = '${cfgPath.replace(/\\/g, '\\\\')}'`,
    writeConfigFn,
    `Write-Config '${NEW_TUNNEL}'`
  ].join('\n');
  fs.writeFileSync(psPath, ps, 'utf8');

  try {
    // Windows 上优先用绝对路径（powershell 别名可能不在 PATH）
    const candidates = [
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'powershell.exe',
      'pwsh'
    ];
    let ran = false;
    let lastErr = '';
    for (const exe of candidates) {
      try {
        execFileSync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath], {
          encoding: 'utf8', stdio: 'pipe', timeout: 30000
        });
        ran = true;
        break;
      } catch (e) {
        lastErr = String((e.stderr || e.message)).slice(0, 300);
      }
    }
    if (!ran) bad('执行 watchdog Write-Config', lastErr);
  } catch (e) {
    bad('执行 watchdog Write-Config', String(e.message).slice(0, 300));
  }

  const out = fs.readFileSync(cfgPath, 'utf8');
  out.includes('apiBases') ? ok('watchdog Write-Config 产出包含 apiBases') : bad('watchdog Write-Config 产出包含 apiBases', out);
  out.includes(OLD_PRIMARY) ? ok('watchdog Write-Config 保留了原主地址') : bad('watchdog Write-Config 保留了原主地址', out);
  out.includes(NEW_TUNNEL) ? ok('watchdog Write-Config 写入了新隧道地址') : bad('watchdog Write-Config 写入了新隧道地址', out);
  out.includes('apiBase:') ? ok('watchdog Write-Config 产出包含 apiBase') : bad('watchdog Write-Config 产出包含 apiBase', out);
  out.includes('wsBase') ? ok('watchdog Write-Config 产出包含 wsBase') : bad('watchdog Write-Config 产出包含 wsBase', out);

  // 解析验证
  const m = out.match(/apiBases:\s*\[([\s\S]*?)\]/);
  if (m) {
    const items = m[1].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean);
    items.length === 2 && items[0] !== items[1]
      ? ok('apiBases 是两个不同的候选地址')
      : bad('apiBases 是两个不同的候选地址', JSON.stringify(items));
    items[0] === OLD_PRIMARY ? ok('apiBases[0] 为原主地址（正式服务器优先）') : bad('apiBases[0] 为原主地址（正式服务器优先）', items[0]);
    items[1] === NEW_TUNNEL ? ok('apiBases[1] 为新隧道地址') : bad('apiBases[1] 为新隧道地址', items[1]);
  } else {
    bad('apiBases 是两个不同的候选地址', '未匹配到数组');
  }
}

// ---------- 3. 真实 config.js 也必须格式正确 ----------
const realCfg = fs.readFileSync(path.join(root, 'client/public/config.js'), 'utf8');
realCfg.includes('apiBases') ? ok('当前 config.js 含 apiBases') : bad('当前 config.js 含 apiBases', realCfg);
realCfg.includes('apiBase:') ? ok('当前 config.js 含 apiBase') : bad('当前 config.js 含 apiBase', realCfg);

// ---------- 4. 前端 normalizeApiBases 能正确读取 ----------
const appJs = fs.readFileSync(path.join(root, 'client/public/app.js'), 'utf8');
const fn = extractFn(appJs, 'normalizeApiBases');
if (!fn) {
  bad('抽取 normalizeApiBases', '未找到');
} else {
  const run = new Function('cfg', fn + '\nreturn normalizeApiBases(cfg);');
  const list = run({ apiBases: [OLD_PRIMARY, NEW_TUNNEL], apiBase: OLD_PRIMARY });
  list.length === 2 && list[0] === OLD_PRIMARY && list[1] === NEW_TUNNEL
    ? ok('前端能解析出两个候选地址')
    : bad('前端能解析出两个候选地址', JSON.stringify(list));
  const list2 = run({ apiBase: 'https://only-one.example.com' });
  list2.length === 1 ? ok('兼容旧版单地址配置') : bad('兼容旧版单地址配置', JSON.stringify(list2));
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
if (fail) failures.forEach((f) => console.log('  ! ' + f));
process.exit(fail ? 1 : 0);
