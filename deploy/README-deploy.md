# 微聊 - 生产环境部署手册

> 目标：把「微聊」后端从本机测试环境迁移到 **约 ¥70/年的云服务器**（阿里云/腾讯云轻量应用服务器均可）。
> 当前本机部署**保留不动**，作为测试服务。

---

## 0. 现在有两套环境

| 环境 | 地址 | 作用 |
|---|---|---|
| **测试服务**（现有） | `https://lixiaofeng-ql.github.io/weiliao/` + 本机 Cloudflare 隧道 | 开发调试，随时可重装 |
| **正式服务**（新） | `https://你的域名/` → 云服务器 | 长期使用，数据独立 |

前端 `config.js` 支持**多后端候选**：

```js
apiBases: [
  'https://你的域名',            // [0] 主：正式服务器
  'https://xxx.trycloudflare.com' // [1] 备：测试隧道
]
```

客户端会**自动探测**：主地址不通时无缝切到备用，WebSocket 断线重连时也会自动轮换。
所以两套服务可以并存，互不影响。

---

## 1. 你需要准备什么

### 1.1 云服务器（约 ¥70/年）

推荐：**腾讯云轻量应用服务器** 或 **阿里云轻量应用服务器** 2核2G、3~4Mbps、40GB SSD。

- 操作系统：**Ubuntu 22.04 / 24.04 LTS**（脚本按 Debian 系写的）
- 地域：选离你近的（国内访问快）
- 购买后拿到：**公网 IP**、**root 密码**

### 1.2 域名（约 ¥75/年）

如果你还没有域名，两个选择：

| 方案 | 年费 | 适用 |
|---|---|---|
| **买独立域名**（`.com` 约 ¥75/年） | ¥75 | 一步到位，推荐 |
| **用 Cloudflare 命名隧道 + 已有域名** | ¥0 | 你已有域名时选这个 |

> 💡 不想买域名也有折中：直接用服务器公网 IP + `http://IP:3000`，
> 但**没有 HTTPS**，手机浏览器会拦 WebSocket，且微信内置浏览器体验差。**不推荐**。

---

## 2. 一键部署（推荐）

### 2.1 安全组放行端口

在云服务商控制台 → 安全组 → 添加入方向规则：

| 协议 | 端口 | 用途 |
|---|---|---|
| TCP | 22 | SSH |
| TCP | 80 | HTTP（证书申请 + 跳转） |
| TCP | 443 | HTTPS + WebSocket |

### 2.2 SSH 连上服务器

```bash
# Windows PowerShell
ssh root@你的服务器公网IP
# 首次连接输入 yes，然后输密码
```

### 2.3 上传并执行部署脚本

在服务器上执行：

```bash
# 拉取项目
git clone https://github.com/lixiaofeng-ql/weiliao.git /tmp/weiliao
cd /tmp/weiliao

# 一键部署（把域名和密码换成你的）
sudo bash deploy/deploy.sh \
  --domain weiliao.example.com \
  --admin-pass '你的强密码'
```

脚本自动完成：
1. 装 Node.js 20 + Nginx + certbot
2. 克隆代码到 `/opt/weiliao`
3. `npm install`
4. 注册 systemd 服务（开机自启 + 崩溃自动重启）
5. 写 Nginx 反代配置（含 WebSocket 升级）
6. 申请并自动续签 HTTPS 证书
7. 健康自检

### 2.4 解析域名

在域名 DNS 控制台加一条 **A 记录**：

| 类型 | 主机记录 | 记录值 | 线路 |
|---|---|---|---|
| A | `weiliao`（或 `@`） | 你的服务器公网 IP | 默认 |

> 解析生效后重跑一次证书申请（如果部署时还没生效）：
> ```bash
> certbot --nginx -d weiliao.example.com --non-interactive --agree-tos --register-unsafely-without-email --redirect
> ```

---

## 3. 部署完成后：切前端地址

### 3.1 改 `client/public/config.js`

```js
window.WL_CONFIG = {
  apiBases: [
    'https://weiliao.example.com',                    // 主：正式服务器
    'https://investing-fallen-nest-justice.trycloudflare.com' // 备：测试隧道
  ],
  apiBase: 'https://weiliao.example.com',
  wsBase: 'wss://weiliao.example.com/ws'
};
```

### 3.2 推送，Pages 自动发布

```bash
git add client/public/config.js
git commit -m "chore: 切换到正式服务器"
git push origin main
```

> Pages 发布有 1–2 分钟延迟 + 600 秒 CDN 缓存，
> 前端已内置「拉不到就换备用地址」的自愈逻辑，不用等。

