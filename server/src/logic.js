/**
 * 业务逻辑：好友关系、群组、消息、已读状态。
 */
import { db, save, saveNow, nextId } from './db.js';
import { publicUser, randomColor } from './auth.js';

// ============ 好友 ============

export function findUserByUsername(username) {
  return db().users.find((u) => u.username.toLowerCase() === String(username).toLowerCase()) || null;
}

/**
 * 发起好友申请：targetName 为目标账号。
 * 同一对好友只保留一条申请记录（重复申请则更新状态）
 */
export function requestFriend(fromUserId, targetName) {
  const target = findUserByUsername(targetName);
  if (!target) return { error: '账号不存在' };
  if (target.id === fromUserId) return { error: '不能添加自己为好友' };

  const me = db().users.find((u) => u.id === fromUserId);
  if (!me) return { error: '用户不存在' };

  // 已经是好友
  const existing = db().friendships.find(
    (f) =>
      (f.from === fromUserId && f.to === target.id) ||
      (f.from === target.id && f.to === fromUserId)
  );
  if (existing && existing.status === 'accepted') {
    return { error: '你们已经是好友了' };
  }

  // 对方已申请我 → 直接互相通过
  const incoming = db().friendships.find((f) => f.from === target.id && f.to === fromUserId && f.status !== 'rejected');
  if (incoming) {
    incoming.status = 'accepted';
    incoming.updatedAt = Date.now();
    save();
    return { accepted: true, friendship: serializeFriendship(incoming, fromUserId), target: publicUser(target) };
  }

  const friendship = existing || {
    id: nextId('f'),
    from: fromUserId,
    to: target.id,
    status: 'pending',
    createdAt: Date.now()
  };
  friendship.status = 'pending';
  friendship.updatedAt = Date.now();
  if (!existing) db().friendships.push(friendship);
  saveNow();
  return { friendship: serializeFriendship(friendship, fromUserId), target: publicUser(target) };
}

export function respondFriend(userId, friendshipId, accept) {
  const f = db().friendships.find((x) => x.id === friendshipId);
  if (!f) return { error: '申请不存在' };
  if (f.to !== userId) return { error: '无权操作' };
  f.status = accept ? 'accepted' : 'rejected';
  f.updatedAt = Date.now();
  saveNow();
  return { friendship: serializeFriendship(f, userId) };
}

export function serializeFriendship(f, viewerId) {
  const otherId = f.from === viewerId ? f.to : f.from;
  const other = db().users.find((u) => u.id === otherId);
  return {
    id: f.id,
    status: f.status,
    from: f.from,
    to: f.to,
    peer: publicUser(other),
    createdAt: f.createdAt,
    updatedAt: f.updatedAt
  };
}

/** 我的好友列表 + 收到的申请 + 我发出的申请 */
export function listFriendships(userId) {
  const all = db().friendships;
  const friends = [];
  const requests = [];
  const sent = [];
  for (const f of all) {
    if (f.status === 'accepted') {
      friends.push(serializeFriendship(f, userId));
    } else if (f.status === 'pending') {
      if (f.to === userId) requests.push(serializeFriendship(f, userId));
      else sent.push(serializeFriendship(f, userId));
    }
  }
  return { friends, requests, sent };
}

export function areFriends(userId, peerId) {
  return db().friendships.some(
    (f) => f.status === 'accepted' && ((f.from === userId && f.to === peerId) || (f.from === peerId && f.to === userId))
  );
}

// ============ 群组 ============

export function createGroup(ownerId, { name, members = [], description = '' }) {
  const owner = db().users.find((u) => u.id === ownerId);
  if (!owner) return { error: '用户不存在' };
  const trimmed = String(name || '').trim();
  if (!trimmed) return { error: '群名称不能为空' };

  const memberIds = new Set([ownerId, ...members.filter((m) => m && m !== ownerId)]);
  const group = {
    id: nextId('g'),
    name: trimmed,
    description,
    ownerId,
    memberIds: [...memberIds],
    createdAt: Date.now(),
    avatarColor: randomColor()
  };
  db().groups.push(group);
  saveNow();
  return { group: serializeGroup(group, ownerId) };
}

