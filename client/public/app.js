/* ============================================================
 * 微聊 前端逻辑
 * - REST 登录态鉴权
 * - WebSocket 实时消息
 * - 单页视图切换
 * ============================================================ */

// 后端地址：优先 config.js 中的配置，否则同源
const CFG = window.WL_CONFIG || {};
const API = (CFG.apiBase || '').replace(/\/$/, '');
const WS_URL = CFG.wsBase
  || (API
        ? (API.startsWith('https') ? 'wss://' : 'ws://') + API.replace(/^https?:\/\//, '') + '/ws'
        : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');

const EMOJIS = [
  '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩',
  '😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐',
  '🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒',
  '🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕',
  '😟','🙁','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖',
  '😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡',
  '👍','👎','👏','🙌','🤝','🙏','💪','👋','🤞','✌️','🤟','🤘','👌','🤏','🫶','🫡',
  '❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','💕','💞','💯','✨','⭐','🌟','🔥',
  '🎉','🎊','👍🏽','💪🏽','❤️‍🔥','💜','😎','🤓','🥺','👀','💤','⏰','📌','📎','💡','✅'
];

const state = {
  token: localStorage.getItem('wl_token') || '',
  user: null,
  ws: null,
  wsRetry: 0,
  current: null,        // { type:'dm'|'group', targetId, title, peer }
  friends: [],
  requests: [],
  sent: [],
  groups: [],
  joinable: [],
  conversations: [],
  messages: [],
  expandedFb: {},
  selectedMembers: new Set(),
  searchUsers: []
};

/* ==================== 工具 ==================== */
const $ = (id) => document.getElementById(id);

function toast(msg, type = 'info') {
  const wrap = $('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast' + (type !== 'info' ? ' ' + type : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const now = new Date();
  const pad = (n) => (n < 10 ? '0' + n : n);
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return hm;
  }
  if (d.getFullYear() === now.getFullYear()) {
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function formatDateTime(ts) {
  if (!ts) return '-';
  const d = new Date(Number(ts));
  const pad = (n) => (n < 10 ? '0' + n : n);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function initial(name) {
  return String(name || '?').trim().charAt(0).toUpperCase();
}

/* ==================== API ==================== */
let booting = true;   // 启动阶段不因 401 强制跳回登录页

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  if (res.status === 401) {
    if (!booting) logout(true);
    throw new Error('登录已过期，请重新登录');
  }
  if (!json) throw new Error('服务器无响应 (' + res.status + ')');
  if (!json.success) throw new Error(json.message || '请求失败');
  return json;
}

/* ==================== 登录 / 注册 ==================== */
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.authTab === tab);
  });
  $('loginForm').classList.toggle('hidden', tab !== 'login');
  $('registerForm').classList.toggle('hidden', tab !== 'register');
}

document.querySelectorAll('.auth-tab').forEach((btn) => {
  btn.addEventListener('click', () => switchAuthTab(btn.dataset.authTab));
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('loginBtn');
  btn.disabled = true;
  btn.textContent = '登录中...';
  try {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { username: $('loginUsername').value.trim(), password: $('loginPassword').value }
    });
    onLogin(res);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '登 录';
  }
});

$('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('regUsername').value.trim();
  const password = $('regPassword').value;
  const confirm = $('regConfirm').value;
  if (username.length < 3) return toast('账号至少 3 个字符', 'error');
  if (password.length < 6) return toast('密码至少 6 个字符', 'error');
  if (password !== confirm) return toast('两次输入的密码不一致', 'error');

  const btn = $('registerBtn');
  btn.disabled = true;
  btn.textContent = '注册中...';
  try {
    const res = await api('/api/auth/register', {
      method: 'POST',
      body: { username, password, nickname: $('regNickname').value.trim() }
    });
    onLogin(res);
    toast('注册成功', 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '注 册';
  }
});

