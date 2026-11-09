#!/usr/bin/env pwsh
# ============================================================
# 微聊 - 数据库备份脚本
#   .\scripts\backup-db.ps1              立即备份一次
#   .\scripts\backup-db.ps1 -Keep 50     保留最近 50 份
#
# 备份位置：server/data/backups/db-<时间戳>.json
# 说明：服务端每 10 分钟也会自动备份一次，此脚本用于手动快照。
# ============================================================
param(
  [int]$Keep = 20
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root 'server\data'
$dbFile = Join-Path $dataDir 'db.json'
$backupDir = Join-Path $dataDir 'backups'

if (-not (Test-Path $dbFile)) {
  Write-Host "数据库不存在: $dbFile" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path $backupDir)) {
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
}

$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$target = Join-Path $backupDir "db-$stamp.json"
Copy-Item $dbFile $target -Force

# 清理过期备份
Get-ChildItem $backupDir -Filter 'db-*.json' -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending |
  Select-Object -Skip $Keep |
  ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

$size = [math]::Round((Get-Item $target).Length / 1KB, 1)
$count = (Get-ChildItem $backupDir -Filter 'db-*.json' -ErrorAction SilentlyContinue).Count
Write-Host "备份完成: $(Split-Path -Leaf $target)  ($size KB)" -ForegroundColor Green
Write-Host "当前保留 $count 份备份（上限 $Keep）" -ForegroundColor DarkGray