export function joinGroup(userId, groupId) {
  const g = db().groups.find((x) => x.id === groupId);
  if (!g) return { error: '群不存在' };
  if (!g.memberIds.includes(userId)) {
    g.memberIds.push(userId);
    save();
  }
  return { group: serializeGroup(g, userId) };
}

export function leaveGroup(userId, groupId) {
  const g = db().groups.find((x) => x.id === groupId);
  if (!g) return { error: '群不存在' };
  g.memberIds = g.memberIds.filter((m) => m !== userId);
  if (g.ownerId === userId) {
    // 群主退出 → 转让给第一位成员
    g.ownerId = g.memberIds[0] || null;
  }
  save();
  return { ok: true };
}

/** 解散群聊：仅群主可操作 */
export function deleteGroup(userId, groupId) {
  const g = db().groups.find((x) => x.id === groupId);
  if (!g) return { error: '群不存在' };
  if (g.ownerId !== userId) return { error: '只有群主才能解散该群聊' };
  db().groups = db().groups.filter((x) => x.id !== groupId);
  // 同时清理该群的消息与已读记录
  db().messages = db().messages.filter((m) => m.conversationId !== `group:${groupId}`);
  saveNow();
  return { ok: true, group: serializeGroup(g, userId) };
}

export function listGroups(userId) {
  return db()
    .groups.filter((g) => g.memberIds.includes(userId))
    .map((g) => serializeGroup(g, userId));
}

/** 可加入的群：自己不在其中的群 */
export function listAllGroups(userId) {
  return db()
    .groups.filter((g) => !g.memberIds.includes(userId))
    .map((g) => serializeGroup(g, userId));
}

export function serializeGroup(g, viewerId) {
  return {
    id: g.id,
    name: g.name,
    description: g.description || '',
    ownerId: g.ownerId,
    isOwner: g.ownerId === viewerId,
    avatarColor: g.avatarColor,
    createdAt: g.createdAt,
    memberCount: g.memberIds.length,
    members: g.memberIds.map((id) => {
      const u = db().users.find((x) => x.id === id);
      return u ? { ...publicUser(u), isOwner: id === g.ownerId } : null;
    }).filter(Boolean)
  };
}

export function isGroupMember(groupId, userId) {
  const g = db().groups.find((x) => x.id === groupId);
  return !!g && g.memberIds.includes(userId);
}

// ============ 自定义表情包 ============

/** 添加一张自定义表情包 */
export function addSticker(userId, { url, name = '' }) {
  if (!url) return { error: '缺少表情包图片' };
  const sticker = {
    id: nextId('s'),
    userId,
    url,
    name: String(name).trim().slice(0, 30),
    createdAt: Date.now()
  };
  db().stickers.push(sticker);
  saveNow();
  return { sticker };
}

/** 我上传的自定义表情包 */
export function listStickers(userId) {
  return db()
    .stickers.filter((s) => s.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((s) => ({ ...s }));
}

/** 删除自定义表情包（仅本人） */
export function removeSticker(userId, stickerId) {
  const s = db().stickers.find((x) => x.id === stickerId);
  if (!s) return { error: '表情包不存在' };
  if (s.userId !== userId) return { error: '无权删除他人的表情包' };
  db().stickers = db().stickers.filter((x) => x.id !== stickerId);
  save();
  return { ok: true, url: s.url };
}

// ============ 消息 ============

/**
 * 保存消息。type: text | emoji | image | sticker
 * 单聊：conversationId = `dm:<userIdA>:<userIdB>`（按 id 排序）
 * 群聊：conversationId = `group:<groupId>`
 */
export function createMessage({ fromUserId, toType, toId, content, type = 'text' }) {
  const sender = db().users.find((u) => u.id === fromUserId);
  if (!sender) return { error: '用户不存在' };
  const text = String(content || '').trim();
  if (!text) return { error: '消息内容不能为空' };

  const msgType = ['text', 'emoji', 'image', 'sticker'].includes(type) ? type : 'text';
  if (msgType === 'text' && text.length > 5000) return { error: '消息过长' };
  // 图片/表情包内容为 URL，长度限制放宽
  if (msgType !== 'text' && text.length > 500) return { error: '内容过长' };

  let conversationId = '';
  let participants = [];

  if (toType === 'group') {
    const g = db().groups.find((x) => x.id === toId);
    if (!g) return { error: '群不存在' };
    if (!g.memberIds.includes(fromUserId)) return { error: '你不是该群成员' };
    conversationId = `group:${g.id}`;
    participants = g.memberIds.slice();
  } else {
    const peer = db().users.find((u) => u.id === toId);
    if (!peer) return { error: '对方不存在' };
    if (peer.id === fromUserId) return { error: '不能给自己发消息' };
    const ids = [fromUserId, toId].sort();
    conversationId = `dm:${ids[0]}:${ids[1]}`;
    participants = ids;
  }

  const msg = {
    id: nextId('m'),
    conversationId,
    type: msgType,
    content: text,
    from: fromUserId,
    fromName: sender.nickname || sender.username,
    toType,
    toId,
    createdAt: Date.now(),
    participants
  };
  db().messages.push(msg);
  // 每个会话最多保留 2000 条历史
  const sameConv = db().messages.filter((m) => m.conversationId === conversationId);
  if (sameConv.length > 2000) {
    const cut = sameConv.slice(0, sameConv.length - 2000);
    const cutIds = new Set(cut.map((m) => m.id));
    db().messages = db().messages.filter((m) => !cutIds.has(m.id));
  }
  save();
  return { message: serializeMessage(msg) };
}

export function serializeMessage(m) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    type: m.type,
    content: m.content,
    from: m.from,
    fromName: m.fromName,
    toType: m.toType,
    toId: m.toId,
    createdAt: m.createdAt,
    // 广播需要：会话参与者（含发送者），前端也可据此判断是否与自己相关
    participants: m.participants || []
  };
}