function onLogin(res) {
  state.token = res.token;
  state.user = res.user;
  localStorage.setItem('wl_token', res.token);
  showMain();
  connectWS();
  refreshAll();
}

function logout(silent) {
  if (!silent && state.token) {
    api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  }
  state.token = '';
  state.user = null;
  localStorage.removeItem('wl_token');
  if (state.ws) { try { state.ws.close(); } catch {} state.ws = null; }
  $('mainView').classList.add('hidden');
  $('authView').classList.remove('hidden');
  if (!silent) toast('已退出登录');
}

$('logoutBtn').addEventListener('click', () => logout(false));

/* ==================== 视图切换 ==================== */
function showMain() {
  $('authView').classList.add('hidden');
  $('mainView').classList.remove('hidden');
  $('menuNick').textContent = state.user.nickname || state.user.username;
  $('menuAccount').textContent = '@' + state.user.username;
  $('menuAvatar').textContent = initial(state.user.nickname || state.user.username);
  $('menuAvatar').style.background = state.user.avatarColor || '#2b6de8';
  document.querySelectorAll('.admin-only').forEach((el) => {
    el.classList.toggle('hidden', !state.user.isAdmin);
  });
}

const PAGES = ['conversationsPage', 'friendsPanel', 'groupsPanel', 'chatPage', 'adminPanel'];

function showPage(pageId, title) {
  PAGES.forEach((p) => $(p).classList.toggle('hidden', p !== pageId));
  $('pageTitle').textContent = title || '微聊';
  $('backBtn').classList.toggle('hidden', pageId === 'conversationsPage');
  if (pageId !== 'chatPage') $('emojiPanel').classList.add('hidden');
  window.scrollTo(0, 0);
}

$('backBtn').addEventListener('click', () => {
  if (!$('chatPage').classList.contains('hidden')) {
    state.current = null;
    showPage('conversationsPage', '微聊');
    refreshConversations();
  } else {
    showPage('conversationsPage', '微聊');
    refreshConversations();
  }
});

/* ==================== 侧边菜单 ==================== */
function openMenu() {
  $('sideMenu').classList.remove('hidden');
  $('menuMask').classList.remove('hidden');
}
function closeMenu() {
  $('sideMenu').classList.add('hidden');
  $('menuMask').classList.add('hidden');
}
// 统一使用事件委托绑定菜单交互（更稳定，避免个别环境下按钮监听器未生效）
document.addEventListener('click', function (e) {
  const t = e.target;
  if (!t || !t.closest) return;

  // 打开菜单
  if (t.closest('#menuBtn')) {
    openMenu();
    return;
  }

  // 点击遮罩关闭菜单
  if (t.closest('#menuMask')) {
    closeMenu();
    return;
  }

  // 切换到各个面板
  const item = t.closest('.menu-item[data-panel]');
  if (item) {
    const panel = item.dataset.panel;
    closeMenu();
    if (panel === 'friendsPanel') {
      showPage('friendsPanel', '我的好友');
      refreshFriends();
    } else if (panel === 'groupsPanel') {
      showPage('groupsPanel', '我的群聊');
      refreshGroups();
    } else if (panel === 'adminPanel') {
      showPage('adminPanel', '管理后台');
      refreshAdmin();
    }
  }
});

/* ==================== 数据刷新 ==================== */
async function refreshAll() {
  await Promise.allSettled([refreshConversations(), refreshFriends(), refreshGroups()]);
}

async function refreshConversations() {
  try {
    const res = await api('/api/conversations');
    state.conversations = res.conversations || [];
    renderConversations();
  } catch (e) {
    console.error(e);
  }
}

async function refreshFriends() {
  try {
    const res = await api('/api/friends');
    state.friends = res.friends || [];
    state.requests = res.requests || [];
    state.sent = res.sent || [];
    renderFriends();
  } catch (e) {
    console.error(e);
  }
}

