#!/usr/bin/env pwsh
# ZhiShi U 盘交付物打包脚本
#
# 功能：
#   1. 收集各平台构建产物（Windows / macOS / Linux）
#   2. 从 skillshub 复制 skills 功能包
#   3. 整理成统一的 U 盘交付目录结构
#   4. 生成使用说明 README.md
#
# 前置条件：
#   - 已运行 scripts/build/build_windows.ps1（本机）
#   - 如需要 macOS / Linux 产物，需先在对应平台构建并复制到本机 target 目录
#   - skills 包已准备好（默认：D:\project\skillshub\classified_top5）
#
# 用法：
#   .\scripts\release\package_usb_delivery.ps1
#   .\scripts\release\package_usb_delivery.ps1 -SkillsSource "D:\somewhere\skills" -OutputDir "D:\releases"

param(
    [string]$SkillsSource = "D:\project\skillshub\classified_top5",
    [string]$OutputDir = "",
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"

# 项目根目录
$ProjectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $ProjectDir

# 默认输出目录
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $ProjectDir "dist-usb"
}

# 读取版本号
if ([string]::IsNullOrWhiteSpace($Version)) {
    $PackageJson = Get-Content (Join-Path $ProjectDir "package.json") -Raw | ConvertFrom-Json
    $Version = $PackageJson.version
}

$PackageName = "ZhiShi-v${Version}-USB"
$PackageRoot = Join-Path $OutputDir $PackageName

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "  ZhiShi U 盘交付物打包" -ForegroundColor Green
Write-Host "  Version: $Version" -ForegroundColor Blue
Write-Host "  Output:  $PackageRoot" -ForegroundColor Blue
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# 清理旧目录
if (Test-Path $PackageRoot) {
    Write-Host "[0/5] 清理旧交付目录..." -ForegroundColor Blue
    Remove-Item -Recurse -Force $PackageRoot
}

# 创建目录结构
Write-Host "[1/5] 创建 U 盘目录结构..." -ForegroundColor Blue
$WindowsDir = Join-Path $PackageRoot "Windows"
$MacOSDir = Join-Path $PackageRoot "macOS"
$LinuxDir = Join-Path $PackageRoot "Linux"
$SkillsDir = Join-Path $PackageRoot "skills"

New-Item -ItemType Directory -Path $WindowsDir -Force | Out-Null
New-Item -ItemType Directory -Path $MacOSDir -Force | Out-Null
New-Item -ItemType Directory -Path $LinuxDir -Force | Out-Null
New-Item -ItemType Directory -Path $SkillsDir -Force | Out-Null
Write-Host "  OK" -ForegroundColor Green
Write-Host ""

# Windows 产物
Write-Host "[2/5] 收集 Windows 构建产物..." -ForegroundColor Blue
$WindowsBundleDir = Join-Path -Path $ProjectDir -ChildPath "src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis"
$WindowsFiles = @()

if (Test-Path $WindowsBundleDir) {
    $Installer = Get-ChildItem -Path $WindowsBundleDir -Filter "*.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch "portable" } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    $PortableZip = Get-ChildItem -Path $WindowsBundleDir -Filter "*portable*.zip" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if ($Installer) {
        Copy-Item $Installer.FullName -Destination $WindowsDir -Force
        $WindowsFiles += $Installer.Name
        Write-Host "  + $($Installer.Name)" -ForegroundColor Green
    }
    else {
        Write-Host "  警告: 未找到 Windows NSIS 安装包" -ForegroundColor Yellow
    }

    if ($PortableZip) {
        Copy-Item $PortableZip.FullName -Destination $WindowsDir -Force
        $WindowsFiles += $PortableZip.Name
        Write-Host "  + $($PortableZip.Name)" -ForegroundColor Green
    }
    else {
        Write-Host "  警告: 未找到 Windows 便携版 ZIP" -ForegroundColor Yellow
    }

    # WebView2 Runtime installer for offline repair on clean Windows/VM
    $WebView2Installer = Join-Path $ProjectDir "src-tauri\resources\MicrosoftEdgeWebView2Setup.exe"
    if (-not (Test-Path $WebView2Installer)) {
        Write-Host "  下载 WebView2 安装程序..." -ForegroundColor Cyan
        try {
            $webView2Url = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
            $webView2Temp = Join-Path $env:TEMP "MicrosoftEdgeWebView2Setup.exe"
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $webView2Url -OutFile $webView2Temp -UseBasicParsing -TimeoutSec 300
            $webView2Dir = Split-Path -Parent $WebView2Installer
            if (-not (Test-Path $webView2Dir)) {
                New-Item -ItemType Directory -Path $webView2Dir -Force | Out-Null
            }
            Move-Item $webView2Temp $WebView2Installer -Force
            Write-Host "  OK - 已下载 WebView2 安装程序" -ForegroundColor Green
        } catch {
            Write-Host "  警告: 无法下载 WebView2 安装程序: $_" -ForegroundColor Yellow
        }
    }
    if (Test-Path $WebView2Installer) {
        Copy-Item $WebView2Installer -Destination $WindowsDir -Force
        $WindowsFiles += "MicrosoftEdgeWebView2Setup.exe"
        Write-Host "  + MicrosoftEdgeWebView2Setup.exe" -ForegroundColor Green
    }
    else {
        Write-Host "  警告: 未找到 WebView2 安装程序" -ForegroundColor Yellow
    }
}
else {
    Write-Host "  警告: Windows 构建目录不存在：$WindowsBundleDir" -ForegroundColor Yellow
}
Write-Host ""

