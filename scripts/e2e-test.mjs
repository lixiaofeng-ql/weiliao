/**
 * 端到端接口自测脚本：node scripts/e2e-test.mjs
 */
const BASE = process.env.BASE || 'http://localhost:3000';
const RESET = process.env.RESET === '1';

const j = async (path, { method = 'GET', body, token } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
};

/** 注册失败则回退为登录（便于重复执行测试） */
const registerOrLogin = async (username, password, nickname) => {
  const r = await j('/api/auth/register', { method: 'POST', body: { username, password, nickname } });
  if (r.success) return r;
  return await j('/api/auth/login', { method: 'POST', body: { username, password } });
};

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

console.log('\n=== 微聊 E2E 测试 ===\n');

// 1. 注册
console.log('1. 注册账号');
const alice = await registerOrLogin('alice', 'alice123', '爱丽丝');
check('注册 alice', alice.success, alice);
const bob = await registerOrLogin('bob', 'bob12345', '鲍勃');
check('注册 bob', bob.success, bob);
const dup = await j('/api/auth/register', { method: 'POST', body: { username: 'alice', password: 'alice123' } });
check('重复注册被拒绝', dup.success === false, dup);
const short = await j('/api/auth/register', { method: 'POST', body: { username: 'x', password: '1' } });
check('过短账号/密码被拒绝', short.success === false, short);

