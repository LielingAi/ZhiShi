#!/usr/bin/env pwsh

# 基于已有 build_windows.ps1 产物快速准备 USB 原地更新测试环境
# 只需重新编译 zhishi-updater.exe，避免重复构建完整安装包

param(
    [string]$OldDir = "C:\Temp\ZhiShi_0.2.32_x86_64-portable",
    [string]$NewDir = "D:\Temp\ZhiShi_0.2.33_x86_64-portable",
    [switch]$SkipUpdaterBuild
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $ProjectDir

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  USB 原地更新快速测试环境准备" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# 1. 重新编译更新助手
if (-not $SkipUpdaterBuild) {
    Write-Host "[1/4] 重新编译 zhishi-updater.exe..." -ForegroundColor Blue
    & cargo build --release --bin zhishi-updater --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw "zhishi-updater 构建失败" }
    Write-Host "  OK" -ForegroundColor Green
} else {
    Write-Host "[1/4] 跳过更新助手编译 (-SkipUpdaterBuild)" -ForegroundColor Yellow
}

$UpdaterSource = "src-tauri\target\x86_64-pc-windows-msvc\release\zhishi-updater.exe"
if (-not (Test-Path $UpdaterSource)) { throw "未找到 $UpdaterSource" }

# 2. 找到已有的便携版 ZIP
$BundleDir = "src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis"
$ZipFile = Get-ChildItem -Path $BundleDir -Filter "ZhiShi_*_x86_64-portable.zip" | Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $ZipFile) {
    throw "未在 $BundleDir 找到便携版 ZIP，请先运行 scripts/build/build_windows.ps1"
}

Write-Host "[2/4] 使用已有便携版 ZIP: $($ZipFile.Name)" -ForegroundColor Blue

# 3. 准备旧版测试目录
Write-Host "[3/4] 解压旧版到: $OldDir" -ForegroundColor Blue
if (Test-Path $OldDir) {
    Remove-Item -Recurse -Force $OldDir
}
New-Item -ItemType Directory -Path $OldDir -Force | Out-Null

Expand-Archive -Path $ZipFile.FullName -DestinationPath $OldDir -Force

# 替换为最新编译的 updater
Copy-Item $UpdaterSource (Join-Path $OldDir "zhishi-updater.exe") -Force
Write-Host "  已替换为最新 zhishi-updater.exe" -ForegroundColor Green

# 创建用户数据（如果 ZIP 里没有）
$DataDir = Join-Path $OldDir ".zhishi"
if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}
$LogsDir = Join-Path $DataDir "logs"
if (-not (Test-Path $LogsDir)) {
    New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
}
$TestData = Join-Path $DataDir "test-data.txt"
if (-not (Test-Path $TestData)) {
    Set-Content -Path $TestData -Value "这是旧版用户数据，更新后应该保留" -Force
}

# 4. 准备新版 U 盘目录
Write-Host "[4/4] 复制新版到: $NewDir" -ForegroundColor Blue
if (Test-Path $NewDir) {
    Remove-Item -Recurse -Force $NewDir
}
New-Item -ItemType Directory -Path $NewDir -Force | Out-Null

# 直接复制旧版目录的全部内容作为新版基础
Copy-Item -Path "$OldDir\*" -Destination $NewDir -Recurse -Force

# 确保新版目录名是 0.2.33（App 扫描时按目录名匹配版本）
# 实际 exe 版本可能还是 0.2.32，但足够测试流程
Write-Host "  OK" -ForegroundColor Green

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  测试环境准备完成" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步：" -ForegroundColor Yellow
Write-Host "1. 确保本地工单服务已启动，且 .env 中版本配置如下：" -ForegroundColor White
Write-Host "   CLIENT_LATEST_VERSION=0.2.33" -ForegroundColor Cyan
Write-Host "   CLIENT_MINIMUM_VERSION=0.2.30" -ForegroundColor Cyan
Write-Host "   CLIENT_FORCE_UPDATE_BELOW=0.2.31" -ForegroundColor Cyan
Write-Host "   CLIENT_RELEASE_NOTES=测试本地 U 盘更新" -ForegroundColor Cyan
Write-Host ""
Write-Host "2. 启动旧版 App：" -ForegroundColor White
Write-Host "   & '$OldDir\zhishi.exe'" -ForegroundColor Cyan
Write-Host ""
Write-Host "3. 启动后等待 30 秒，应弹出更新对话框" -ForegroundColor White
Write-Host ""
Write-Host "4. 更新日志位置：" -ForegroundColor White
Write-Host "   $OldDir\.zhishi\logs\" -ForegroundColor Cyan
Write-Host ""
Write-Host "提示：新版 exe 实际还是 0.2.32，但目录名是 0.2.33，足够验证更新流程。" -ForegroundColor DarkGray
Write-Host "      如需验证真实版本号变化，请把源码版本号改成 0.2.33 后重新构建 ZIP。" -ForegroundColor DarkGray