# macOS 产物
Write-Host "[3/5] 收集 macOS 构建产物..." -ForegroundColor Blue
$MacOSFiles = @()
$MacOSBundleDirs = @(
    (Join-Path -Path $ProjectDir -ChildPath "src-tauri\target\aarch64-apple-darwin\release\bundle\dmg"),
    (Join-Path -Path $ProjectDir -ChildPath "src-tauri\target\x86_64-apple-darwin\release\bundle\dmg")
)

foreach ($Dir in $MacOSBundleDirs) {
    if (Test-Path $Dir) {
        $Dmg = Get-ChildItem -Path $Dir -Filter "*.dmg" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($Dmg) {
            Copy-Item $Dmg.FullName -Destination $MacOSDir -Force
            $MacOSFiles += $Dmg.Name
            Write-Host "  + $($Dmg.Name)" -ForegroundColor Green
        }
    }
}

if ($MacOSFiles.Count -eq 0) {
    Write-Host "  提示: 未找到 macOS DMG，如不需要可忽略" -ForegroundColor Yellow
}
Write-Host ""

# Linux 产物
Write-Host "[4/5] 收集 Linux 构建产物..." -ForegroundColor Blue
$LinuxFiles = @()
$LinuxBundleDirs = @{
    AppImage = Join-Path -Path $ProjectDir -ChildPath "src-tauri\target\x86_64-unknown-linux-gnu\release\bundle\appimage"
    Deb = Join-Path -Path $ProjectDir -ChildPath "src-tauri\target\x86_64-unknown-linux-gnu\release\bundle\deb"
}

foreach ($Type in $LinuxBundleDirs.Keys) {
    $Dir = $LinuxBundleDirs[$Type]
    if (Test-Path $Dir) {
        $Filter = if ($Type -eq "AppImage") { "*.AppImage" } else { "*.deb" }
        $File = Get-ChildItem -Path $Dir -Filter $Filter -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($File) {
            Copy-Item $File.FullName -Destination $LinuxDir -Force
            $LinuxFiles += $File.Name
            Write-Host "  + $($File.Name)" -ForegroundColor Green
        }
    }
}

if ($LinuxFiles.Count -eq 0) {
    Write-Host "  提示: 未找到 Linux 产物，如不需要可忽略" -ForegroundColor Yellow
}
Write-Host ""

# Skills 功能包
Write-Host "[5/5] 复制 Skills 功能包..." -ForegroundColor Blue
if (Test-Path $SkillsSource) {
    $SourceItems = Get-ChildItem -Path $SkillsSource -Directory -ErrorAction SilentlyContinue
    if ($SourceItems) {
        foreach ($Item in $SourceItems) {
            $Dest = Join-Path $SkillsDir $Item.Name
            Copy-Item $Item.FullName -Destination $Dest -Recurse -Force
        }
        $SkillCount = ($SourceItems | Measure-Object).Count
        Write-Host "  OK - 已复制 $SkillCount 个 Skill 文件夹" -ForegroundColor Green
    }
    else {
        Write-Host "  警告: Skills 源目录为空：$SkillsSource" -ForegroundColor Yellow
    }
}
else {
    Write-Host "  警告: Skills 源目录不存在：$SkillsSource" -ForegroundColor Yellow
}
Write-Host ""

