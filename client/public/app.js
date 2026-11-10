/* ============================================================
 * 微聊 前端逻辑
 * - REST 登录态鉴权
 * - WebSocket 实时消息
 * - 单页视图切换
 * ============================================================ */

// 后端地址：优先 config.js 中的配置，否则同源
// 注意：API / WS_URL 使用 let，因为启动时还会异步刷新一次（绕过 Pages CDN 缓存）
const CFG = window.WL_CONFIG || {};

/**
 * 后端候选地址列表（按优先级）。
 * - config.js 里可以写 apiBases: [主地址, 备用地址...]
 * - 兼容旧写法 apiBase（单个地址）
 * 这样「正式服务器」当主地址、「本地隧道」当备用地址，
 * 主地址挂了自动切到备用，测试服务与生产服务互不影响。
 */
function normalizeApiBases(cfg) {
  const list = [];
  const push = (v) => {
    if (!v) return;
    const s = String(v).trim().replace(/\/$/, '');
    if (s && !list.includes(s)) list.push(s);
  };
  if (Array.isArray(cfg.apiBases)) cfg.apiBases.forEach(push);
  push(cfg.apiBase);
  return list;
}

let API_CANDIDATES = normalizeApiBases(CFG);
let API_INDEX = 0;
let API = API_CANDIDATES[0] || '';

function deriveWsUrl(base) {
  if (!base) {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }
  return (base.startsWith('https') ? 'wss://' : 'ws://') + base.replace(/^https?:\/\//, '') + '/ws';
}

let WS_URL = CFG.wsBase
  || (API
    ? (API.startsWith('https') ? 'wss://' : 'ws://') + API.replace(/^https?:\/\//, '') + '/ws'
    : (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');

/** 当前生效的后端（同步用） */
function currentApiBase() {
  return API_CANDIDATES[API_INDEX] || '';
}

/** 切换到下一个可用后端；没有更多候选时返回 false */
function rotateApiBase() {
  if (API_INDEX + 1 >= API_CANDIDATES.length) return false;
  API_INDEX += 1;
  API = API_CANDIDATES[API_INDEX];
  WS_URL = deriveWsUrl(API);
  console.warn('[api] 切换后端 ->', API);
  return true;
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

    // 解析候选列表 apiBases: ['a', 'b']
    const listMatch = text.match(/apiBases\s*:\s*\[([^\]]*)\]/);
    let candidates = [];
    if (listMatch) {
      candidates = listMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, '').replace(/\/$/, ''))
        .filter(Boolean);
    }
    if (!candidates.length) candidates = [newApi];
    if (!candidates.includes(newApi)) candidates.unshift(newApi);

    const changed = candidates.join('|') !== API_CANDIDATES.join('|');
    if (!changed) return false;

    console.log('[config] 后端地址变更:', API_CANDIDATES.join(' , '), '->', candidates.join(' , '));
    API_CANDIDATES = candidates;
    // 优先保持当前正在工作的后端（若还在候选列表里）
    const keep = API_CANDIDATES.indexOf(API);
    API_INDEX = keep >= 0 ? keep : 0;
    API = API_CANDIDATES[API_INDEX];
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
  // E2EE 初始化的 promise（发送消息前需等待，避免竞态发明文）
  e2eeInitPromise: null,
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

/** 底部「微信」标签的未读红点 */
function updateTabBadge() {
  const dot = $('tabUnreadDot');
  if (!dot) return;
  const n = state.unreadTotal;
  dot.classList.toggle('hidden', n <= 0);
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
    // 必须走 mediaUrl：后端返回的是 /uploads/xxx 相对路径，
    // 直接用会解析到 Pages 站点根目录导致 404（头像裂图）
    return `<div class="avatar ${cls}" style="${style}"><img src="${escapeHtml(mediaUrl(avatarUrl))}" alt="" loading="lazy" /></div>`;
  }
  return `<div class="avatar ${cls}" style="${style}">${escapeHtml(initial(name))}</div>`;
}

/**
 * 上传地址补全（后端返回 /uploads/xxx 相对路径）
 * @deprecated 已被 mediaUrl 取代，保留兼容旧调用
 */
function absUrl(u) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u) || u.startsWith('data:')) return u;
  return API + u;
}

/**
 * 媒体资源地址补全（图片 / 表情包）。
 * - 绝对地址、dataURL：原样返回
 * - /uploads/xxx：用户上传的文件，走后端
 * - stickers/xxx、icons/xxx：前端静态资源，随前端站点走
 */
