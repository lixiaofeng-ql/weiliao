/* ============================================================
 * 微聊 前端逻辑
 * - REST 登录态鉴权
 * - WebSocket 实时消息
 * - 单页视图切换
 * ============================================================ */

// 后端地址：优先 config.js 中的配置，否则同源
// 注意：API / WS_URL 使用 let，因为启动时还会异步刷新一次（绕过 Pages CDN 缓存）
const CFG = window.WL_CONFIG || {};
let API = (CFG.apiBase || '').replace(/\/$/, '');
let WS_URL = CFG.wsBase
  || (API
        ? (API.startsWith('https') ? 'wss://' : 'ws://') + API.replace(/^https?:\/\//, '') + '/ws'
        : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');

/** 根据 apiBase 推导 ws 地址 */
function deriveWsUrl(base) {
  if (!base) {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }
  return (base.startsWith('https') ? 'wss://' : 'ws://') + base.replace(/^https?:\/\//, '') + '/ws';
}

/**
 * 运行时重新拉取 config.js。
 * 背景：GitHub Pages CDN 对 config.js 缓存 600 秒，隧道换地址后
 * 直接 <script> 加载会拿到旧地址。这里用带时间戳的 URL 强制回源。
 * @returns {Promise<boolean>} 地址是否发生变化
 */
async function refreshRemoteConfig() {
  try {
    const url = 'config.js?t=' + Date.now();
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return false;
    const text = await res.text();
    // 解析出 apiBase
    const m = text.match(/apiBase\s*:\s*['"]([^'"]+)['"]/);
    if (!m || !m[1]) return false;
    const newApi = m[1].replace(/\/$/, '');
    if (!newApi || newApi === API) return false;

    console.log('[config] 后端地址变更:', API, '->', newApi);
    API = newApi;
    WS_URL = deriveWsUrl(API);
    return true;
  } catch (e) {
    console.warn('[config] 刷新配置失败', e);
    return false;
  }
}

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
  searchUsers: [],
  stickers: [],          // 我的自定义表情包
  builtInStickers: [],   // 内置斗图
  emojiTab: 'emoji',
  unreadTotal: 0,
  notify: {
    sound: localStorage.getItem('wl_sound') !== '0',
    desktop: localStorage.getItem('wl_desktop') === '1',
    badge: localStorage.getItem('wl_badge') !== '0'
  }
};

/* ---------------- 提示音（WebAudio 合成，无需音频文件） ---------------- */
let audioCtx = null;
function playNotificationSound() {
  if (!state.notify.sound) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    // 微信式双音「叮—咚」
    [
      { f: 880, t: 0, d: 0.14 },
      { f: 1174.7, t: 0.13, d: 0.22 }
    ].forEach((n) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.f, now + n.t);
      gain.gain.setValueAtTime(0.0001, now + n.t);
      gain.gain.exponentialRampToValueAtTime(0.18, now + n.t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + n.t + n.d);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + n.t);
      osc.stop(now + n.t + n.d + 0.02);
    });
  } catch (e) {
    console.warn('[sound] 播放失败', e);
  }
}

/* ---------------- 标题未读角标 ---------------- */
function updateTitleBadge() {
  const n = state.unreadTotal;
  const base = '微聊';
  if (!state.notify.badge || n <= 0) {
    document.title = base;
    return;
  }
  document.title = `(${n > 99 ? '99+' : n}) ${base}`;
}

/* ---------------- 桌面通知 ---------------- */
function requestNotifyPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

function showDesktopNotification(title, body) {
  if (!state.notify.desktop) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, {
      body,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: 'wl-' + Date.now(),
      silent: true
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch (e) {
    console.warn('[notify] 桌面通知失败', e);
  }
}

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

/**
 * 渲染头像 HTML：有图片用图片，否则用首字 + 底色。
 * @param {string} name 昵称
 * @param {string} color 底色
 * @param {string} avatarUrl 图片地址
 * @param {string} cls 额外的 class
 */
function avatarHtml(name, color, avatarUrl, cls = '') {
  const style = `background:${escapeHtml(color || '#2b6de8')}`;
  if (avatarUrl) {
    return `<div class="avatar ${cls}" style="${style}"><img src="${escapeHtml(avatarUrl)}" alt="" loading="lazy" /></div>`;
  }
  return `<div class="avatar ${cls}" style="${style}">${escapeHtml(initial(name))}</div>`;
}

/** 上传地址补全（后端返回 /uploads/xxx 相对路径） */
function absUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u) || u.startsWith('data:')) return u;
  return API + u;
}

