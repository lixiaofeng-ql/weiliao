/**
 * 生成 PWA 图标（纯 Node，无第三方依赖）。
 * 手写 PNG 编码：IHDR + IDAT(zlib) + IEND
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'client', 'public', 'icons');

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 画一个圆角方块 + 「微」字样感的色块图标 */
function makeIcon(size) {
  const bytesPerPixel = 4;
  const raw = Buffer.alloc(size * (size * bytesPerPixel + 1));

  const bg = [43, 109, 232];      // #2b6de8
  const accent = [91, 141, 239];  // 渐变亮部
  const radius = Math.round(size * 0.22);

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * bytesPerPixel + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const i = rowStart + 1 + x * bytesPerPixel;

      // 圆角判定
      let inside = true;
      const cx = x < radius ? radius : x >= size - radius ? size - radius - 1 : x;
      const cy = y < radius ? radius : y >= size - radius ? size - radius - 1 : y;
      const dx = x - cx;
      const dy = y - cy;
      if ((x < radius || x >= size - radius) && (y < radius || y >= size - radius)) {
        inside = dx * dx + dy * dy <= radius * radius;
      }

      if (!inside) {
        raw[i] = 0; raw[i + 1] = 0; raw[i + 2] = 0; raw[i + 3] = 0;
        continue;
      }

      // 线性渐变
      const t = (x + y) / (2 * size);
      const r = Math.round(bg[0] + (accent[0] - bg[0]) * t);
      const g = Math.round(bg[1] + (accent[1] - bg[1]) * t);
      const b = Math.round(bg[2] + (accent[2] - bg[2]) * t);
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255;
    }
  }

  // 居中画一个白色对话气泡
  const cx = size / 2;
  const cy = size / 2;
  const bw = size * 0.46;
  const bh = size * 0.36;
  const br = size * 0.09;
  const bubbleTop = cy - bh * 0.62;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * bytesPerPixel + 1);
    for (let x = 0; x < size; x++) {
      const i = rowStart + 1 + x * bytesPerPixel;
      if (raw[i + 3] === 0) continue;

      const bx = Math.max(Math.abs(x - cx) - (bw / 2 - br), 0);
      const by = Math.max(Math.abs(y - (bubbleTop + bh / 2)) - (bh / 2 - br), 0);
      const inBubble = bx * bx + by * by <= br * br;

      // 小尾巴
      const tailX = cx - bw * 0.28;
      const tailY = bubbleTop + bh - 1;
      const inTail =
        Math.abs(x - tailX) <= size * 0.05 &&
        y > tailY &&
        y <= tailY + size * 0.1 &&
        Math.abs(x - tailX) <= (tailY + size * 0.1 - y);

      if (inBubble || inTail) {
        raw[i] = 255; raw[i + 1] = 255; raw[i + 2] = 255;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(file, makeIcon(size));
  console.log('[icons] 已生成', file);
}
