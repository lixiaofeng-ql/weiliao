/**
 * 极简 JSON 存储：无需原生依赖，跨平台开箱即用。
 * 数据落在 server/data/db.json，写入采用「临时文件 + rename」原子替换。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const EMPTY = {
  users: [],
  sessions: [],
  friendships: [],
  groups: [],
  messages: [],
  reads: {},
  seq: {}
};

let state = structuredClone(EMPTY);
let writeTimer = null;

export function db() {
  return state;
}

export function load() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      state = Object.assign(structuredClone(EMPTY), parsed);
      state.reads = state.reads || {};
      state.seq = state.seq || {};
      console.log('[db] 已加载', DB_FILE, '用户数:', state.users.length);
    } else {
      console.log('[db] 新建数据库', DB_FILE);
    }
  } catch (e) {
    console.error('[db] 加载失败，使用空数据', e);
    state = structuredClone(EMPTY);
  }
  return state;
}

/** 延迟合并写入，避免高频发消息时频繁落盘 */
export function save() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(persistNow, 200);
}

/** 立即落盘（进程退出前调用） */
export function persistNow() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('[db] 写入失败', e);
  }
}

/** 生成自增 id：u_1 / m_2 / g_3 ... */
export function nextId(prefix) {
  state.seq[prefix] = (state.seq[prefix] || 0) + 1;
  return `${prefix}_${state.seq[prefix]}`;
}