async function refreshGroups() {
  try {
    const res = await api('/api/groups');
    state.groups = res.groups || [];
    state.joinable = res.joinable || [];
    renderGroups();
  } catch (e) {
    console.error(e);
  }
}

/* ==================== 渲染：会话列表 ==================== */
function renderConversations() {
  const box = $('convList');
  const list = state.conversations;
  $('convEmpty').classList.toggle('hidden', list.length > 0);
  box.innerHTML = list.map((c) => `
    <button class="conv-item" data-conv="${escapeHtml(c.conversationId)}" data-type="${c.type}" data-target="${escapeHtml(c.targetId)}">
      <div class="avatar" style="background:${escapeHtml(c.avatarColor || '#2b6de8')}">${escapeHtml(initial(c.title))}</div>
      <div class="conv-main">
        <div class="conv-top">
          <div class="conv-title">${escapeHtml(c.title)}</div>
          <div class="conv-time">${formatTime(c.lastTime)}</div>
        </div>
        <div class="conv-bottom">
          <div class="conv-msg">${escapeHtml(c.lastMessage)}</div>
          ${c.unread > 0 ? `<div class="unread-badge">${c.unread > 99 ? '99+' : c.unread}</div>` : ''}
        </div>
      </div>
    </button>
  `).join('');

  box.querySelectorAll('.conv-item').forEach((el) => {
    el.addEventListener('click', () => openChat(el.dataset.type, el.dataset.target, el.querySelector('.conv-title').textContent));
  });
}

/* ==================== 渲染：好友 ==================== */
function renderFriends() {
  $('friendCount').textContent = state.friends.length;
  $('requestCount').textContent = state.requests.length;
  $('requestBlock').classList.toggle('hidden', state.requests.length === 0);

  $('requestList').innerHTML = state.requests.map((r) => `
    <div class="row-item">
      <div class="avatar" style="background:${escapeHtml(r.peer.avatarColor || '#2b6de8')}">${escapeHtml(initial(r.peer.nickname))}</div>
      <div class="row-main">
        <div class="row-name">${escapeHtml(r.peer.nickname)}<span class="tag tag-gray">@${escapeHtml(r.peer.username)}</span></div>
        <div class="row-sub">申请添加你为好友</div>
      </div>
      <div class="row-actions">
        <button class="btn btn-sm btn-primary" data-accept="${escapeHtml(r.id)}">同意</button>
        <button class="btn btn-sm" data-reject="${escapeHtml(r.id)}">拒绝</button>
      </div>
    </div>
  `).join('');

  $('friendList').innerHTML = state.friends.map((f) => `
    <div class="row-item">
      <div class="avatar" style="background:${escapeHtml(f.peer.avatarColor || '#2b6de8')}">${escapeHtml(initial(f.peer.nickname))}</div>
      <div class="row-main">
        <div class="row-name">${escapeHtml(f.peer.nickname)}<span class="tag tag-gray">@${escapeHtml(f.peer.username)}</span></div>
        <div class="row-sub">点击开始聊天</div>
      </div>
      <div class="row-actions">
        <button class="btn btn-sm btn-primary" data-chat="${escapeHtml(f.peer.id)}">聊天</button>
      </div>
    </div>
  `).join('');

  $('sentList').innerHTML = state.sent.length ? state.sent.map((f) => `
    <div class="row-item">
      <div class="avatar" style="background:${escapeHtml(f.peer.avatarColor || '#2b6de8')}">${escapeHtml(initial(f.peer.nickname))}</div>
      <div class="row-main">
        <div class="row-name">${escapeHtml(f.peer.nickname)}<span class="tag tag-gray">@${escapeHtml(f.peer.username)}</span></div>
        <div class="row-sub">等待对方通过</div>
      </div>
    </div>
  `).join('') : '<div class="row-sub" style="padding:6px 2px;">暂无</div>';

  // 事件绑定
  $('requestList').querySelectorAll('[data-accept]').forEach((b) =>
    b.addEventListener('click', () => respondFriend(b.dataset.accept, true)));
  $('requestList').querySelectorAll('[data-reject]').forEach((b) =>
    b.addEventListener('click', () => respondFriend(b.dataset.reject, false)));
  $('friendList').querySelectorAll('[data-chat]').forEach((b) => {
    b.addEventListener('click', () => {
      const f = state.friends.find((x) => x.peer.id === b.dataset.chat);
      if (f) openChat('dm', f.peer.id, f.peer.nickname || f.peer.username);
    });
  });
}