/* ==================== API ==================== */
let booting = true;   // 启动阶段不因 401 强制跳回登录页

/** 判断是否为「服务不可达」类错误（而非业务错误） */
function isNetworkError(err) {
  if (!err) return false;
  const msg = String(err.message || '');
  return /Failed to fetch|NetworkError|服务器无响应|load failed|无法连接/i.test(msg);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new Error('无法连接服务器，请检查网络或稍后重试');
  }
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
  loadStickers();
  loadBuiltInStickers();
  requestNotifyPermission();
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

/* ==================== 个人资料 ==================== */
const AVATAR_COLORS = ['#2b6de8', '#0f8a5f', '#c47b0a', '#7c4dff', '#d43838', '#00a0a8', '#e06c9f', '#3f6f3f'];

function renderColorRow() {
  const row = $('colorRow');
  if (!row) return;
  const cur = (state.user && state.user.avatarColor) || '#2b6de8';
  row.innerHTML = AVATAR_COLORS.map((c) => `
    <button class="color-dot ${c === cur ? 'on' : ''}" data-color="${c}" style="background:${c}"></button>
  `).join('');
  row.querySelectorAll('[data-color]').forEach((b) => {
    b.addEventListener('click', () => {
      row.querySelectorAll('[data-color]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    });
  });
}

/** 打开个人资料页 */
function openProfile() {
  const u = state.user;
  $('profileNickname').value = u.nickname || '';
  renderColorRow();
  renderMyStickers();
  showPage('profilePanel', '个人资料');
}

$('profileBtn')?.addEventListener('click', () => {
  closeMenu();
  openProfile();
});

/** 上传头像 */
$('avatarEditBtn')?.addEventListener('click', () => $('avatarInput').click());

$('avatarInput')?.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    toast('头像上传中...');
    const url = await uploadImage(file, 'avatar');
    const res = await api('/api/auth/profile', { method: 'POST', body: { avatar: url } });
    state.user = res.user;
    renderMyAvatar();
    toast('头像已更新', 'success');
    refreshAll();
  } catch (err) {
    toast(err.message || '头像更新失败', 'error');
  }
});

/** 保存昵称与底色 */
$('saveProfileBtn')?.addEventListener('click', async () => {
  const nickname = $('profileNickname').value.trim();
  const on = $('colorRow').querySelector('.color-dot.on');
  const avatarColor = on ? on.dataset.color : (state.user.avatarColor || '#2b6de8');
  try {
    const res = await api('/api/auth/profile', { method: 'POST', body: { nickname, avatarColor } });
    state.user = res.user;
    renderMyAvatar();
    toast('资料已保存', 'success');
    refreshAll();
  } catch (e) {
    toast(e.message, 'error');
  }
});

/* ---------------- 通知设置 ---------------- */
$('soundToggle')?.addEventListener('change', (e) => {
  state.notify.sound = e.target.checked;
  localStorage.setItem('wl_sound', e.target.checked ? '1' : '0');
  if (e.target.checked) playNotificationSound(); // 试听
});

$('notifyToggle')?.addEventListener('change', (e) => {
  state.notify.desktop = e.target.checked;
  localStorage.setItem('wl_desktop', e.target.checked ? '1' : '0');
  if (e.target.checked) requestNotifyPermission();
});

$('badgeToggle')?.addEventListener('change', (e) => {
  state.notify.badge = e.target.checked;
  localStorage.setItem('wl_badge', e.target.checked ? '1' : '0');
  updateTitleBadge();
});

/* ==================== 视图切换 ==================== */
function showMain() {
  $('authView').classList.add('hidden');
  $('mainView').classList.remove('hidden');
  $('menuNick').textContent = state.user.nickname || state.user.username;
  $('menuAccount').textContent = '@' + state.user.username;
  renderMyAvatar();
  document.querySelectorAll('.admin-only').forEach((el) => {
    el.classList.toggle('hidden', !state.user.isAdmin);
  });
  // 首次进入时同步一次通知开关状态
  $('soundToggle').checked = state.notify.sound;
  $('notifyToggle').checked = state.notify.desktop;
  $('badgeToggle').checked = state.notify.badge;
}

