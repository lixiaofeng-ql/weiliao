#!/usr/bin/env bash
# 校验 deploy.sh 生成 systemd 环境变量文件的逻辑
# 重点：含特殊字符（双引号、反斜杠、井号、美元、单引号、空格）的管理员密码必须原样保留
set -euo pipefail
cd "$(dirname "$0")/.."

INSTALL_DIR=/opt/weiliao
DATA_DIR=/opt/weiliao/data
DOMAIN=chat.example.com

# 与 deploy.sh 第 5 步完全一致的逻辑
generate_env() {
  local ADMIN_PASS="$1"
  local OUT="$2"
  cat > "$OUT" <<ENVEOF
NODE_ENV=production
PORT=3000
WL_DATA_DIR=$DATA_DIR
WL_UPLOAD_DIR=$DATA_DIR/uploads
ADMIN_USER=admin
WL_PUBLIC_URL=https://$DOMAIN
WL_PUBLIC_WS=wss://$DOMAIN/ws
ENVEOF
  local _pw
  _pw=${ADMIN_PASS//\\/\\\\}
  _pw=${_pw//\"/\\\"}
  printf 'ADMIN_PASS="%s"\n' "$_pw" >> "$OUT"
}

pass=0; fail=0

# 用 node 解析 systemd EnvironmentFile 的双引号规则（与 systemd 一致：
# 双引号内支持 \n \t \\ \" 等转义），验证还原后与原密码完全相同。
parse_env() {
  node -e '
    const fs = require("fs");
    const line = fs.readFileSync(process.argv[1], "utf8")
      .split(/\r?\n/).find(l => l.startsWith("ADMIN_PASS="));
    let v = line.slice("ADMIN_PASS=".length);
    if (v.startsWith("\"") && v.endsWith("\"")) {
      v = v.slice(1, -1)
        .replace(/\\\\/g, "\u0000")
        .replace(/\\"/g, "\"")
        .replace(/\u0000/g, "\\");
    }
    process.stdout.write(v);
  ' "$1"
}

check() {
  local name="$1" pw="$2" out="$3"
  generate_env "$pw" "$out"
  local got
  got=$(parse_env "$out")
  if [[ "$got" == "$pw" ]]; then
    echo "  ✓ $name"
    pass=$((pass+1))
  else
    echo "  ✗ $name — 期望 [$pw] 实际 [$got]"
    fail=$((fail+1))
  fi
}

echo ""
echo "=== 部署模板 密码转义 测试 ==="
echo ""

check "普通密码"             'admin123'         /tmp/wl-env1
check "含双引号"             'My"Pass'          /tmp/wl-env2
check "含反斜杠"             'a\b\c'            /tmp/wl-env3
check "含美元符号"           'pa$$w0rd'         /tmp/wl-env4
check "含井号"               'pa#ss'            /tmp/wl-env5
check "含空格"               'my pass word'     /tmp/wl-env6

# 含单引号的密码用变量传入，避免测试脚本自身的引号嵌套问题
SQ="'"
check "含单引号"             "it${SQ}s"         /tmp/wl-env7
check "全特殊字符组合"       'a"b\c$d#e f'      /tmp/wl-env8
check "单双引号混合"         "mix${SQ}and\"dq"  /tmp/wl-env9
check "中文密码"             '我的密码123'      /tmp/wl-env10

# service 文件生成检查
sed -e '/^Environment=/d' \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$INSTALL_DIR/server|" \
    -e "s|^EnvironmentFile=.*|EnvironmentFile=/etc/weiliao.env|" \
    deploy/systemd/weiliao.service > /tmp/wl-test.service

if grep -q '^Environment=' /tmp/wl-test.service; then
  echo "  ✗ service 里仍有 Environment= 行"
  fail=$((fail+1))
else
  echo "  ✓ service 里 Environment= 已全部移除"
  pass=$((pass+1))
fi

grep -q '^EnvironmentFile=/etc/weiliao.env' /tmp/wl-test.service \
  && { echo "  ✓ service 正确指向 EnvironmentFile"; pass=$((pass+1)); } \
  || { echo "  ✗ service 未指向 EnvironmentFile"; fail=$((fail+1)); }

bash -n deploy/deploy.sh \
  && { echo "  ✓ deploy.sh 语法正确"; pass=$((pass+1)); } \
  || { echo "  ✗ deploy.sh 语法错误"; fail=$((fail+1)); }

echo ""
echo "=== 结果: $pass 通过 / $fail 失败 ==="
[[ $fail -eq 0 ]] || exit 1
