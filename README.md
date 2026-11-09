# 微聊 Weiliao

轻量级即时通讯系统 —— 注册登录、好友、单聊/群聊、表情、管理后台。

技术栈：**原生 JS 前端 + Node.js/Express + WebSocket**，数据存 JSON 文件，零数据库依赖。

## 功能

| 模块 | 说明 |
|---|---|
| 注册 / 登录 | 账号密码注册，密码 scrypt 加盐不可逆存储，token 会话 |
| 好友 | 通过账号搜索添加、申请 / 同意 / 拒绝、好友列表、删除好友 |
| 私聊 | WebSocket 实时推送、历史消息、未读数、已读回执 |
| 群聊 | 创建群、邀请好友入群、加入群、成员列表、群消息、**群主可解散群聊** |
| 表情 | 内置 144 个表情面板，表情消息独立样式 |
| 斗图表情包 | **内置 151 个 GIF 斗图** + 用户可自行上传 / 删除自定义表情包 |
| 自定义头像 | 上传本地图片作头像，8 种底色可选，实时同步给好友 |
| 图片消息 | 聊天页可直接发送图片（自动压缩 + 上传） |
| 消息提醒 | **提示音（WebAudio 双音）+ 桌面通知 + 浏览器标题未读角标**，三者可分别开关 |
| 管理后台 | `admin` 账号可查看注册账号总数、在线人数、用户明细、删除用户 |
| 快捷入口 | 侧边菜单内置「神经科学」入口，直达 shengjing 项目 |
| PWA | 安卓 Chrome 可「添加到主屏幕」安装为 App；iOS Safari 支持添加到主屏幕 |

## 快速开始

```bash
# 1. 安装依赖
npm run install:server

# 2. 启动服务（默认 3000 端口）
npm start

# 3. 浏览器打开
#    http://localhost:3000
```

管理员初始账号：**admin / admin123**（可用环境变量 `ADMIN_USER` / `ADMIN_PASS` 覆盖）

自定义端口：

```bash
PORT=8080 npm start
```

## 目录结构

```
weiliao/
├── client/public/          # 前端（静态文件，无需构建）
│   ├── index.html          # 单页结构
│   ├── app.css             # 样式（移动端优先）
│   ├── app.js              # 交互逻辑 + WebSocket 客户端
│   ├── manifest.json       # PWA 配置
│   └── icons/              # 应用图标
├── server/
│   ├── src/
│   │   ├── index.js        # HTTP 接口 + WebSocket 服务
│   │   ├── db.js           # JSON 存储
│   │   ├── auth.js         # 密码散列 / 会话
│   │   └── logic.js        # 好友 / 群组 / 消息业务
│   └── data/db.json        # 数据文件（自动生成，已 gitignore）
├── scripts/
│   ├── gen-icons.mjs       # 生成 PWA 图标
│   └── e2e-test.mjs        # 端到端接口自测
└── .github/workflows/      # GitHub Pages 自动部署
```

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册 |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/auth/me` | 当前用户 |
| POST | `/api/auth/profile` | 修改昵称 / 头像 / 头像底色 |
| POST | `/api/upload` | 上传图片（头像 / 表情包），返回 `/uploads/xxx` |
| GET | `/api/stickers` | 我的自定义表情包 |
| POST | `/api/stickers` | 添加自定义表情包 |
| DELETE | `/api/stickers/:id` | 删除自定义表情包 |
| GET | `/api/friends` | 好友 / 申请列表 |
| GET | `/api/users/search` | 按账号或昵称搜索 |
| POST | `/api/friends/request` | 添加好友 |
| POST | `/api/friends/respond` | 同意 / 拒绝申请 |
| DELETE | `/api/friends/:id` | 删除好友 |
| GET | `/api/groups` | 我的群 + 可加入群 |
| POST | `/api/groups` | 创建群 |
| POST | `/api/groups/:id/join` | 加入群 |
| POST | `/api/groups/:id/leave` | 退群 |
| GET | `/api/messages` | 历史消息 |
| POST | `/api/messages` | 发消息 |
| POST | `/api/messages/read` | 标记已读 |
| GET | `/api/conversations` | 会话列表 |
| GET | `/api/online` | 在线人数 |
| GET | `/api/admin/stats` | 管理后台统计（仅管理员） |
| DELETE | `/api/admin/users/:id` | 删除用户（仅管理员） |

WebSocket：`ws://host:3000/ws?token=<登录token>`

推送事件：`new_message`、`friend_request`、`friend_response`、`friend_removed`、`group_created`、`group_update`、`online_update`、`account_removed`

## 测试

```bash
npm start                 # 另开一个终端保持运行
node scripts/e2e-test.mjs # 35 项端到端断言
```

## 部署

### 方案 A：GitHub Pages（前端 + 外部后端）

1. 仓库 → Settings → Pages → Source 选 `GitHub Actions`
2. 推送后自动把 `client/public` 部署到 Pages
3. 前端 API 地址需改成后端地址：改 `client/public/app.js` 顶部
   ```js
   const API = 'https://your-backend.com';
   const WS_URL = 'wss://your-backend.com/ws';
   ```

### 方案 B：完整后端部署（推荐，聊天需要服务端）

任意支持 Node 的平台（Railway / Render / VPS / 内网服务器）：

```bash
git clone <repo> && cd weiliao
npm run install:server
PORT=3000 ADMIN_USER=admin ADMIN_PASS=你的密码 npm start
```

建议前面加 Nginx 反代并配 HTTPS（WebSocket 需要）。

### 安卓安装

Chrome 打开站点 → 右上角菜单 → 「添加到主屏幕」，即可作为 App 安装。

### iOS

Safari 打开站点 → 分享按钮 → 「添加到主屏幕」。

## 安全说明

- 密码使用 `scrypt` + 16 字节随机 salt 存储，不可逆
- 会话 token 随机 24 字节，服务端校验
- 管理接口双重校验（登录态 + `isAdmin`）
- 非群成员无法读取/发送群消息
- 上线前请修改默认管理员密码并启用 HTTPS

## License

MIT
