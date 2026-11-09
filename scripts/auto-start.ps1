$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root '.tools'
$cf = Join-Path $tools 'cloudflared.exe'
$cfg = Join-Path $root 'client\public\config.js'
$tunnelLog = Join-Path $root '.tunnel.log'
$tunnelErr = Join-Path $root '.tunnel.err.log'
$serverLog = Join-Path $root '.server.log'

function Log($m) { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $m" }

# ---------- 1. 清理旧进程 ----------
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# ---------- 1. 启动前先备份数据库 ----------
# 保证任何异常操作前都有一份可回滚的快照
try {
  $backupScript = Join-Path $PSScriptRoot 'backup-db.ps1'
  if (Test-Path $backupScript) {
    & $backupScript -Keep 20 | Out-Null
    Log '数据库已备份'
  }
} catch {
  Log "备份失败（不阻塞启动）: $($_.Exception.Message)"
}

# ---------- 2. 启动后端 ----------
if (-not (Test-Path (Join-Path $root 'server\node_modules'))) {
  Log '安装后端依赖...'
  npm run install:server --prefix $root | Out-Null
}
Start-Process -FilePath 'node' -ArgumentList 'src/index.js' -WorkingDirectory (Join-Path $root 'server') `
  -RedirectStandardOutput $serverLog -RedirectStandardError "$serverLog.err" -WindowStyle Hidden
Log '后端已启动 (localhost:3000)'
Start-Sleep -Seconds 4

# ---------- 3. 启动隧道 ----------
if (-not (Test-Path $cf)) {
  Log '未找到 cloudflared，尝试下载...'
  New-Item -ItemType Directory -Force -Path $tools | Out-Null
  $m = 'https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  Invoke-WebRequest -Uri $m -OutFile $cf -UseBasicParsing -TimeoutSec 120
}
Remove-Item $tunnelErr -ErrorAction SilentlyContinue

# 隧道最多尝试 3 次（网络波动 / DNS 故障时自动重试）
$url = $null
for ($attempt = 1; $attempt -le 3 -and -not $url; $attempt++) {
  if ($attempt -gt 1) {
    Log "隧道启动失败，$attempt 秒后重试（第 $attempt 次）..."
    Start-Sleep -Seconds $attempt
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item $tunnelErr -ErrorAction SilentlyContinue
  }

  Start-Process -FilePath $cf -ArgumentList 'tunnel', '--url', 'http://localhost:3000', '--no-autoupdate' `
    -WorkingDirectory $root -RedirectStandardOutput "$tunnelLog.out" -RedirectStandardError $tunnelErr -WindowStyle Hidden

  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    $raw = Get-Content $tunnelErr -Raw -ErrorAction SilentlyContinue
    # 只匹配真正分配到的子域名，且排除 api.trycloudflare.com 这类服务端域名
    # cloudflared 输出的格式： |  https://xxx-yyy-zzz.trycloudflare.com  |
    if ($raw -match 'https://(?!api\.)[a-z0-9][a-z0-9-]{2,}\.trycloudflare\.com') {
      $url = $Matches[0]
      break
    }
  }
}
if (-not $url) {
  Log '隧道启动失败（已重试 3 次，仍未获取到公网地址）'
  Log "错误详情见 $tunnelErr"
  # 保留原有 config.js，不要写入无效地址
  exit 1
}
Log "公网地址: $url"

# ---------- 4. 回写 config ----------
$wsHost = ([Uri]$url).Host
$content = @"
/**
 * 微聊 前端运行时配置
 * ---------------------------------------------------------------
 * 本文件由 scripts/start-local.ps1 自动生成，请勿手工修改。
 * 重新运行该脚本可获取新的公网地址。
 */
window.WL_CONFIG = {
  // 后端接口根地址
  apiBase: '$url',
  // WebSocket 地址
  wsBase: 'wss://$wsHost/ws'
};
"@
[IO.File]::WriteAllText($cfg, $content, [Text.UTF8Encoding]::new($false))
Log 'config.js 已更新'

# ---------- 5. 推送（可失败，不影响本地使用） ----------
try {
  Push-Location $root
  git add client/public/config.js 2>&1 | Out-Null
  git commit -m 'chore: 自动更新后端公网地址' 2>&1 | Out-Null
  git push origin main 2>&1 | Out-Null
  Log '已推送到 GitHub (Pages 约 1-2 分钟生效)'
} catch {
  Log "推送失败（不影响本地使用）: $($_.Exception.Message)"
} finally {
  Pop-Location
}

Log "完成。本地 http://localhost:3000  |  公网 $url"
