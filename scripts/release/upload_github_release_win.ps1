# 上传 Windows 构建产物（NSIS .exe）到 GitHub Release
# 可独立运行，也被 .\scripts\release\publish_windows.ps1 调用
#
# 用法: .\scripts\release\upload_github_release_win.ps1

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $ProjectDir

# 读取版本号
$TauriConf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$Version = $TauriConf.version

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  上传 Windows 产物到 GitHub Release" -ForegroundColor Cyan
Write-Host "  Version: v$Version" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# 检查 gh CLI
$ghCmd = Get-Command gh -ErrorAction SilentlyContinue
if (-not $ghCmd) {
    Write-Host "[X] gh CLI 未安装" -ForegroundColor Red
    Write-Host "    安装: winget install --id GitHub.cli" -ForegroundColor Yellow
    throw "gh CLI 未安装"
}

# 查找 NSIS .exe 文件
$TargetDir = Join-Path $ProjectDir "src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis"
$NsisExe = Get-ChildItem -Path $TargetDir -Filter "*.exe" -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch "portable" } | Select-Object -First 1

if (-not $NsisExe) {
    Write-Host "[X] 未找到 NSIS 安装包" -ForegroundColor Red
    Write-Host "    请先运行 .\scripts\build\build_windows.ps1 完成构建" -ForegroundColor Yellow
    throw "未找到 NSIS 安装包"
}

Write-Host "  [OK] $($NsisExe.Name)" -ForegroundColor Green
Write-Host ""

# 检查 Release 是否存在 (临时放宽 ErrorAction，gh stderr 输出不应触发终止)
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$releaseCheck = & gh release view "v$Version" 2>&1
$ghExitCode = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($ghExitCode -ne 0) {
    Write-Host "[X] GitHub Release v$Version 不存在" -ForegroundColor Red
    Write-Host "    请先通过 merge-release 流程创建 Release" -ForegroundColor Yellow
    throw "GitHub Release v$Version 不存在"
}

# 上传 (临时放宽 ErrorAction，gh 进度输出走 stderr)
Write-Host "上传到 GitHub Release v$Version..." -ForegroundColor Cyan
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& gh release upload "v$Version" $NsisExe.FullName --clobber
$ghExitCode = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($ghExitCode -eq 0) {
    Write-Host ""
    Write-Host "[OK] GitHub Release 上传完成" -ForegroundColor Green
    Write-Host "  - $($NsisExe.Name)" -ForegroundColor White
} else {
    Write-Host "[X] 上传失败" -ForegroundColor Red
    throw "GitHub Release 上传失败"
}
