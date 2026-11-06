/**
 * 下载微信风格斗图 GIF 表情包到 client/public/stickers/
 * 素材来源: github.com/willie4624/dinkiebitmapstickers (MIT/CC 协议)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'client', 'public', 'stickers');
const REPO = 'willie4624/dinkiebitmapstickers';
const API = 'https://api.github.com/repos/' + REPO + '/contents/gif';

fs.mkdirSync(OUT, { recursive: true });

const res = await fetch(API, { headers: { 'User-Agent': 'node' } });
const list = await res.json();
if (!Array.isArray(list)) throw new Error('获取文件列表失败: ' + JSON.stringify(list).slice(0, 200));

const gifs = list.filter((f) => f.name.endsWith('.gif'));
console.log('共发现', gifs.length, '个 GIF');

let ok = 0;
let fail = 0;
const manifest = [];

for (const f of gifs) {
  const target = path.join(OUT, f.name);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    manifest.push({ name: f.name, url: 'stickers/' + f.name });
    ok++;
    continue;
  }
  try {
    const raw = await fetch(f.download_url, { headers: { 'User-Agent': 'node' } });
    if (!raw.ok) throw new Error('HTTP ' + raw.status);
    const buf = Buffer.from(await raw.arrayBuffer());
    fs.writeFileSync(target, buf);
    manifest.push({ name: f.name, url: 'stickers/' + f.name });
    ok++;
    process.stdout.write('\r已下载 ' + ok + '/' + gifs.length);
  } catch (e) {
    fail++;
    console.error('\n失败 ' + f.name + ': ' + e.message);
  }
}

manifest.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(
  path.join(OUT, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
  'utf8'
);
console.log('\n完成：成功 ' + ok + '，失败 ' + fail);
console.log('清单已写入 client/public/stickers/manifest.json');
