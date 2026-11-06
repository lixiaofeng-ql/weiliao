#!/usr/bin/env pwsh
# ============================================================
# 微聊 - 一键启动本地后端 + 公网隧道
#   .\scripts\start-local.ps1            仅本地启动
#   .\scripts\start-local.ps1 --push     启动并推送到 GitHub Pages
#
# 作用：
#   1. 启动 Node 后端（localhost:3000）
#   2. 启动 Cloudflare 隧道，把本地后端暴露到公网 HTTPS
#   3. 自动把公网地址写回 client/public/config.js
#   4. 可选把新地址推送到 GitHub，让 Pages 站点同步生效
# ============================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root '.tools'
$cf = Join-Path $tools 'cloudflared.exe'
$cfg = Join-Path $root 'client\public\config.js'
$tunnelLog = Join-Path $root '.tunnel.log'
$tunnelErr = Join-Path $root '.tunnel.err.log'
$serverLog = Join-Path $root '.server.log'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# ---------- 1. 检查依赖 ----------
if (-not (Test-Path $cf)) {
  Write-Step '未找到 cloudflared，正在下载...'
  New-Item -ItemType Directory -Force -Path $tools | Out-Null
  $mirrors = @(
    'https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
    'https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  )
  $ok = $false
  foreach ($m in $mirrors) {
    try {
      Write-Host "    尝试 $m"
      Invoke-WebRequest -Uri $m -OutFile $cf -UseBasicParsing -TimeoutSec 120
      if ((Get-Item $cf).Length -gt 5MB) { $ok = $true; break }
    } catch { Write-Host "    失败: $($_.Exception.Message)" }
  }
  if (-not $ok) { throw 'cloudflared 下载失败，请手动下载后放到 .tools\cloudflared.exe' }
}
Write-Step 'cloudflared 就绪'

# ---------- 2. 停止旧进程 ----------
Write-Step '清理旧进程'
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# ---------- 3. 启动后端 ----------
Write-Step '启动后端 (localhost:3000)'
if (-not (Test-Path (Join-Path $root 'server\node_modules'))) {
  Write-Step '安装后端依赖...'
  npm run install:server | Out-Null
}
Start-Process -FilePath 'node' -ArgumentList 'src/index.js' -WorkingDirectory (Join-Path $root 'server') `
  -RedirectStandardOutput $serverLog -RedirectStandardError "$serverLog.err" -WindowStyle Hidden
Start-Sleep -Seconds 4

# ---------- 4. 启动隧道 ----------
Write-Step '启动 Cloudflare 隧道...'
Remove-Item $tunnelLog, $tunnelErr -ErrorAction SilentlyContinue
Start-Process -FilePath $cf -ArgumentList 'tunnel', '--url', 'http://localhost:3000', '--no-autoupdate' `
  -WorkingDirectory $root -RedirectStandardOutput $tunnelLog -RedirectStandardError $tunnelErr -WindowStyle Hidden

$url = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 2
  $raw = (Get-Content $tunnelErr -Raw -ErrorAction SilentlyContinue)
  if ($raw -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $url = $Matches[0]; break }
}
if (-not $url) { throw '隧道启动失败，请查看 .tunnel.err.log' }
Write-Step "公网地址: $url" -ForegroundColor Green

# ---------- 5. 回写 config.js ----------
Write-Step '更新 client/public/config.js'
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
Write-Step 'config.js 已更新' -ForegroundColor Green

# ---------- 6. 可选：推送到 GitHub ----------
if ($args -contains '--push') {
  Write-Step '推送到 GitHub (Pages 自动发布)...'
  Push-Location $root
  try {
    git add client/public/config.js
    git commit -m 'chore: 更新后端公网地址' 2>&1 | Out-Null
    git push origin main 2>&1 | Out-Null
    Write-Step '已推送，等待约 1-2 分钟 Pages 生效' -ForegroundColor Green
  } catch {
    Write-Warning "推送失败：$($_.Exception.Message)"
  } finally {
    Pop-Location
  }
}

Write-Host ''
Write-Host '============================================' -ForegroundColor Green
Write-Host ' 微聊已启动' -ForegroundColor Green
Write-Host " 本地访问  : http://localhost:3000"
Write-Host " 公网后端  : $url"
Write-Host ' Pages 站点: https://lixiaofeng-ql.github.io/weiliao/'
Write-Host ' 管理员   : admin / admin123'
Write-Host '============================================' -ForegroundColor Green
Write-Host ''
Write-Host '提示：关闭本窗口或按 Ctrl+C 即可停止服务。'
