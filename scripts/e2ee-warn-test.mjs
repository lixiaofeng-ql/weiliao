/**
 * 微聊 - 「未加密会话」警示条逻辑测试
 *
 * 用 JSDOM 无关的轻量方式：直接抽取 app.js 里的 updateChatE2eeWarn 逻辑，
 * 在 Node 里模拟 DOM 与 state，验证 4 种情形的判定结果：
 *
 *  1. 端到端加密开启 + 私钥已解锁 + 对方有公钥 → 不显示警示
 *  2. 端到端加密被用户关闭 → 显示「已关闭」
 *  3. 私钥未解锁 → 显示「未解锁」
 *  4. 对方没有公钥 → 显示「对方尚未生成加密密钥」
 *
 * 同时验证：
 *  - index.html 里存在警示条 DOM 与「去开启」按钮
 *  - app.css 里存在对应样式
 */
import fs from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const failures = [];
function ok(n) { pass++; console.log(`  ✓ ${n}`); }
function bad(n, d) { fail++; failures.push(`${n}: ${d}`); console.log(`  ✗ ${n} — ${d}`); }

const root = path.resolve('.');
const appJs = fs.readFileSync(path.join(root, 'client/public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'client/public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'client/public/app.css'), 'utf8');

console.log('\n=== 微聊 未加密警示条 测试 ===\n');

// ---- 1. DOM 与样式存在 ----
html.includes('id="chatE2eeWarn"') ? ok('index.html 存在警示条容器') : bad('index.html 存在警示条容器', '未找到');
html.includes('id="chatE2eeFixBtn"') ? ok('index.html 存在「去开启」按钮') : bad('index.html 存在「去开启」按钮', '未找到');
html.includes('id="chatE2eeWarnText"') ? ok('index.html 存在警示文案节点') : bad('index.html 存在警示文案节点', '未找到');
css.includes('.e2ee-warn') ? ok('app.css 存在警示条样式') : bad('app.css 存在警示条样式', '未找到');

// ---- 2. app.js 里存在 updateChatE2eeWarn 且被调用 ----
appJs.includes('function updateChatE2eeWarn()') ? ok('app.js 定义 updateChatE2eeWarn') : bad('app.js 定义 updateChatE2eeWarn', '未找到');
const calls = (appJs.match(/updateChatE2eeWarn\(\)/g) || []).length;
calls >= 3 ? ok(`updateChatE2eeWarn 被调用 ${calls} 处`) : bad('updateChatE2eeWarn 被多处调用', '仅 ' + calls + ' 处');

// ---- 3. 抽取函数体，在模拟 DOM 里跑 4 种情形 ----
// 取出函数源码（含其直接依赖的 recipientsOfConversation）
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let depth = 0, i = src.indexOf('{', start);
  const begin = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const fnRecipients = extractFn(appJs, 'recipientsOfConversation');
const fnWarn = extractFn(appJs, 'updateChatE2eeWarn');
const fnEnabled = extractFn(appJs, 'e2eeEnabled');
if (!fnRecipients || !fnWarn || !fnEnabled) {
  bad('抽取函数源码', '未找到');
} else {
  // 模拟 DOM
  function makeDom() {
    const els = {
      chatE2eeWarn: { classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } }, textContent: '' },
      chatE2eeWarnText: { textContent: '' }
    };
    return {
      els,
      $: (id) => els[id] || null
    };
  }

  /** 运行一次判定 */
  function evaluate({ e2eeOn, ready, peerHasKey }) {
    const dom = makeDom();
    const state = {
      user: { id: 'me' },
      current: { type: 'dm', targetId: 'peer', conversationId: 'dm:me:peer' },
      groups: []
    };
    const E2EE = {
      peerKeysOf: (id) => (peerHasKey ? { publicKey: 'pk', sigPublicKey: 'sp' } : null)
    };
    const window = { E2EE, WL_E2EE_READY: ready };
    const localStorage = { getItem: (k) => (k === 'wl_e2ee' ? (e2eeOn ? '1' : '0') : null) };
    const fn = new Function('state', 'window', 'localStorage', '$',
      fnEnabled + '\n' + fnRecipients + '\n' + fnWarn + '\nreturn updateChatE2eeWarn();');
    fn(state, window, localStorage, dom.$);
    const shown = !dom.els.chatE2eeWarn.classList.contains('hidden');
    return { shown, text: dom.els.chatE2eeWarnText.textContent };
  }

  // 情形 1：全部就绪 → 隐藏
  const r1 = evaluate({ e2eeOn: true, ready: true, peerHasKey: true });
  !r1.shown ? ok('情形1 全部就绪 → 不显示警示') : bad('情形1 全部就绪 → 不显示警示', r1.text);

  // 情形 2：用户关闭了 E2EE
  const r2 = evaluate({ e2eeOn: false, ready: true, peerHasKey: true });
  r2.shown && r2.text.includes('已关闭') ? ok('情形2 加密已关闭 → 显示提示') : bad('情形2 加密已关闭 → 显示提示', JSON.stringify(r2));

  // 情形 3：私钥未解锁
  const r3 = evaluate({ e2eeOn: true, ready: false, peerHasKey: true });
  r3.shown && r3.text.includes('未解锁') ? ok('情形3 私钥未解锁 → 显示提示') : bad('情形3 私钥未解锁 → 显示提示', JSON.stringify(r3));

  // 情形 4：对方没有公钥
  const r4 = evaluate({ e2eeOn: true, ready: true, peerHasKey: false });
  r4.shown && r4.text.includes('尚未生成加密密钥') ? ok('情形4 对方无公钥 → 显示提示') : bad('情形4 对方无公钥 → 显示提示', JSON.stringify(r4));

  // ---- 4. 关键：任何一种降级情形都不会静默 ----
  const allWarned = [r1, r2, r3, r4].every((r, i) => i === 0 ? !r.shown : r.shown);
  allWarned ? ok('所有降级情形都有明确提示（无静默降级）') : bad('所有降级情形都有明确提示（无静默降级）', JSON.stringify([r1, r2, r3, r4]));
}

// ---- 5. 发送流程：私钥未就绪时必须等待初始化，绝不静默发明文 ----
appJs.includes('if (state.e2eeInitPromise)') ? ok('发送前会等待 E2EE 初始化') : bad('发送前会等待 E2EE 初始化', '未找到');
appJs.includes('端到端加密未就绪，本条消息将以明文发送') ? ok('私钥未就绪时有明确告警') : bad('私钥未就绪时有明确告警', '未找到');
appJs.includes('对方（') && appJs.includes('尚未生成加密密钥，本条消息以明文发送')
  ? ok('对方缺公钥时有明确告警') : bad('对方缺公钥时有明确告警', '未找到');

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
if (fail) failures.forEach((f) => console.log('  ! ' + f));
process.exit(fail ? 1 : 0);