# 生成 README.md（使用单引号避免反引号转义问题）
$ReadmeLines = @(
    '# ZhiShi v{{VERSION}} 安装包'
    ''
    '本目录包含 ZhiShi 桌面端各平台安装包及 Skills 功能包。'
    ''
    '## 目录说明'
    ''
    '| 目录 | 内容 |'
    '|------|------|'
    '| `Windows/` | Windows 安装包、便携版压缩包、WebView2 修复程序 |'
    '| `macOS/` | macOS DMG 安装包 |'
    '| `Linux/` | Linux AppImage 和 deb 安装包 |'
    '| `skills/` | 第三方 Skills 功能包 |'
    ''
    '## 快速开始'
    ''
    '### Windows'
    ''
    '**方式一：安装包（推荐长期使用）**'
    ''
    '1. 打开 `Windows/` 目录。'
    '2. 双击 `ZhiShi_{{VERSION}}_x64-setup.exe`。'
    '3. 按安装向导完成安装。'
    '4. 从开始菜单或桌面快捷方式启动 ZhiShi。'
    ''
    '**方式二：便携版（绿色免安装）**'
    ''
    '1. 打开 `Windows/` 目录。'
    '2. 将 `ZhiShi_{{VERSION}}_x86_64-portable.zip` 解压到任意位置，例如 `D:\ZhiShi\`。'
    '3. 进入解压后的文件夹，双击 `zhishi.exe`。'
    ''
    '> 便携版所有数据（配置、会话、任务）都保存在解压文件夹内的 `.zhishi\` 目录中，删除整个文件夹即可彻底卸载。'
    ''
    '> 如果系统提示缺少 WebView2 运行环境，请运行同目录下的 `MicrosoftEdgeWebView2Setup.exe` 完成修复后再启动。'
    ''
    '### macOS'
    ''
    '1. 打开 `macOS/` 目录，选择对应芯片版本的 `.dmg`：'
    '   - Apple Silicon (M1/M2/M3): `ZhiShi_{{VERSION}}_aarch64.dmg`'
    '   - Intel: `ZhiShi_{{VERSION}}_x86_64.dmg`'
    '2. 双击 `.dmg` 文件。'
    '3. 将 `ZhiShi.app` 拖入「应用程序」文件夹。'
    '4. 从「启动台」或「应用程序」打开 ZhiShi。'
    ''
    '### Linux'
    ''
    '**方式一：AppImage（免安装）**'
    ''
    '```bash'
    'chmod +x ZhiShi_{{VERSION}}_x86_64.AppImage'
    './ZhiShi_{{VERSION}}_x86_64.AppImage'
    '```'
    ''
    '**方式二：deb 包（Debian/Ubuntu）**'
    ''
    '```bash'
    'sudo dpkg -i ZhiShi_{{VERSION}}_amd64.deb'
    'sudo apt-get install -f'
    '```'
    ''
    '## Skills 功能包安装'
    ''
    '1. 复制 `skills/` 目录下的所有文件夹到：'
    '   - Windows: `C:\Users\<用户名>\.zhishi\skills\`'
    '   - macOS / Linux: `~/.zhishi/skills/`'
    '2. 重启 ZhiShi。'
    '3. 在 **设置 > 技能 Skills > 用户技能** 中查看已添加的 Skills。'
    ''
    '## 首次使用'
    ''
    '1. 启动 ZhiShi 后，打开 **设置 > 模型供应商**。'
    '2. 配置你的 API Key（DeepSeek、Kimi、智谱等）。'
    '3. 回到启动页，添加工作区，新建会话，开始对话。'
    ''
    '## 技术支持'
    ''
    '如遇问题，请联系服务提供方，并提供应用版本号和日志文件。'
)

$ReadmeContent = ($ReadmeLines -join "`r`n") -replace '{{VERSION}}', $Version
$ReadmePath = Join-Path $PackageRoot "README.md"
$ReadmeContent | Out-File -FilePath $ReadmePath -Encoding utf8
Write-Host "  OK - 已生成 README.md" -ForegroundColor Green
Write-Host ""

# 最终汇总
Write-Host "=========================================" -ForegroundColor Green
Write-Host "  U 盘交付物打包完成" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host ""
Write-Host "输出目录: $PackageRoot" -ForegroundColor Cyan
Write-Host ""
Write-Host "内容清单:" -ForegroundColor Blue

$Tree = Get-ChildItem -Path $PackageRoot -Recurse -File |
    Select-Object -ExpandProperty FullName |
    ForEach-Object { $_.Substring($PackageRoot.Length + 1) }

foreach ($Item in $Tree) {
    Write-Host "  $Item" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "下一步：将整个文件夹复制到 U 盘根目录即可交付。" -ForegroundColor Green
Write-Host ""
