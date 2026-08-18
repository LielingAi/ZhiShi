#!/usr/bin/env pwsh

# 快速准备 USB 原地更新本地测试环境
# 不构建完整安装包，直接编译 release 二进制并准备测试目录

param(
    [string]$OldDir = "C:\Temp\ZhiShi_0.2.32_x86_64-portable",
    [string]$NewDir = "D:\Temp\ZhiShi_0.2.33_x86_64-portable",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $ProjectDir

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  ZhiShi USB 更新本地测试环境准备" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# 1. 前端 GUI 已删除（无窗口后台宿主形态）——无需前端构建。
Write-Host "[1/5] 前端已删除，跳过" -ForegroundColor Yellow

# 2. 构建 Rust 主程序和更新助手
if (-not $SkipBuild) {
    Write-Host "[2/5] 构建 Rust 主程序 (release)..." -ForegroundColor Blue
    & cargo build --release --bin zhishi --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw "zhishi 构建失败" }
    Write-Host "  OK" -ForegroundColor Green

    Write-Host "[3/5] 构建更新助手 (release)..." -ForegroundColor Blue
    & cargo build --release --bin zhishi-updater --target x86_64-pc-windows-msvc --manifest-path src-tauri/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw "zhishi-updater 构建失败" }
    Write-Host "  OK" -ForegroundColor Green
} else {
    Write-Host "[2-3/5] 跳过 Rust 构建 (-SkipBuild)" -ForegroundColor Yellow
}

$TargetDir = "src-tauri\target\x86_64-pc-windows-msvc\release"
if (-not (Test-Path "$TargetDir\zhishi.exe")) { throw "未找到 $TargetDir\zhishi.exe，请先构建" }
if (-not (Test-Path "$TargetDir\zhishi-updater.exe")) { throw "未找到 $TargetDir\zhishi-updater.exe，请先构建" }

# 4. 准备旧版测试目录
Write-Host "[4/5] 准备旧版测试目录: $OldDir" -ForegroundColor Blue
if (Test-Path $OldDir) {
    Remove-Item -Recurse -Force $OldDir
}
New-Item -ItemType Directory -Path $OldDir -Force | Out-Null

# 复制主程序、更新助手、VC++ Runtime、Tauri 资源
Copy-Item "$TargetDir\zhishi.exe" $OldDir -Force
Copy-Item "$TargetDir\zhishi-updater.exe" $OldDir -Force

$Dlls = @("vcruntime140.dll", "vcruntime140_1.dll")
foreach ($dll in $Dlls) {
    $src = Join-Path "src-tauri\resources" $dll
    if (Test-Path $src) {
        Copy-Item $src $OldDir -Force
    } else {
        Write-Host "  警告: 未找到 $dll" -ForegroundColor Yellow
    }
}

$ResourceItems = @(
    "bundled-agents",
    "bundled-skills",
    "cli",
    "en.lproj",
    "novo",
    "nodejs",
    "server-dist.js",
    "server-dist.js.map",
    "shared",
    "sharp-runtime",
    "tsx-runtime",
    "zh-Hans.lproj"
)
foreach ($item in $ResourceItems) {
    $src = Join-Path $TargetDir $item
    if (Test-Path $src) {
        Copy-Item $src $OldDir -Recurse -Force
    }
}

# 创建便携模式标记和用户数据
"portable" | Out-File -FilePath (Join-Path $OldDir ".data_mode") -Encoding ascii -NoNewline
New-Item -ItemType Directory -Path (Join-Path $OldDir ".zhishi") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $OldDir ".zhishi\logs") -Force | Out-Null
New-Item -ItemType File -Path (Join-Path $OldDir ".zhishi\test-data.txt") -Force | Out-Null
Set-Content -Path (Join-Path $OldDir ".zhishi\test-data.txt") -Value "这是旧版用户数据，更新后应该保留"

Write-Host "  OK" -ForegroundColor Green

# 5. 准备新版 U 盘目录
Write-Host "[5/5] 准备新版 U 盘目录: $NewDir" -ForegroundColor Blue
if (Test-Path $NewDir) {
    Remove-Item -Recurse -Force $NewDir
}
New-Item -ItemType Directory -Path $NewDir -Force | Out-Null

# 新版暂时用同样的 exe（本地测试可以这样做，真实发版时需要是 0.2.33 的实际构建产物）
Copy-Item "$TargetDir\zhishi.exe" $NewDir -Force
Copy-Item "$TargetDir\zhishi-updater.exe" $NewDir -Force
foreach ($dll in $Dlls) {
    $src = Join-Path "src-tauri\resources" $dll
    if (Test-Path $src) {
        Copy-Item $src $NewDir -Force
    }
}
foreach ($item in $ResourceItems) {
    $src = Join-Path $TargetDir $item
    if (Test-Path $src) {
        Copy-Item $src $NewDir -Recurse -Force
    }
}
"portable" | Out-File -FilePath (Join-Path $NewDir ".data_mode") -Encoding ascii -NoNewline

Write-Host "  OK" -ForegroundColor Green

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  测试环境准备完成" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "下一步：" -ForegroundColor Yellow
Write-Host "1. 确保本地工单服务已启动（docker compose up -d）" -ForegroundColor White
Write-Host ""
Write-Host "2. 通过 API 设置测试版本（如果还没设置）：" -ForegroundColor White
Write-Host '   curl -X POST http://ticket.zhishi.help/api/v1/client-version/admin \' -ForegroundColor Cyan
Write-Host '     -H "X-API-Key: 你的_API_KEY" \' -ForegroundColor Cyan
Write-Host '     -H "Content-Type: application/json" \' -ForegroundColor Cyan
Write-Host '     -d "{"""version""":"""0.2.33""","""download_url""":"""http://ticket.zhishi.help/download/ZhiShi_0.2.33_x86_64-portable.zip"""}"' -ForegroundColor Cyan
Write-Host ""
Write-Host "2. 启动旧版 App：" -ForegroundColor White
Write-Host "   & '$OldDir\zhishi.exe'" -ForegroundColor Cyan
Write-Host ""
Write-Host "3. 启动后等待 30 秒，应弹出更新对话框" -ForegroundColor White
Write-Host ""
Write-Host "4. 更新日志位置：" -ForegroundColor White
Write-Host "   $OldDir\.zhishi\logs\" -ForegroundColor Cyan
Write-Host ""
Write-Host "提示：新版目录里还是 0.2.32 的 exe，但目录名是 0.2.33，足够测试流程。" -ForegroundColor DarkGray
Write-Host "      如需验证真实版本变化，请手动把版本号改成 0.2.33 后重新构建新版 exe。" -ForegroundColor DarkGray