/** 渲染侧边菜单与资料页里的「我」头像 */
function renderMyAvatar() {
  const u = state.user;
  if (!u) return;
  const color = u.avatarColor || '#2b6de8';
  const img = u.avatar
    ? `<img src="${escapeHtml(absUrl(u.avatar))}" alt="" />`
    : escapeHtml(initial(u.nickname || u.username));
  const menuAvatar = $('menuAvatar');
  menuAvatar.style.background = color;
  menuAvatar.innerHTML = img;
  const pa = $('profileAvatar');
  if (pa) {
    pa.style.background = color;
    pa.innerHTML = img;
  }
}

const PAGES = ['conversationsPage', 'friendsPanel', 'groupsPanel', 'chatPage', 'adminPanel', 'profilePanel'];

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
      ${avatarHtml(c.title, c.avatarColor, c.avatar || '')}
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

  // 汇总未读数 → 标题角标
  state.unreadTotal = list.reduce((s, c) => s + (c.unread || 0), 0);
  updateTitleBadge();
}

/* ==================== 渲染：好友 ==================== */
function renderFriends() {
  $('friendCount').textContent = state.friends.length;
  $('requestCount').textContent = state.requests.length;
  $('requestBlock').classList.toggle('hidden', state.requests.length === 0);

  $('requestList').innerHTML = state.requests.map((r) => `
    <div class="row-item">
      ${avatarHtml(r.peer.nickname, r.peer.avatarColor, r.peer.avatar)}
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
      ${avatarHtml(f.peer.nickname, f.peer.avatarColor, f.peer.avatar)}
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
      ${avatarHtml(f.peer.nickname, f.peer.avatarColor, f.peer.avatar)}
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
      ${avatarHtml(g.name, g.avatarColor, g.avatar)}
      <div class="row-main">
        <div class="row-name">${escapeHtml(g.name)}${g.isOwner ? '<span class="tag tag-blue">群主</span>' : ''}</div>
        <div class="row-sub">${g.memberCount} 人${g.description ? ' · ' + escapeHtml(g.description) : ''}</div>
      </div>
      <div class="row-actions">
        <button class="btn btn-sm btn-primary" data-group-chat="${escapeHtml(g.id)}">进入</button>
        <button class="btn btn-sm" data-members="${escapeHtml(g.id)}">成员</button>
        ${g.isOwner ? `<button class="btn btn-sm btn-danger" data-del-group="${escapeHtml(g.id)}">解散</button>` : ''}
      </div>
    </div>
  `).join('') : '<div class="row-sub" style="padding:6px 2px;">暂无群聊</div>';

  $('joinableGroupList').innerHTML = state.joinable.length ? state.joinable.map((g) => `
    <div class="row-item">
      ${avatarHtml(g.name, g.avatarColor, g.avatar)}
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
  $('myGroupList').querySelectorAll('[data-del-group]').forEach((b) =>
    b.addEventListener('click', () => confirmDeleteGroup(b.dataset.delGroup)));
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
        ${avatarHtml(m.nickname, m.avatarColor, m.avatar, 'avatar-sm')}
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

/** 群主解散群聊 */
function confirmDeleteGroup(groupId) {
  const g = state.groups.find((x) => x.id === groupId);
  if (!g) return;
  if (!g.isOwner) return toast('只有群主才能解散该群聊', 'error');
  openModal({
    title: '解散群聊',
    bodyHtml: `<div>确定要解散群聊 <b>${escapeHtml(g.name)}</b> 吗？<br />解散后群成员将全部退出，群内聊天记录也会一并清除，且无法恢复。</div>`,
    okText: '确认解散',
    onOk: async () => {
      try {
        await api('/api/groups/' + groupId, { method: 'DELETE' });
        toast('群聊已解散', 'success');
        // 若正在该群聊天中，退回会话列表
        if (state.current && state.current.type === 'group' && state.current.targetId === groupId) {
          state.current = null;
          showPage('conversationsPage', '微聊');
        }
        refreshGroups();
        refreshConversations();
        return true;
      } catch (e) {
        toast(e.message, 'error');
        return false;
      }
    }
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
    const isImage = m.type === 'image';
    const isSticker = m.type === 'sticker';

    let bubbleInner = '';
    let bubbleCls = 'msg-bubble';
    if (isImage) {
      bubbleCls += ' msg-image';
      bubbleInner = `<img src="${escapeHtml(absUrl(m.content))}" alt="图片" loading="lazy" />`;
    } else if (isSticker) {
      bubbleCls += ' msg-sticker';
      bubbleInner = `<img src="${escapeHtml(absUrl(m.content))}" alt="表情包" loading="lazy" />`;
    } else {
      bubbleInner = escapeHtml(m.content);
    }
    if (isEmoji) bubbleCls += ' emoji-msg';

    const avatar = avatarHtml(m.fromName, avatarColorOf(m.from), avatarUrlOf(m.from), 'msg-avatar');

    return `
      <div class="msg-row ${mine ? 'mine' : ''}">
        ${avatar}
        <div class="msg-col">
          ${!mine ? `<div class="msg-sender">${escapeHtml(m.fromName)}</div>` : ''}
          <div class="${bubbleCls}">${bubbleInner}</div>
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

/** 取某人的头像图片地址 */
function avatarUrlOf(userId) {
  if (userId === state.user.id) return state.user.avatar || '';
  const f = state.friends.find((x) => x.peer.id === userId);
  if (f) return f.peer.avatar || '';
  const g = state.groups.find((x) => x.members.some((m) => m.id === userId));
  if (g) {
    const m = g.members.find((x) => x.id === userId);
    if (m) return m.avatar || '';
  }
  return '';
}

/** 发送一条消息（走 WebSocket，低延迟） */
async function sendMessage({ content, type = 'text' } = {}) {
  const input = $('msgInput');
  const text = String(content == null ? input.value : content).trim();
  if (!text) return;
  if (!state.current) return;

  const isEmoji = type === 'text' && EMOJIS.includes(text) && text.length <= 4;
  const msgType = type === 'text' ? (isEmoji ? 'emoji' : 'text') : type;
  if (type === 'text') {
    input.value = '';
    input.style.height = 'auto';
  }

  try {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({
        action: 'send_message',
        toType: state.current.type,
        toId: state.current.targetId,
        content: text,
        type: msgType
      }));
    } else {
      const res = await api('/api/messages', {
        method: 'POST',
        body: { toType: state.current.type, toId: state.current.targetId, content: text, type: msgType }
      });
      if (res.message) {
        state.messages.push(res.message);
        renderMessages();
      }
    }
  } catch (e) {
    toast(e.message, 'error');
    if (type === 'text') input.value = text;
  }
}

