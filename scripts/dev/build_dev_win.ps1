#!/usr/bin/env pwsh

# ZhiShi Windows Dev 构建脚本

# 构建带 DevTools 的调试版本，启动时自动打开控制台

# 只构建 NSIS 安装包 (Debug 模式)



$ErrorActionPreference = "Stop"



$PROJECT_DIR = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)



# 加载 .env 文件（如果存在）

$envFile = Join-Path $PROJECT_DIR ".env"

if (Test-Path $envFile) {

    Get-Content $envFile | ForEach-Object {

        if ($_ -match '^([^=]+)=(.*)$') {

            $key = $matches[1].Trim()

            $value = $matches[2].Trim()

            # 移除可能的引号

            $value = $value -replace '^["'']|["'']$', ''

            [System.Environment]::SetEnvironmentVariable($key, $value, "Process")

        }

    }

}



# 颜色输出函数

function Write-ColorOutput {

    param(

        [string]$Message,

        [string]$Color = "White"

    )

    Write-Host $Message -ForegroundColor $Color

}



Write-Host ""

Write-ColorOutput "╔═══════════════════════════════════════════════════════╗" "Cyan"

Write-ColorOutput "║  🤖 ZhiShi Windows Dev 构建                         ║" "Cyan"

Write-ColorOutput "║  ⚠ DevTools 启用 + Debug 模式                        ║" "Cyan"

Write-ColorOutput "╚═══════════════════════════════════════════════════════╝" "Cyan"

Write-Host ""



# ========================================

# 版本同步检查

# ========================================

$packageJson = Get-Content (Join-Path $PROJECT_DIR "package.json") | ConvertFrom-Json

$PKG_VERSION = $packageJson.version



$tauriJson = Get-Content (Join-Path $PROJECT_DIR "src-tauri/tauri.conf.json") | ConvertFrom-Json

$TAURI_VERSION = $tauriJson.version



$cargoToml = Get-Content (Join-Path $PROJECT_DIR "src-tauri/Cargo.toml")

$CARGO_VERSION = ($cargoToml | Select-String 'version = "([^"]+)"' | Select-Object -First 1).Matches.Groups[1].Value



if ($PKG_VERSION -ne $TAURI_VERSION -or $PKG_VERSION -ne $CARGO_VERSION) {

    Write-ColorOutput "⚠ 版本号不一致:" "Yellow"

    Write-ColorOutput "  package.json:      $PKG_VERSION" "Cyan"

    Write-ColorOutput "  tauri.conf.json:   $TAURI_VERSION" "Cyan"

    Write-ColorOutput "  Cargo.toml:        $CARGO_VERSION" "Cyan"

    Write-Host ""

    $reply = Read-Host "是否同步版本号到 $PKG_VERSION? (y/N)"

    if ($reply -eq "y" -or $reply -eq "Y") {

        node (Join-Path $PROJECT_DIR "scripts/sync-version.js")

        Write-Host ""

    }

}



# 杀死残留进程（避免"旧代码"问题）

Write-ColorOutput "[准备] 杀死残留进程..." "Blue"



$appProcesses = Get-Process | Where-Object { $_.ProcessName -eq "ZhiShi" }



if ($appProcesses) {

    $appProcesses | Stop-Process -Force -ErrorAction SilentlyContinue

    Write-Host "  清理了 $($appProcesses.Count) 个 ZhiShi 进程" -ForegroundColor Gray

}



# 验证进程清理完成（最多等待 2 秒）

$maxWait = 20  # 20 * 100ms = 2s

$waited = 0

while ($waited -lt $maxWait) {

    $remainingApp = Get-Process -Name "ZhiShi" -ErrorAction SilentlyContinue

    if (-not $remainingApp) {

        break

    }

    Start-Sleep -Milliseconds 100

    $waited++

}



if ($waited -gt 0) {

    Write-Host "  进程清理验证完成 (耗时 $($waited * 100)ms)" -ForegroundColor Gray

}



