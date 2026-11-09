/**
 * 微聊端到端回归测试
 * 运行：node scripts/e2e-test.mjs [baseUrl]
 *   baseUrl 可用命令行参数或 BASE 环境变量指定
 *   默认测试本地 http://localhost:3000
 *
 * 注意：直接对生产服务运行本测试会污染生产数据库，
 *       请使用 scripts/e2e-clean.mjs（隔离环境运行）。
 */
const BASE = process.argv[2] || process.env.BASE || 'http://localhost:3000';

// 保险：直接对生产服务跑测试会污染生产数据库，这里显式警告
if (BASE.includes('localhost:3000') || BASE.includes('127.0.0.1:3000')) {
  console.warn(
    '\n⚠ 警告：正在对默认端口 3000 运行测试。\n' +
    '  如果这是生产服务，测试数据会写入生产数据库。\n' +
    '  隔离运行请用：node scripts/e2e-clean.mjs\n'
  );
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    failures.push(name + (extra ? ' -> ' + extra : ''));
    console.log('  ✗ ' + name + (extra ? '  (' + extra + ')' : ''));
  }
}

async function api(path, { method = 'GET', body, token } = {}) {
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

const rnd = Date.now().toString(36);
const U1 = 'test_' + rnd;
const U2 = 'test2_' + rnd;

console.log('\n=== 微聊回归测试 @ ' + BASE + ' ===\n');

console.log('[1] 注册 / 登录');
let r = await api('/api/auth/register', { method: 'POST', body: { username: U1, password: 'pw123456', nickname: '测试甲' } });
check('注册新用户', r.json && r.json.success, JSON.stringify(r.json));
const tok1 = r.json && r.json.token;
check('注册返回 token', !!tok1);

r = await api('/api/auth/register', { method: 'POST', body: { username: U1, password: 'pw123456' } });
check('重复注册被拒绝', r.json && r.json.success === false);

r = await api('/api/auth/register', { method: 'POST', body: { username: U2, password: 'pw123456', nickname: '测试乙' } });
const tok2 = r.json && r.json.token;
check('注册第二个用户', !!tok2);

r = await api('/api/auth/login', { method: 'POST', body: { username: U1, password: 'wrong' } });
check('错误密码登录失败', r.json && r.json.success === false);

r = await api('/api/auth/login', { method: 'POST', body: { username: U1, password: 'pw123456' } });
check('正确密码登录成功', r.json && r.json.success);
const tok = r.json && r.json.token;

r = await api('/api/auth/me', { token: tok });
check('获取当前用户', r.json && r.json.success && r.json.user.username === U1);

r = await api('/api/auth/me');
check('未带 token 返回 401', r.status === 401);

console.log('\n[2] 好友');
const searchRes = await api('/api/users/search?keyword=' + U2, { token: tok });
const id2 = searchRes.json.users[0] && searchRes.json.users[0].id;
check('搜索用户', !!id2, JSON.stringify(searchRes.json));

r = await api('/api/friends/request', { method: 'POST', body: { username: U2 }, token: tok });
check('发送好友请求', r.json && r.json.success, JSON.stringify(r.json));

r = await api('/api/friends/request', { method: 'POST', body: { username: U2 }, token: tok2 });
check('重复发起被拒绝', r.json && r.json.success === false);

r = await api('/api/friends', { token: tok2 });
const reqs = r.json.requests || [];
check('对方收到好友请求', reqs.length > 0, JSON.stringify(Object.keys(r.json)));
const reqId = reqs[0] && reqs[0].id;

r = await api('/api/friends/respond', { method: 'POST', body: { friendshipId: reqId, accept: true }, token: tok2 });
check('同意好友请求', r.json && r.json.success, JSON.stringify(r.json));

r = await api('/api/friends', { token: tok });
check('好友列表包含对方', (r.json.friends || []).some((f) => f.peer.username === U2), JSON.stringify(r.json.friends));

console.log('\n[3] 群聊');
r = await api('/api/groups', { method: 'POST', body: { name: '测试群_' + rnd, members: [id2] }, token: tok });
check('创建群聊', r.json && r.json.success);
const gid = r.json && r.json.group && r.json.group.id;

r = await api('/api/groups', { token: tok });
check('群列表包含新群', (r.json.groups || []).some((g) => g.id === gid));

console.log('\n[4] 消息');
r = await api('/api/messages', { method: 'POST', body: { toType: 'group', toId: gid, content: '大家好' }, token: tok });
check('发送群消息', r.json && r.json.success);

r = await api('/api/messages?toType=group&toId=' + gid, { token: tok2 });
const gm = r.json.messages || [];
check('对方收到群消息', gm.some((m) => m.content === '大家好'), JSON.stringify(gm.slice(0,1)));

r = await api('/api/messages', { method: 'POST', body: { toType: 'group', toId: gid, content: 'x' }, token: 'badtoken' });
check('非法 token 发消息被拒', r.status === 401);

r = await api('/api/messages?toType=group&toId=' + gid, { token: tok });
check('消息列表非空', (r.json.messages || []).length > 0);

console.log('\n[5] 上传');
// 1x1 PNG
const png1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
r = await api('/api/upload', { method: 'POST', body: { dataUrl: png1, prefix: 'img' }, token: tok });
check('小图上传成功', r.json && r.json.success && !!r.json.url, JSON.stringify(r.json));

const gifUrl = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
r = await api('/api/upload', { method: 'POST', body: { dataUrl: gifUrl, prefix: 'sticker' }, token: tok });
check('GIF 上传保持 gif 后缀', r.json && r.json.url && r.json.url.endsWith('.gif'), JSON.stringify(r.json));

r = await api('/api/upload', { method: 'POST', body: { dataUrl: 'data:text/plain;base64,aGk=', prefix: 'img' }, token: tok });
check('非图片类型被拒绝', r.json && r.json.success === false);

r = await api('/api/upload', { method: 'POST', body: { dataUrl: png1, prefix: 'img' } });
check('未登录上传被拒', r.status === 401);

console.log('\n[6] 表情包');
r = await api('/api/stickers', { token: tok });
check('获取表情包列表', r.json && r.json.success && Array.isArray(r.json.stickers));

r = await api('/api/stickers', { method: 'POST', body: { url: r.json.stickers[0] ? r.json.stickers[0].url : '/uploads/x.gif', name: '我的表情' }, token: tok });
check('添加自定义表情包', r.json && r.json.success);

console.log('\n[7] 资料修改');
r = await api('/api/auth/profile', { method: 'POST', body: { nickname: '新昵称', avatarColor: '#ff0000' }, token: tok });
check('修改昵称', r.json && r.json.success && r.json.user.nickname === '新昵称');
check('修改颜色', r.json && r.json.user.avatarColor === '#ff0000');

console.log('\n[8] 群解散权限');
r = await api('/api/groups', { method: 'POST', body: { name: '待解散群_' + rnd }, token: tok2 });
const gid2 = r.json && r.json.group && r.json.group.id;
r = await api('/api/groups/' + gid2, { method: 'DELETE', token: tok });
check('非群主不能解散群', r.json && r.json.success === false);

r = await api('/api/groups/' + gid, { method: 'DELETE', token: tok });
check('群主可以解散群', r.json && r.json.success);

r = await api('/api/groups', { token: tok });
check('解散后群列表不含该群', !(r.json.groups || []).some((g) => g.id === gid));

console.log('\n[9] 管理员');
r = await api('/api/admin/stats', { token: tok });
check('普通用户不能访问管理后台', r.status === 403);

r = await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
const adminTok = r.json && r.json.token;
check('管理员登录', !!adminTok);

r = await api('/api/admin/stats', { token: adminTok });
check('管理员可查看统计', r.json && r.json.success && r.json.stats.totalUsers >= 1);

console.log('\n[10] 注销');
r = await api('/api/auth/logout', { method: 'POST', token: tok });
check('注销成功', r.json && r.json.success);
r = await api('/api/auth/me', { token: tok });
check('注销后 token 失效', r.status === 401);

console.log('\n============================================');
console.log('通过: ' + pass + '  失败: ' + fail);
if (fail) {
  console.log('\n失败项:');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('============================================\n');
process.exit(fail ? 1 : 0);