/** 拉取历史消息（最近 limit 条，倒序返回后转为正序） */
export function listMessages(userId, conversationId, limit = 50) {
  const conv = db().messages.filter((m) => m.conversationId === conversationId && m.participants.includes(userId));
  return conv.slice(-limit).map(serializeMessage);
}

export function dmConversationId(a, b) {
  const ids = [a, b].sort();
  return `dm:${ids[0]}:${ids[1]}`;
}

// ============ 会话列表 ============

/** 会话列表里显示的最后一条消息摘要 */
export function previewText(m) {
  if (m.type === 'image') return '[图片]';
  if (m.type === 'sticker') return '[表情包]';
  return m.content;
}

/** 我最近的消息会话，按最后一条消息时间倒序 */
export function listConversations(userId) {
  const convMap = new Map();
  for (const m of db().messages) {
    if (!m.participants.includes(userId)) continue;
    const cur = convMap.get(m.conversationId);
    if (!cur || m.createdAt > cur.createdAt) convMap.set(m.conversationId, m);
  }
  return [...convMap.values()]
    .sort((x, y) => y.createdAt - x.createdAt)
    .map((m) => {
      const unread = db().messages.filter(
        (x) => x.conversationId === m.conversationId && x.from !== userId && !isRead(userId, x.id)
      ).length;
      if (m.conversationId.startsWith('group:')) {
        const gid = m.conversationId.slice(6);
        const g = db().groups.find((x) => x.id === gid);
        return {
          conversationId: m.conversationId,
          type: 'group',
          targetId: gid,
          title: g ? g.name : '已解散的群',
          avatarColor: g ? g.avatarColor : '#8f959e',
          lastMessage: previewText(m),
          lastTime: m.createdAt,
          unread
        };
      }
      const peerId = m.participants.find((p) => p !== userId);
      const peer = db().users.find((u) => u.id === peerId);
      return {
        conversationId: m.conversationId,
        type: 'dm',
        targetId: peerId,
        title: peer ? peer.nickname || peer.username : '未知用户',
        avatarColor: peer ? peer.avatarColor : '#8f959e',
        avatar: peer ? peer.avatar || '' : '',
        lastMessage: previewText(m),
        lastTime: m.createdAt,
        unread
      };
    });
}

export function isRead(userId, messageId) {
  const r = db().reads[userId];
  return !!(r && r[messageId]);
}

export function markRead(userId, conversationId) {
  const unread = db().messages.filter(
    (m) => m.conversationId === conversationId && m.from !== userId && !isRead(userId, m.id)
  );
  if (!db().reads[userId]) db().reads[userId] = {};
  for (const m of unread) db().reads[userId][m.id] = Date.now();
  if (unread.length) save();
  return unread.length;
}
