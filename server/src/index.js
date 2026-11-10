/**
 * HTTP REST 接口 + WebSocket 实时通道。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { load, save, saveNow, persistNow, db } from './db.js';
import { createUser, verifyPassword, hashPassword, createSession, destroySession, userByToken, publicUser } from './auth.js';
import {
  requestFriend,
  respondFriend,
  listFriendships,
  findUserByUsername,
  createGroup,
  joinGroup,
  leaveGroup,
  deleteGroup,
  listGroups,
  listAllGroups,
  serializeGroup,
  isGroupMember,
  createMessage,
  listMessages,
  listConversations,
  markRead,
  dmConversationId,
  addSticker,
  listStickers,
  removeSticker,
  getChatSettings,
  updateChatSettings,
  clearConversation
} from './logic.js';
import { saveImage, saveBinary, removeUpload, ensureUploadDir, UPLOAD_DIR } from './upload.js';

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

load();

// ============ 初始化管理员 ============
if (!findUserByUsername(ADMIN_USER)) {
  const u = createUser({
    username: ADMIN_USER,
    password: ADMIN_PASS,
    nickname: '管理员',
    isAdmin: true
  });
  console.log('[init] 已创建管理员账号:', u.username, '/', ADMIN_PASS);
}

const app = express();
app.use(cors());
// JSON 体积上限：需容纳 base64 图片（3MB 二进制 -> 约 4MB base64）
app.use(express.json({ limit: '5mb' }));

/** 简易访问日志 */
app.use((req, res, next) => {
  console.log(`[http] ${req.method} ${req.url}`);
  next();
});

/** 取当前登录用户 */
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token;
  const user = userByToken(token);
  if (!user) return res.status(401).json({ success: false, message: '未登录或登录已过期' });
  req.user = user;
  req.token = token;
  next();
}

/** 取 WebSocket 连接 */
function requireAdmin(req, res, next) {
  if (!req.user.isAdmin) return res.status(403).json({ success: false, message: '需要管理员权限' });
  next();
}

// ============ 公开接口 ============

/** 健康检查（无需登录，供前端探活） */
app.get('/api/health', (req, res) => {
  res.json({ success: true, ok: true, time: Date.now() });
});

/**
 * 地址发现接口。
 * 前端拿到 Pages 上的旧地址连不上时，可以调用它获取最新的可用地址。
 * 后端在启动脚本里把自己的公网地址写入 WL_PUBLIC_URL，
 * 同时后端会把最新隧道地址写进自身可访问的位置。
 */
app.get('/api/discover', (req, res) => {
  res.json({
    success: true,
    apiBase: process.env.WL_PUBLIC_URL || '',
    wsBase: process.env.WL_PUBLIC_WS || '',
    time: Date.now()
  });
});

// ============ 认证接口 ============

