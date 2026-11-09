/**
 * 极简 JSON 存储：无需原生依赖，跨平台开箱即用。
 * 数据落在 server/data/db.json，写入采用「临时文件 + rename」原子替换。
 *
 * 数据安全要点：
 * 1. saveNow()  —— 关键操作（注册/建群/改资料）立即落盘，不走延迟队列
 * 2. save()     —— 高频操作（发消息）延迟合并写入，避免频繁 IO
 * 3. 定时备份   —— 每 10 分钟把 db.json 复制一份到 backups/，保留最近 N 份
 * 4. 备份校验   —— 启动时若主文件损坏，自动从最近备份恢复
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 支持用 WL_DATA_DIR 指定数据目录（测试隔离用），默认 server/data
export const DATA_DIR = process.env.WL_DATA_DIR
  ? path.resolve(process.env.WL_DATA_DIR)
  : path.resolve(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

/** 最新快照文件名（每次关键操作后覆盖，灾难恢复时优先使用） */
const LATEST_FILE = 'latest.json';

/** 备份保留份数 */
const MAX_BACKUPS = 20;
/** 备份间隔（毫秒） */
const BACKUP_INTERVAL = 10 * 60 * 1000;

const EMPTY = {
  users: [],
  sessions: [],
  friendships: [],
  groups: [],
  messages: [],
  reads: {},
  // 用户自定义表情包：{ id, userId, url, name, createdAt }
  stickers: [],
  seq: {}
};

let state = structuredClone(EMPTY);
let writeTimer = null;
let backupTimer = null;
let dirty = false;

export function db() {
  return state;
}

/** 确保数据目录存在 */
function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

/**
 * 启动时加载数据。
 * 主文件缺失或损坏时，自动尝试从 backups/ 里最近一份可用的备份恢复。
 */
export function load() {
  try {
    ensureDirs();

    if (fs.existsSync(DB_FILE)) {
      const parsed = tryReadJson(DB_FILE);
      if (parsed) {
        state = Object.assign(structuredClone(EMPTY), parsed);
        state.reads = state.reads || {};
        state.seq = state.seq || {};
        console.log('[db] 已加载', DB_FILE, '用户数:', state.users.length);
        startBackupTimer();
        return state;
      }
      console.error('[db] 主数据文件损坏，尝试从备份恢复...');
    } else {
      console.log('[db] 新建数据库', DB_FILE);
    }

    // 主文件不可用 -> 从备份恢复
    const restored = restoreFromBackup();
    if (restored) {
      console.log('[db] 已从备份恢复，用户数:', state.users.length);
    } else {
      state = structuredClone(EMPTY);
      persistNow();
    }
    startBackupTimer();
  } catch (e) {
    console.error('[db] 加载失败，使用空数据', e);
    state = structuredClone(EMPTY);
  }
  return state;
}

/** 读取并解析 JSON，失败返回 null */
function tryReadJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.users)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 从备份目录恢复数据。
 * 优先级：latest.json（最近一次关键操作快照） > 按时间倒序的历史备份
 */
function restoreFromBackup() {
  let files = [];
  try {
    files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return false;
  }

  // 最新快照优先
  const candidates = [];
  if (files.includes(LATEST_FILE)) candidates.push(LATEST_FILE);
  const history = files
    .filter((f) => f !== LATEST_FILE)
    .sort()
    .reverse();
  candidates.push(...history);

  for (const f of candidates) {
    const parsed = tryReadJson(path.join(BACKUP_DIR, f));
    if (parsed) {
      state = Object.assign(structuredClone(EMPTY), parsed);
      state.reads = state.reads || {};
      state.seq = state.seq || {};
      console.log('[db] 使用备份文件:', f);
      // 立刻把恢复后的数据写回主文件
      persistNow();
      return true;
    }
  }
  return false;
}

/**
 * 生成「最新快照」（固定文件名）。
 * 每次关键操作（注册/改资料/建群等）后调用，保证灾难恢复能拿回最近状态。
 */
function snapshot() {
  try {
    ensureDirs();
    const file = path.join(BACKUP_DIR, LATEST_FILE);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('[db] 快照失败', e);
  }
}

/**
 * 延迟合并写入，避免高频发消息时频繁落盘。
 * 注意：注册 / 建群 / 改资料等关键操作请调用 saveNow()。
 */
export function save() {
  dirty = true;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    persistNow();
  }, 200);
}

/**
 * 立即落盘（关键数据变更时使用）。
 * 会等待已排队的延迟写入完成，确保数据真正写到磁盘。
 * 额外生成一份「最新快照」，保证灾难恢复时能拿回最近的关键数据。
 */
export function saveNow() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  persistNow();
  snapshot();
}

/** 立即落盘（进程退出前调用） */
export function persistNow() {
  try {
    ensureDirs();
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, DB_FILE);
    dirty = false;
  } catch (e) {
    console.error('[db] 写入失败', e);
  }
}

/** 定时备份：把当前数据存一份到 backups/ */
export function backupNow() {
  try {
    ensureDirs();
    if (!fs.existsSync(DB_FILE)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(BACKUP_DIR, `db-${stamp}.json`);
    fs.copyFileSync(DB_FILE, file);

    // 同时刷新最新快照
    snapshot();

    // 清理过期备份，只保留最近 MAX_BACKUPS 份
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('db-') && f.endsWith('.json'))
      .sort();
    while (files.length > MAX_BACKUPS) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch { /* ignore */ }
    }
    console.log('[db] 已备份 ->', path.basename(file));
  } catch (e) {
    console.error('[db] 备份失败', e);
  }
}

/** 启动定时备份 */
function startBackupTimer() {
  if (backupTimer) return;
  backupTimer = setInterval(() => {
    if (dirty) persistNow();
    backupNow();
  }, BACKUP_INTERVAL);
  // 定时器不应阻止进程退出
  if (backupTimer.unref) backupTimer.unref();
  console.log('[db] 已启用定时备份（每 10 分钟一次，保留最近', MAX_BACKUPS, '份）');
}

/** 生成自增 id：u_1 / m_2 / g_3 ... */
export function nextId(prefix) {
  state.seq[prefix] = (state.seq[prefix] || 0) + 1;
  return `${prefix}_${state.seq[prefix]}`;
}
