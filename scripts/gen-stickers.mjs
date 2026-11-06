/**
 * 生成内置斗图表情包（纯 Node，无需第三方依赖）。
 * 用 node:zlib 手写最小 PNG 编码器，绘制简单表情图形。
 *   node scripts/gen-stickers.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'client', 'public', 'stickers');
const SIZE = 120;

/* ---------------- 最小 PNG 编码器 ---------------- */
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** rgba: Uint8Array(size*size*4) */
function encodePNG(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy
      ? Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
      : null;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 画布 ---------------- */
class Canvas {
  constructor(size) {
    this.size = size;
    this.buf = Buffer.alloc(size * size * 4);
  }
  set(x, y, [r, g, b, a = 255]) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y * this.size + x) * 4;
    const sa = a / 255;
    const da = this.buf[i + 3] / 255;
    const na = sa + da * (1 - sa);
    if (na === 0) return;
    this.buf[i] = Math.round((r * sa + this.buf[i] * da * (1 - sa)) / na);
    this.buf[i + 1] = Math.round((g * sa + this.buf[i + 1] * da * (1 - sa)) / na);
    this.buf[i + 2] = Math.round((b * sa + this.buf[i + 2] * da * (1 - sa)) / na);
    this.buf[i + 3] = Math.round(na * 255);
  }
  /** 抗锯齿填充椭圆 */
  ellipse(cx, cy, rx, ry, color) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const d = dx * dx + dy * dy;
        if (d <= 1) this.set(x, y, color);
      }
    }
  }
  /** 抗锯齿描边圆 */
  ring(cx, cy, r, width, color) {
    const outer = r + width / 2;
    const inner = r - width / 2;
    for (let y = Math.floor(cy - outer); y <= Math.ceil(cy + outer); y++) {
      for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= outer && d >= inner) this.set(x, y, color);
      }
    }
  }
  /** 圆角矩形 */
  roundRect(x0, y0, w, h, r, color) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const dx = Math.max(x0 + r - x, x - (x0 + w - 1 - r), 0);
        const dy = Math.max(y0 + r - y, y - (y0 + h - 1 - r), 0);
        if (dx * dx + dy * dy <= r * r) this.set(x, y, color);
      }
    }
  }
  /** 眼睛（黑点） */
  eye(cx, cy, r = 6, color = [30, 30, 40, 255]) {
    this.ellipse(cx, cy, r, r, color);
  }
  /** 嘴：smile / frown / open / flat */
  mouth(cx, cy, w, kind, color = [30, 30, 40, 255], thick = 4) {
    for (let t = -1; t <= 1.0001; t += 0.02) {
      const x = cx + t * w;
      let y;
      if (kind === 'smile') y = cy - Math.cos(t * 1.2) * 0 + (t * t) * 12;
      else if (kind === 'frown') y = cy - (t * t) * 12;
      else if (kind === 'flat') y = cy;
      else y = cy;
      if (kind === 'open') {
        this.ellipse(x, cy, thick * 0.8, thick * 0.8, color);
      } else {
        this.ellipse(x, y, thick, thick, color);
      }
    }
  }
  /** 泪水/汗滴 */
  drop(cx, cy, s, color = [90, 180, 240, 235]) {
    this.ellipse(cx, cy + s * 0.3, s * 0.7, s, color);
  }
}

/* ---------------- 表情定义 ---------------- */
const YELLOW = [255, 214, 92, 255];
const YELLOW_D = [240, 186, 50, 255];
const WHITE = [255, 255, 255, 255];
const BLACK = [38, 38, 48, 255];
const RED = [235, 78, 78, 255];
const MOUTH_OPEN = [150, 60, 60, 255];