app.post('/api/auth/register', (req, res) => {
  const { username, password, nickname } = req.body || {};
  if (!username || !password) {
    return res.json({ success: false, message: '账号和密码不能为空' });
  }
  if (String(username).trim().length < 3) {
    return res.json({ success: false, message: '账号至少 3 个字符' });
  }
  if (String(password).length < 6) {
    return res.json({ success: false, message: '密码至少 6 个字符' });
  }
  if (findUserByUsername(String(username).trim())) {
    return res.json({ success: false, message: '该账号已被注册' });
  }
  const user = createUser({
    username: String(username).trim(),
    password,
    nickname: nickname ? String(nickname).trim() : String(username).trim()
  });
  const token = createSession(user.id);
  res.json({ success: true, token, user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = findUserByUsername(String(username || '').trim());
  if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    return res.json({ success: false, message: '账号或密码错误' });
  }
  user.lastLoginAt = Date.now();
  save();
  const token = createSession(user.id);
  res.json({ success: true, token, user: publicUser(user) });
});

app.post('/api/auth/logout', auth, (req, res) => {
  destroySession(req.token);
  res.json({ success: true });
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json({ success: true, user: publicUser(req.user) });
});

// ============ 个人资料 ============

/** 修改昵称 / 头像 */
app.post('/api/auth/profile', auth, (req, res) => {
  const { nickname, avatar, avatarColor } = req.body || {};

  if (nickname !== undefined) {
    const n = String(nickname).trim();
    if (!n) return res.json({ success: false, message: '昵称不能为空' });
    if (n.length > 20) return res.json({ success: false, message: '昵称最多 20 个字符' });
    req.user.nickname = n;
  }

  if (avatar !== undefined) {
    const a = String(avatar || '').trim();
    // 允许清空头像（回退为首字色块）
    if (a) {
      if (!a.startsWith('/uploads/') && !/^https?:\/\//i.test(a)) {
        return res.json({ success: false, message: '头像地址不合法' });
      }
      // 换头像时删掉旧文件
      if (req.user.avatar && req.user.avatar.startsWith('/uploads/')) {
        removeUpload(req.user.avatar);
      }
    }
    req.user.avatar = a;
  }

  if (avatarColor !== undefined) {
    const c = String(avatarColor || '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(c)) {
      return res.json({ success: false, message: '头像颜色格式不合法' });
    }
    req.user.avatarColor = c;
  }

  saveNow();
  // 广播资料变更，好友/群成员界面能实时更新
  broadcastProfileChange(req.user);
  res.json({ success: true, user: publicUser(req.user) });
});

/** 上传图片（头像 / 表情包） */
app.post('/api/upload', auth, (req, res) => {
  const { dataUrl, prefix } = req.body || {};
  const result = saveImage(dataUrl, prefix === 'sticker' ? 'sticker' : 'avatar');
  if (result.error) return res.json({ success: false, message: result.error });
  res.json({ success: true, url: result.url, bytes: result.bytes });
});

/** 上传加密后的文件（端到端加密的图片 / 表情包密文） */
app.post('/api/upload/enc', auth, (req, res) => {
  const { data, prefix } = req.body || {};
  const result = saveBinary(data, 'enc');
  if (result.error) return res.json({ success: false, message: result.error });
  res.json({ success: true, url: result.url, bytes: result.bytes });
});

// ============ 自定义表情包 ============

app.get('/api/stickers', auth, (req, res) => {
  res.json({ success: true, stickers: listStickers(req.user.id) });
});

app.post('/api/stickers', auth, (req, res) => {
  const { url, name, fileKeyIv, fileKeyCt, fileIv } = req.body || {};
  if (!url || !url.startsWith('/uploads/')) {
    return res.json({ success: false, message: '表情包地址不合法' });
  }
  const result = addSticker(req.user.id, { url, name, fileKeyIv, fileKeyCt, fileIv });
  if (result.error) return res.json({ success: false, message: result.error });
  res.json({ success: true, sticker: result.sticker });
});

app.delete('/api/stickers/:id', auth, (req, res) => {
  const result = removeSticker(req.user.id, req.params.id);
  if (result.error) return res.json({ success: false, message: result.error });
  removeUpload(result.url);
  res.json({ success: true });
});

// ============ 好友接口 ============

app.get('/api/friends', auth, (req, res) => {
  res.json({ success: true, ...listFriendships(req.user.id) });
});

/** 按账号搜索用户 */
app.get('/api/users/search', auth, (req, res) => {
  const kw = String(req.query.keyword || '').trim().toLowerCase();
  if (!kw) return res.json({ success: true, users: [] });
  const users = db()
    .users.filter((u) => {
      if (u.id === req.user.id) return false;
      return (
        u.username.toLowerCase().includes(kw) ||
        (u.nickname || '').toLowerCase().includes(kw)
      );
    })
    .slice(0, 30)
    .map(publicUser);
  res.json({ success: true, users });
});

/** 通过账号添加好友 */
app.post('/api/friends/request', auth, (req, res) => {
  const targetName = String((req.body || {}).username || '').trim();
  if (!targetName) return res.json({ success: false, message: '请输入对方账号' });
  const result = requestFriend(req.user.id, targetName);
  if (result.error) return res.json({ success: false, message: result.error });
  // 通知对方
  if (result.target) {
    notifyUser(result.target.id, 'friend_request', {
      friendship: result.friendship,
      from: publicUser(req.user)
    });
  }
  res.json({ success: true, ...result });
});

app.post('/api/friends/respond', auth, (req, res) => {
  const { friendshipId, accept } = req.body || {};
  const result = respondFriend(req.user.id, friendshipId, !!accept);
  if (result.error) return res.json({ success: false, message: result.error });
  // 通知双方
  const f = db().friendships.find((x) => x.id === friendshipId);
  if (f) {
    notifyUser(f.from, 'friend_response', { friendship: result.friendship });
    notifyUser(f.to, 'friend_response', { friendship: result.friendship });
  }
  res.json({ success: true, friendship: result.friendship });
});

app.delete('/api/friends/:id', auth, (req, res) => {
  const f = db().friendships.find((x) => x.id === req.params.id);
  if (!f) return res.json({ success: false, message: '记录不存在' });
  if (f.from !== req.user.id && f.to !== req.user.id) {
    return res.json({ success: false, message: '无权操作' });
  }
  db().friendships = db().friendships.filter((x) => x.id !== f.id);
  save();
  notifyUser(f.from === req.user.id ? f.to : f.from, 'friend_removed', {});
  res.json({ success: true });
});

// ============ 群组接口 ============

app.get('/api/groups', auth, (req, res) => {
  res.json({ success: true, groups: listGroups(req.user.id), joinable: listAllGroups(req.user.id) });
});

app.post('/api/groups', auth, (req, res) => {
  const { name, members, description } = req.body || {};
  const result = createGroup(req.user.id, { name, members, description });
  if (result.error) return res.json({ success: false, message: result.error });
  // 通知群成员
  for (const uid of result.group.members.map((m) => m.id)) {
    notifyUser(uid, 'group_created', { group: result.group });
  }
  res.json({ success: true, group: result.group });
});

app.post('/api/groups/:id/join', auth, (req, res) => {
  const result = joinGroup(req.user.id, req.params.id);
  if (result.error) return res.json({ success: false, message: result.error });
  for (const uid of result.group.members.map((m) => m.id)) {
    notifyUser(uid, 'group_update', { group: result.group });
  }
  res.json({ success: true, group: result.group });
});

app.post('/api/groups/:id/leave', auth, (req, res) => {
  const result = leaveGroup(req.user.id, req.params.id);
  if (result.error) return res.json({ success: false, message: result.error });
  res.json({ success: true });
});

/** 解散群聊：仅群主 */
app.delete('/api/groups/:id', auth, (req, res) => {
  const gid = req.params.id;
  const g = db().groups.find((x) => x.id === gid);
  if (!g) return res.json({ success: false, message: '群不存在' });
  if (g.ownerId !== req.user.id) {
    return res.status(403).json({ success: false, message: '只有群主才能解散该群聊' });
  }
  // 先通知成员，再删除
  const memberIds = g.memberIds.slice();
  const result = deleteGroup(req.user.id, gid);
  if (result.error) return res.json({ success: false, message: result.error });
  for (const uid of memberIds) {
    notifyUser(uid, 'group_deleted', { groupId: gid, groupName: g.name });
  }
  res.json({ success: true });
});

// ============ 消息接口 ============

app.get('/api/messages', auth, (req, res) => {
  const { conversationId, toType, toId, limit } = req.query;
  let conv = conversationId;
  if (!conv && toType && toId) {
    conv = toType === 'group' ? `group:${toId}` : dmConversationId(req.user.id, toId);
  }
  if (!conv) return res.json({ success: false, message: '缺少 conversationId' });
  if (conv.startsWith('group:')) {
    const gid = conv.slice(6);
    if (!isGroupMember(gid, req.user.id)) {
      return res.status(403).json({ success: false, message: '你不是该群成员' });
    }
  }
  res.json({ success: true, messages: listMessages(req.user.id, conv, Number(limit) || 50) });
});

app.post('/api/messages', auth, (req, res) => {
  const { toType, toId, content, type, cipher, fileIv } = req.body || {};
  const result = createMessage({
    fromUserId: req.user.id,
    toType: toType || 'dm',
    toId,
    content,
    type: type || 'text',
    cipher: cipher || null,
    fileIv: fileIv || ''
  });
  if (result.error) return res.json({ success: false, message: result.error });
  broadcastMessage(result.message);
  res.json({ success: true, message: result.message });
});

// ============ 端到端加密接口 ============

/**
 * 上传/更新本用户的加密身份材料。
 * 服务端只做「存取」，无法解开私钥（私钥用密码派生的 KEK 加密后才上传）。
 */
app.post('/api/crypto/keys', auth, (req, res) => {
  const u = req.user;
  const {
    cryptoSalt,
    cryptoPublicKey,
    cryptoSigPublicKey,
    cryptoEncPrivate,
    cryptoSigPrivate
  } = req.body || {};

  // 全量提交：要么都提供，要么都不改
  const all = [cryptoSalt, cryptoPublicKey, cryptoSigPublicKey, cryptoEncPrivate, cryptoSigPrivate];
  const provided = all.filter((v) => v !== undefined && v !== null && v !== '');
  if (provided.length === 0) {
    return res.json({ success: false, message: '缺少密钥参数' });
  }
  if (provided.length !== all.length) {
    return res.json({ success: false, message: '密钥参数不完整' });
  }

  u.cryptoSalt = String(cryptoSalt);
  u.cryptoPublicKey = String(cryptoPublicKey);
  u.cryptoSigPublicKey = String(cryptoSigPublicKey);
  u.cryptoEncPrivate = String(cryptoEncPrivate);
  u.cryptoSigPrivate = String(cryptoSigPrivate);
  saveNow();
  res.json({ success: true, publicKey: u.cryptoPublicKey, sigPublicKey: u.cryptoSigPublicKey });
});

/**
 * 拉取会话内相关用户的公钥。
 * 只返回公钥，私钥永不下发。
 */
app.get('/api/crypto/keys', auth, (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  const unique = [...new Set(ids)].slice(0, 200);
  const keys = db()
    .users.filter((u) => unique.includes(u.id))
    .map((u) => ({
      id: u.id,
      username: u.username,
      nickname: u.nickname || u.username,
      cryptoPublicKey: u.cryptoPublicKey || '',
      cryptoSigPublicKey: u.cryptoSigPublicKey || ''
    }));
  res.json({ success: true, keys });
});

/** 取回自己的私钥密文（用于本地解锁） */
app.get('/api/crypto/me', auth, (req, res) => {
  const u = req.user;
  res.json({
    success: true,
    crypto: {
      id: u.id,
      username: u.username,
      cryptoSalt: u.cryptoSalt || '',
      cryptoPublicKey: u.cryptoPublicKey || '',
      cryptoSigPublicKey: u.cryptoSigPublicKey || '',
      cryptoEncPrivate: u.cryptoEncPrivate || '',
      cryptoSigPrivate: u.cryptoSigPrivate || ''
    }
  });
});

app.post('/api/messages/read', auth, (req, res) => {
  const { conversationId } = req.body || {};
  if (!conversationId) return res.json({ success: false, message: '缺少 conversationId' });
  const count = markRead(req.user.id, conversationId);
  res.json({ success: true, count });
});

app.get('/api/conversations', auth, (req, res) => {
  res.json({ success: true, conversations: listConversations(req.user.id) });
});

// ============ 聊天设置接口 ============

/** 读取某会话的设置（免打扰 / 置顶 / 背景） */
app.get('/api/chat/settings', auth, (req, res) => {
  const { conversationId } = req.query;
  if (!conversationId) return res.json({ success: false, message: '缺少 conversationId' });
  res.json({ success: true, settings: getChatSettings(req.user.id, conversationId) });
});

/** 更新会话设置 */
app.post('/api/chat/settings', auth, (req, res) => {
  const { conversationId, muted, pinned, background } = req.body || {};
  if (!conversationId) return res.json({ success: false, message: '缺少 conversationId' });
  const patch = {};
  if ('muted' in (req.body || {})) patch.muted = muted;
  if ('pinned' in (req.body || {})) patch.pinned = pinned;
  if ('background' in (req.body || {})) patch.background = background;
  const result = updateChatSettings(req.user.id, conversationId, patch);
  if (result.error) return res.json({ success: false, message: result.error });
  res.json({ success: true, settings: result.settings });
});

/** 清空聊天记录 */
app.post('/api/chat/clear', auth, (req, res) => {
  const { conversationId } = req.body || {};
  if (!conversationId) return res.json({ success: false, message: '缺少 conversationId' });
  // 权限校验：必须是会话参与者
  const isParticipant = db().messages.some((m) => m.conversationId === conversationId && m.participants.includes(req.user.id));
  const inGroup = conversationId.startsWith('group:')
    && isGroupMember(conversationId.slice(6), req.user.id);
  if (!isParticipant && !inGroup) {
    return res.status(403).json({ success: false, message: '无权操作该会话' });
  }
  const result = clearConversation(req.user.id, conversationId);
  res.json({ success: true, removed: result.removed });
});

/** 在线人数（所有登录用户可查） */
app.get('/api/online', auth, (req, res) => {
  const online = [...wss.clients].filter((c) => c.readyState === 1 && c.userId).length;
  res.json({ success: true, online });
});

// ============ 管理员后台 ============

app.get('/api/admin/stats', auth, requireAdmin, (req, res) => {
  const users = db().users;
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const activeToday = users.filter((u) => u.lastLoginAt && now - u.lastLoginAt < dayMs).length;
  const online = [...wss.clients].filter((c) => c.readyState === 1 && c.userId).length;
  res.json({
    success: true,
    stats: {
      totalUsers: users.length,
      adminUsers: users.filter((u) => u.isAdmin).length,
      activeToday,
      online,
      totalGroups: db().groups.length,
      totalMessages: db().messages.length,
      totalFriendships: db().friendships.filter((f) => f.status === 'accepted').length
    },
    users: users
      .map((u) => ({
        ...publicUser(u),
        passwordHash: undefined,
        friendCount: db().friendships.filter(
          (f) => f.status === 'accepted' && (f.from === u.id || f.to === u.id)
        ).length,
        groupCount: db().groups.filter((g) => g.memberIds.includes(u.id)).length,
        messageCount: db().messages.filter((m) => m.from === u.id).length
      }))
  });
});

/** 管理员删除用户 */
app.delete('/api/admin/users/:id', auth, requireAdmin, (req, res) => {
  const id = req.params.id;
  const target = db().users.find((u) => u.id === id);
  if (!target) return res.json({ success: false, message: '用户不存在' });
  if (target.isAdmin) return res.json({ success: false, message: '不能删除管理员账号' });
  db().users = db().users.filter((u) => u.id !== id);
  db().sessions = db().sessions.filter((s) => s.userId !== id);
  db().friendships = db().friendships.filter((f) => f.from !== id && f.to !== id);
  db().groups.forEach((g) => {
    g.memberIds = g.memberIds.filter((m) => m !== id);
  });
  // 关键操作：立即落盘
  saveNow();
  notifyUser(id, 'account_removed', {});
  res.json({ success: true });
});

/**
 * 管理员重置用户密码
 * 密码是 scrypt 加盐散列存储、不可逆，所以密码遗忘时只能重置。
 */
app.post('/api/admin/users/:id/password', auth, requireAdmin, (req, res) => {
  const id = req.params.id;
  const target = db().users.find((u) => u.id === id);
  if (!target) return res.json({ success: false, message: '用户不存在' });
  const pwd = String((req.body || {}).password || '');
  if (pwd.length < 6) return res.json({ success: false, message: '新密码至少 6 个字符' });
  const { salt, hash } = hashPassword(pwd);
  target.passwordSalt = salt;
  target.passwordHash = hash;
  // 重置密码后使该用户所有会话失效，强制重新登录
  db().sessions = db().sessions.filter((s) => s.userId !== id);
  saveNow();
  notifyUser(id, 'account_removed', {});
  res.json({ success: true });
});

/** 管理员修改自己的密码 */
app.post('/api/admin/password', auth, requireAdmin, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (String(newPassword || '').length < 6) {
    return res.json({ success: false, message: '新密码至少 6 个字符' });
  }
  if (!verifyPassword(oldPassword, req.user.passwordSalt, req.user.passwordHash)) {
    return res.json({ success: false, message: '原密码不正确' });
  }
  const { salt, hash } = hashPassword(newPassword);
  req.user.passwordSalt = salt;
  req.user.passwordHash = hash;
  db().sessions = db().sessions.filter((s) => s.userId !== req.user.id);
  saveNow();
  res.json({ success: true });
});