Write-ColorOutput "✓ 进程已清理" "Green"

Write-Host ""



# 清理旧构建（包括 Rust 缓存的 resources）

Write-ColorOutput "[准备] 清理旧构建..." "Blue"



# 清理构建输出目录

$dirsToClean = @(

    @{ Path = (Join-Path $PROJECT_DIR "dist"); Name = "前端构建输出" },

    @{ Path = (Join-Path $PROJECT_DIR "src-tauri/target/x86_64-pc-windows-msvc/debug/bundle"); Name = "Debug 打包输出" },

    @{ Path = (Join-Path $PROJECT_DIR "src-tauri/target/x86_64-pc-windows-msvc/debug/resources"); Name = "Debug resources 缓存" }

)



foreach ($dir in $dirsToClean) {

    if (Test-Path $dir.Path) {

        try {

            Remove-Item -Recurse -Force $dir.Path -ErrorAction Stop

            Write-Host "  已清理: $($dir.Name)" -ForegroundColor Gray

        } catch {

            Write-Host "  警告: 清理 $($dir.Name) 失败: $_" -ForegroundColor Yellow

            # 不抛出异常，继续构建

        }

    }

}



# 创建占位符资源目录（满足 Tauri bundle 阶段的资源校验）。

# server-dist.js / cli/zhishi.js 由 tauri:build

# 的 beforeBuildCommand（tauri.conf.json）通过 npm run build:server/cli

# 在构建期间生成；不需要额外占位文件。


#   - cli/ : 仅占位，CLI bundle 由 esbuild-bundle.mjs 的 post-build hook 写入

foreach ($subdir in @("tsx-runtime", "cli")) {

    $d = Join-Path $PROJECT_DIR "src-tauri/resources/$subdir"

    if (-not (Test-Path $d)) {

        New-Item -ItemType Directory -Path $d -Force | Out-Null

    }

}

$tsxPlaceholder = Join-Path $PROJECT_DIR "src-tauri/resources/tsx-runtime/.dev-placeholder"

if (-not (Test-Path $tsxPlaceholder)) {

    "dev mode: tsx loads from top-level node_modules/tsx via find_tsx_runtime_loader fallback" | Out-File -FilePath $tsxPlaceholder -Encoding UTF8

}



# VC++ Runtime DLL 占位符（满足 tauri.windows.conf.json 资源校验）

foreach ($dll in @("vcruntime140.dll", "vcruntime140_1.dll")) {

    $dllPath = Join-Path $PROJECT_DIR "src-tauri/resources/$dll"

    if (-not (Test-Path $dllPath)) {

        $systemDll = "$env:SystemRoot\System32\$dll"

        if (Test-Path $systemDll) {

            Copy-Item $systemDll $dllPath -Force

        } else {

            "placeholder" | Out-File -FilePath $dllPath -Encoding UTF8

        }

    }

}



Write-ColorOutput "✓ 已清理并创建占位符" "Green"

Write-Host ""



# TypeScript 检查

Write-ColorOutput "[1/3] TypeScript 类型检查..." "Blue"

Set-Location $PROJECT_DIR

$typecheckResult = & npm.cmd run typecheck

if ($LASTEXITCODE -ne 0) {

    Write-ColorOutput "✗ TypeScript 检查失败，请修复后重试" "Red"

    exit 1

}

Write-ColorOutput "✓ TypeScript 检查通过" "Green"

Write-Host ""



# 前端 GUI 已删除（无窗口后台宿主形态）——跳过前端构建。

Write-ColorOutput "[2/3] 前端已删除，跳过" "Blue"

Write-Host ""



# zhishi CLI 的打包不在这里——`npm run tauri:build` 的 beforeBuildCommand

# (tauri.conf.json) 已包含 `npm run build:cli`，由 `scripts/esbuild-bundle.mjs`

# 的 post-build hook 同步把 zhishi.cmd 拷贝到 resources/cli/。



# 强制触发 Rust 重新编译 (确保 sidecar.rs 的逻辑修改生效)