$('addFriendBtn').addEventListener('click', async () => {
  const kw = $('friendSearch').value.trim();
  if (!kw) return toast('请输入对方账号或昵称', 'error');
  try {
    const res = await api('/api/friends/request', { method: 'POST', body: { username: kw } });
    if (res.accepted) {
      toast('已互相关注，双方成为好友', 'success');
    } else {
      toast('好友申请已发送', 'success');
    }
    $('friendSearch').value = '';
    refreshFriends();
  } catch (e) {
    toast(e.message, 'error');
  }
});

async function respondFriend(friendshipId, accept) {
  try {
    await api('/api/friends/respond', { method: 'POST', body: { friendshipId, accept } });
    toast(accept ? '已同意好友申请' : '已拒绝', 'success');
    refreshFriends();
    refreshConversations();
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ==================== 渲染：群聊 ==================== */
function renderGroups() {
  $('groupCount').textContent = state.groups.length;

  $('myGroupList').innerHTML = state.groups.length ? state.groups.map((g) => `
    <div class="row-item">
      <div class="avatar" style="background:${escapeHtml(g.avatarColor || '#2b6de8')}">${escapeHtml(initial(g.name))}</div>
      <div class="row-main">
        <div class="row-name">${escapeHtml(g.name)}${g.isOwner ? '<span class="tag tag-blue">群主</span>' : ''}</div>
        <div class="row-sub">${g.memberCount} 人${g.description ? ' · ' + escapeHtml(g.description) : ''}</div>
      </div>
      <div class="row-actions">
        <button class="btn btn-sm btn-primary" data-group-chat="${escapeHtml(g.id)}">进入</button>
        <button class="btn btn-sm" data-members="${escapeHtml(g.id)}">成员</button>
      </div>
    </div>
  `).join('') : '<div class="row-sub" style="padding:6px 2px;">暂无群聊</div>';

  $('joinableGroupList').innerHTML = state.joinable.length ? state.joinable.map((g) => `
    <div class="row-item">
      <div class="avatar" style="background:${escapeHtml(g.avatarColor || '#2b6de8')}">${escapeHtml(initial(g.name))}</div>
      <div class="row-main">
        <div class="row-name">${escapeHtml(g.name)}</div>
        <div class="row-sub">${g.memberCount} 人</div>
      </div>
      <div class="row-actions">
        <button class="btn btn-sm btn-primary" data-join="${escapeHtml(g.id)}">加入</button>
      </div>
    </div>
  `).join('') : '<div class="row-sub" style="padding:6px 2px;">暂无其他群聊</div>';

  $('myGroupList').querySelectorAll('[data-group-chat]').forEach((b) =>
    b.addEventListener('click', () => {
      const g = state.groups.find((x) => x.id === b.dataset.groupChat);
      if (g) openChat('group', g.id, g.name);
    }));
  $('myGroupList').querySelectorAll('[data-members]').forEach((b) =>
    b.addEventListener('click', () => showMembers(b.dataset.members)));
  $('joinableGroupList').querySelectorAll('[data-join]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api('/api/groups/' + b.dataset.join + '/join', { method: 'POST' });
        toast('已加入群聊', 'success');
        refreshGroups();
      } catch (e) {
        toast(e.message, 'error');
      }
    }));
}

$('refreshGroupsBtn').addEventListener('click', refreshGroups);

