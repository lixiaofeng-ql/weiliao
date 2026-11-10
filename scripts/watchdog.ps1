#!/usr/bin/env pwsh
# ============================================================
# 微聊 - 隧道看门狗
#   .\scripts\watchdog.ps1            前台运行（调试用）
#   .\scripts\watchdog.ps1 -Once      只检查一次
#
# 作用：
#   定期检查「本地后端 + 公网隧道」是否健康，
#   发现失效就自动重启隧道、更新 config.js 并推送到 GitHub。
#
# 触发场景（已实测遇到）：
#   - Cloudflare 快速隧道被服务端回收（Unauthorized: Tunnel not found）
#   - 网络抖动导致隧道断开后未自愈
#   - 后端进程意外退出
# ============================================================
param(
  [int]$IntervalSec = 120,
  [switch]$Once
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root '.tools'
$cf = Join-Path $tools 'cloudflared.exe'
$cfg = Join-Path $root 'client\public\config.js'
$tunnelLog = Join-Path $root '.tunnel.log'
$tunnelErr = Join-Path $root '.tunnel.err.log'
$serverLog = Join-Path $root '.server.log'

function Log($m) {
  Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $m"
}

# ---------- 读取当前 config.js 里的地址 ----------
# 优先读 apiBases[0]（主地址），退回 apiBase（兼容旧格式）
function Get-ConfiguredUrl() {
  try {
    if (-not (Test-Path $cfg)) { return $null }
    $raw = Get-Content $cfg -Raw -ErrorAction SilentlyContinue
    if (-not $raw) { return $null }
    $bm = [regex]::Match($raw, "apiBases\s*:\s*\[\s*['""]([^'""]+)['""]")
    if ($bm.Success) { return $bm.Groups[1].Value.TrimEnd('/') }
    if ($raw -match "apiBase:\s*'([^']+)'") { return $Matches[1] }
    return $null
  } catch { return $null }
}

# ---------- 检查本地后端是否在跑 ----------
function Test-Backend {
  try {
    $conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    if (-not $conn) { return $false }
    # 用无需登录的健康检查接口确认可响应
    $r = Invoke-WebRequest -Uri 'http://localhost:3000/api/health' -UseBasicParsing -TimeoutSec 8
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

# ---------- 检查公网隧道是否可用 ----------
function Test-Tunnel($url) {
  if (-not $url) { return $false }
  try {
    $r = Invoke-WebRequest -Uri "$url/api/health" -UseBasicParsing -TimeoutSec 15
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

# ---------- 启动后端 ----------
function Start-Backend {
  Log '启动后端 (localhost:3000)...'
  Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  Start-Process -FilePath 'node' -ArgumentList 'src/index.js' -WorkingDirectory (Join-Path $root 'server') `
    -RedirectStandardOutput $serverLog -RedirectStandardError "$serverLog.err" -WindowStyle Hidden
  Start-Sleep -Seconds 4
}

# ---------- 启动隧道并返回公网地址 ----------
function Start-Tunnel {
  Log '启动 Cloudflare 隧道...'
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Remove-Item $tunnelErr -ErrorAction SilentlyContinue

  # --protocol http2 比 quic 稳定（国内网络下 quic 常超时）
  Start-Process -FilePath $cf -ArgumentList 'tunnel', '--url', 'http://localhost:3000', '--no-autoupdate', '--protocol', 'http2' `
    -WorkingDirectory $root -RedirectStandardOutput $tunnelLog -RedirectStandardError $tunnelErr -WindowStyle Hidden

  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 2
    $raw = Get-Content $tunnelErr -Raw -ErrorAction SilentlyContinue
    # 排除 api.trycloudflare.com 这类服务端域名
    if ($raw -match 'https://(?!api\.)[a-z0-9][a-z0-9-]{2,}\.trycloudflare\.com') {
      return $Matches[0]
    }
  }
  return $null
}

# ---------- 写回 config.js ----------
# 注意：必须保留 apiBases 候选列表，否则会丢失故障转移能力
function Write-Config($url) {
  $wsHost = ([Uri]$url).Host

  # 读取旧配置里的主地址（通常是正式服务器，固定不变）
  $primary = $url
  try {
    if (Test-Path $cfg) {
      $old = Get-Content $cfg -Raw -ErrorAction SilentlyContinue
      if ($old) {
        $lm = [regex]::Match($old, "apiBases\s*:\s*\[([^\]]*)\]")
        if ($lm.Success) {
          $items = $lm.Groups[1].Value -split ',' | ForEach-Object {
            $_.Trim().Trim("'", '"').TrimEnd('/')
          } | Where-Object { $_ }
          if ($items.Count -ge 1 -and $items[0] -ne $url) { $primary = $items[0] }
        }
      }
    }
  } catch { }

  $content = @"
/**
 * 微聊 前端运行时配置
 * ---------------------------------------------------------------
 * 本文件由 scripts/auto-start.ps1 / watchdog.ps1 自动生成，请勿手工修改。
 *
 * apiBases：后端候选地址，按优先级排列。
 *   [0] 正式服务器（固定地址，长期有效）
 *   [1] 本地 Cloudflare 隧道（测试服务，地址会变）
 * 前端会自动探测，主地址不通时无缝切到备用地址。
 */
window.WL_CONFIG = {
  // 后端候选地址（按优先级）
  apiBases: [
    '$primary',
    '$url'
  ],
  // 主后端接口根地址（兼容旧版读取方式）
  apiBase: '$primary',
  // WebSocket 地址
  wsBase: 'wss://$wsHost/ws'
};
"@
  [IO.File]::WriteAllText($cfg, $content, [Text.UTF8Encoding]::new($false))
}

# ---------- 推送到 GitHub ----------
function Push-Config {
  try {
    Push-Location $root
    git add client/public/config.js 2>&1 | Out-Null
    $dirty = $null -ne (git status --porcelain client/public/config.js 2>$null)
    if ($dirty) {
      git commit -m 'chore: 自动更新后端公网地址（看门狗修复）' 2>&1 | Out-Null
      # GitHub 在 http2 下常被 reset 断，强制降级为 HTTP/1.1
      for ($i = 0; $i -lt 3; $i++) {
        $out = git push origin main 2>&1
        if ($LASTEXITCODE -eq 0) { return $true }
        Start-Sleep -Seconds 6
      }
      return $false
    }
    return $false
  } catch {
    Log "推送失败（不影响本地使用）: $($_.Exception.Message)"
    return $false
  } finally {
    Pop-Location
  }
}

# ---------- 自愈主流程 ----------
function Repair-Tunnel {
  Log '检测到异常，开始修复...'

  if (-not (Test-Backend)) {
    Log '本地后端无响应'
    Start-Backend
  }

  $url = Start-Tunnel
  if (-not $url) {
    Log '隧道启动失败'
    return $null
  }
  Log "新公网地址: $url"

  Write-Config $url
  Log 'config.js 已更新'

  # 验证新地址真的可用
  Start-Sleep -Seconds 3
  if (Test-Tunnel $url) {
    Log '✓ 隧道已恢复'
  } else {
    Log '⚠ 新地址暂时未验证通过，稍后重试'
  }

  Push-Config
  return $url
}

# ==================== 主循环 ====================
Log '看门狗启动，检查间隔 ' + $IntervalSec + ' 秒'

while ($true) {
  try {
    $cfgUrl = Get-ConfiguredUrl
    $backendOk = Test-Backend
    $tunnelOk = Test-Tunnel $cfgUrl

    if (-not $backendOk -or -not $tunnelOk) {
      Log "异常：后端=$(if($backendOk){'正常'}else{'异常'}) 隧道=$(if($tunnelOk){'正常'}else{'异常'}) 地址=$cfgUrl"
      Repair-Tunnel | Out-Null
    } else {
      Log "正常 地址=$cfgUrl"
    }
  } catch {
    Log "检查出错: $($_.Exception.Message)"
  }

  if ($Once) { break }
  Start-Sleep -Seconds $IntervalSec
}

Log '看门狗退出'