$('sendBtn').addEventListener('click', () => sendMessage());
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

/* ==================== 表情 / 斗图面板 ==================== */
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

/** 渲染内置斗图 */
function renderBuiltInStickers() {
  const box = $('stickerGrid');
  if (!state.builtInStickers.length) {
    box.innerHTML = '<div class="row-sub" style="padding:10px 2px;">暂无内置表情包</div>';
    return;
  }
  box.innerHTML = state.builtInStickers.map((s) => `
    <button class="sticker-item" data-sticker="${escapeHtml(s.url)}" title="${escapeHtml(s.name)}">
      <img src="${escapeHtml(s.url)}" alt="${escapeHtml(s.name)}" loading="lazy" />
    </button>
  `).join('');
  box.querySelectorAll('[data-sticker]').forEach((b) => {
    b.addEventListener('click', () => {
      sendMessage({ content: b.dataset.sticker, type: 'sticker' });
      $('emojiPanel').classList.add('hidden');
    });
  });
}

/** 渲染我的自定义表情包 */
function renderMyStickers() {
  const grids = [$('stickerMineGrid'), $('stickerMineGrid2')].filter(Boolean);
  const count = state.stickers.length;
  const cnt = $('stickerCount');
  if (cnt) cnt.textContent = count;

  grids.forEach((box) => {
    if (!box) return;
    if (!count) {
      box.innerHTML = '<div class="row-sub" style="padding:10px 2px;">还没有上传表情包</div>';
      return;
    }
    box.innerHTML = state.stickers.map((s) => `
      <button class="sticker-item" data-mine-sticker="${escapeHtml(s.url)}" data-id="${escapeHtml(s.id)}" title="${escapeHtml(s.name || '表情包')}">
        <img src="${escapeHtml(absUrl(s.url))}" alt="" loading="lazy" />
        <span class="sticker-del" data-del-sticker="${escapeHtml(s.id)}">×</span>
      </button>
    `).join('');

    box.querySelectorAll('[data-mine-sticker]').forEach((b) => {
      b.addEventListener('click', (e) => {
        if (e.target.dataset.delSticker) return; // 点删除按钮不发送
        sendMessage({ content: b.dataset.mineSticker, type: 'sticker' });
        $('emojiPanel').classList.add('hidden');
      });
    });
    box.querySelectorAll('[data-del-sticker]').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = b.dataset.delSticker;
        try {
          await api('/api/stickers/' + id, { method: 'DELETE' });
          toast('已删除表情包', 'success');
          loadStickers();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  });
}

/** 加载我的表情包 */
async function loadStickers() {
  try {
    const res = await api('/api/stickers');
    state.stickers = res.stickers || [];
    renderMyStickers();
  } catch (e) {
    console.error(e);
  }
}

/** 加载内置斗图清单 */
async function loadBuiltInStickers() {
  try {
    const res = await fetch('stickers/manifest.json');
    const list = await res.json();
    state.builtInStickers = Array.isArray(list) ? list : [];
    renderBuiltInStickers();
  } catch (e) {
    console.error('[sticker] 内置表情包加载失败', e);
  }
}

/** 表情面板标签切换 */
function switchEmojiTab(tab) {
  state.emojiTab = tab;
  document.querySelectorAll('.emoji-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.emojiTab === tab);
  });
  $('emojiGrid').classList.toggle('hidden', tab !== 'emoji');
  $('stickerGrid').classList.toggle('hidden', tab !== 'sticker');
  $('stickerMineGrid2').classList.toggle('hidden', tab !== 'mine');
  $('emojiUploadRow').classList.toggle('hidden', tab !== 'mine');
}

