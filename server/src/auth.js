/**
 * 账号密码与会话令牌工具。
 * - 密码使用 scrypt + 随机 salt，不可逆存储
 * - 登录态使用随机 token，服务端保存（重启后仍有效）
 */
import crypto from 'node:crypto';
import { db, save, saveNow, nextId } from './db.js';

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, hash) {
  try {
    const target = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    if (target.length !== expected.length) return false;
    return crypto.timingSafeEqual(target, expected);
  } catch {
    return false;
  }
}

export function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db().sessions.push({
    token,
    userId,
    createdAt: Date.now(),
    lastActiveAt: Date.now()
  });
  // 清理过期会话
  const now = Date.now();
  db().sessions = db().sessions.filter((s) => now - s.lastActiveAt < 30 * 24 * 3600 * 1000);
  save();
  return token;
}

export function destroySession(token) {
  db().sessions = db().sessions.filter((s) => s.token !== token);
  save();
}

export function userByToken(token) {
  if (!token) return null;
  const sess = db().sessions.find((s) => s.token === token);
  if (!sess) return null;
  sess.lastActiveAt = Date.now();
  const user = db().users.find((u) => u.id === sess.userId);
  return user || null;
}

/** 对外暴露的安全用户信息，绝不返回密码散列 */
export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    nickname: user.nickname || user.username,
    avatarColor: user.avatarColor || '#2b6de8',
    // 自定义头像图片地址（为空则回退为 avatarColor + 首字）
    avatar: user.avatar || '',
    isAdmin: !!user.isAdmin,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    // 加密相关：只暴露公钥，绝不暴露私钥密文之外的任何东西
    cryptoPublicKey: user.cryptoPublicKey || '',
    cryptoSigPublicKey: user.cryptoSigPublicKey || ''
  };
}

export function createUser({ username, password, nickname, isAdmin = false }) {
  const user = {
    id: nextId('u'),
    username,
    nickname: nickname || username,
    passwordSalt: '',
    passwordHash: '',
    avatarColor: randomColor(),
    avatar: '',
    isAdmin,
    // 端到端加密：身份密钥材料
    cryptoSalt: '',
    cryptoPublicKey: '',
    cryptoSigPublicKey: '',
    cryptoEncPrivate: '',
    cryptoSigPrivate: '',
    createdAt: Date.now(),
    lastLoginAt: null
  };
  const { salt, hash } = hashPassword(password);
  user.passwordSalt = salt;
  user.passwordHash = hash;
  db().users.push(user);
  // 关键数据：立即落盘，避免进程异常导致注册丢失
  saveNow();
  return user;
}

const COLORS = ['#2b6de8', '#0f8a5f', '#c47b0a', '#7c4dff', '#d43838', '#00a0a8', '#e06c9f', '#3f6f3f'];
export function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}