// 2. 登录
console.log('2. 登录');
const login = await j('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'alice123' } });
check('alice 登录成功', login.success && !!login.token, login);
const badLogin = await j('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'wrong' } });
check('错误密码被拒绝', badLogin.success === false, badLogin);
const A = login.token, B = bob.token;

// 3. 好友
console.log('3. 好友功能');
const req = await j('/api/friends/request', { method: 'POST', body: { username: 'bob' }, token: A });
check('alice 添加 bob 为好友', req.success, req);
const bobFriends = await j('/api/friends', { token: B });
check('bob 收到 1 条好友申请', bobFriends.success && bobFriends.requests && bobFriends.requests.length >= 1, bobFriends);
const fid = (bobFriends.requests || [])[0]?.id;
const accept = await j('/api/friends/respond', { method: 'POST', body: { friendshipId: fid, accept: true }, token: B });
check('bob 同意好友申请', accept.success, accept);
const aliceFriends = await j('/api/friends', { token: A });
check('alice 好友列表含 bob', aliceFriends.friends && aliceFriends.friends.length === 1, aliceFriends);
const addSelf = await j('/api/friends/request', { method: 'POST', body: { username: 'alice' }, token: A });
check('不能加自己为好友', addSelf.success === false, addSelf);
const search = await j('/api/users/search?keyword=bo', { token: A });
check('按账号搜索用户', search.success && search.users.length >= 1, search);

// 4. 单聊 + 表情
console.log('4. 私聊与表情');
const msg = await j('/api/messages', { method: 'POST', body: { toType: 'dm', toId: bob.user.id, content: '你好 bob' }, token: A });
check('alice 发送私聊消息', msg.success, msg);
const emoji = await j('/api/messages', { method: 'POST', body: { toType: 'dm', toId: bob.user.id, content: '😀', type: 'emoji' }, token: A });
check('发送表情消息', emoji.success, emoji);
const selfMsg = await j('/api/messages', { method: 'POST', body: { toType: 'dm', toId: bob.user.id, content: '自聊' }, token: B });
check('不能给自己发消息', selfMsg.success === false, selfMsg);
const hist = await j('/api/messages?toType=dm&toId=' + alice.user.id, { token: B });
check('bob 收到 2 条消息', hist.success && hist.messages.length === 2, hist);
const convs = await j('/api/conversations', { token: B });
check('bob 会话列表有 1 条', convs.success && convs.conversations.length === 1, convs);
check('会话含未读数', convs.conversations[0].unread === 2, convs.conversations[0]);
await j('/api/messages/read', { method: 'POST', body: { conversationId: convs.conversations[0].conversationId }, token: B });
const convs2 = await j('/api/conversations', { token: B });
check('已读后未读归零', convs2.conversations[0].unread === 0, convs2.conversations[0]);

// 5. 群聊
console.log('5. 群聊功能');
const grp = await j('/api/groups', { method: 'POST', body: { name: '项目讨论组', members: [bob.user.id], description: '测试群' }, token: A });
check('alice 创建群聊', grp.success && grp.group.memberCount === 2, grp);
const gid = grp.group.id;
const gmsg = await j('/api/messages', { method: 'POST', body: { toType: 'group', toId: gid, content: '大家好' }, token: B });
check('群成员发送群消息', gmsg.success, gmsg);
const ghist = await j('/api/messages?conversationId=group:' + gid, { token: A });
check('群消息历史可读', ghist.success && ghist.messages.length === 1, ghist);
const myGroups = await j('/api/groups', { token: B });
check('bob 的群列表含该群', myGroups.groups.some((g) => g.id === gid), myGroups);
const outsider = await registerOrLogin('carol', 'carol123', '卡罗尔');
const outsiderMsg = await j('/api/messages', { method: 'POST', body: { toType: 'group', toId: gid, content: '偷偷发言' }, token: outsider.token });
check('非群成员不能发言', outsiderMsg.success === false, outsiderMsg);
const joinable = await j('/api/groups', { token: outsider.token });
check('carol 看到可加入群列表', joinable.joinable.some((g) => g.id === gid), joinable);
const joined = await j(`/api/groups/${gid}/join`, { method: 'POST', token: outsider.token });
check('carol 加入群聊', joined.success && joined.group.memberCount === 3, joined);

// 6. 权限
console.log('6. 权限校验');
const noAuth = await j('/api/friends');
check('未登录访问被拒绝', noAuth.success === false, noAuth);
const notAdmin = await j('/api/admin/stats', { token: A });
check('普通用户访问后台被拒', notAdmin.success === false, notAdmin);
const adminLogin = await j('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
check('admin 登录成功', adminLogin.success, adminLogin);
const stats = await j('/api/admin/stats', { token: adminLogin.token });
check('admin 可查注册账号数', stats.success && stats.stats.totalUsers >= 4, stats.stats);
check('admin 可见用户列表', stats.users && stats.users.length >= 4, stats.users && stats.users.length);
const delAdmin = await j('/api/admin/users/' + adminLogin.user.id, { method: 'DELETE', token: adminLogin.token });
check('不能删除管理员', delAdmin.success === false, delAdmin);

// 7. WebSocket
console.log('7. WebSocket 实时推送');
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WebSocket } = require('../server/node_modules/ws');
const got = [];
// WS 地址跟随 BASE，保证隔离端口下也能测到
const WS_BASE = BASE.replace(/^http/, 'ws');
const wsA = new WebSocket(`${WS_BASE}/ws?token=${A}`);
const wsB = new WebSocket(`${WS_BASE}/ws?token=${B}`);
await new Promise((r) => { let n = 0; const t = setInterval(() => { if (++n > 40 || (wsA.readyState === 1 && wsB.readyState === 1)) { clearInterval(t); r(); } }, 50); });
check('WS 连接建立', wsA.readyState === 1 && wsB.readyState === 1);
wsB.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.action === 'new_message') got.push(m.message); });
await new Promise((r) => setTimeout(r, 200));
await j('/api/messages', { method: 'POST', body: { toType: 'dm', toId: bob.user.id, content: '实时消息测试' }, token: A });
await new Promise((r) => setTimeout(r, 600));
check('bob 通过 WS 实时收到消息', got.some((m) => m.content === '实时消息测试'), got);
const badWs = new WebSocket(`${WS_BASE}/ws?token=invalid`);
await new Promise((r) => setTimeout(r, 400));
check('无效 token 的 WS 被拒绝', badWs.readyState === 3, badWs.readyState);
wsA.close(); wsB.close();

