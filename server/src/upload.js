/**
 * 图片上传：接收 base64 dataURL，落盘到 server/data/uploads/。
 * 不存进 db.json，避免数据文件被 base64 撑爆。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 支持用 WL_UPLOAD_DIR 指定上传目录（测试隔离用），默认 server/data/uploads
export const UPLOAD_DIR = process.env.WL_UPLOAD_DIR
  ? path.resolve(process.env.WL_UPLOAD_DIR)
  : path.resolve(__dirname, '..', 'data', 'uploads');

const MAX_BYTES = 3 * 1024 * 1024; // 单张 3MB
const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
};

/** 确保目录存在 */
export function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * 保存一张 base64 图片。
 * @param {string} dataUrl 形如 data:image/png;base64,xxxx
 * @returns {{url:string, bytes:number, mime:string} | {error:string}}
 */
export function saveImage(dataUrl, prefix = 'img') {
  if (typeof dataUrl !== 'string' || !dataUrl) {
    return { error: '缺少图片数据' };
  }
  const m = /^data:([a-z0-9/+.-]+);base64,(.+)$/i.exec(dataUrl.trim());
  if (!m) return { error: '图片格式不正确，请重新选择' };

  const mime = m[1].toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) return { error: '仅支持 PNG / JPG / GIF / WEBP 格式的图片' };

  let buf;
  try {
    buf = Buffer.from(m[2], 'base64');
  } catch {
    return { error: '图片解析失败' };
  }
  if (!buf.length) return { error: '图片内容为空' };
  if (buf.length > MAX_BYTES) return { error: '图片过大，请选择 3MB 以内的图片' };

  ensureUploadDir();
  const name = `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return { url: `/uploads/${name}`, bytes: buf.length, mime };
}

/** 删除已上传的文件 */
export function removeUpload(url) {
  if (!url || !url.startsWith('/uploads/')) return false;
  const name = path.basename(url);
  const full = path.join(UPLOAD_DIR, name);
  try {
    if (fs.existsSync(full)) {
      fs.unlinkSync(full);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}
