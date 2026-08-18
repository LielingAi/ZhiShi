#!/usr/bin/env pwsh
# ZhiShi 发布流程交互菜单
# 统一入口：改版本号 → 构建 → 发布 → USB 打包
#
# 用法：在项目根目录运行
#   .\scripts\release\release_menu.ps1

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $ProjectDir

# ── 辅助函数 ──────────────────────────────────────────

function Get-CurrentVersion {
    $conf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
    return $conf.version
}

function Show-Header {
    Clear-Host
    $ver = Get-CurrentVersion
    Write-Host "╔═══════════════════════════════════════════════╗" -ForegroundColor Cyan
    Write-Host "║         ZhiShi 发布流程管理                  ║" -ForegroundColor Cyan
    Write-Host "╠═══════════════════════════════════════════════╣" -ForegroundColor Cyan
    Write-Host "║  当前版本: v$ver" -ForegroundColor Green
    Write-Host "║  工作目录: $ProjectDir" -ForegroundColor Gray
    Write-Host "╚═══════════════════════════════════════════════╝" -ForegroundColor Cyan
    Write-Host ""
}

function Show-Menu {
    Show-Header
    Write-Host "  请选择操作:" -ForegroundColor White
    Write-Host ""
    Write-Host "    [1] 查看/修改版本号" -ForegroundColor Yellow
    Write-Host "    [2] 构建打包 (build_windows.ps1)" -ForegroundColor Yellow
    Write-Host "    [3] 发布上传 (publish_windows.ps1)" -ForegroundColor Yellow
    Write-Host "    [4] USB 交付物打包" -ForegroundColor Yellow
    Write-Host "    [5] 全自动流程 (1→2→3 依次执行)" -ForegroundColor Magenta
    Write-Host ""
    Write-Host "    [0] 退出" -ForegroundColor Gray
    Write-Host ""
    $choice = Read-Host "  请输入编号"
    return $choice
}

function Confirm-Step {
    param([string]$Message)
    Write-Host ""
    $ans = Read-Host "  $Message (y/N)"
    return ($ans -eq "y" -or $ans -eq "Y")
}

function Wait-And-Return {
    Write-Host ""
    Write-Host "  按回车键返回菜单..." -ForegroundColor Gray
    Read-Host | Out-Null
}

# ── 功能模块 ──────────────────────────────────────────

