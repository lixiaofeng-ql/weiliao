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
Start-Process -FilePath $cf -ArgumentList 'tunnel', '--url', 'http://localhost:3000', '--no-autoupdate' `
  -WorkingDirectory $root -RedirectStandardOutput "$tunnelLog.out" -RedirectStandardError $tunnelErr -WindowStyle Hidden

$url = $null
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  $raw = Get-Content $tunnelErr -Raw -ErrorAction SilentlyContinue
  if ($raw -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $url = $Matches[0]; break }
}
if (-not $url) { Log '隧道启动失败'; exit 1 }
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