### 3.3 验证

```bash
# 正式服务器
curl https://weiliao.example.com/api/health

# 页面
curl -I https://lixiaofeng-ql.github.io/weiliao/
```

---

## 4. 数据迁移（把测试环境的账号搬过去）

如果你想把本机测试环境的用户/群/消息搬到正式服务器：

```bash
# 1. 本机打包数据库
cd /path/to/weiliao/server/data
tar czf weiliao-data.tar.gz db.json uploads/

# 2. 传到服务器
scp weiliao-data.tar.gz root@你的IP:/tmp/

# 3. 服务器上先停服务，再覆盖
ssh root@你的IP
systemctl stop weiliao
cd /opt/weiliao/data
tar xzf /tmp/weiliao-data.tar.gz
systemctl start weiliao
```

> ⚠️ **重要**：`db.json` 里存着密码的 scrypt 散列，迁移后**原密码依然有效**。
> 但 **E2EE 私钥**也在里面 —— 迁移后用户在新服务器上能用**原密码**解锁私钥，
> 历史消息照常可解密。这正是零知识设计的好处：换服务器不需要重新生成密钥。

---

## 5. 日常运维

```bash
# 状态 / 重启 / 停止
systemctl status weiliao
systemctl restart weiliao
systemctl stop weiliao

# 实时日志
journalctl -u weiliao -f

# 手动备份数据库
cp /opt/weiliao/data/db.json /opt/weiliao/data/db.json.$(date +%F-%H%M%S)

# 更新代码（保留数据）
cd /opt/weiliao && git pull && cd server && npm install --omit=dev && systemctl restart weiliao
```

### 自动备份（推荐加一条 crontab）

```bash
crontab -e
# 每天 3:00 备份，保留 14 份
0 3 * * * cp /opt/weiliao/data/db.json /opt/weiliao/data/backups/db.$(date +\%F).json
```

> 服务端本身已内置**每 10 分钟自动备份 + 保留 20 份 + 崩溃自动从备份恢复**
> （见 `server/src/db.js`），crontab 只是双保险。

### 防火墙

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

---

## 6. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `nginx -t` 报 `could not build server names` | DNS 还没解析到本机，先等解析生效 |
| certbot 报 `Timeout during connect` | 安全组没放行 80，或云防火墙未开 |
| 页面能开但聊天没反应 | WebSocket 被拦，检查 Nginx 的 `location /ws` 配置存在 |
| 502 Bad Gateway | Node 服务没起来：`systemctl status weiliao` 看日志 |
| 手机上 `wss://` 连不上 | 证书没签发成功，`https://` 能开再检查 `wsBase` 协议头 |
| 数据库写入失败 | 目录权限：`chown -R root:root /opt/weiliao/data` |

---

## 7. 不想要域名？用 Cloudflare 命名隧道（服务器上也跑）

如果**不想买域名**但已有 Cloudflare 账号，可以在这台服务器上跑命名隧道：

```bash
# 1. 服务器上装 cloudflared
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg.key | \
  gpg --dearmor -o /usr/share/keyrings/cloudflare.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare.gpg] https://pkg.cloudflare.com/cloudflared any main" > \
  /etc/apt/sources.list.d/cloudflared.list
apt-get update && apt-get install -y cloudflared

# 2. 登录（在服务器上执行，会输出一个链接，用浏览器授权）
cloudflared tunnel login

# 3. 创建隧道
cloudflared tunnel create weiliao
```

之后在 Cloudflare Dashboard 里把 `chat.你的域名` 的 CNAME 指向隧道，
并把 `deploy/cloudflared.yml` 放到 `/etc/cloudflared/config.yml`，
再起一个 systemd 服务跑 `cloudflared tunnel run weiliao`。

> 优点：**不占用服务器 80/443 端口**，也不需要开放安全组。
> 缺点：多一层 Cloudflare 中转，延迟略高。

---

## 8. 环境隔离确认

| | 测试服务 | 正式服务 |
|---|---|---|
| 前端 | 同一个 Pages 站点 | 同一个 Pages 站点 |
| 后端地址 | `config.js` 候选[1] | `config.js` 候选[0] |
| 数据库 | 本机 `server/data/db.json` | 服务器 `/opt/weiliao/data/db.json` |
| 上传文件 | 本机 `server/data/uploads/` | 服务器 `/opt/weiliao/data/uploads/` |
| 管理员 | 同上（各自独立） | 同上（各自独立） |

**两边数据完全隔离，互不影响。** 正式服务稳定后可以把测试环境的隧道候选删掉。