$('createGroupBtn').addEventListener('click', () => {
  state.selectedMembers = new Set();
  openModal({
    title: '创建群聊',
    bodyHtml: `
      <div>群名称</div>
      <input id="newGroupName" placeholder="请输入群名称" maxlength="30" />
      <div style="margin-top:10px;">群简介（选填）</div>
      <input id="newGroupDesc" placeholder="例如：项目讨论组" maxlength="100" />
      <div style="margin-top:10px;">选择成员</div>
      <div class="member-pick" id="memberPick">
        ${state.friends.map((f) => `
          <button class="member-chip" data-pick="${escapeHtml(f.peer.id)}">
            ${escapeHtml(f.peer.nickname)}
          </button>
        `).join('') || '<div class="row-sub">还没有好友，先去添加好友</div>'}
      </div>
    `,
    okText: '创建',
    onOk: async () => {
      const name = $('newGroupName').value.trim();
      if (!name) { toast('请输入群名称', 'error'); return false; }
      try {
        await api('/api/groups', {
          method: 'POST',
          body: { name, description: $('newGroupDesc').value.trim(), members: [...state.selectedMembers] }
        });
        toast('群聊已创建', 'success');
        refreshGroups();
        return true;
      } catch (e) {
        toast(e.message, 'error');
        return false;
      }
    }
  });

  // 成员选择交互
  setTimeout(() => {
    $('memberPick')?.querySelectorAll('.member-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const id = chip.dataset.pick;
        if (state.selectedMembers.has(id)) {
          state.selectedMembers.delete(id);
          chip.classList.remove('on');
        } else {
          state.selectedMembers.add(id);
          chip.classList.add('on');
        }
      });
    });
  }, 0);
});

function showMembers(groupId) {
  const g = state.groups.find((x) => x.id === groupId);
  if (!g) return;
  openModal({
    title: g.name + ' · 群成员 (' + g.memberCount + ')',
    bodyHtml: `<div>${g.members.map((m) => `
      <div class="row-item" style="margin-bottom:6px;">
        <div class="avatar" style="width:32px;height:32px;font-size:13px;background:${escapeHtml(m.avatarColor || '#2b6de8')}">${escapeHtml(initial(m.nickname))}</div>
        <div class="row-main">
          <div class="row-name">${escapeHtml(m.nickname)}${m.isOwner ? '<span class="tag tag-blue">群主</span>' : ''}</div>
          <div class="row-sub">@${escapeHtml(m.username)}</div>
        </div>
      </div>`).join('')}</div>`,
    okText: '关闭',
    hideCancel: true,
    onOk: () => true
  });
}