const STICKERS = [
  {
    name: '开心',
    draw(c) {
      c.ellipse(60, 62, 46, 46, YELLOW);
      c.eye(44, 52, 6, BLACK);
      c.eye(76, 52, 6, BLACK);
      c.mouth(60, 70, 16, 'smile', BLACK, 4);
      c.ellipse(33, 64, 8, 5, [255, 150, 150, 130]);
      c.ellipse(87, 64, 8, 5, [255, 150, 150, 130]);
    }
  },
  {
    name: '大笑',
    draw(c) {
      c.ellipse(60, 62, 46, 46, YELLOW);
      c.ellipse(44, 50, 7, 8, BLACK);
      c.ellipse(76, 50, 7, 8, BLACK);
      c.ellipse(60, 74, 15, 11, MOUTH_OPEN);
      c.ellipse(60, 80, 8, 5, RED);
    }
  },
  {
    name: '无语',
    draw(c) {
      c.ellipse(60, 62, 46, 46, YELLOW);
      c.eye(44, 52, 6, BLACK);
      c.eye(76, 52, 6, BLACK);
      c.mouth(60, 74, 14, 'flat', BLACK, 4);
      c.drop(94, 40, 7);
    }
  },
  {
    name: '生气',
    draw(c) {
      c.ellipse(60, 62, 46, 46, [240, 120, 90, 255]);
      c.eye(44, 50, 6, BLACK);
      c.eye(76, 50, 6, BLACK);
      c.mouth(60, 78, 14, 'frown', BLACK, 4);
      // 怒气符号
      c.ring(92, 30, 9, 3, RED);
      c.ring(30, 26, 6, 3, RED);
    }
  },
  {
    name: '哭泣',
    draw(c) {
      c.ellipse(60, 62, 46, 46, YELLOW);
      c.eye(44, 50, 6, BLACK);
      c.eye(76, 50, 6, BLACK);
      c.mouth(60, 76, 14, 'frown', BLACK, 4);
      c.drop(42, 68, 8);
      c.drop(78, 68, 8);
    }
  },
  {
    name: '惊讶',
    draw(c) {
      c.ellipse(60, 62, 46, 46, YELLOW);
      c.eye(44, 48, 7, BLACK);
      c.eye(76, 48, 7, BLACK);
      c.ellipse(60, 78, 9, 11, MOUTH_OPEN);
    }
  },
  {
    name: '点赞',
    draw(c) {
      c.ellipse(60, 62, 46, 46, YELLOW);
      c.eye(44, 50, 6, BLACK);
      c.eye(76, 50, 6, BLACK);
      c.mouth(60, 72, 14, 'smile', BLACK, 4);
      // 竖起大拇指
      c.roundRect(84, 22, 16, 26, 8, YELLOW_D);
      c.roundRect(80, 44, 24, 18, 8, YELLOW);
    }
  },
  {
    name: '拍桌',
    draw(c) {
      c.ellipse(60, 60, 44, 44, YELLOW);
      c.eye(42, 48, 6, BLACK);
      c.eye(78, 48, 6, BLACK);
      c.mouth(60, 74, 16, 'open', BLACK, 5);
      // 冲击线
      for (let i = 0; i < 5; i++) {
        const a = -0.9 + i * 0.45;
        c.ellipse(60 + Math.cos(a) * 52, 60 + Math.sin(a) * 52, 4, 8, [255, 190, 60, 220]);
      }
    }
  },
  {
    name: '害羞',
    draw(c) {
      c.ellipse(60, 62, 46, 46, YELLOW);
      c.eye(44, 52, 6, BLACK);
      c.eye(76, 52, 6, BLACK);
      c.mouth(60, 74, 10, 'smile', BLACK, 3);
      c.ellipse(30, 66, 10, 7, [255, 130, 140, 190]);
      c.ellipse(90, 66, 10, 7, [255, 130, 140, 190]);
    }
  },
  {
    name: '加油',
    draw(c) {
      c.ellipse(60, 62, 46, 46, YELLOW);
      c.eye(44, 50, 6, BLACK);
      c.eye(76, 50, 6, BLACK);
      c.mouth(60, 72, 15, 'smile', BLACK, 4);
      // 挥舞的小旗
      c.roundRect(84, 30, 3, 26, 1, [120, 120, 130, 255]);
      c.roundRect(87, 30, 16, 11, 2, RED);
    }
  },
  {
    name: '问号',
    draw(c) {
      c.ellipse(60, 62, 46, 46, YELLOW);
      c.eye(44, 50, 6, BLACK);
      c.eye(76, 50, 6, BLACK);
      c.mouth(60, 78, 10, 'flat', BLACK, 4);
      c.ellipse(92, 34, 12, 12, [255, 255, 255, 235]);
      c.ellipse(92, 34, 5, 5, BLACK);
      c.roundRect(89, 38, 6, 12, 3, [255, 255, 255, 235]);
    }
  },
  {
    name: '心心',
    draw(c) {
      c.ellipse(46, 48, 20, 20, RED);
      c.ellipse(74, 48, 20, 20, RED);
      c.ellipse(60, 70, 26, 24, RED);
      c.ellipse(52, 62, 7, 5, [255, 190, 195, 220]);
    }
  }
];

/* ---------------- 生成 ---------------- */
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const manifest = [];
for (const st of STICKERS) {
  const c = new Canvas(SIZE);
  st.draw(c);
  const png = encodePNG(c.buf, SIZE);
  const file = `${st.name}.png`;
  fs.writeFileSync(path.join(OUT_DIR, file), png);
  manifest.push({ name: st.name, url: `stickers/${file}` });
  console.log('[sticker]', file, png.length, 'bytes');
}

// 写入 manifest 供前端读取
fs.writeFileSync(
  path.join(OUT_DIR, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
  'utf8'
);
console.log('[done] 共生成', manifest.length, '个表情包 →', OUT_DIR);