document.querySelectorAll('.emoji-tab').forEach((b) => {
  b.addEventListener('click', () => switchEmojiTab(b.dataset.emojiTab));
});

$('emojiBtn').addEventListener('click', () => {
  $('emojiPanel').classList.toggle('hidden');
});

/* ---------------- 图片选择与上传 ---------------- */

/** 单张图片最大二进制体积（与服务端 MAX_BYTES 保持一致） */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/**
 * 上传目标体积。
 * Cloudflare 免费隧道上行速度很慢（实测 ~34KB/s），
 * 因此客户端把普通图片压到 400KB 以内，保证 10 秒内传完。
 */
const TARGET_UPLOAD_BYTES = 400 * 1024;

/**
 * 读取文件为 dataURL。
 * - GIF 保持原始格式，避免斗图动画被压成静态图
 * - 其他格式按目标体积压缩（先缩尺寸，再降质量）
 */
function readImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      reject(new Error('请选择图片文件'));
      return;
    }
    // GIF 直接原样上传，保留动画
    if (file.type === 'image/gif') {
      if (file.size > MAX_IMAGE_BYTES) {
        reject(new Error('表情包过大，请选择 3MB 以内的图片'));
        return;
      }
      const gifReader = new FileReader();
      gifReader.onerror = () => reject(new Error('图片读取失败'));
      gifReader.onload = () => resolve(gifReader.result);
      gifReader.readAsDataURL(file);
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片解析失败'));
      img.onload = () => {
        try {
          resolve(compressImage(img));
        } catch (e) {
          reject(new Error('图片压缩失败，请换一张试试'));
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * 把已解码的图片压缩到目标体积以内。
 * 策略：先限制最长边 1280px，再逐级降质量直到满足体积要求。
 */
function compressImage(img) {
  const MAX_DIM = 1280;
  let w = img.width;
  let h = img.height;
  if (w > MAX_DIM || h > MAX_DIM) {
    const scale = MAX_DIM / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);

  // 逐步降低质量
  for (const q of [0.82, 0.72, 0.62, 0.5, 0.4, 0.3]) {
    const url = canvas.toDataURL('image/jpeg', q);
    // base64 长度约等于二进制体积 * 1.37
    if (url.length <= TARGET_UPLOAD_BYTES * 1.37) return url;
  }

  // 仍然过大：进一步缩小尺寸再试
  const scale2 = 0.7;
  canvas.width = Math.round(w * scale2);
  canvas.height = Math.round(h * scale2);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  for (const q of [0.7, 0.55, 0.4, 0.3]) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (url.length <= TARGET_UPLOAD_BYTES * 1.37) return url;
  }
  return canvas.toDataURL('image/jpeg', 0.3);
}

/** 上传图片到服务器，返回 URL */
async function uploadImage(file, prefix) {
  const dataUrl = await readImageFile(file);
  const kb = Math.round(dataUrl.length / 1024);
  // 隧道上行较慢，超过 600KB 时给出预期耗时提示
  if (kb > 600) {
    toast(`图片 ${kb}KB，上传中（约需 ${Math.ceil(kb / 40)} 秒）...`);
  } else {
    toast('图片上传中...');
  }
  const res = await api('/api/upload', { method: 'POST', body: { dataUrl, prefix } });
  return res.url;
}

/** 发送图片消息 */
$('imageInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!state.current) return toast('请先进入聊天', 'error');
  try {
    toast('图片上传中...');
    const url = await uploadImage(file, 'img');
    await sendMessage({ content: url, type: 'image' });
    toast('图片已发送', 'success');
  } catch (err) {
    toast(err.message || '图片发送失败', 'error');
  }
});

$('imageBtn').addEventListener('click', () => $('imageInput').click());

/** 添加自定义表情包 */
async function handleStickerFile(file) {
  if (!file) return;
  try {
    toast('表情包上传中...');
    const url = await uploadImage(file, 'sticker');
    await api('/api/stickers', { method: 'POST', body: { url, name: file.name.replace(/\.[^.]+$/, '') } });
    toast('表情包已添加', 'success');
    await loadStickers();
    switchEmojiTab('mine');
  } catch (err) {
    toast(err.message || '表情包添加失败', 'error');
  }
}

[$('stickerInput'), $('stickerInput2')].filter(Boolean).forEach((inp) => {
  inp.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    handleStickerFile(file);
  });
});