# ./scripts/dev/build_dev.sh 用 `touch` 只更新 mtime；旧版本这里写的是

# `(Get-Date) | Out-File -Append`，把时间戳直接 *append 到源码文件内容*，

# 每次 dev build 都给 sidecar.rs / main.rs 屁股加一行垃圾，污染 git 工作区。

# PS 没有 touch，但等价做法是改 LastWriteTime 属性。

$sidecarFile = Join-Path $PROJECT_DIR "src-tauri/src/sidecar.rs"

$mainFile = Join-Path $PROJECT_DIR "src-tauri/src/main.rs"

(Get-Item $sidecarFile).LastWriteTime = Get-Date

(Get-Item $mainFile).LastWriteTime = Get-Date



# 构建 Tauri 应用

Write-ColorOutput "[3/3] 构建 Tauri 应用 (Debug 模式, NSIS)..." "Blue"



# 强制移除旧的可执行文件，防止 cargo 偷懒不重新链接

$oldExe = Join-Path $PROJECT_DIR "src-tauri/target/x86_64-pc-windows-msvc/debug/zhishi.exe"

if (Test-Path $oldExe) {

    Remove-Item $oldExe -Force

}



# 如果没有设置 TAURI_SIGNING_PRIVATE_KEY，跳过签名错误

# (App 本身会正常构建，只是 updater 签名会失败)

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {

    Write-ColorOutput "⚠ 未设置 TAURI_SIGNING_PRIVATE_KEY，更新签名将被跳过" "Yellow"

}



Write-ColorOutput "这可能需要几分钟..." "Yellow"



# 使用 --target 指定架构，确保构建正确的版本

try {

    & npm.cmd run tauri:build -- --debug --bundles nsis --target x86_64-pc-windows-msvc --config src-tauri/tauri.windows.conf.json

    if ($LASTEXITCODE -ne 0 -and $env:TAURI_SIGNING_PRIVATE_KEY) {

        throw "Tauri build failed"

    }

} catch {

    if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {

        Write-ColorOutput "⚠ 构建完成（签名跳过）" "Yellow"

    } else {

        throw

    }

}



# 查找输出

$BUNDLE_DIR = Join-Path $PROJECT_DIR "src-tauri/target/x86_64-pc-windows-msvc/debug/bundle/nsis"

$SETUP_EXE = Get-ChildItem -Path $BUNDLE_DIR -Filter "*-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1



Write-Host ""

Write-ColorOutput "═══════════════════════════════════════════════════════" "Green"

Write-ColorOutput "  Dev 构建完成!" "Green"

Write-ColorOutput "═══════════════════════════════════════════════════════" "Green"

Write-Host ""



if ($SETUP_EXE) {

    $APP_SIZE = "{0:N2} MB" -f ($SETUP_EXE.Length / 1MB)

    Write-ColorOutput "  应用路径:" "Cyan"

    Write-Host "    🪟 $($SETUP_EXE.FullName)"

    Write-ColorOutput "    📏 大小: $APP_SIZE" "White"

    Write-Host ""

    Write-ColorOutput "  Dev 特性:" "Cyan"

    Write-ColorOutput "    ✅ 启动时自动打开 DevTools" "White"

    Write-ColorOutput "    ✅ 宽松 CSP (允许 IPC)" "White"

    Write-ColorOutput "    ✅ 包含最新 server 代码" "White"

    Write-Host ""

} else {

    Write-ColorOutput "  未找到构建产物，请检查上方输出" "Yellow"

    Write-ColorOutput "  预期路径: $BUNDLE_DIR" "Yellow"

}



Write-ColorOutput "  运行方式:" "Cyan"

if ($SETUP_EXE) {

    Write-Host "    1. 安装: .\$($SETUP_EXE.Name)"

    Write-Host "    2. 或直接运行安装包测试"

} else {

    Write-Host "    (构建失败，无可用安装包)"

}

Write-Host ""

