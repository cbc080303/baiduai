# 一键上线到 GitHub Pages
# 目标仓库：cbc080303/baiduai（已确认为空仓库）
# 用法：双击同目录的 deploy-pages.cmd
# 说明：只有第 1 步需要你本人操作（浏览器里授权 GitHub），其余自动完成。

$ErrorActionPreference = "Stop"
$RepoName = "baiduai"
$WorkDir  = "E:\百度搭子"

Set-Location $WorkDir

# 定位 gh
$GH = "C:\Users\caiba\gh-cli\bin\gh.exe"
if (-not (Test-Path $GH)) {
    $cmd = Get-Command gh -ErrorAction SilentlyContinue
    if ($cmd) { $GH = $cmd.Source }
}
if (-not (Test-Path $GH)) {
    throw "未找到 GitHub CLI。请先执行：winget install GitHub.cli，或把 gh.exe 路径填入本脚本的 `$GH 变量。"
}
Write-Host "使用 gh: $GH" -ForegroundColor DarkGray

# 第 1 步：授权（唯一需要你本人完成的步骤）
Write-Host "`n[1/3] GitHub 授权" -ForegroundColor Cyan
Write-Host "浏览器会打开 https://github.com/login/device，把终端里显示的一次性代码填进去并点 Authorize。" -ForegroundColor Yellow
& $GH auth login --hostname github.com --git-protocol https --web
if ($LASTEXITCODE -ne 0) { throw "授权未完成，脚本终止。" }

$User = (& $GH api user --jq .login).Trim()
Write-Host "已登录：$User" -ForegroundColor Green

# 第 2 步：建仓库并推送
Write-Host "`n[2/3] 创建公开仓库并推送 main 分支" -ForegroundColor Cyan
$hasOrigin = @(git remote) -contains "origin"
& $GH repo view "$User/$RepoName" *> $null
$repoExists = ($LASTEXITCODE -eq 0)

if (-not $repoExists) {
    & $GH repo create "$RepoName" --public --source=. --remote=origin --push
    if ($LASTEXITCODE -ne 0) { throw "仓库创建或推送失败。" }
} else {
    Write-Host "仓库 $User/$RepoName 已存在，改为推送当前内容。" -ForegroundColor Yellow
    if (-not $hasOrigin) { git remote add origin "https://github.com/$User/$RepoName.git" }
    git push -u origin main
    if ($LASTEXITCODE -ne 0) { throw "推送失败。" }
}

# 第 3 步：开启 Pages
Write-Host "`n[3/3] 开启 GitHub Pages" -ForegroundColor Cyan
$body = '{"source":{"branch":"main","path":"/"}}'
$body | & $GH api -X POST "repos/$User/$RepoName/pages" --input - *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Pages 可能已开启或需手动设置：仓库 Settings → Pages → Source 选 main / (root)。" -ForegroundColor Yellow
}

Write-Host "`n等待 Pages 构建（约 30 秒）..." -ForegroundColor DarkGray
Start-Sleep -Seconds 30

$Url = "https://$User.github.io/$RepoName/"
Write-Host "`n完成。访问地址：" -ForegroundColor Green
Write-Host $Url -ForegroundColor Green

# 自检：主页面能否取到 title
try {
    $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 20
    if ($resp.StatusCode -eq 200) {
        Write-Host "自检通过：HTTP 200，页面可访问。" -ForegroundColor Green
        Write-Host "请把这个地址填进比赛提交表，并确认页面里有「查遗漏候选（A）」按钮。" -ForegroundColor Yellow
    } else {
        Write-Host "自检返回 $($resp.StatusCode)，Pages 可能还在构建，等 1 分钟再刷新。" -ForegroundColor Yellow
    }
} catch {
    Write-Host "自检未通过（$($_.Exception.Message)）。若刚开启 Pages，等 1 分钟后手动打开上面的地址确认。" -ForegroundColor Yellow
}