#!/usr/bin/env bash
# ============================================================
# 微聊 - 一键部署脚本（Ubuntu / Debian / 阿里云轻量 / 腾讯云轻量）
# ------------------------------------------------------------
# 用法：
#   sudo bash deploy.sh --domain weiliao.example.com --admin-pass '你的管理员密码'
#
# 脚本会：
#   1. 安装 Node.js 20 + Nginx
#   2. 拉取代码 / 或使用本地代码
#   3. 安装依赖
#   4. 注册 systemd 服务
#   5. 配置 Nginx + 申请 HTTPS 证书
#   6. 自检
# ============================================================
set -euo pipefail

DOMAIN=""
ADMIN_PASS="admin123"
MODE="git"          # git | local
REPO="https://github.com/lixiaofeng-ql/weiliao.git"
BRANCH="main"
INSTALL_DIR="/opt/weiliao"
DATA_DIR="/opt/weiliao/data"
SERVICE_USER="root"

usage() {
  cat <<EOF
用法: sudo bash deploy.sh --domain <域名> [--admin-pass <密码>] [--mode git|local] [--repo <git地址>] [--branch <分支>]

示例:
  sudo bash deploy.sh --domain chat.example.com --admin-pass 'MyStrongPass123'
  sudo bash deploy.sh --domain chat.example.com --mode local
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)     DOMAIN="$2"; shift 2 ;;
    --admin-pass) ADMIN_PASS="$2"; shift 2 ;;
    --mode)       MODE="$2"; shift 2 ;;
    --repo)       REPO="$2"; shift 2 ;;
    --branch)     BRANCH="$2"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "未知参数: $1"; usage; exit 1 ;;
  esac
done

if [[ -z "$DOMAIN" ]]; then
  echo "错误：必须用 --domain 指定域名"
  usage
  exit 1
fi

log()  { echo -e "\n\033[1;32m==> $*\033[0m"; }
warn() { echo -e "\033[1;33m[警告] $*\033[0m"; }
err()  { echo -e "\033[1;31m[错误] $*\033[0m"; exit 1; }

# ------------------------------------------------------------
log "1/8 检查运行环境"
if [[ $EUID -ne 0 ]]; then err "请用 root 运行（sudo bash deploy.sh ...）"; fi
command -v apt-get >/dev/null || err "本脚本仅支持 Ubuntu / Debian"
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  NODE_ARCH="x64" ;;
  aarch64) NODE_ARCH="arm64" ;;
  *) err "不支持的架构: $ARCH" ;;
esac

# ------------------------------------------------------------
log "2/8 安装 Node.js 20 与 Nginx"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
if ! command -v node >/dev/null || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_20.x" | bash -
  apt-get install -y nodejs
fi
apt-get install -y nginx git certbot python3-certbot-nginx curl
echo "node $(node -v) / nginx $(nginx -v 2>&1 | grep -o '[0-9.]*$')"

# ------------------------------------------------------------
log "3/8 放置代码到 $INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$DATA_DIR/uploads" /var/log/weiliao

if [[ "$MODE" == "git" ]]; then
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    log "更新已有代码..."
    git -C "$INSTALL_DIR" fetch --all
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
  else
    log "克隆代码..."
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$INSTALL_DIR"
  fi
  # 保留数据目录（不被 git 覆盖）
  mkdir -p "$DATA_DIR/uploads"
else
  log "使用本地代码（当前目录）"
  SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  mkdir -p "$INSTALL_DIR"
  cp -r "$SRC_DIR/server" "$INSTALL_DIR/" 2>/dev/null || true
  cp -r "$SRC_DIR/client" "$INSTALL_DIR/" 2>/dev/null || true
  cp -r "$SRC_DIR/package.json" "$INSTALL_DIR/" 2>/dev/null || true
  rm -rf "$INSTALL_DIR/server/node_modules"
fi

# ------------------------------------------------------------
log "4/8 安装依赖"
cd "$INSTALL_DIR/server"
npm install --omit=dev --no-audit --no-fund

# ------------------------------------------------------------
log "5/8 注册 systemd 服务"
sed -e "s|^Environment=PORT=.*|Environment=PORT=3000|" \
    -e "s|^Environment=ADMIN_PASS=.*|Environment=ADMIN_PASS=$ADMIN_PASS|" \
    -e "s|^Environment=WL_PUBLIC_URL=.*|Environment=WL_PUBLIC_URL=https://$DOMAIN|" \
    -e "s|^Environment=WL_PUBLIC_WS=.*|Environment=WL_PUBLIC_WS=wss://$DOMAIN/ws|" \
    "$INSTALL_DIR/deploy/systemd/weiliao.service" > /etc/systemd/system/weiliao.service
# systemd 的 Environment 不支持变量插值中的特殊字符，做一次转义
sed -i "s|Environment=ADMIN_PASS=.*|Environment=ADMIN_PASS=\"$(printf '%s' "$ADMIN_PASS" | sed 's/[\\"\\\\]/\\\\&/g')\"|" /etc/systemd/system/weiliao.service

systemctl daemon-reload
systemctl enable weiliao
systemctl restart weiliao
sleep 3
systemctl is-active --quiet weiliao || {
  err "服务启动失败，日志如下："
  journalctl -u weiliao -n 50 --no-pager
  exit 1
}
log "服务已启动: systemctl status weiliao"

# ------------------------------------------------------------
log "6/8 配置 Nginx"
cp "$INSTALL_DIR/deploy/nginx/weiliao.conf" /etc/nginx/conf.d/weiliao.conf
sed -i "s|weiliao.example.com|$DOMAIN|g" /etc/nginx/conf.d/weiliao.conf
# 默认站点冲突时移除
rm -f /etc/nginx/sites-enabled/default
nginx -t || err "nginx 配置检查失败"

# ------------------------------------------------------------
log "7/8 申请 HTTPS 证书"
# 先用 HTTP 配置启动 nginx
systemctl restart nginx
sleep 2
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
     --register-unsafely-without-email --redirect 2>/dev/null; then
  log "HTTPS 证书申请成功"
else
  warn "证书申请失败（可能服务器未放行 80/443 端口或域名未解析到本机）"
  warn "请在云服务商安全组放行 80/443 后重跑：certbot --nginx -d $DOMAIN"
fi
nginx -t && systemctl reload nginx

# ------------------------------------------------------------
log "8/8 自检"
echo "--- 本地健康检查 ---"
curl -sS "http://127.0.0.1:3000/api/health" && echo
echo "--- 域名健康检查 ---"
curl -sS "https://$DOMAIN/api/health" && echo
echo "--- WebSocket 检查 ---"
curl -sS -o /dev/null -w "HTTP %{http_code}\n" "https://$DOMAIN/ws"

cat <<EOF

============================================================
 微聊部署完成！
============================================================
 域名      : https://$DOMAIN
 管理账号  : admin / $ADMIN_PASS
 数据目录  : $DATA_DIR
 服务状态  : systemctl status weiliao
 实时日志  : journalctl -u weiliao -f
 备份目录  : $DATA_DIR/backups

 下一步：
 1. 在云服务商安全组放行 80 / 443 端口
 2. 把域名 DNS 解析到本服务器公网 IP
 3. 修改前端 config.js（见 deploy/README-deploy.md 最后一节）
============================================================
EOF
