/**
 * 微聊 - 微信风格 UI + 聊天设置 接口测试
 * 在隔离环境（端口 3312 + 临时数据目录）运行，不污染生产库。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3312;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-uitest-'));

let pass = 0;
let fail = 0;
const failures = [];

function ok(name) { pass++; console.log(`  ✓ ${name}`); }
function bad(name, detail) {
  fail++; failures.push(`${name}: ${detail}`);
  console.log(`  ✗ ${name} — ${detail}`);
}

async function req(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 启动隔离服务 ----------
const server = spawn('node', ['src/index.js'], {
  cwd: path.resolve('server'),
  env: { ...process.env, PORT: String(PORT), WL_DATA_DIR: DATA_DIR, WL_UPLOAD_DIR: path.join(DATA_DIR, 'uploads') },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => console.error('[server]', String(d).trim()));

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch { /* retry */ }
    await wait(300);
  }
  return false;
}

// ---------- 测试用例 ----------
async function run() {
  console.log('\n=== 微聊 UI/聊天设置 测试 ===\n');

  if (!(await waitReady())) { console.log('服务启动失败'); return; }

  // 1. 注册两个用户
  const s = Date.now().toString(36);
  const alice = await req('/api/auth/register', { method: 'POST', body: { username: 'alice_' + s, password: 'test123456', nickname: '爱丽丝' } });
  const bob = await req('/api/auth/register', { method: 'POST', body: { username: 'bob_' + s, password: 'test123456', nickname: '鲍勃' } });
  alice.json.success ? ok('注册 alice') : bad('注册 alice', JSON.stringify(alice.json));
  bob.json.success ? ok('注册 bob') : bad('注册 bob', JSON.stringify(bob.json));
  const ta = alice.json.token, tb = bob.json.token;
  const uidA = alice.json.user.id, uidB = bob.json.user.id;

  // 2. 成为好友
  await req('/api/friends/request', { method: 'POST', body: { username: 'bob_' + s }, token: ta });
  const fr = await req('/api/friends', { token: tb });
  const reqId = fr.json.requests?.[0]?.id;
  await req('/api/friends/respond', { method: 'POST', body: { friendshipId: reqId, accept: true }, token: tb });
  const fr2 = await req('/api/friends', { token: ta });
  fr2.json.friends?.length === 1 ? ok('建立好友关系') : bad('建立好友关系', JSON.stringify(fr2.json));

  // 3. 发消息
  const convId = `dm:${[uidA, uidB].sort().join(':')}`;
  await req('/api/messages', { method: 'POST', body: { toType: 'dm', toId: uidB, content: '你好，这是一条测试消息', type: 'text' }, token: ta });
  const msgs = await req('/api/messages?conversationId=' + encodeURIComponent(convId), { token: ta });
  msgs.json.messages?.length === 1 ? ok('发送并读取消息') : bad('发送并读取消息', JSON.stringify(msgs.json));

  // 4. 读取聊天设置（默认值）
  const st0 = await req('/api/chat/settings?conversationId=' + encodeURIComponent(convId), { token: ta });
  st0.json.settings?.muted === false && st0.json.settings?.pinned === false
    ? ok('读取默认聊天设置')
    : bad('读取默认聊天设置', JSON.stringify(st0.json));

  // 5. 开启消息免打扰
  const st1 = await req('/api/chat/settings', { method: 'POST', body: { conversationId: convId, muted: true }, token: ta });
  st1.json.settings?.muted === true ? ok('开启消息免打扰') : bad('开启消息免打扰', JSON.stringify(st1.json));

  // 6. 置顶聊天
  const st2 = await req('/api/chat/settings', { method: 'POST', body: { conversationId: convId, pinned: true }, token: ta });
  st2.json.settings?.pinned === true ? ok('置顶聊天') : bad('置顶聊天', JSON.stringify(st2.json));

  // 7. 设置聊天背景
  const st3 = await req('/api/chat/settings', { method: 'POST', body: { conversationId: convId, background: 'linear-gradient(160deg,#dbeafe,#e0e7ff)' }, token: ta });
  st3.json.settings?.background?.includes('dbeafe') ? ok('设置聊天背景') : bad('设置聊天背景', JSON.stringify(st3.json));

  // 8. 非法背景地址应被拒绝
  const st4 = await req('/api/chat/settings', { method: 'POST', body: { conversationId: convId, background: 'javascript:alert(1)' }, token: ta });
  st4.json.success === false ? ok('拒绝非法背景地址') : bad('拒绝非法背景地址', JSON.stringify(st4.json));

  // 9. 会话列表应带上设置
  const convs = await req('/api/conversations', { token: ta });
  const c = convs.json.conversations?.find((x) => x.conversationId === convId);
  c?.muted === true && c?.pinned === true ? ok('会话列表返回免打扰/置顶状态') : bad('会话列表返回免打扰/置顶状态', JSON.stringify(c));

  // 10. 置顶会话应排在最前
  await req('/api/messages', { method: 'POST', body: { toType: 'dm', toId: uidB, content: '第二条', type: 'text' }, token: ta });
  const convs2 = await req('/api/conversations', { token: ta });
  convs2.json.conversations?.[0]?.conversationId === convId
    ? ok('置顶会话排在最前')
    : bad('置顶会话排在最前', JSON.stringify(convs2.json.conversations?.map((x) => x.conversationId)));

  // 11. 非法背景需保持原值
  const st5 = await req('/api/chat/settings?conversationId=' + encodeURIComponent(convId), { token: ta });
  st5.json.settings?.background?.includes('dbeafe')
    ? ok('非法设置未覆盖原背景')
    : bad('非法设置未覆盖原背景', JSON.stringify(st5.json));

  // 12. 无权清空他人会话
  const other = await req('/api/chat/clear', { method: 'POST', body: { conversationId: 'dm:u_999:u_998' }, token: ta });
  other.status === 403 || other.json.success === false ? ok('无权清空他人会话被拒绝') : bad('无权清空他人会话被拒绝', JSON.stringify(other.json));

  // 13. 清空聊天记录
  const cl = await req('/api/chat/clear', { method: 'POST', body: { conversationId: convId }, token: ta });
  cl.json.success === true ? ok('清空聊天记录') : bad('清空聊天记录', JSON.stringify(cl.json));
  const msgs2 = await req('/api/messages?conversationId=' + encodeURIComponent(convId), { token: ta });
  msgs2.json.messages?.length === 0 ? ok('清空后消息列表为空') : bad('清空后消息列表为空', JSON.stringify(msgs2.json));

  // 14. 群聊相关
  const g = await req('/api/groups', { method: 'POST', body: { name: '测试群', members: [uidB] }, token: ta });
  g.json.success ? ok('创建群聊') : bad('创建群聊', JSON.stringify(g.json));
  const gid = g.json.group?.id;
  const gmsg = await req('/api/messages', { method: 'POST', body: { toType: 'group', toId: gid, content: '群消息', type: 'text' }, token: ta });
  gmsg.json.success ? ok('发送群消息') : bad('发送群消息', JSON.stringify(gmsg.json));

  // 15. 群会话设置
  const gconv = 'group:' + gid;
  const gst = await req('/api/chat/settings', { method: 'POST', body: { conversationId: gconv, muted: true }, token: tb });
  gst.json.settings?.muted === true ? ok('群聊设置可用') : bad('群聊设置可用', JSON.stringify(gst.json));

  // 16. 设置隔离性：双方设置互不影响
  const aSet = await req('/api/chat/settings?conversationId=' + encodeURIComponent(convId), { token: ta });
  const bSet = await req('/api/chat/settings?conversationId=' + encodeURIComponent(convId), { token: tb });
  aSet.json.settings?.muted === true && bSet.json.settings?.muted === false
    ? ok('聊天设置按用户隔离')
    : bad('聊天设置按用户隔离', JSON.stringify({ a: aSet.json, b: bSet.json }));

  // 17. 个人资料接口应返回头像等字段
  const me = await req('/api/auth/me', { token: ta });
  me.json.user?.username && 'avatar' in me.json.user
    ? ok('个人资料含头像字段')
    : bad('个人资料含头像字段', JSON.stringify(me.json));

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  if (fail) { failures.forEach((f) => console.log('  ! ' + f)); }
}

// ---------- 清理 ----------
function cleanup() {
  try { server.kill('SIGKILL'); } catch { /* ignore */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

run().then(() => {
  cleanup();
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('测试异常:', e);
  cleanup();
  process.exit(1);
});