/* ==================== 聊天 ==================== */
async function openChat(type, targetId, title) {
  state.current = { type, targetId, title };
  showPage('chatPage', title);
  $('chatBody').innerHTML = '';
  state.messages = [];

  const convId = type === 'group' ? 'group:' + targetId : dmId(state.user.id, targetId);
  state.current.conversationId = convId;

  try {
    const res = await api('/api/messages?conversationId=' + encodeURIComponent(convId));
    state.messages = res.messages || [];
    renderMessages();
    api('/api/messages/read', { method: 'POST', body: { conversationId: convId } }).catch(() => {});
    refreshConversations();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function dmId(a, b) {
  const ids = [a, b].sort();
  return 'dm:' + ids[0] + ':' + ids[1];
}

function renderMessages() {
  const box = $('chatBody');
  const me = state.user.id;
  box.innerHTML = state.messages.map((m) => {
    const mine = m.from === me;
    const isEmoji = m.type === 'emoji';
    return `
      <div class="msg-row ${mine ? 'mine' : ''}">
        <div class="msg-avatar" style="background:${escapeHtml(avatarColorOf(m.from))}">${escapeHtml(initial(m.fromName))}</div>
        <div class="msg-col">
          ${!mine ? `<div class="msg-sender">${escapeHtml(m.fromName)}</div>` : ''}
          <div class="msg-bubble ${isEmoji ? 'emoji-msg' : ''}">${escapeHtml(m.content)}</div>
          <div class="msg-time">${formatTime(m.createdAt)}</div>
        </div>
      </div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

function avatarColorOf(userId) {
  if (userId === state.user.id) return state.user.avatarColor || '#2b6de8';
  const f = state.friends.find((x) => x.peer.id === userId);
  if (f) return f.peer.avatarColor || '#2b6de8';
  const g = state.groups.find((x) => x.members.some((m) => m.id === userId));
  if (g) {
    const m = g.members.find((x) => x.id === userId);
    if (m) return m.avatarColor || '#2b6de8';
  }
  return '#8f959e';
}

async function sendMessage() {
  const input = $('msgInput');
  const text = input.value.trim();
  if (!text) return;
  if (!state.current) return;

  const isEmoji = EMOJIS.includes(text) && text.length <= 4;
  input.value = '';
  input.style.height = 'auto';

  try {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({
        action: 'send_message',
        toType: state.current.type,
        toId: state.current.targetId,
        content: text,
        type: isEmoji ? 'emoji' : 'text'
      }));
    } else {
      const res = await api('/api/messages', {
        method: 'POST',
        body: { toType: state.current.type, toId: state.current.targetId, content: text, type: isEmoji ? 'emoji' : 'text' }
      });
      if (res.message) {
        state.messages.push(res.message);
        renderMessages();
      }
    }
  } catch (e) {
    toast(e.message, 'error');
    input.value = text;
  }
}

$('sendBtn').addEventListener('click', sendMessage);
$('msgInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
$('msgInput').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 100) + 'px';
});

/* ==================== 表情面板 ==================== */
function initEmoji() {
  $('emojiGrid').innerHTML = EMOJIS.map((e) =>
    `<button class="emoji-item" data-emoji="${escapeHtml(e)}">${e}</button>`).join('');
  $('emojiGrid').querySelectorAll('.emoji-item').forEach((b) => {
    b.addEventListener('click', () => {
      const input = $('msgInput');
      input.value += b.dataset.emoji;
      input.focus();
    });
  });
}
initEmoji();

$('emojiBtn').addEventListener('click', () => {
  $('emojiPanel').classList.toggle('hidden');
});

/* ==================== 模态框 ==================== */
let modalOkHandler = null;

function openModal({ title, bodyHtml, okText = '确定', cancelText = '取消', hideCancel = false, onOk }) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = bodyHtml;
  modalOkHandler = onOk;
  const footer = $('modalFooter');
  footer.innerHTML = `
    ${hideCancel ? '' : `<button class="btn" id="modalCancel">${cancelText}</button>`}
    <button class="btn btn-primary" id="modalOk">${okText}</button>
  `;
  $('modalMask').classList.remove('hidden');
  $('modalOk').addEventListener('click', async () => {
    const r = modalOkHandler ? await modalOkHandler() : true;
    if (r !== false) closeModal();
  });
  if (!hideCancel) $('modalCancel').addEventListener('click', closeModal);
}

function closeModal() {
  $('modalMask').classList.add('hidden');
  modalOkHandler = null;
}
$('modalMask').addEventListener('click', (e) => {
  if (e.target === $('modalMask')) closeModal();
});

/* ==================== 管理后台 ==================== */
async function refreshAdmin() {
  try {
    const res = await api('/api/admin/stats');
    const s = res.stats;
    $('statTotalUsers').textContent = s.totalUsers;
    $('statActive').textContent = s.activeToday;
    $('statOnline').textContent = s.online;
    $('statGroups').textContent = s.totalGroups;
    $('statMessages').textContent = s.totalMessages;
    $('statFriends').textContent = s.totalFriendships;

    $('adminUserTable').innerHTML = (res.users || []).map((u) => `
      <tr>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.nickname)}</td>
        <td>${u.isAdmin ? '<span class="tag tag-blue">管理员</span>' : '<span class="tag tag-gray">普通用户</span>'}</td>
        <td>${u.friendCount}</td>
        <td>${u.groupCount}</td>
        <td>${u.messageCount}</td>
        <td>${formatDateTime(u.createdAt)}</td>
        <td>${formatDateTime(u.lastLoginAt)}</td>
        <td>${u.isAdmin ? '<span class="row-sub">—</span>' : `<button class="btn btn-sm btn-danger" data-del="${escapeHtml(u.id)}" data-name="${escapeHtml(u.username)}">删除</button>`}</td>
      </tr>
    `).join('');

    $('adminUserTable').querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', () => {
        openModal({
          title: '删除用户',
          bodyHtml: `<div>确定要删除账号 <b>${escapeHtml(b.dataset.name)}</b> 吗？该操作不可恢复。</div>`,
          okText: '删除',
          onOk: async () => {
            try {
              await api('/api/admin/users/' + b.dataset.del, { method: 'DELETE' });
              toast('已删除', 'success');
              refreshAdmin();
              return true;
            } catch (e) {
              toast(e.message, 'error');
              return false;
            }
          }
        });
      });
    });
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ==================== WebSocket ==================== */
function connectWS() {
  if (!state.token) return;
  if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;

  try {
    const ws = new WebSocket(WS_URL + '?token=' + encodeURIComponent(state.token));
    state.ws = ws;

    ws.onopen = () => {
      state.wsRetry = 0;
      console.log('[ws] 已连接');
      // 连接建立时主动同步一次在线人数
      api('/api/online').then((r) => {
        if (r && typeof r.online === 'number') {
          $('onlinePill').innerHTML = '● <b>' + r.online + '</b> 在线';
        }
      }).catch(() => {});
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleWS(msg);
    };

    ws.onclose = () => {
      state.ws = null;
      // 掉线重连（指数退避，最多 30s）
      const delay = Math.min(1000 * Math.pow(1.6, state.wsRetry++), 30000);
      setTimeout(() => {
        if (state.token) connectWS();
      }, delay);
    };

    ws.onerror = () => { try { ws.close(); } catch {} };
  } catch (e) {
    console.error('[ws] 创建失败', e);
  }
}

function handleWS(msg) {
  const action = msg.action;

  if (action === 'new_message') {
    const m = msg.message;
    // 当前会话内的消息 → 直接追加
    if (state.current && state.current.conversationId === m.conversationId) {
      if (!state.messages.some((x) => x.id === m.id)) {
        state.messages.push(m);
        renderMessages();
        api('/api/messages/read', { method: 'POST', body: { conversationId: m.conversationId } }).catch(() => {});
      }
    }
    refreshConversations();
    return;
  }

  if (action === 'friend_request') {
    toast(`${msg.data.from.nickname} 请求添加你为好友`);
    refreshFriends();
    return;
  }

  if (action === 'friend_response') {
    refreshFriends();
    refreshConversations();
    return;
  }

  if (action === 'friend_removed') {
    refreshFriends();
    return;
  }

  if (action === 'group_created' || action === 'group_update') {
    refreshGroups();
    return;
  }

  if (action === 'online_update') {
    $('onlinePill').innerHTML = '● <b>' + msg.online + '</b> 在线';
    return;
  }

  if (action === 'account_removed') {
    toast('账号已被管理员删除');
    logout(true);
    return;
  }

  if (action === 'error') {
    toast(msg.message || '服务端错误', 'error');
  }
}

/* ==================== 启动 ==================== */
async function boot() {
  if (!state.token) { booting = false; return; }
  try {
    const res = await api('/api/auth/me');
    state.user = res.user;
    showMain();
    connectWS();
    refreshAll();
  } catch {
    // 只有在页面启动时确实没有有效登录态才回到登录页；
    // 避免与注册/登录并发时把刚建立的会话踢掉
    if (!state.user) {
      logout(true);
    }
  } finally {
    booting = false;
  }
}
boot();