// ============ 静态前端 ============
const CLIENT_DIST = fileURLToPath(new URL('../../client/public/', import.meta.url));
ensureUploadDir();
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.use(express.static(CLIENT_DIST, {
  setHeaders: (res) => {
    // 开发阶段禁用缓存，避免改了前端却看到旧版本
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));
console.log('[server] 静态目录:', CLIENT_DIST);
console.log('[server] 上传目录:', UPLOAD_DIR);

// ============ WebSocket ============
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const user = userByToken(token);
  if (!user) {
    ws.close(4001, 'unauthorized');
    return;
  }
  ws.userId = user.id;
  ws.isAlive = true;

  console.log('[ws] 连接', user.username, '在线数:', wss.clients.size);
  notifyAdminsOnline();

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleWsMessage(ws, user, msg);
  });

  ws.on('close', () => {
    console.log('[ws] 断开', user.username);
    notifyAdminsOnline();
  });
});

/** 心跳，清理僵尸连接 */
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  });
}, 30000);

/** WebSocket 消息处理：客户端可通过 ws 直接发消息（低延迟） */
function handleWsMessage(ws, user, msg) {
  const action = msg.action || msg.type;

  if (action === 'ping') {
    sendToWs(ws, { action: 'pong', time: Date.now() });
    return;
  }

  if (action === 'send_message' || action === 'message') {
    const result = createMessage({
      fromUserId: user.id,
      toType: msg.toType || 'dm',
      toId: msg.toId,
      content: msg.content,
      type: msg.type || 'text',
      cipher: msg.cipher || null,
      fileIv: msg.fileIv || ''
    });
    if (result.error) {
      sendToWs(ws, { action: 'error', message: result.error });
      return;
    }
    broadcastMessage(result.message);
    return;
  }

  if (action === 'read') {
    if (msg.conversationId) markRead(user.id, msg.conversationId);
    return;
  }

  if (action === 'typing') {
    const participants = msg.participants || [];
    for (const pid of participants) {
      notifyUser(pid, 'typing', { from: user.id, fromName: user.nickname, toId: msg.toId });
    }
  }
}