[$('addStickerBtn'), $('addStickerBtn2')].filter(Boolean).forEach((btn) => {
  btn.addEventListener('click', () => {
    const inp = btn.id === 'addStickerBtn' ? $('stickerInput') : $('stickerInput2');
    inp.click();
  });
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
      setTimeout(async () => {
        if (!state.token) return;
        // 重连前刷新一次配置，兼容隧道换址后 WS 仍指向旧地址
        await refreshRemoteConfig();
        connectWS();
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
    } else {
      // 不在当前会话 → 提醒（声音 + 桌面通知）
      notifyNewMessage(m);
    }
    refreshConversations();
    return;
  }

  if (action === 'friend_request') {
    toast(`${msg.data.from.nickname} 请求添加你为好友`);
    playNotificationSound();
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

  if (action === 'group_deleted') {
    toast(`群聊「${msg.data.groupName}」已被群主解散`, 'error');
    if (state.current && state.current.type === 'group' && state.current.targetId === msg.data.groupId) {
      state.current = null;
      showPage('conversationsPage', '微聊');
    }
    refreshGroups();
    refreshConversations();
    return;
  }

  if (action === 'profile_updated') {
    // 某人的资料变了：如果是我本人，同步本地状态
    if (state.user && msg.user.id === state.user.id) {
      state.user = { ...state.user, ...msg.user };
      renderMyAvatar();
    }
    refreshFriends();
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

/** 新消息提醒：提示音 + 桌面通知 */
function notifyNewMessage(m) {
  const me = state.user ? state.user.id : '';
  if (m.from === me) return;   // 自己发的消息不提醒

  const isGroup = m.toType === 'group';
  let title = '';
  let body = '';

  if (isGroup) {
    const g = state.groups.find((x) => x.id === m.toId);
    title = (g ? g.name : '群聊') + ' · ' + (m.fromName || '新消息');
    body = m.type === 'image' ? '[图片]' : m.type === 'sticker' ? '[表情包]' : (m.content || '');
  } else {
    title = m.fromName || '新消息';
    body = m.type === 'image' ? '[图片]' : m.type === 'sticker' ? '[表情包]' : (m.content || '');
  }

  playNotificationSound();
  showDesktopNotification(title, body);

  // 页面在前台时也弹一个轻提示
  if (document.visibilityState === 'visible' && document.hasFocus()) {
    toast(`${title}：${body.length > 20 ? body.slice(0, 20) + '…' : body}`);
  }
}

/* ==================== 启动 ==================== */
async function boot() {
  if (!state.token) { booting = false; return; }
  try {
    // 先尝试用当前地址，若失败则刷新一次配置（应对隧道换址）
    let res = null;
    try {
      res = await api('/api/auth/me');
    } catch (e) {
      if (await refreshRemoteConfig()) {
        res = await api('/api/auth/me');
      } else {
        throw e;
      }
    }
    state.user = res.user;
    showMain();
    connectWS();
    refreshAll();
    loadStickers();
    loadBuiltInStickers();
  } catch (err) {
    console.error('[boot] 启动失败', err);
    // 只有在页面启动时确实没有有效登录态才回到登录页；
    // 避免与注册/登录并发时把刚建立的会话踢掉
    if (!state.user) {
      if (isNetworkError(err)) {
        toast('后端服务暂时无法连接，请稍后重试', 'error');
      }
      logout(true);
    }
  } finally {
    booting = false;
  }
}
boot();