// 8. 个人资料 / 头像
console.log('8. 个人资料与头像');
const prof1 = await j('/api/auth/profile', { method: 'POST', body: { nickname: '爱丽丝改名' }, token: A });
check('修改昵称成功', prof1.success && prof1.user.nickname === '爱丽丝改名', prof1);
const prof2 = await j('/api/auth/profile', { method: 'POST', body: { avatarColor: '#0f8a5f' }, token: A });
check('修改头像底色成功', prof2.success && prof2.user.avatarColor === '#0f8a5f', prof2);
const profBad = await j('/api/auth/profile', { method: 'POST', body: { avatar: 'javascript:alert(1)' }, token: A });
check('非法头像地址被拒绝', profBad.success === false, profBad);
// 上传 1x1 PNG
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const up = await j('/api/upload', { method: 'POST', body: { dataUrl: png, prefix: 'avatar' }, token: A });
check('上传头像图片成功', up.success && up.url.startsWith('/uploads/'), up);
const prof3 = await j('/api/auth/profile', { method: 'POST', body: { avatar: up.url }, token: A });
check('绑定自定义头像成功', prof3.success && prof3.user.avatar === up.url, prof3);
const me = await j('/api/auth/me', { token: A });
check('头像信息对外可见', me.success && me.user.avatar === up.url, me.user);
const profBadColor = await j('/api/auth/profile', { method: 'POST', body: { avatarColor: 'red' }, token: A });
check('非法头像颜色被拒绝', profBadColor.success === false, profBadColor);

// 9. 自定义表情包
console.log('9. 自定义表情包');
const stList0 = await j('/api/stickers', { token: A });
check('表情包列表可读', stList0.success && Array.isArray(stList0.stickers), stList0);
const stAdd = await j('/api/stickers', { method: 'POST', body: { url: '/uploads/sticker_test.gif', name: '测试表情' }, token: A });
check('添加自定义表情包成功', stAdd.success && stAdd.sticker.id, stAdd);
const stList1 = await j('/api/stickers', { token: A });
check('我的表情包包含刚添加的', stList1.stickers.some((s) => s.id === stAdd.sticker.id), stList1);
const stDel = await j('/api/stickers/' + stAdd.sticker.id, { method: 'DELETE', token: A });
check('删除自定义表情包成功', stDel.success, stDel);
const stDelOther = await j('/api/stickers/s_nonexist', { method: 'DELETE', token: B });
check('删除他人表情包被拒', stDelOther.success === false, stDelOther);

// 10. 发送图片 / 表情包消息
console.log('10. 图片与表情包消息');
const imgMsg = await j('/api/messages', { method: 'POST', body: { toType: 'dm', toId: bob.user.id, content: '/uploads/x.png', type: 'image' }, token: A });
check('发送图片消息成功', imgMsg.success && imgMsg.message.type === 'image', imgMsg);
const stickerMsg = await j('/api/messages', { method: 'POST', body: { toType: 'dm', toId: bob.user.id, content: 'stickers/f-huaji.gif', type: 'sticker' }, token: A });
check('发送表情包消息成功', stickerMsg.success && stickerMsg.message.type === 'sticker', stickerMsg);
const imgConvs = await j('/api/conversations', { token: B });
const dmConv = imgConvs.conversations.find((c) => c.conversationId.startsWith('dm:'));
check('会话列表表情包摘要为[表情包]', dmConv && dmConv.lastMessage === '[表情包]', dmConv);

// 11. 群聊删除（仅群主）
console.log('11. 群聊解散权限');
const gOwner = await j('/api/groups', { method: 'POST', body: { name: '待解散群', members: [bob.user.id] }, token: A });
check('创建测试群成功', gOwner.success, gOwner);
const delGid = gOwner.group.id;
const notOwner = await j('/api/groups/' + delGid, { method: 'DELETE', token: B });
check('非群主不能解散群聊', notOwner.success === false, notOwner);
const owner = await j('/api/groups/' + delGid, { method: 'DELETE', token: A });
check('群主可以解散群聊', owner.success, owner);
const gone = await j('/api/groups', { token: B });
check('解散后群聊不再出现在列表', !gone.groups.some((g) => g.id === delGid), gone.groups);

console.log(`\n=== 结果: 通过 ${pass} / 失败 ${fail} ===\n`);
process.exit(fail > 0 ? 1 : 0);