function sendToWs(ws, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

/** 广播消息给会话参与者 */
function broadcastMessage(message) {
  const payload = { action: 'new_message', message };
  const participants = message.participants || [];
  for (const ws of wss.clients) {
    if (!ws.userId) continue;
    if (participants.includes(ws.userId)) {
      sendToWs(ws, payload);
    }
  }
}

/** 定向推送 */
function notifyUser(userId, action, data) {
  const payload = { action, data };
  for (const ws of wss.clients) {
    if (ws.userId === userId) sendToWs(ws, payload);
  }
}

/** 推送在线人数给所有在线用户 */
function notifyAdminsOnline() {
  const online = [...wss.clients].filter((c) => c.readyState === 1 && c.userId).length;
  for (const ws of wss.clients) {
    if (!ws.userId) continue;
    sendToWs(ws, { action: 'online_update', online });
  }
}

/** 广播用户资料变更（头像 / 昵称） */
function broadcastProfileChange(user) {
  const payload = { action: 'profile_updated', user: publicUser(user) };
  for (const ws of wss.clients) {
    if (ws.userId) sendToWs(ws, payload);
  }
}

// ============ 启动 ============
server.listen(PORT, () => {
  console.log(`[server] 微聊服务端已启动: http://localhost:${PORT}`);
  console.log(`[server] 管理员账号: ${ADMIN_USER} / ${ADMIN_PASS}`);
});

process.on('SIGINT', () => {
  persistNow();
  process.exit(0);
});
process.on('SIGTERM', () => {
  persistNow();
  process.exit(0);
});
// 进程退出（含窗口关闭 / 任务管理器结束）时确保数据落盘
process.on('exit', () => {
  persistNow();
});
process.on('uncaughtException', (e) => {
  console.error('[server] 未捕获异常', e);
  persistNow();
});