function mediaUrl(u) {
  if (!u) return '';
  if (/^(https?:)?\/\//i.test(u) || u.startsWith('data:')) return u;
  if (u.startsWith('/')) return API + u;
  // 相对路径：优先当作前端静态资源
  return assetUrl(u);
}

/**
 * 前端静态资源地址补全。
 * 表情包等资源由 GitHub Pages（或后端）提供，用相对路径会在
 * 路径带前缀的站点（/weiliao/）下解析错位，这里统一基于当前页面目录补全。
 */
function assetUrl(u) {
  if (!u) return '';
  if (/^(https?:)?\/\//i.test(u) || u.startsWith('data:')) return u;
  if (u.startsWith('/')) {
    // 绝对路径：取站点根（Pages 部署在 /weiliao/ 子路径时需要回退到根再拼）
    const root = location.pathname.replace(/\/[^/]*$/, '/');
    return new URL(u, location.origin + root).href;
  }
  return new URL(u, document.baseURI).href;
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

  const send = (base) => fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  let res;
  try {
    res = await send(API);
  } catch (e) {
    // 主后端连不上：依次尝试备用后端
    console.warn('[api] 连接失败，尝试切换后端', path);
    let ok = false;
    // 1) 先刷新一次远程配置（隧道地址可能已变更）
    if (await refreshRemoteConfig()) {
      try {
        res = await send(currentApiBase());
        ok = true;
      } catch { /* 继续尝试备用 */ }
    }
    // 2) 再轮换候选后端
    while (!ok && rotateApiBase()) {
      try {
        res = await send(currentApiBase());
        ok = true;
      } catch { /* 试下一个 */ }
    }
    if (!ok) throw new Error('无法连接服务器，请检查网络或稍后重试');
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
  const password = $('loginPassword').value;
  try {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { username: $('loginUsername').value.trim(), password }
    });
    onLogin(res);
    // 端到端加密：用同一密码解锁本机私钥
    initE2EE(res, password);
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
    // 端到端加密：为新账号生成身份密钥
    initE2EE(res, password);
    toast('注册成功', 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '注 册';
  }
});

/* ============================================================
   端到端加密（E2EE）集成层
   ------------------------------------------------------------
   与 e2ee.js 配合：
   - 登录后用密码解锁本机私钥（私钥密文存在服务端，密码解不开就废）
   - 发送前加密，收到后解密，服务端全程只见密文
   ============================================================ */

/**
 * E2EE 是否启用（本地开关，存在 localStorage）。
 * 默认开启（opt-out）：只有用户主动关闭才走明文。
 * 这样绝大多数用户默认就享有端到端加密。
 */
function e2eeEnabled() {
  const v = localStorage.getItem('wl_e2ee');
  // 没有任何记录 → 视为开启
  if (v === null || v === undefined) return true;
  return v === '1';
}

/** 开启 / 关闭 E2EE */
function setE2eeEnabled(on) {
  localStorage.setItem('wl_e2ee', on ? '1' : '0');
  window.WL_E2EE_READY = false;
  if (!on && window.E2EE) window.E2EE.lock();
}

/**
 * 登录后初始化 E2EE。
 * @param {object} res 登录/注册响应
 * @param {string} password 明文密码（仅本地使用，不上传）
 */
async function initE2EE(res, password) {
  const p = (async () => {
    if (!window.E2EE) return;
    if (!e2eeEnabled()) {
      window.WL_E2EE_READY = false;
      return;
    }
    try {
      // 取回自己的私钥密文
      const cres = await api('/api/crypto/me');
      const c = cres.crypto || {};

      // 首次登录或密钥缺失 → 生成新身份
      if (!c.cryptoEncPrivate || !c.cryptoSigPrivate) {
        await window.E2EE.setupIdentity(api, res.user, password);
        toast('已为你的账号生成加密密钥', 'success');
      } else {
        const u = await window.E2EE.unlock(
          { ...c, username: res.user.username },
          password
        );
        if (u.needSetup) {
          await window.E2EE.setupIdentity(api, res.user, password);
        }
      }

      // 缓存自己的公钥（发消息时 encryptMessage 需要用到）
      const me = await api('/api/auth/me');
      window.E2EE.cachePeerKeys([
        {
          id: me.user.id,
          cryptoPublicKey: me.user.cryptoPublicKey,
          cryptoSigPublicKey: me.user.cryptoSigPublicKey
        }
      ]);

      window.WL_E2EE_READY = true;
      await refreshPeerKeys();
      updateChatE2eeWarn();
    } catch (e) {
      // 最常见原因：管理员重置过密码 → 私钥密文解不开
      console.warn('[e2ee] 初始化失败，本次会话以明文模式运行', e);
      window.WL_E2EE_READY = false;
      const isKeyProblem = /operation failed|decrypt|OperationError/i.test(String(e && e.message));
      updateChatE2eeWarn();
      toast(
        isKeyProblem
          ? '端到端加密解锁失败（密码可能已被重置）。为保证安全，本次会话按明文模式运行。'
          : '端到端加密初始化失败，将以普通模式聊天',
        'error'
      );
    }
  })();
  // 暴露 promise，让发送流程能等待初始化完成，避免竞态发明文
  state.e2eeInitPromise = p;
  return p;
}

/** 拉取好友与群成员的公钥并缓存 */
async function refreshPeerKeys() {
  if (!window.E2EE || !e2eeEnabled()) return;
  try {
    const ids = new Set();
    for (const f of state.friends || []) ids.add(f.peer.id);
    for (const g of state.groups || []) {
      for (const m of g.members || []) ids.add(m.id);
    }
    if (state.user) ids.add(state.user.id);
    if (!ids.size) return;
    const res = await api('/api/crypto/keys?ids=' + [...ids].join(','));
    window.E2EE.cachePeerKeys(res.keys || []);
    // 对方公钥可能刚生成 → 刷新警示条
    updateChatE2eeWarn();
  } catch (e) {
    console.warn('[e2ee] 拉取公钥失败', e);
  }
}

/**
 * 取当前会话的接收者列表（含自己，保证历史消息自己也能看）。
 */
function recipientsOfConversation() {
  const cur = state.current;
  if (!cur) return [];
  const ids = new Set([state.user.id]);
  if (cur.type === 'group') {
    const g = state.groups.find((x) => x.id === cur.targetId);
    if (g) for (const m of g.members || []) ids.add(m.id);
    else ids.add(cur.targetId);
  } else {
    ids.add(cur.targetId);
  }
  return [...ids];
}

/**
 * 更新聊天页顶部的「未加密」常驻警示条。
 * 让用户永远知道当前会话是不是加密的，避免静默降级。
 */
function updateChatE2eeWarn() {
  const bar = $('chatE2eeWarn');
  const txt = $('chatE2eeWarnText');
  if (!bar || !txt) return;
  const cur = state.current;

  let reason = '';
  if (!window.E2EE || !e2eeEnabled()) {
    reason = '端到端加密已关闭，本会话消息将以明文传输';
  } else if (!window.WL_E2EE_READY) {
    reason = '端到端加密未解锁，本会话消息将以明文传输（请重新登录或解锁私钥）';
  } else if (cur) {
    // 检查会话成员是否都有公钥
    const missing = recipientsOfConversation()
      .filter((id) => id !== state.user.id)
      .filter((id) => {
        const k = window.E2EE.peerKeysOf && window.E2EE.peerKeysOf(id);
        return !k || !k.publicKey;
      });
    if (missing.length) {
      reason = '对方尚未生成加密密钥，本会话消息将以明文传输';
    }
  }

  if (reason) {
    txt.textContent = reason;
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}

/**
 * 加密一条消息（若已启用 E2EE）。
 * @returns {Promise<{cipher:boolean, content:string, fileIv?:string, fileKey?:Uint8Array}>}
 */
async function encryptOutgoing({ content, type, fileKey, fileIv }) {
  const cur = state.current;
  if (!window.E2EE || !e2eeEnabled()) {
    return { cipher: false, content, fileIv: fileIv || '' };
  }
  // 等待 E2EE 初始化完成（登录后是异步的，避免竞态发明文）
  if (state.e2eeInitPromise) {
    try { await state.e2eeInitPromise; } catch { /* ignore */ }
  }
  if (!window.WL_E2EE_READY) {
    // 私钥解锁失败 → 明确告知，绝不静默发明文
    toast('端到端加密未就绪，本条消息将以明文发送（请在「我 → 端到端加密」检查）', 'error');
    return { cipher: false, content, fileIv: fileIv || '' };
  }
  const recipients = recipientsOfConversation();
  let res = await window.E2EE.encryptMessage({
    content,
    type,
    conversationId: cur.conversationId,
    senderId: state.user.id,
    recipients,
    fileKey
  });

  // 对方公钥可能刚生成（对方刚登录），先强制刷新一次再判定失败
  if (!res.ok) {
    await refreshPeerKeys();
    res = await window.E2EE.encryptMessage({
      content,
      type,
      conversationId: cur.conversationId,
      senderId: state.user.id,
      recipients,
      fileKey
    });
  }

  if (!res.ok) {
    // 缺少对方公钥 → 降级为明文发送，但明确告知用户（绝不静默降级）
    const who = recipients.filter((id) => id !== state.user.id).join('、');
    toast(
      '对方（' + (who || '该会话成员') + '）尚未生成加密密钥，本条消息以明文发送。' +
      '请让对方登录一次以启用加密。',
      'error'
    );
    console.warn('[e2ee] 加密失败，降级明文:', res.reason);
    return { cipher: false, content, fileIv: fileIv || '' };
  }
  return { cipher: true, content: JSON.stringify(res.payload), fileIv: fileIv || '' };
}

/**
 * 解密一条收到的消息。
 * @returns {Promise<{content:string, type:string, fileKey:Uint8Array|null, cipher:boolean}>}
 */
async function decryptIncoming(m) {
  if (!m.cipher) {
    return { content: m.content, type: m.type, fileKey: null, cipher: false };
  }
  if (!window.E2EE || !window.WL_E2EE_READY) {
    return { content: '🔒（请重新登录以解密此消息）', type: 'text', fileKey: null, cipher: true };
  }
  try {
    const payload = JSON.parse(m.content);
    // 找发送者的签名公钥
    const senderKey = window.E2EE.peerKeysOf(m.from);
    const res = await window.E2EE.decryptMessage(
      payload,
      m.conversationId,
      m.from,
      state.user.id,
      senderKey ? senderKey.sigPublicKey : ''
    );
    if (!res.ok) {
      return { content: '⚠️（消息解密失败）', type: 'text', fileKey: null, cipher: true };
    }
    return { content: res.content, type: res.type, fileKey: res.fileKey, cipher: true };
  } catch (e) {
    return { content: '⚠️（消息格式异常）', type: 'text', fileKey: null, cipher: true };
  }
}

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
  state.e2eeInitPromise = null;
  window.WL_E2EE_READY = false;
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
  showPage('profilePanel', '我');
  setActiveTab('me');
}

/** 「我」标签页刷新 */
function refreshProfile() {
  if (!state.user) return;
  $('profileNickname').value = state.user.nickname || '';
  renderColorRow();
  renderMyStickers();
  refreshE2eeStatus();
}

/** 刷新端到端加密状态显示 */
function refreshE2eeStatus() {
  const toggle = $('e2eeToggle');
  const status = $('e2eeStatus');
  const sub = $('e2eeSubStatus');
  if (toggle) toggle.checked = e2eeEnabled();
  if (!status) return;
  if (!e2eeEnabled()) {
    status.textContent = '未启用（消息以普通方式传输）';
  } else if (window.WL_E2EE_READY) {
    status.textContent = '已启用，聊天内容在传输前加密，服务端无法读取明文';
  } else {
    status.textContent = '已启用但未解锁，请重新登录以解密消息';
  }
  if (sub) {
    sub.textContent = e2eeEnabled()
      ? '聊天内容在传输前加密，服务端无法读取明文'
      : '关闭后消息将以未加密方式传输';
  }
}

/** 端到端加密开关 */
$('e2eeToggle')?.addEventListener('change', async (e) => {
  const on = e.target.checked;
  setE2eeEnabled(on);
  if (on) {
    toast('端到端加密已开启，正在初始化密钥…');
    // 需要密码解锁，这里提示用户重新登录以完成解锁
    openModal({
      title: '开启端到端加密',
      bodyHtml: '<div>端到端加密需要用你的密码解锁本机私钥。请重新登录一次以完成设置。</div>',
      okText: '去登录',
      cancelText: '稍后',
      onOk: () => {
        logout(true);
        toast('请重新登录以完成加密设置');
        return true;
      }
    });
  } else {
    toast('端到端加密已关闭', 'success');
  }
  refreshE2eeStatus();
});

/** 「发现」标签页刷新 */
function refreshDiscover() {
  refreshE2eeStatus();
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
    ? `<img src="${escapeHtml(mediaUrl(u.avatar))}" alt="" />`
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

const PAGES = ['conversationsPage', 'friendsPanel', 'groupsPanel', 'chatPage', 'adminPanel', 'profilePanel', 'discoverPanel'];

/** 底部标签栏与页面的对应关系 */
const TAB_PAGES = {
  chats: 'conversationsPage',
  contacts: 'friendsPanel',
  discover: 'discoverPanel',
  me: 'profilePanel'
};
const TAB_TITLES = {
  chats: '微信',
  contacts: '通讯录',
  discover: '发现',
  me: '我'
};

/** 当前激活的底部标签 */
let activeTab = 'chats';

function showPage(pageId, title) {
  PAGES.forEach((p) => $(p).classList.toggle('hidden', p !== pageId));
  $('pageTitle').textContent = title || '微聊';
  $('backBtn').classList.toggle('hidden', pageId === 'conversationsPage');
  if (pageId !== 'chatPage') $('emojiPanel').classList.add('hidden');
  // 聊天页隐藏底部标签栏（微信进入会话后不显示标签）
  const inChat = pageId === 'chatPage';
  $('tabBar').classList.toggle('hidden', inChat);
  $('chatMenuBtn').classList.toggle('hidden', !inChat);
  // 同步底部标签高亮
  const tab = Object.keys(TAB_PAGES).find((k) => TAB_PAGES[k] === pageId);
  if (tab) setActiveTab(tab);
  window.scrollTo(0, 0);
}

/** 设置底部标签高亮 */
function setActiveTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  $('pageTitle').textContent = TAB_TITLES[tab] || '微聊';
}

/** 切换到底部某个标签 */
function switchTab(tab) {
  if (!TAB_PAGES[tab]) return;
  state.current = null;
  const pageId = TAB_PAGES[tab];
  showPage(pageId, TAB_TITLES[tab]);
  setActiveTab(tab);
  if (tab === 'chats') refreshConversations();
  if (tab === 'contacts') refreshFriends();
  if (tab === 'discover') refreshDiscover();
  if (tab === 'me') refreshProfile();
}

document.querySelectorAll('.tab-item').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

$('backBtn').addEventListener('click', () => {
  if (!$('chatPage').classList.contains('hidden')) {
    state.current = null;
    showPage('conversationsPage', '微信');
    setActiveTab('chats');
    refreshConversations();
  } else {
    showPage('conversationsPage', '微信');
    setActiveTab('chats');
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
    // 好友公钥更新（E2EE 需要）
    refreshPeerKeys();
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
    // 群成员公钥更新（E2EE 需要）
    refreshPeerKeys();
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
    <button class="conv-item ${c.pinned ? 'is-pinned' : ''}" data-conv="${escapeHtml(c.conversationId)}" data-type="${c.type}" data-target="${escapeHtml(c.targetId)}">
      <span class="conv-avatar-wrap" data-act="profile">
        ${avatarHtml(c.title, c.avatarColor, c.avatar || '')}
      </span>
      <div class="conv-main">
        <div class="conv-top">
          <div class="conv-title">
            ${c.pinned ? '<span class="conv-pin">📌</span>' : ''}
            ${c.muted ? '<span class="conv-mute">🔕</span>' : ''}
            ${escapeHtml(c.title)}
          </div>
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
    el.addEventListener('click', (e) => {
      // 点击头像 → 打开个人资料卡；点击其他区域 → 进入聊天
      if (e.target.closest('[data-act="profile"]')) {
        e.stopPropagation();
        openConvProfile(el.dataset.type, el.dataset.target);
        return;
      }
      openChat(el.dataset.type, el.dataset.target, el.querySelector('.conv-title').textContent.trim());
    });
  });

  // 汇总未读数 → 标题角标
  state.unreadTotal = list.reduce((s, c) => s + (c.unread || 0), 0);
  updateTitleBadge();
  updateTabBadge();
}

/** 从会话列表打开个人资料卡 */
function openConvProfile(type, targetId) {
  if (type === 'group') {
    const g = state.groups.find((x) => x.id === targetId);
    if (!g) return;
    openProfileCard({
      id: g.id,
      username: 'group_' + g.id,
      nickname: g.name,
      avatarColor: g.avatarColor,
      avatar: g.avatar || '',
      createdAt: g.createdAt
    }, {
      isFriend: false,
      extraFacts: [['群成员', g.memberCount + ' 人'], ['群主', g.ownerId === state.user.id ? '我' : (g.members.find((m) => m.isOwner)?.nickname || '—')]],
      extraActionText: '群成员',
      onCloseAction: () => showGroupMembers(g.id)
    });
    return;
  }
  const f = state.friends.find((x) => x.peer.id === targetId);
  const peer = f ? f.peer : null;
  if (!peer) {
    toast('对方资料暂不可用', 'error');
    return;
  }
  openProfileCard(peer, {
    isFriend: true,
    onMessage: () => openChat('dm', peer.id, peer.nickname || peer.username)
  });
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

/** 当前聊天设置（免打扰 / 置顶 / 背景） */
let chatSettings = { muted: false, pinned: false, background: '' };

async function openChat(type, targetId, title) {
  // 单聊时把对方资料存进 current，供聊天信息面板使用
  const peer = type === 'dm'
    ? (state.friends.find((x) => x.peer.id === targetId)?.peer || null)
    : null;
  state.current = { type, targetId, title, peer };
  showPage('chatPage', title);
  $('chatBody').innerHTML = '';
  state.messages = [];

  const convId = type === 'group' ? 'group:' + targetId : dmId(state.user.id, targetId);
  state.current.conversationId = convId;

  // 读取并应用聊天设置（背景）
  try {
    const sres = await api('/api/chat/settings?conversationId=' + encodeURIComponent(convId));
    chatSettings = sres.settings || { muted: false, pinned: false, background: '' };
  } catch (e) {
    chatSettings = { muted: false, pinned: false, background: '' };
  }
  applyChatBackground(chatSettings.background);

  try {
    const res = await api('/api/messages?conversationId=' + encodeURIComponent(convId));
    state.messages = res.messages || [];
    renderMessages();
    api('/api/messages/read', { method: 'POST', body: { conversationId: convId } }).catch(() => {});
    refreshConversations();
  } catch (e) {
    toast(e.message, 'error');
  }

  // 更新「未加密」警示条
  updateChatE2eeWarn();
}

/** 警示条上的「去开启」按钮 → 跳到 E2EE 设置 */
$('chatE2eeFixBtn')?.addEventListener('click', () => {
  switchTab('me');
  // 「我」页面里滚到端到端加密开关
  setTimeout(() => {
    const t = $('e2eeToggle');
    if (t && t.scrollIntoView) t.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 120);
});

function dmId(a, b) {
  const ids = [a, b].sort();
  return 'dm:' + ids[0] + ':' + ids[1];
}

function renderMessages() {
  const box = $('chatBody');
  const me = state.user.id;

  // 先用占位渲染（加密消息显示解密中），随后异步解密并替换
  box.innerHTML = state.messages.map((m) => {
    const mine = m.from === me;
    const avatar = avatarHtml(m.fromName, avatarColorOf(m.from), avatarUrlOf(m.from), 'msg-avatar');
    const placeholder = m.cipher ? '<span class="msg-decrypting">🔒 解密中…</span>' : '';

    return `
      <div class="msg-row ${mine ? 'mine' : ''}" data-msg-id="${escapeHtml(m.id)}">
        <span class="msg-avatar-wrap" data-msg-user="${escapeHtml(m.from)}" title="查看资料">
          ${avatar}
        </span>
        <div class="msg-col">
          ${!mine ? `<div class="msg-sender">${escapeHtml(m.fromName)}</div>` : ''}
          <div class="msg-bubble" data-bubble>${placeholder}</div>
          <div class="msg-time">${formatTime(m.createdAt)}</div>
        </div>
      </div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;

  // 点击消息头像 → 查看资料卡
  box.querySelectorAll('[data-msg-user]').forEach((el) => {
    el.addEventListener('click', () => openUserProfileById(el.dataset.msgUser));
  });

  // 异步解密并填充气泡
  decryptAndFill(box);
}

/**
 * 解密消息并填充到气泡里。
 */
async function decryptAndFill(box) {
  for (const m of state.messages) {
    const row = box.querySelector(`[data-msg-id="${CSS.escape(m.id)}"]`);
    if (!row) continue;
    const bubble = row.querySelector('[data-bubble]');
    if (!bubble) continue;

    let content = m.content;
    let type = m.type;
    let fileKey = null;

    if (m.cipher) {
      const d = await decryptIncoming(m);
      content = d.content;
      type = d.type;
      fileKey = d.fileKey;
    }

    let bubbleInner = '';
    let bubbleCls = 'msg-bubble';
    if (type === 'image') {
      bubbleCls += ' msg-image';
      bubbleInner = await renderMediaContent(content, fileKey, m.fileIv, '图片');
    } else if (type === 'sticker') {
      bubbleCls += ' msg-sticker';
      bubbleInner = await renderMediaContent(content, fileKey, m.fileIv, '表情包');
    } else {
      bubbleInner = escapeHtml(content);
    }
    if (type === 'emoji') bubbleCls += ' emoji-msg';

    bubble.className = bubbleCls;
    bubble.innerHTML = bubbleInner;
  }
}

/**
 * 渲染图片 / 表情包内容。
 * 加密消息需要用 fileKey 解密密文后再转成 blob URL。
 */
async function renderMediaContent(content, fileKey, fileIv, alt) {
  if (fileKey && window.E2EE) {
    try {
      const url = content;
      const res = await fetch(mediaUrl(url));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const encBytes = new Uint8Array(await res.arrayBuffer());
      const plain = await window.E2EE.decryptFile(encBytes, fileKey, fileIv);
      const blob = new Blob([plain], { type: 'application/octet-stream' });
      const objUrl = URL.createObjectURL(blob);
      return `<img src="${objUrl}" alt="${escapeHtml(alt)}" />`;
    } catch (e) {
      console.warn('[e2ee] 图片解密失败', e);
      return '<span class="msg-decrypting">⚠️ 图片解密失败</span>';
    }
  }
  return `<img src="${escapeHtml(mediaUrl(content))}" alt="${escapeHtml(alt)}" loading="lazy" />`;
}

/** 按用户 ID 打开个人资料卡 */
function openUserProfileById(userId) {
  if (!userId) return;
  if (userId === state.user.id) {
    openProfileCard(state.user, { isSelf: true });
    return;
  }
  const f = state.friends.find((x) => x.peer.id === userId);
  if (f) {
    openProfileCard(f.peer, {
      isFriend: true,
      onMessage: () => openChat('dm', f.peer.id, f.peer.nickname || f.peer.username)
    });
    return;
  }
  // 群成员：从群列表里找
  for (const g of state.groups) {
    const m = g.members.find((x) => x.id === userId);
    if (m) {
      openProfileCard(m, {
        isFriend: false,
        onMessage: () => openChat('dm', m.id, m.nickname || m.username)
      });
      return;
    }
  }
  toast('对方资料暂不可用', 'error');
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
async function sendMessage({ content, type = 'text', fileKey = null, fileIv = '' } = {}) {
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
    // 端到端加密：先加密再发送
    const enc = await encryptOutgoing({ content: text, type: msgType, fileKey, fileIv });
    const body = {
      toType: state.current.type,
      toId: state.current.targetId,
      content: enc.content,
      type: msgType
    };
    if (enc.cipher) body.cipher = 1;
    if (enc.fileIv) body.fileIv = enc.fileIv;

    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({
        action: 'send_message',
        ...body
      }));
    } else {
      const res = await api('/api/messages', { method: 'POST', body });
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
      <img src="${escapeHtml(assetUrl(s.url))}" alt="${escapeHtml(s.name)}" loading="lazy" />
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
async function renderMyStickers() {
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
        <img src="${escapeHtml(mediaUrl(s.url))}" alt="" loading="lazy" />
        <span class="sticker-del" data-del-sticker="${escapeHtml(s.id)}">×</span>
      </button>
    `).join('');

    box.querySelectorAll('[data-mine-sticker]').forEach((b) => {
      b.addEventListener('click', async (e) => {
        if (e.target.dataset.delSticker) return; // 点删除按钮不发送
        await sendSticker(b);
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

    // 加密表情包：异步解密图片并替换 src（服务端存的是密文）
    state.stickers.forEach((s) => {
      if (!s.fileKeyCt) return;
      const el = box.querySelector(`[data-id="${CSS.escape(s.id)}"] img`);
      if (!el) return;
      decryptStickerImage(s)
        .then((objUrl) => { if (objUrl) el.src = objUrl; })
        .catch(() => {
          el.replaceWith(Object.assign(document.createElement('span'), {
            className: 'row-sub', textContent: '🔒'
          }));
        });
    });
  });
}

/** 解密加密表情包，返回 blob URL */
async function decryptStickerImage(s) {
  if (!window.E2EE || !s.fileKeyCt) return null;
  const unwrapped = await window.E2EE.unwrapFileKey(s.fileKeyIv, s.fileKeyCt);
  if (unwrapped.error) return null;
  const res = await fetch(mediaUrl(s.url));
  if (!res.ok) return null;
  const encBytes = new Uint8Array(await res.arrayBuffer());
  const plain = await window.E2EE.decryptFile(encBytes, unwrapped.fileKey, s.fileIv);
  const blob = new Blob([plain], { type: 'application/octet-stream' });
  return URL.createObjectURL(blob);
}

/** 发送一张自定义表情包（加密的走 fileKey 加密通道） */
async function sendSticker(btn) {
  const id = btn.dataset.id;
  const s = state.stickers.find((x) => x.id === id);
  if (!s) return;
  if (s.fileKeyCt && window.E2EE && window.WL_E2EE_READY) {
    // 加密表情包：把 fileKey 随消息加密传给接收方
    const unwrapped = await window.E2EE.unwrapFileKey(s.fileKeyIv, s.fileKeyCt);
    if (!unwrapped.error) {
      await sendMessage({ content: s.url, type: 'sticker', fileKey: unwrapped.fileKey, fileIv: s.fileIv });
      return;
    }
  }
  await sendMessage({ content: s.url, type: 'sticker' });
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
    // 用 assetUrl 补全，避免站点挂在 /weiliao/ 子路径下时解析错位
    const res = await fetch(assetUrl('stickers/manifest.json'), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const list = await res.json();
    // 保留原始相对路径，渲染时再补全（避免把绝对地址写进历史消息）
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

/**
 * 上传加密后的图片（端到端加密模式）。
 * 服务端存的是密文，无法还原成图片。
 * @returns {Promise<{url:string, fileKey:Uint8Array, fileIv:string}>}
 */
async function uploadEncryptedImage(file) {
  const dataUrl = await readImageFile(file);
  // dataURL -> 原始字节
  const b64 = dataUrl.split(',')[1] || '';
  const raw = window.E2EE.b64ToBytes(b64);

  const fileKey = window.E2EE.newFileKey();
  const enc = await window.E2EE.encryptFile(raw, fileKey);

  toast('图片加密中并上传...');
  const res = await api('/api/upload/enc', {
    method: 'POST',
    body: { data: window.E2EE.bytesToB64(enc.bytes) }
  });
  return { url: res.url, fileKey, fileIv: enc.iv };
}

/** 发送图片消息 */
$('imageInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!state.current) return toast('请先进入聊天', 'error');
  try {
    if (e2eeEnabled() && window.WL_E2EE_READY && window.E2EE) {
      // 加密模式：先加密文件再上传，fileKey 随消息加密传递
      const up = await uploadEncryptedImage(file);
      await sendMessage({ content: up.url, type: 'image', fileKey: up.fileKey, fileIv: up.fileIv });
    } else {
      toast('图片上传中...');
      const url = await uploadImage(file, 'img');
      await sendMessage({ content: url, type: 'image' });
    }
    toast('图片已发送', 'success');
  } catch (err) {
    toast(err.message || '图片发送失败', 'error');
  }
});

$('imageBtn').addEventListener('click', () => $('imageInput').click());

/**
 * 添加自定义表情包。
 * 加密模式下：图片先在本地加密再上传，fileKey 用 KEK 包裹后随记录存储，
 * 服务器只保存密文图片 + 密文 fileKey，无法还原。
 */
async function handleStickerFile(file) {
  if (!file) return;
  try {
    const useEnc = e2eeEnabled() && window.E2EE && window.WL_E2EE_READY;
    if (useEnc) {
      toast('表情包加密中并上传...');
      const dataUrl = await readImageFile(file);
      const b64 = dataUrl.split(',')[1] || '';
      const raw = window.E2EE.b64ToBytes(b64);
      const fileKey = window.E2EE.newFileKey();
      const enc = await window.E2EE.encryptFile(raw, fileKey);
      const up = await api('/api/upload/enc', {
        method: 'POST',
        body: { data: window.E2EE.bytesToB64(enc.bytes) }
      });
      // fileKey 用 KEK 包裹后存储
      const wrapped = await window.E2EE.wrapFileKey(fileKey);
      if (wrapped.error) throw new Error(wrapped.error);
      await api('/api/stickers', {
        method: 'POST',
        body: {
          url: up.url,
          name: file.name.replace(/\.[^.]+$/, ''),
          fileKeyIv: wrapped.keyIv,
          fileKeyCt: wrapped.keyCt,
          fileIv: enc.iv
        }
      });
    } else {
      toast('表情包上传中...');
      const url = await uploadImage(file, 'sticker');
      await api('/api/stickers', { method: 'POST', body: { url, name: file.name.replace(/\.[^.]+$/, '') } });
    }
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

/* ============================================================
   「发现」页面按钮
   ============================================================ */
$('discoverStickers')?.addEventListener('click', () => {
  switchTab('me');
  toast('在「我 → 我的表情包」中管理');
});

$('discoverGroups')?.addEventListener('click', () => {
  switchTab('chats');
  showPage('groupsPanel', '我的群聊');
  refreshGroups();
});

/* ============================================================
   微信风格：个人资料卡（点击头像查看）
   ============================================================ */

/**
 * 打开个人资料卡
 * @param {object} user 用户对象 { id, username, nickname, avatarColor, avatar, isAdmin, createdAt }
 * @param {object} opts { isSelf, onMessage }
 */
function openProfileCard(user, opts = {}) {
  if (!user) return;
  const u = user;
  const color = u.avatarColor || '#2b6de8';
  const avatarInner = u.avatar
    ? `<img src="${escapeHtml(mediaUrl(u.avatar))}" alt="" />`
    : escapeHtml(initial(u.nickname || u.username));

  const tags = [];
  if (u.isAdmin) tags.push('<span class="pcard-tag">管理员</span>');
  if (opts.isSelf) tags.push('<span class="pcard-tag tag-gray">这是我自己</span>');
  else if (u.isFriend) tags.push('<span class="pcard-tag tag-green">已是好友</span>');

  const facts = [];
  facts.push(['昵称', u.nickname || u.username]);
  facts.push(['账号', '@' + u.username]);
  if (u.createdAt) facts.push(['注册时间', new Date(Number(u.createdAt)).toLocaleString('zh-CN')]);
  if (opts.isSelf && u.lastLoginAt) facts.push(['最后登录', new Date(Number(u.lastLoginAt)).toLocaleString('zh-CN')]);
  if (opts.extraFacts) facts.push(...opts.extraFacts);

  const actions = [];
  if (opts.isSelf) {
    actions.push('<button class="btn btn-primary" id="pcardEdit">编辑资料</button>');
  } else if (opts.onMessage) {
    actions.push('<button class="btn btn-primary" id="pcardMsg">发消息</button>');
  }
  if (opts.onDelete) {
    actions.push('<button class="btn btn-danger" id="pcardDel">删除</button>');
  }
  if (opts.onCloseAction) {
    actions.push(`<button class="btn" id="pcardExtra">${escapeHtml(opts.extraActionText || '更多')}</button>`);
  }

  $('profileCardSheet').innerHTML = `
    <div class="pcard">
      <div class="pcard-avatar" style="background:${escapeHtml(color)}">${avatarInner}</div>
      <div class="pcard-name">${escapeHtml(u.nickname || u.username)}</div>
      <div class="pcard-account">@${escapeHtml(u.username)}</div>
      ${tags.length ? `<div class="pcard-tags">${tags.join('')}</div>` : ''}
      <div class="pcard-facts">
        ${facts.map(([k, v]) => `
          <div class="pcard-fact">
            <span class="pcard-fact-k">${escapeHtml(k)}</span>
            <span class="pcard-fact-v">${escapeHtml(String(v))}</span>
          </div>`).join('')}
      </div>
      ${actions.length ? `<div class="pcard-actions">${actions.join('')}</div>` : ''}
    </div>`;

  $('profileCardMask').classList.remove('hidden');

  const close = () => $('profileCardMask').classList.add('hidden');
  const editBtn = $('pcardEdit');
  if (editBtn) editBtn.addEventListener('click', () => { close(); switchTab('me'); });
  const msgBtn = $('pcardMsg');
  if (msgBtn) msgBtn.addEventListener('click', () => { close(); opts.onMessage(); });
  const delBtn = $('pcardDel');
  if (delBtn) delBtn.addEventListener('click', () => { close(); opts.onDelete(); });
  const extraBtn = $('pcardExtra');
  if (extraBtn) extraBtn.addEventListener('click', () => { close(); opts.onCloseAction(); });
}

$('profileCardMask').addEventListener('click', (e) => {
  if (e.target === $('profileCardMask')) $('profileCardMask').classList.add('hidden');
});

/* ============================================================
   微信风格：聊天信息面板（左上角三个点）
   ============================================================ */

/** 打开聊天信息面板 */
async function openChatSheet() {
  const cur = state.current;
  if (!cur) return;
  const convId = cur.conversationId;

  // 读取设置
  try {
    const res = await api('/api/chat/settings?conversationId=' + encodeURIComponent(convId));
    chatSettings = res.settings || { muted: false, pinned: false, background: '' };
  } catch (e) {
    console.warn('[chat] 读取聊天设置失败', e);
  }

  // 标题与头像
  let title = cur.title || '聊天';
  let color = '#2b6de8';
  let avatarInner = escapeHtml(initial(title));
  const peer = cur.peer;
  if (cur.type === 'dm' && peer) {
    color = peer.avatarColor || '#2b6de8';
    avatarInner = peer.avatar
      ? `<img src="${escapeHtml(mediaUrl(peer.avatar))}" alt="" />`
      : escapeHtml(initial(peer.nickname || peer.username));
  } else if (cur.type === 'group') {
    const g = state.groups.find((x) => x.id === cur.targetId);
    if (g) {
      color = g.avatarColor || '#2b6de8';
      title = g.name;
      avatarInner = escapeHtml(initial(g.name));
    }
  }

  const groupExtra = cur.type === 'group'
    ? `<button class="sheet-item" data-sheet-act="members">
         <span class="si-icon">👥</span>
         <span class="si-main"><span class="si-title">群成员</span></span>
         <span class="row-arrow">›</span>
       </button>`
    : '';

  $('chatSheet').innerHTML = `
    <div class="sheet-head">
      <div class="avatar" style="background:${escapeHtml(color)}">${avatarInner}</div>
      <div class="sheet-head-main">
        <div class="sheet-head-name">${escapeHtml(title)}</div>
        <div class="sheet-head-sub">${cur.type === 'group' ? '群聊' : '单聊'}</div>
      </div>
      <button class="sheet-close" data-sheet-act="close">✕</button>
    </div>
    <div class="sheet-list">
      <button class="sheet-item" data-sheet-act="search">
        <span class="si-icon">🔍</span>
        <span class="si-main"><span class="si-title">查找聊天内容</span></span>
        <span class="row-arrow">›</span>
      </button>
      <div class="sheet-divider"></div>
      <label class="sheet-item">
        <span class="si-icon">🔕</span>
        <span class="si-main">
          <span class="si-title">消息免打扰</span>
          <span class="si-sub">不再提醒此会话的新消息</span>
        </span>
        <span class="switch"><input type="checkbox" id="swMute" ${chatSettings.muted ? 'checked' : ''} /><span class="switch-slider"></span></span>
      </label>
      <label class="sheet-item">
        <span class="si-icon">📌</span>
        <span class="si-main">
          <span class="si-title">置顶聊天</span>
          <span class="si-sub">保持在会话列表最上方</span>
        </span>
        <span class="switch"><input type="checkbox" id="swPin" ${chatSettings.pinned ? 'checked' : ''} /><span class="switch-slider"></span></span>
      </label>
      <div class="sheet-divider"></div>
      <button class="sheet-item" data-sheet-act="background">
        <span class="si-icon">🎨</span>
        <span class="si-main">
          <span class="si-title">设置聊天背景</span>
          <span class="si-sub">${chatSettings.background ? '已设置自定义背景' : '使用默认背景'}</span>
        </span>
        <span class="row-arrow">›</span>
      </button>
      ${groupExtra}
      <div class="sheet-divider"></div>
      <button class="sheet-item danger" data-sheet-act="clear">
        <span class="si-icon">🗑️</span>
        <span class="si-main"><span class="si-title">清空聊天记录</span></span>
      </button>
    </div>`;

  $('chatSheetMask').classList.remove('hidden');

  // 免打扰开关
  $('swMute').addEventListener('change', async (e) => {
    await saveChatSetting(convId, { muted: e.target.checked });
  });
  // 置顶开关
  $('swPin').addEventListener('change', async (e) => {
    await saveChatSetting(convId, { pinned: e.target.checked });
  });

  // 面板内各项操作
  $('chatSheet').querySelectorAll('[data-sheet-act]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      const act = el.dataset.sheetAct;
      if (act === 'close') { closeChatSheet(); return; }
      if (act === 'search') { closeChatSheet(); openChatSearch(); return; }
      if (act === 'background') { closeChatSheet(); openBackgroundPicker(); return; }
      if (act === 'members') { closeChatSheet(); showGroupMembers(cur.targetId); return; }
      if (act === 'clear') { closeChatSheet(); confirmClearChat(convId); return; }
    });
  });
}

function closeChatSheet() {
  $('chatSheetMask').classList.add('hidden');
}

$('chatSheetMask').addEventListener('click', (e) => {
  if (e.target === $('chatSheetMask')) closeChatSheet();
});

$('chatMenuBtn').addEventListener('click', () => openChatSheet());

/** 保存一项聊天设置 */
async function saveChatSetting(conversationId, patch) {
  try {
    const res = await api('/api/chat/settings', { method: 'POST', body: { conversationId, ...patch } });
    chatSettings = res.settings || chatSettings;
    applyChatBackground(chatSettings.background);
    refreshConversations();
    return true;
  } catch (e) {
    toast(e.message || '保存失败', 'error');
    return false;
  }
}

/** 应用聊天背景 */
function applyChatBackground(bg) {
  const body = $('chatBody');
  if (!body) return;
  if (!bg) {
    body.style.backgroundImage = '';
    body.classList.remove('custom-bg');
    return;
  }
  // CSS 渐变直接作为 background-image；图片地址走 url()
  const isGradient = /^(linear|radial)-gradient\(/i.test(bg);
  body.style.backgroundImage = isGradient ? bg : `url("${bg.replace(/"/g, '\\"')}")`;
  body.classList.add('custom-bg');
}

/** 选择聊天背景 */
function openBackgroundPicker() {
  const presets = [
    { name: '默认', value: '' },
    { name: '浅蓝', value: 'linear-gradient(160deg,#dbeafe,#e0e7ff)' },
    { name: '浅绿', value: 'linear-gradient(160deg,#d1fae5,#ecfccb)' },
    { name: '浅粉', value: 'linear-gradient(160deg,#fce7f3,#f3e8ff)' },
    { name: '浅灰', value: 'linear-gradient(160deg,#f1f5f9,#e2e8f0)' },
    { name: '深色', value: 'linear-gradient(160deg,#1f2937,#111827)' }
  ];
  const html = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;">
      ${presets.map((p, i) => `
        <button class="bg-pick" data-bg="${escapeHtml(p.value)}" data-idx="${i}" style="
          height:62px;border-radius:11px;border:2px solid ${p.value ? '#e2e5ea' : 'transparent'};
          background:${p.value || 'linear-gradient(160deg,#f5f6f8,#ebedf0)'};
          display:flex;align-items:flex-end;justify-content:center;padding-bottom:5px;font-size:12px;color:#64748b;">
          ${escapeHtml(p.name)}
        </button>`).join('')}
    </div>
    <div style="margin-top:14px;">
      <div class="field-label">或使用已上传的图片作为背景</div>
      <input type="file" id="bgFileInput" accept="image/png,image/jpeg,image/webp" />
    </div>`;

  openModal({
    title: '设置聊天背景',
    bodyHtml: html,
    okText: '确定',
    onOk: async () => {
      const picked = document.querySelector('.bg-pick.is-picked');
      if (picked) {
        const val = picked.dataset.bg;
        await saveChatSetting(state.current.conversationId, { background: val });
        toast('背景已更新', 'success');
        return true;
      }
      return false;
    }
  });

  // 选中高亮
  $('modalBody').querySelectorAll('.bg-pick').forEach((b) => {
    b.addEventListener('click', () => {
      $('modalBody').querySelectorAll('.bg-pick').forEach((x) => x.classList.remove('is-picked'));
      b.classList.add('is-picked');
      b.style.borderColor = '#2b6de8';
      $('modalBody').querySelectorAll('.bg-pick').forEach((x) => { if (x !== b) x.style.borderColor = '#e2e5ea'; });
    });
  });

  // 上传自定义背景
  const fileInput = $('bgFileInput');
  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const url = await uploadImage(file, 'bg');
        await saveChatSetting(state.current.conversationId, { background: url });
        toast('背景已更新', 'success');
        closeModal();
      } catch (err) {
        toast(err.message || '背景设置失败', 'error');
      }
    });
  }
}

/** 查找聊天内容 */
function openChatSearch() {
  openModal({
    title: '查找聊天内容',
    bodyHtml: `
      <input type="text" id="chatSearchInput" placeholder="输入关键词搜索本会话消息" />
      <div id="chatSearchResult" style="margin-top:12px;max-height:40vh;overflow:auto;"></div>`,
    okText: '搜索',
    cancelText: '关闭',
    onOk: async () => {
      const kw = $('chatSearchInput').value.trim();
      if (!kw) return false;
      const box = $('chatSearchResult');
      const hits = state.messages.filter((m) => String(m.content || '').includes(kw));
      box.innerHTML = hits.length
        ? hits.map((m) => `
            <div class="sheet-item" style="padding:10px 0;">
              <span class="si-main">
                <span class="si-title" style="font-size:13.5px;">${escapeHtml(String(m.content).slice(0, 80))}</span>
                <span class="si-sub">${escapeHtml(m.fromName)} · ${escapeHtml(formatTime(m.createdAt))}</span>
              </span>
            </div>`).join('')
        : '<div class="row-sub">没有找到相关消息</div>';
      return false;
    }
  });
}

/** 确认清空聊天记录 */
function confirmClearChat(conversationId) {
  openModal({
    title: '清空聊天记录',
    bodyHtml: '<div>确定要清空与该会话的全部聊天记录吗？此操作不可恢复。</div>',
    okText: '清空',
    cancelText: '取消',
    onOk: async () => {
      try {
        const res = await api('/api/chat/clear', { method: 'POST', body: { conversationId } });
        state.messages = [];
        renderMessages();
        refreshConversations();
        toast(`已清空 ${res.removed || 0} 条消息`, 'success');
        return true;
      } catch (e) {
        toast(e.message || '清空失败', 'error');
        return false;
      }
    }
  });
}

/** 显示群成员 */
function showGroupMembers(groupId) {  const g = state.groups.find((x) => x.id === groupId);
  if (!g) {
    // 群不在我的列表里（可能刚被邀请），重新拉取
    api('/api/groups').then((res) => {
      state.groups = res.groups || [];
      const gg = state.groups.find((x) => x.id === groupId);
      if (gg) showGroupMembers(groupId);
      else toast('群聊不存在', 'error');
    });
    return;
  }
  openModal({
    title: '群成员',
    bodyHtml: g.members.map((m) => `
      <div class="row-item" style="padding:9px 0;">
        ${avatarHtml(m.nickname, m.avatarColor, m.avatar, 'avatar-sm')}
        <div class="row-main">
          <div class="row-name">${escapeHtml(m.nickname)}${m.isOwner ? '<span class="tag tag-blue">群主</span>' : ''}</div>
          <div class="row-sub">@${escapeHtml(m.username)}</div>
        </div>
      </div>`).join(''),
    okText: '关闭',
    hideCancel: true,
    onOk: () => true
  });
}

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
        <td>${u.isAdmin
          ? '<span class="row-sub">—</span>'
          : `<button class="btn btn-sm" data-pwd="${escapeHtml(u.id)}" data-name="${escapeHtml(u.username)}">重置密码</button>
             <button class="btn btn-sm btn-danger" data-del="${escapeHtml(u.id)}" data-name="${escapeHtml(u.username)}">删除</button>`}</td>
      </tr>
    `).join('');

    // 重置密码
    $('adminUserTable').querySelectorAll('[data-pwd]').forEach((b) => {
      b.addEventListener('click', () => {
        openModal({
          title: '重置密码',
          bodyHtml: `
            <div class="field">
              <span class="field-label">账号</span>
              <input type="text" value="${escapeHtml(b.dataset.name)}" disabled />
            </div>
            <div class="field">
              <span class="field-label">新密码（至少 6 位）</span>
              <input type="text" id="resetPwdInput" placeholder="请输入新密码" autocomplete="off" />
            </div>
            <div class="row-sub" style="margin-top:6px">重置后该用户需用新密码重新登录</div>
          `,
          okText: '重置',
          onOk: async () => {
            const pwd = ($('resetPwdInput') || {}).value || '';
            if (pwd.length < 6) {
              toast('新密码至少 6 个字符', 'error');
              return false;
            }
            try {
              await api('/api/admin/users/' + b.dataset.pwd + '/password', {
                method: 'POST',
                body: { password: pwd }
              });
              toast('密码已重置', 'success');
              return true;
            } catch (e) {
              toast(e.message, 'error');
              return false;
            }
          }
        });
      });
    });

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
        // 连续重连仍失败 → 切到备用后端（正式服务器 <-> 测试隧道）
        if (state.wsRetry >= 3 && rotateApiBase()) {
          state.wsRetry = 0;
        }
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

  // 加密消息不在通知里暴露密文
  const bodyText = m.cipher
    ? '🔒 [加密消息]'
    : (m.type === 'image' ? '[图片]' : m.type === 'sticker' ? '[表情包]' : (m.content || ''));

  if (isGroup) {
    const g = state.groups.find((x) => x.id === m.toId);
    title = (g ? g.name : '群聊') + ' · ' + (m.fromName || '新消息');
    body = bodyText;
  } else {
    title = m.fromName || '新消息';
    body = bodyText;
  }

  playNotificationSound();
  showDesktopNotification(title, body);

  // 页面在前台时也弹一个轻提示
  if (document.visibilityState === 'visible' && document.hasFocus()) {
    toast(`${title}：${body.length > 20 ? body.slice(0, 20) + '…' : body}`);
  }
}

/* ==================== 启动 ==================== */
/**
 * 页面刷新后提示用户输入密码解锁 E2EE 私钥。
 * 私钥用密码派生的 KEK 加密，服务端无法解开，所以必须由用户输入密码。
 */
function promptE2eeUnlock() {
  if (!window.E2EE || !e2eeEnabled()) return;
  if (window.WL_E2EE_READY) return;

  const unlockTask = (async () => {
    const pwd = ($('e2eeUnlockPwd') && $('e2eeUnlockPwd').value) || '';
    if (!pwd) throw new Error('请输入密码');
    const cres = await api('/api/crypto/me');
    const c = cres.crypto || {};
    if (!c.cryptoEncPrivate) {
      await window.E2EE.setupIdentity(api, state.user, pwd);
    } else {
      await window.E2EE.unlock({ ...c, username: state.user.username }, pwd);
    }
    const me = await api('/api/auth/me');
    window.E2EE.cachePeerKeys([{
      id: me.user.id,
      cryptoPublicKey: me.user.cryptoPublicKey,
      cryptoSigPublicKey: me.user.cryptoSigPublicKey
    }]);
    window.WL_E2EE_READY = true;
    await refreshPeerKeys();
    refreshE2eeStatus();
    toast('端到端加密已解锁', 'success');
    // 重新渲染当前会话以解密已有消息
    if (state.current) {
      const cur = state.current;
      await openChat(cur.type, cur.targetId, cur.title);
    }
  })();
  state.e2eeInitPromise = unlockTask;

  openModal({
    title: '解锁端到端加密',
    bodyHtml: `
      <div class="e2ee-unlock-box">
        <p>为了解密历史消息，请输入你的登录密码解锁本机私钥。</p>
        <p class="muted">密码只在本机使用，不会上传。服务器只保存加密后的私钥，无法读取。</p>
        <input type="password" id="e2eeUnlockPwd" class="input" placeholder="请输入登录密码" autocomplete="current-password" />
      </div>
    `,
    okText: '解锁',
    cancelText: '暂不',
    onOk: async () => {
      try {
        await unlockTask;
        return true;
      } catch (e) {
        toast('解锁失败：' + (e && e.message ? e.message : '密码不正确'), 'error');
        return false;
      }
    }
  });
  setTimeout(() => { try { $('e2eeUnlockPwd') && $('e2eeUnlockPwd').focus(); } catch { /* ignore */ } }, 100);
}

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
    // 刷新页面后需要密码才能解锁私钥 → 提示用户解锁
    promptE2eeUnlock();
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
