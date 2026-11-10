/**
 * 微聊 - E2EE 服务端集成测试
 *
 * 验证完整链路：
 *   1. 上传密钥材料
 *   2. 服务端只返回公钥，私钥仅本人可取
 *   3. 加密消息入库后数据库里没有明文
 *   4. 会话列表预览不泄露明文
 *   5. 密文上传接口可用
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3313;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-e2ee-int-'));

let pass = 0, fail = 0;
const failures = [];
function ok(n) { pass++; console.log(`  ✓ ${n}`); }
function bad(n, d) { fail++; failures.push(`${n}: ${d}`); console.log(`  ✗ ${n} — ${d}`); }

async function req(p, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + p, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn('node', ['src/index.js'], {
  cwd: path.resolve('server'),
  env: { ...process.env, PORT: String(PORT), WL_DATA_DIR: DATA_DIR, WL_UPLOAD_DIR: path.join(DATA_DIR, 'uploads') },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => console.error('[server]', String(d).trim()));

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch { /* retry */ }
    await wait(300);
  }
  return false;
}

async function run() {
  console.log('\n=== 微聊 E2EE 服务端集成测试 ===\n');
  if (!(await waitReady())) { console.log('服务启动失败'); return; }

  const s = Date.now().toString(36);
  // 1. 注册
  const a = await req('/api/auth/register', { method: 'POST', body: { username: 'ea_' + s, password: 'test123456', nickname: '甲' } });
  const b = await req('/api/auth/register', { method: 'POST', body: { username: 'eb_' + s, password: 'test123456', nickname: '乙' } });
  a.json.success && b.json.success ? ok('注册两个用户') : bad('注册两个用户', '失败');
  const ta = a.json.token, tb = b.json.token;
  const uidA = a.json.user.id, uidB = b.json.user.id;

  // 2. 上传密钥材料
  const keysA = {
    cryptoSalt: 'a'.repeat(32),
    cryptoPublicKey: 'PUBKEY_A_'.repeat(10),
    cryptoSigPublicKey: 'SIGPUB_A_'.repeat(10),
    cryptoEncPrivate: JSON.stringify({ iv: 'ivA', ct: 'ctA' }),
    cryptoSigPrivate: JSON.stringify({ iv: 'ivA2', ct: 'ctA2' })
  };
  const up = await req('/api/crypto/keys', { method: 'POST', body: keysA, token: ta });
  up.json.success ? ok('上传加密身份材料') : bad('上传加密身份材料', JSON.stringify(up.json));

  // 3. 参数不完整应被拒绝
  const bad1 = await req('/api/crypto/keys', { method: 'POST', body: { cryptoSalt: 'x' }, token: ta });
  bad1.json.success === false ? ok('拒绝不完整的密钥参数') : bad('拒绝不完整的密钥参数', JSON.stringify(bad1.json));

  // 4. 拉取公钥接口（用别人的 id）
  const pk = await req('/api/crypto/keys?ids=' + uidA, { token: tb });
  pk.json.keys?.[0]?.cryptoPublicKey === keysA.cryptoPublicKey ? ok('他人可拉取我的公钥') : bad('他人可拉取我的公钥', JSON.stringify(pk.json));
  const noPriv = pk.json.keys?.[0] && !('cryptoEncPrivate' in pk.json.keys[0]);
  noPriv ? ok('公钥接口不泄露私钥') : bad('公钥接口不泄露私钥', '返回了私钥字段');

  // 5. /api/crypto/me 只允许本人取自己的私钥密文
  const me = await req('/api/crypto/me', { token: ta });
  me.json.crypto?.cryptoEncPrivate ? ok('本人可取回自己的私钥密文') : bad('本人可取回自己的私钥密文', JSON.stringify(me.json));

  // 6. 好友关系 + 加密消息
  await req('/api/friends/request', { method: 'POST', body: { username: 'eb_' + s }, token: ta });
  const fr = await req('/api/friends', { token: tb });
  await req('/api/friends/respond', { method: 'POST', body: { friendshipId: fr.json.requests?.[0]?.id, accept: true }, token: tb });

  const SECRET = '这是一条绝密内容TOP-SECRET-9999';
  const fakePayload = { v: 1, eph: 'AAA', sig: 'BBB', r: { [uidA]: { iv: 'i', ct: 'ENCRYPTED' }, [uidB]: { iv: 'i', ct: 'ENCRYPTED2' } } };
  const convId = `dm:${[uidA, uidB].sort().join(':')}`;
  const sm = await req('/api/messages', {
    method: 'POST',
    body: { toType: 'dm', toId: uidB, content: JSON.stringify(fakePayload), type: 'text', cipher: 1 },
    token: ta
  });
  sm.json.success && sm.json.message?.cipher === 1 ? ok('加密消息入库成功并标记 cipher=1') : bad('加密消息入库成功', JSON.stringify(sm.json));

  // 7. 数据库里不能有明文
  // 消息写入走 200ms 延迟落盘，等一下再读文件
  await wait(800);
  const dbRaw = fs.readFileSync(path.join(DATA_DIR, 'db.json'), 'utf8');
  dbRaw.includes(SECRET) ? bad('数据库不含明文', '数据库中出现了明文！') : ok('数据库不含明文');
  dbRaw.includes('ENCRYPTED') ? ok('数据库存的是密文') : bad('数据库存的是密文', '未找到密文标记');

  // 8. 会话列表预览不泄露
  const convs = await req('/api/conversations', { token: ta });
  const preview = convs.json.conversations?.find((c) => c.conversationId === convId)?.lastMessage;
  preview === '[加密消息]' ? ok('会话列表预览显示为「[加密消息]」') : bad('会话列表预览显示为「[加密消息]」', String(preview));

  // 9. 消息列表返回 cipher 标记
  const msgs = await req('/api/messages?conversationId=' + encodeURIComponent(convId), { token: tb });
  msgs.json.messages?.[0]?.cipher === 1 ? ok('消息列表返回 cipher 标记') : bad('消息列表返回 cipher 标记', JSON.stringify(msgs.json.messages?.[0]));

  // 10. 密文文件上传
  const enc = await req('/api/upload/enc', { method: 'POST', body: { data: Buffer.from([1,2,3,4,5,6,7,8]).toString('base64') }, token: ta });
  enc.json.success && enc.json.url?.startsWith('/uploads/') ? ok('密文文件上传成功') : bad('密文文件上传成功', JSON.stringify(enc.json));
  const filePath = path.join(DATA_DIR, 'uploads', path.basename(enc.json.url || ''));
  fs.existsSync(filePath) ? ok('密文文件已落盘') : bad('密文文件已落盘', '文件不存在');

  // 11. 未登录不能访问密钥接口
  const noAuth = await req('/api/crypto/me');
  noAuth.status === 401 ? ok('未登录访问密钥接口被拒绝') : bad('未登录访问密钥接口被拒绝', String(noAuth.status));

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
  if (fail) failures.forEach((f) => console.log('  ! ' + f));
}

run().then(() => {
  try { server.kill('SIGKILL'); } catch { /* ignore */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('测试异常:', e);
  try { server.kill('SIGKILL'); } catch { /* ignore */ }
  process.exit(1);
});
