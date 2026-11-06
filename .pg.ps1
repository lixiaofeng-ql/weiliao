$ErrorActionPreference = 'Continue'
$gh = "$env:LOCALAPPDATA\Programs\GitHub CLI\gh.exe"
$repo = "C:\Users\lxf\Projects\weiliao"
$out = @()

Set-Location $repo

# 1. 把 Pages 切到 Actions 构建（build_type=workflow），这样部署的是 client/public 而非 README
$out += "=== set pages build_type=workflow ==="
$out += (& $gh api -X PUT "repos/lixiaofeng-ql/weiliao/pages" -f "build_type=workflow" 2>&1 | Out-String)

# 2. 重新触发 Actions 部署
$out += "=== trigger workflow ==="
$out += (& $gh workflow run deploy.yml --repo "lixiaofeng-ql/weiliao" 2>&1 | Out-String)

Start-Sleep -Seconds 5

# 3. 提交前端改动
$out += "=== commit ==="
$out += (git add -A 2>&1 | Out-String)
$out += (git commit -m "fix: 支持 GitHub Pages 子路径部署与可配置后端地址

- 新增 config.js，前端可在部署时配置后端 API / WebSocket 地址
- 静态资源改用相对路径，兼容 /weiliao/ 子路径
- manifest / 图标改为相对路径引用" 2>&1 | Out-String)

# 4. 推送
for ($i = 1; $i -le 3; $i++) {
  $r = (git push origin main 2>&1 | Out-String)
  $out += "push attempt $i : " + ($r -replace "`r?`n", ' | ')
  if ($r -match 'main -> main|Everything up-to-date') { break }
  Start-Sleep -Seconds 5
}

$out += "=== status ==="
$out += (git status -sb 2>&1 | Out-String)

$out | Out-File -FilePath "$repo\.pg.txt" -Encoding utf8