function Show-VersionInfo {
    Show-Header
    $ver = Get-CurrentVersion
    $pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
    $cargo = Get-Content "src-tauri\Cargo.toml" -Raw
    $cargoVer = if ($cargo -match 'version = "([^"]+)"') { $Matches[1] } else { "未知" }

    Write-Host "  版本信息:" -ForegroundColor Cyan
    Write-Host "  ----------------------------------------"
    Write-Host "    tauri.conf.json: $ver" -ForegroundColor White
    Write-Host "    package.json:    $($pkg.version)" -ForegroundColor White
    Write-Host "    Cargo.toml:      $cargoVer" -ForegroundColor White

    $match = ($ver -eq $pkg.version -and $ver -eq $cargoVer)
    if ($match) {
        Write-Host "  ----------------------------------------"
        Write-Host "  状态: ✅ 版本一致" -ForegroundColor Green
    } else {
        Write-Host "  ----------------------------------------"
        Write-Host "  状态: ❌ 版本不一致，需要同步" -ForegroundColor Yellow
    }
    Write-Host ""

    if (Confirm-Step "是否修改版本号？") {
        $newVer = Read-Host "  输入新版本号 (当前: $ver)"
        if ($newVer -and $newVer -match '^\d+\.\d+\.\d+$') {
            Write-Host ""
            Write-Host "  正在更新版本号到 v$newVer ..." -ForegroundColor Cyan

            # 更新 tauri.conf.json
            $conf = Get-Content "src-tauri\tauri.conf.json" -Raw
            $conf = $conf -replace '"version": "\d+\.\d+\.\d+"', "`"version`": `"$newVer`""
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllText("src-tauri\tauri.conf.json", $conf, $utf8NoBom)

            # 更新 package.json
            $pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
            $pkg.version = $newVer
            $pkgJson = $pkg | ConvertTo-Json -Depth 10
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllText("package.json", $pkgJson, $utf8NoBom)

            # 更新 Cargo.toml
            $cargo = Get-Content "src-tauri\Cargo.toml" -Raw
            $cargo = $cargo -replace '^version = "\d+\.\d+\.\d+"', "version = `"$newVer`""
            [System.IO.File]::WriteAllText("src-tauri\Cargo.toml", $cargo, $utf8NoBom)

            Write-Host "  ✅ 版本已更新为 v$newVer" -ForegroundColor Green
        } else {
            Write-Host "  ❌ 版本号格式错误 (期望 x.y.z)" -ForegroundColor Red
        }
    }
    Wait-And-Return
}

function Run-Build {
    Show-Header
    $ver = Get-CurrentVersion
    Write-Host "  ⏳ 即将构建 v$ver" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  参数选项:" -ForegroundColor Gray
    Write-Host "    [1] 标准构建（推荐）" -ForegroundColor Yellow
    Write-Host "    [2] 跳过 TypeScript 检查" -ForegroundColor Yellow
    Write-Host "    [3] 仅构建可执行文件（跳过 NSIS 打包）" -ForegroundColor Yellow
    Write-Host "    [4] 跳过便携版 ZIP" -ForegroundColor Yellow
    Write-Host "    [5] USB 便携版模式" -ForegroundColor Yellow
    Write-Host "    [0] 返回菜单" -ForegroundColor Gray
    Write-Host ""
    $opt = Read-Host "  请选择构建模式"

    $args = @()
    switch ($opt) {
        "1" { # 标准构建
            if (-not (Confirm-Step "确认开始构建 v$ver？")) { return }
        }
        "2" { # 跳过类型检查
            $args += "-SkipTypeCheck"
            if (-not (Confirm-Step "确认开始构建 v$ver（跳过类型检查）？")) { return }
        }
        "3" { # 仅 EXE
            $args += "-SkipBundle"
            if (-not (Confirm-Step "确认开始构建 v$ver（跳过 NSIS）？")) { return }
        }
        "4" { # 跳过便携版
            $args += "-SkipPortable"
            if (-not (Confirm-Step "确认开始构建 v$ver（跳过便携版）？")) { return }
        }
        "5" { # USB 模式
            $args += "-USBMode"
            if (-not (Confirm-Step "确认开始 USB 便携版构建 v$ver？")) { return }
        }
        default { return }
    }

    Write-Host ""
    Write-Host "  🔨 开始构建，这可能需要 10-30 分钟..." -ForegroundColor Yellow
    Write-Host ""

    & "$ProjectDir\scripts\build\build_windows.ps1" @args

    if ($LASTEXITCODE -eq 0 -or $?) {
        Write-Host ""
        Write-Host "  ✅ 构建完成" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "  ❌ 构建失败，请查看上方错误信息" -ForegroundColor Red
    }
    Wait-And-Return
}

function Run-Publish {
    Show-Header
    $ver = Get-CurrentVersion
    Write-Host "  📤 即将发布 v$ver" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  这将执行以下操作:" -ForegroundColor Gray
    Write-Host "    1. 上传便携版 ZIP 到工单服务器" -ForegroundColor White
    Write-Host "    2. 上传构建产物到 R2" -ForegroundColor White
    Write-Host "    3. 上传 GitHub Release" -ForegroundColor White
    Write-Host ""

    # 检查构建产物是否存在
    $nsisDir = "src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis"
    if (-not (Test-Path $nsisDir)) {
        Write-Host "  ⚠ 未找到构建产物目录" -ForegroundColor Red
        Write-Host "  请先运行构建（菜单选项 2）" -ForegroundColor Yellow
        Wait-And-Return
        return
    }

    # 检查便携版 ZIP
    $portableZip = Get-ChildItem -Path $nsisDir -Filter "*portable*.zip" -ErrorAction SilentlyContinue
    if (-not $portableZip) {
        Write-Host "  ⚠ 未找到便携版 ZIP" -ForegroundColor Yellow
        Write-Host "  发布脚本将跳过上传到工单服务器" -ForegroundColor Yellow
    } else {
        Write-Host "  便携版 ZIP: $($portableZip.Name)" -ForegroundColor Cyan
    }

    # 检查 API_KEY
    $apiKey = [Environment]::GetEnvironmentVariable("API_KEY", "Process")
    if (-not $apiKey) {
        # 尝试从 .env 读取
        $envFile = Join-Path $ProjectDir ".env"
        if (Test-Path $envFile) {
            $envContent = Get-Content $envFile
            $match = $envContent | Select-String '^API_KEY=(.+)$'
            if ($match) {
                $apiKey = $match.Matches.Groups[1].Value
            }
        }
    }
    if (-not $apiKey) {
        Write-Host "  ⚠ 未配置 API_KEY" -ForegroundColor Yellow
        Write-Host "  请在 .env 中添加: API_KEY=你的密钥" -ForegroundColor Yellow
    } else {
        Write-Host "  API_KEY: 已配置 ✅" -ForegroundColor Green
    }

    Write-Host ""
    if (-not (Confirm-Step "确认发布 v$ver？")) { return }

    Write-Host ""
    Write-Host "  📤 开始发布..." -ForegroundColor Yellow
    Write-Host ""

    & "$ProjectDir\scripts\release\publish_windows.ps1"

    if ($LASTEXITCODE -eq 0 -or $?) {
        Write-Host ""
        Write-Host "  ✅ 发布完成" -ForegroundColor Green
    } else {
        Write-Host ""
        Write-Host "  ⚠ 发布过程有警告，请查看上方信息" -ForegroundColor Yellow
    }
    Wait-And-Return
}

function Run-UsbPackage {
    Show-Header
    $ver = Get-CurrentVersion
    Write-Host "  💾 USB 交付物打包" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  将构建产物整理为 U 盘交付目录结构" -ForegroundColor Gray
    Write-Host "  包含: Windows / macOS / Linux 安装包 + Skills 功能包" -ForegroundColor Gray
    Write-Host ""

    if (-not (Confirm-Step "确认打包 v$ver？")) { return }

    Write-Host ""
    & "$ProjectDir\scripts\release\package_usb_delivery.ps1" -Version $ver

    Write-Host ""
    Write-Host "  ✅ USB 打包完成" -ForegroundColor Green
    Write-Host "  输出目录: $ProjectDir\dist-usb\ZhiShi-v${ver}-USB" -ForegroundColor Cyan
    Wait-And-Return
}

function Run-FullAuto {
    Show-Header
    Write-Host "  🔄 全自动发布流程" -ForegroundColor Magenta
    Write-Host ""
    Write-Host "  将依次执行:" -ForegroundColor Cyan
    Write-Host "    1. 修改版本号" -ForegroundColor White
    Write-Host "    2. 构建打包" -ForegroundColor White
    Write-Host "    3. 发布上传" -ForegroundColor White
    Write-Host ""
    Write-Host "  ⚠ 构建过程需要 10-30 分钟，请确保网络稳定" -ForegroundColor Yellow
    Write-Host ""

    if (-not (Confirm-Step "确认开始全自动流程？")) { return }

    # 第一步：改版本号
    $currentVer = Get-CurrentVersion
    Write-Host ""
    Write-Host "  [1/3] 修改版本号" -ForegroundColor Cyan
    $newVer = Read-Host "  当前版本 v$currentVer，输入新版本号"
    if (-not $newVer -or $newVer -notmatch '^\d+\.\d+\.\d+$') {
        Write-Host "  ❌ 版本号格式错误，取消流程" -ForegroundColor Red
        Wait-And-Return
        return
    }

    # 更新 tauri.conf.json
    $conf = Get-Content "src-tauri\tauri.conf.json" -Raw
    $conf = $conf -replace '"version": "\d+\.\d+\.\d+"', "`"version`": `"$newVer`""
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText("src-tauri\tauri.conf.json", $conf, $utf8NoBom)

    # 更新 package.json
    $pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
    $pkg.version = $newVer
    $pkgJson = $pkg | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText("package.json", $pkgJson, $utf8NoBom)

    # 更新 Cargo.toml
    $cargo = Get-Content "src-tauri\Cargo.toml" -Raw
    $cargo = $cargo -replace '^version = "\d+\.\d+\.\d+"', "version = `"$newVer`""
    [System.IO.File]::WriteAllText("src-tauri\Cargo.toml", $cargo, $utf8NoBom)

    Write-Host "  ✅ 版本已更新为 v$newVer" -ForegroundColor Green

    # 第二步：构建
    Write-Host ""
    Write-Host "  [2/3] 开始构建 v$newVer ..." -ForegroundColor Cyan
    Write-Host "  这可能需要 10-30 分钟..." -ForegroundColor Yellow
    & "$ProjectDir\scripts\build\build_windows.ps1"

    if ($LASTEXITCODE -ne 0 -and -not $?) {
        Write-Host "  ❌ 构建失败，流程终止" -ForegroundColor Red
        Wait-And-Return
        return
    }

    # 第三步：发布
    Write-Host ""
    Write-Host "  [3/3] 开始发布 v$newVer ..." -ForegroundColor Cyan
    & "$ProjectDir\scripts\release\publish_windows.ps1"

    Write-Host ""
    Write-Host "  ✅ 全自动流程完成！" -ForegroundColor Green
    Write-Host "  版本: v$currentVer → v$newVer" -ForegroundColor Cyan
    Wait-And-Return
}

# ── 主循环 ──────────────────────────────────────────

# 加载 .env 到进程环境变量（供发布脚本读取）
$envFile = Join-Path $ProjectDir ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^([^#=]+)=(.*)$') {
            $name = $Matches[1].Trim()
            $value = $Matches[2].Trim()
            if ($value -match '^"([^"]*)"' -or $value -match "^'([^']*)'") {
                $value = $Matches[1]
            } else {
                $value = $value -replace '\s+#.*$', ''
                $value = $value.Trim()
            }
            Set-Item -Path "env:$name" -Value $value
        }
    }
}

while ($true) {
    $choice = Show-Menu
    switch ($choice) {
        "1" { Show-VersionInfo }
        "2" { Run-Build }
        "3" { Run-Publish }
        "4" { Run-UsbPackage }
        "5" { Run-FullAuto }
        "0" {
            Write-Host "  再见！" -ForegroundColor Cyan
            exit 0
        }
        default {
            Write-Host "  无效选项，请重新输入" -ForegroundColor Red
            Start-Sleep -Seconds 1
        }
    }
}
