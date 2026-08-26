#!/usr/bin/env pwsh

# ZhiShi Windows 正式发布构建脚本

# 构建 NSIS 安装包和便携版 ZIP

# 支持 Windows x64



param(

    [switch]$SkipTypeCheck,

    [switch]$SkipFrontend,

    [switch]$SkipPortable,

    [switch]$USBMode,

    [switch]$SkipBundle

)



$ErrorActionPreference = "Stop"

$BuildSuccess = $false



try {

    $ProjectDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))

    Set-Location $ProjectDir



    # 读取版本号

    $TauriConf = Get-Content "src-tauri\tauri.conf.json" -Raw -Encoding UTF8 | ConvertFrom-Json

    $Version = $TauriConf.version

    $TauriConfPath = Join-Path $ProjectDir "src-tauri\tauri.conf.json"

    $EnvFile = Join-Path $ProjectDir ".env"



    Write-Host ""

    Write-Host "=========================================" -ForegroundColor Cyan

    Write-Host "  ZhiShi Windows 发布构建" -ForegroundColor Green

    if ($USBMode) {

        Write-Host "  Mode: USB Portable" -ForegroundColor Magenta

    } else {

        Write-Host "  Mode: Local Install" -ForegroundColor Blue

    }

    Write-Host "  Version: $Version" -ForegroundColor Blue

    Write-Host "=========================================" -ForegroundColor Cyan

    Write-Host ""



    # ========================================

    # 版本同步检查

    # ========================================

    $PkgJson = Get-Content "package.json" -Raw -Encoding UTF8 | ConvertFrom-Json

    $PkgVersion = $PkgJson.version



    $CargoToml = Get-Content "src-tauri\Cargo.toml" -Raw

    $CargoVersionMatch = [regex]::Match($CargoToml, 'version = "([^"]+)"')

    $CargoVersion = if ($CargoVersionMatch.Success) { $CargoVersionMatch.Groups[1].Value } else { "" }



    if ($PkgVersion -ne $Version -or $PkgVersion -ne $CargoVersion) {

        Write-Host "版本号不一致:" -ForegroundColor Yellow

        Write-Host "  package.json:    $PkgVersion" -ForegroundColor Cyan

        Write-Host "  tauri.conf.json: $Version" -ForegroundColor Cyan

        Write-Host "  Cargo.toml:      $CargoVersion" -ForegroundColor Cyan

        Write-Host ""

        $sync = Read-Host "是否同步版本号到 $PkgVersion? (y/N)"

        if ($sync -eq "y" -or $sync -eq "Y") {

            & node "$ProjectDir\scripts\sync-version.js"

            $Version = $PkgVersion

            Write-Host ""

        }

    }



    # ========================================

    # 加载环境变量

    # ========================================

    Write-Host "[1/7] 加载环境配置..." -ForegroundColor Blue



    if (Test-Path $EnvFile) {

        # 加载 .env (支持行内注释)

        Get-Content $EnvFile | ForEach-Object {

            if ($_ -match '^([^#=]+)=(.*)$') {

                $name = $Matches[1].Trim()

                $value = $Matches[2].Trim()



                # 处理带引号的值（提取引号内的内容，忽略引号外的注释）

                if ($value -match '^"([^"]*)"' -or $value -match "^'([^']*)'") {

                    $value = $Matches[1]

                } else {

                    # 无引号的值，移除行内注释

                    $value = $value -replace '\s+#.*$', ''

                    $value = $value.Trim()

                }



                [Environment]::SetEnvironmentVariable($name, $value, "Process")

            }

        }

        Write-Host "  OK - 已加载 .env" -ForegroundColor Green

    }

    else {

        Write-Host "  警告: .env 文件不存在，将使用默认配置" -ForegroundColor Yellow

    }



    # 检查 Tauri 签名密钥

    $TauriSigningKey = [Environment]::GetEnvironmentVariable("TAURI_SIGNING_PRIVATE_KEY", "Process")

    if (-not $TauriSigningKey) {

        Write-Host ""

        Write-Host "=========================================" -ForegroundColor Yellow

        Write-Host "  警告: TAURI_SIGNING_PRIVATE_KEY 未设置" -ForegroundColor Yellow

        Write-Host "  自动更新功能将不可用!" -ForegroundColor Yellow

        Write-Host "=========================================" -ForegroundColor Yellow

        Write-Host ""

        $continue = Read-Host "是否继续构建? (Y/n)"

        if ($continue -eq "n" -or $continue -eq "N") {

            Write-Host "构建已取消" -ForegroundColor Red

            throw "用户取消构建"

        }

    }

    else {

        Write-Host "  OK - Tauri 签名私钥已配置" -ForegroundColor Green

    }

    Write-Host ""





    # ========================================

    Write-Host "[2/7] 检查依赖..." -ForegroundColor Blue



    function Test-Command {

        param([string]$Command, [string]$HelpUrl)

        try {

            $null = Invoke-Expression $Command 2>&1

            return $true

        }

        catch {

            Write-Host "  X - $Command 未安装" -ForegroundColor Red

            Write-Host "      请安装: $HelpUrl" -ForegroundColor Yellow

            return $false

        }

    }



    $depOk = $true

    if (-not (Test-Command "rustc --version" "https://rustup.rs")) { $depOk = $false }

    if (-not (Test-Command "npm --version" "https://nodejs.org")) { $depOk = $false }



    # 检查 Rust Windows 目标

    $installedTargets = & rustup target list --installed 2>$null

    if ($installedTargets -notcontains "x86_64-pc-windows-msvc") {

        Write-Host "  安装 Rust 目标: x86_64-pc-windows-msvc" -ForegroundColor Yellow

        & rustup target add x86_64-pc-windows-msvc

    }

    else {

        Write-Host "  OK - Rust 目标已安装: x86_64-pc-windows-msvc" -ForegroundColor Green

    }



    if (-not $depOk) {

        throw "请先安装缺失的依赖"

    }



    $nodejsPath = "src-tauri\resources\nodejs\node.exe"

    $NodeDir = "src-tauri\resources\nodejs"

    Write-Host "  检查 bundled Node.js... " -NoNewline

    if (Test-Path $nodejsPath) {

        Write-Host "OK (exists)" -ForegroundColor Green

        # Node.js 已存在，但仍需确保 npm 已升级（首次下载后未升级的遗留情况）

        $npmDir = Join-Path $NodeDir "node_modules\npm"

        $nodeExe = Join-Path $NodeDir "node.exe"

        if (Test-Path $npmDir) {

            $npmCli = Join-Path $npmDir "bin\npm-cli.js"

            $curVer = & $nodeExe $npmCli --version 2>&1

            # npm 11.9.0 has minizlib CJS bug — must upgrade

            if ("$curVer" -match "^11\.[0-9]\.") {

                Write-Host "    npm v$curVer 需要升级..." -ForegroundColor Yellow

                try {

                    $npmTmpDir = Join-Path $env:TEMP "npm_upgrade_$(Get-Random)"

                    New-Item -ItemType Directory -Path $npmTmpDir -Force | Out-Null

                    $registryJson = Invoke-RestMethod -Uri "https://registry.npmjs.org/npm/latest" -TimeoutSec 30

                    $tarballUrl = $registryJson.dist.tarball

                    $tgzPath = Join-Path $npmTmpDir "npm.tgz"

                    Invoke-WebRequest -Uri $tarballUrl -OutFile $tgzPath -TimeoutSec 60

                    tar -xzf $tgzPath -C $npmTmpDir 2>&1 | Out-Null

                    $extractedPkg = Join-Path $npmTmpDir "package"

                    if (Test-Path $extractedPkg) {

                        Remove-Item -Recurse -Force $npmDir

                        Move-Item -Path $extractedPkg -Destination $npmDir

                        $newVer = & $nodeExe (Join-Path $npmDir "bin\npm-cli.js") --version 2>&1

                        Write-Host "    npm 升级: v$curVer → v$newVer ✓" -ForegroundColor Green

                    }

                    Remove-Item -Recurse -Force $npmTmpDir -ErrorAction SilentlyContinue

                } catch {

                    Write-Host "    npm 升级失败: $_" -ForegroundColor Red

                }

            } else {

                Write-Host "    npm v$curVer ✓" -ForegroundColor Green

            }

        }

    } else {

        Write-Host "MISSING - downloading..." -ForegroundColor Yellow

        # Auto-download Node.js if .\scripts\setup\setup_windows.ps1 was not run

        try {

            $NodeVersion = "24.14.0"

            $NodeDir = "src-tauri\resources\nodejs"

            $ZipName = "node-v$NodeVersion-win-x64.zip"

            $TempZip = Join-Path $env:TEMP "node-windows.zip"

            $TempDir = Join-Path $env:TEMP "node-windows-extract"

            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

            Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/$ZipName" -OutFile $TempZip -UseBasicParsing -TimeoutSec 300

            if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }

            Expand-Archive -Path $TempZip -DestinationPath $TempDir -Force

            $ExtractedDir = Join-Path $TempDir "node-v$NodeVersion-win-x64"

            if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }

            New-Item -ItemType Directory -Path $NodeDir -Force | Out-Null

            # Copy top-level files

            Copy-Item (Join-Path $ExtractedDir "node.exe") $NodeDir -Force

            Copy-Item (Join-Path $ExtractedDir "npm.cmd") $NodeDir -Force

            Copy-Item (Join-Path $ExtractedDir "npx.cmd") $NodeDir -Force

            Copy-Item (Join-Path $ExtractedDir "npm") $NodeDir -Force

            Copy-Item (Join-Path $ExtractedDir "npx") $NodeDir -Force

            # Use robocopy for node_modules — Copy-Item -Recurse silently skips

            # files beyond MAX_PATH (260 chars), corrupting npm's minizlib/minipass

            $SrcMod = Join-Path $ExtractedDir "node_modules"

            $DstMod = Join-Path $NodeDir "node_modules"

            if (Test-Path $SrcMod) {

                & robocopy $SrcMod $DstMod /E /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null

                if ($LASTEXITCODE -ge 8) { throw "robocopy failed: exit $LASTEXITCODE" }

            }

            if (Test-Path $TempZip) { Remove-Item -Force $TempZip }

            if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }

            # Upgrade npm — bundled npm 11.9.0 has minizlib CJS bug on Windows.

            # CANNOT use `npm install npm@latest` (catch-22: broken npm can't upgrade itself).

            # Download npm tarball directly with Invoke-WebRequest + tar (Win10+ built-in).

            $npmDir = Join-Path $NodeDir "node_modules\npm"

            if (Test-Path $npmDir) {

                Write-Host "    升级 npm (curl + tar)..." -NoNewline

                try {

                    $nodeExe = Join-Path $NodeDir "node.exe"

                    $oldNpmCli = Join-Path $npmDir "bin\npm-cli.js"

                    $oldVer = if (Test-Path $oldNpmCli) { & $nodeExe $oldNpmCli --version 2>&1 } else { "unknown" }

                    Write-Host " 当前 v$oldVer" -NoNewline



                    $npmTmpDir = Join-Path $env:TEMP "npm_upgrade_$(Get-Random)"

                    New-Item -ItemType Directory -Path $npmTmpDir -Force | Out-Null

                    $registryJson = Invoke-RestMethod -Uri "https://registry.npmjs.org/npm/latest" -TimeoutSec 30

                    $tarballUrl = $registryJson.dist.tarball

                    Write-Host " → 下载 $($registryJson.version)..." -NoNewline

                    $tgzPath = Join-Path $npmTmpDir "npm.tgz"

                    Invoke-WebRequest -Uri $tarballUrl -OutFile $tgzPath -TimeoutSec 60

                    tar -xzf $tgzPath -C $npmTmpDir 2>&1 | Out-Null

                    $extractedPkg = Join-Path $npmTmpDir "package"

                    if (Test-Path $extractedPkg) {

                        Remove-Item -Recurse -Force $npmDir

                        Move-Item -Path $extractedPkg -Destination $npmDir

                        $newNpmCli = Join-Path $npmDir "bin\npm-cli.js"

                        $newVer = & $nodeExe $newNpmCli --version 2>&1

                        Write-Host " → v$newVer ✓" -ForegroundColor Green

                    } else {

                        Write-Host " 解压失败 (package/ 目录不存在)" -ForegroundColor Red

                    }

                    Remove-Item -Recurse -Force $npmTmpDir -ErrorAction SilentlyContinue

                } catch {

                    Write-Host " 下载失败: $_ " -ForegroundColor Red

                    Write-Host "    ⚠ npm 未升级，插件安装可能失败" -ForegroundColor Yellow

                    Remove-Item -Recurse -Force $npmTmpDir -ErrorAction SilentlyContinue

                }

            }

            Write-Host "    OK - Node.js downloaded" -ForegroundColor Green

        } catch {

            Write-Host "    下载失败，请先运行 .\scripts\setup\setup_windows.ps1" -ForegroundColor Red

            $depOk = $false

        }

    }



    $gitInstallerPath = "src-tauri\nsis\Git-Installer.exe"

    Write-Host "  检查 Git installer... " -NoNewline

    if (Test-Path $gitInstallerPath) {

        Write-Host "OK" -ForegroundColor Green

    } else {

        Write-Host "MISSING" -ForegroundColor Red

        Write-Host "    请先运行 .\scripts\setup\setup_windows.ps1 下载 Git 安装包" -ForegroundColor Yellow

        $depOk = $false

    }



    # VC++ Runtime DLL (app-local deployment for bundled Node.js + native modules)

    $resDir = "src-tauri\resources"

    $vcDlls = @("vcruntime140.dll", "vcruntime140_1.dll")

    Write-Host "  检查 VC++ Runtime DLL... " -NoNewline

    $allPresent = $true

    foreach ($dll in $vcDlls) {

        if (-not (Test-Path (Join-Path $resDir $dll))) { $allPresent = $false; break }

    }

    if ($allPresent) {

        Write-Host "OK" -ForegroundColor Green

    } else {

        # Auto-extract from system if not present (dev machine always has MSVC)

        $systemDll = "$env:SystemRoot\System32\vcruntime140.dll"

        if (Test-Path $systemDll) {

            if (-not (Test-Path $resDir)) { New-Item -ItemType Directory -Path $resDir -Force | Out-Null }

            foreach ($dll in $vcDlls) {

                $src = "$env:SystemRoot\System32\$dll"

                if (Test-Path $src) {

                    Copy-Item $src (Join-Path $resDir $dll) -Force

                }

            }

            Write-Host "OK (auto-extracted)" -ForegroundColor Green

        } else {

            Write-Host "MISSING" -ForegroundColor Red

            Write-Host "    请先运行 .\scripts\setup\setup_windows.ps1 提取 VC++ Runtime DLL" -ForegroundColor Yellow

            $depOk = $false

        }

    }



    if (-not $depOk) {

        throw "缺少构建必需文件，请运行 .\scripts\setup\setup_windows.ps1"

    }



    Write-Host "  OK - 依赖检查通过" -ForegroundColor Green

    Write-Host ""



    # ========================================

    # 验证 CSP 配置（不再覆盖）

    # ========================================

    Write-Host "[3/7] 验证 CSP 配置..." -ForegroundColor Blue



    $conf = Get-Content $TauriConfPath -Raw -Encoding UTF8 | ConvertFrom-Json

    $currentCsp = $conf.app.security.csp



    # 验证关键 CSP 指令是否存在

    $requiredCspParts = @(

        "http://ipc.localhost",

        "asset:"

        # 1.2.3：删掉 "https://download.zhishi.help" 要求——GUI 删除后 CSP 只约束
        # 占位页，运行时代码（Rust/Node）下资源不受 CSP 管；全仓库无任何
        # WebView 内代码引用该域，此要求为 GUI 时代残留。

    )



    $missingParts = @()

    foreach ($part in $requiredCspParts) {

        if ($currentCsp -notlike "*$part*") {

            $missingParts += $part

        }

    }



    # 特殊验证: connect-src 指令必须包含 http://ipc.localhost (Windows Tauri IPC 关键)

    # connect-src 是管 fetch/XHR/WebSocket 的标准 CSP 指令；Windows Tauri IPC 走

    # Fetch API 打到 http://ipc.localhost，必须由 connect-src 放行。（旧版校验的

    # 是非标准指令 fetch-src——WebKit/WebView2 都忽略它、只在 console 报

    # "Unrecognized"，已从 CSP 移除；真正生效的一直是 connect-src。）

    if ($currentCsp -match "connect-src\s+([^;]+)") {

        $connectSrcDirective = $matches[1]

        if ($connectSrcDirective -notlike "*http://ipc.localhost*") {

            $missingParts += "connect-src 缺少 http://ipc.localhost (Windows 必需)"

        }

    } else {

        $missingParts += "connect-src 指令"

    }



    if ($missingParts.Count -gt 0) {

        Write-Host "  错误: CSP 配置不符合 Windows 要求:" -ForegroundColor Red

        $missingParts | ForEach-Object { Write-Host "    - $_" -ForegroundColor Red }

        Write-Host ""

        Write-Host "  Windows Tauri IPC 需要 connect-src 包含 http://ipc.localhost" -ForegroundColor Yellow

        Write-Host "  请检查 tauri.conf.json 中的 CSP 配置" -ForegroundColor Yellow

        Write-Host ""

        throw "CSP 配置不完整，无法在 Windows 上正常运行"

    } else {

        Write-Host "  OK - CSP 配置完整 (包含 Windows IPC 支持)" -ForegroundColor Green

    }

    Write-Host ""



    # ========================================

    # 初始化 MSVC 编译环境 (link.exe / cl.exe)

    # ========================================

    if (-not (Get-Command link.exe -ErrorAction SilentlyContinue)) {

        Write-Host "[准备] 初始化 MSVC 编译环境..." -ForegroundColor Blue

        $vcFound = $false



        # Find vcvarsall.bat via vswhere

        $programFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")

        $vsWhere = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"

        if (Test-Path $vsWhere) {

            $vsPath = & $vsWhere -latest -products * -property installationPath 2>$null

            if ($vsPath) {

                $vcvarsall = Join-Path $vsPath "VC\Auxiliary\Build\vcvarsall.bat"

                if (Test-Path $vcvarsall) {

                    Write-Host "  找到: $vcvarsall" -ForegroundColor Cyan

                    # Import environment variables from vcvarsall into PowerShell

                    $tempFile = [System.IO.Path]::GetTempFileName()

                    cmd /c "`"$vcvarsall`" x64 > nul 2>&1 && set > `"$tempFile`""

                    Get-Content $tempFile | ForEach-Object {

                        if ($_ -match '^([^=]+)=(.*)$') {

                            [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')

                        }

                    }

                    Remove-Item $tempFile -ErrorAction SilentlyContinue

                    $vcFound = $true

                    Write-Host "  OK - MSVC x64 环境已加载" -ForegroundColor Green

                }

            }

        }



        if (-not $vcFound) {

            Write-Host "  未找到 vcvarsall.bat，Rust 编译可能失败" -ForegroundColor Yellow

            Write-Host "  建议从 Developer PowerShell for VS 运行此脚本" -ForegroundColor Yellow

        }

        Write-Host ""

    }



    # ========================================

    # 清理旧构建（包括缓存的 resources）

    # ========================================

    Write-Host "[准备] 清理旧构建..." -ForegroundColor Blue



    # 杀死残留进程（避免文件锁定）

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



    # 清理构建输出目录

    $dirsToClean = @(


        @{ Path = "src-tauri\target\x86_64-pc-windows-msvc\release\bundle"; Name = "打包输出" },

        @{ Path = "src-tauri\target\x86_64-pc-windows-msvc\release\resources"; Name = "resources 缓存 (CRITICAL)" },

        @{ Path = "src-tauri\target\x86_64-pc-windows-msvc\release\mino"; Name = "旧默认工作区模板缓存 (mino)" }

    )



    foreach ($dir in $dirsToClean) {

        if (Test-Path $dir.Path) {

            try {

                Remove-Item -Recurse -Force $dir.Path -ErrorAction Stop

                Write-Host "  已清理: $($dir.Name)" -ForegroundColor Gray

            } catch {

                Write-Host "  警告: 清理 $($dir.Name) 失败: $_" -ForegroundColor Yellow

                Write-Host "  路径: $($dir.Path)" -ForegroundColor Yellow

                # 不抛出异常，继续构建

            }

        }

    }



    Write-Host "  OK - 清理完成（含 resources 缓存）" -ForegroundColor Green

    Write-Host ""



    # ========================================

    # TypeScript 类型检查

    # ========================================

    if (-not $SkipTypeCheck) {

        Write-Host "[4/7] TypeScript 类型检查..." -ForegroundColor Blue

        & npm.cmd run typecheck

        if ($LASTEXITCODE -ne 0) {

            throw "TypeScript 检查失败，请修复后重试"

        }

        Write-Host "  OK - TypeScript 检查通过" -ForegroundColor Green

        Write-Host ""

    }

    else {

        Write-Host "[4/7] 跳过 TypeScript 类型检查" -ForegroundColor Yellow

        Write-Host ""

    }



    # ========================================

    # 构建前端和服务端

    # ========================================

    Write-Host "[5/7] 构建前端和服务端..." -ForegroundColor Blue



    # Sidecar / Bridge / CLI 三件套统一通过 npm scripts，由

    # `scripts/esbuild-bundle.mjs` 单一入口驱动。Driver 自带 post-build：

    #   - cli: 复制 zhishi.cmd 到 resources/cli/

    #   - server: 校验产物不含硬编码 __dirname 路径

    # 实际上 tauri:build 的 beforeBuildCommand (tauri.conf.json) 也会

    # 跑同一组 npm 脚本——这里显式提前一步是为了 build 阶段提早暴露

    # 错误（避免等到 cargo 链接成功才发现 server-dist.js 有问题）。

    Write-Host "  打包 Sidecar / CLI..." -ForegroundColor Cyan

    & npm.cmd run build:server

    if ($LASTEXITCODE -ne 0) { throw "服务端打包失败" }

    & npm.cmd run build:cli

    if ($LASTEXITCODE -ne 0) { throw "zhishi CLI 打包失败" }

    Write-Host "    OK - Sidecar / CLI 打包完成" -ForegroundColor Green



    # 填充 tsx-runtime（Plugin Bridge 走绝对路径 --import）—— Windows 当前

    # 仅 x64 构建；将来加 arm64 时把 --cpu 参数化。

    Write-Host "  填充 tsx-runtime (win32-x64)..." -ForegroundColor Cyan

    & npm.cmd run build:tsx-runtime -- win32 x64

    if ($LASTEXITCODE -ne 0) { throw "tsx-runtime 填充失败" }

    Write-Host "    OK - tsx-runtime 就绪" -ForegroundColor Green



    # M4c: Claude Agent SDK 已删除——不再分发 claude native binary(pi 引擎纯 JS,无原生依赖)。



    # NOTE: agent-browser CLI is no longer bundled. The skill at

    # bundled-skills/agent-browser/SKILL.md teaches AI to self-install via

    # `npm install -g agent-browser@<pinned>` (with `npx` fallback) on first

    # use. Removing the bundle saves ~84MB installer size + build time.



    # 预装 sharp 图像处理（替代 jimp，libvips 原生）

    Write-Host "  预装 sharp 图像处理（libvips 原生）..." -ForegroundColor Cyan

    $sharpDir = Join-Path $ProjectDir "src-tauri\resources\sharp-runtime"

    if (Test-Path $sharpDir) {

        Remove-Item -Recurse -Force $sharpDir

    }

    New-Item -ItemType Directory -Path $sharpDir -Force | Out-Null

    $sharpPkgJson = @"

{

  "name": "sharp-runtime",

  "private": true,

  "version": "1.0.0",

  "dependencies": { "sharp": "0.34.5" }

}

"@

    Set-Content -Path (Join-Path $sharpDir "package.json") -Value $sharpPkgJson -Encoding utf8

    Push-Location $sharpDir

    $ErrorActionPreference = "Continue"
    $null = & npm.cmd install --no-audit --no-fund --no-save --ignore-scripts 2>$null

    Pop-Location

    if ($LASTEXITCODE -ne 0) {

        throw "sharp 主包预装失败"

    }

    # Windows 只装 x64 变体（arm64 Windows 用户少且 sharp 0.34 也支持，可按需扩展）

    $sharpWinArch = if ($Target -match "aarch64") { "arm64" } else { "x64" }

    Push-Location $sharpDir

    $null = & npm.cmd install --no-save --force --no-audit --no-fund --ignore-scripts "@img/sharp-win32-$sharpWinArch@0.34.5" 2>$null
    $ErrorActionPreference = "Stop"

    Pop-Location

    if ($LASTEXITCODE -ne 0) {

        throw "sharp Windows 平台包安装失败"

    }

    $sharpNode = Join-Path $sharpDir "node_modules\@img\sharp-win32-$sharpWinArch\lib\sharp-win32-$sharpWinArch.node"

    if (-not (Test-Path $sharpNode)) {

        throw "sharp-win32-$sharpWinArch.node 缺失"

    }

    # 删除非 win32 变体（节省 NSIS 安装包大小）

    $imgDir = Join-Path $sharpDir "node_modules\@img"

    Get-ChildItem -Path $imgDir -Directory -ErrorAction SilentlyContinue |

        Where-Object { $_.Name -like "sharp-darwin*" -or $_.Name -like "sharp-linux*" -or $_.Name -like "sharp-libvips-darwin*" -or $_.Name -like "sharp-libvips-linux*" -or $_.Name -eq "sharp-wasm32" } |

        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

    Write-Host "    OK - sharp 预装完成 (win32-$sharpWinArch)" -ForegroundColor Green



    # 预装 better-sqlite3（记忆库 memory.db 引擎）

    # 原生 addon 必须匹配内置 Node 的 ABI（v24.x = ABI 137），而构建机的

    # 系统 Node 是 v22——所以分两步：先 --ignore-scripts 装纯 JS 部分，

    # 再用内置 Node 跑 prebuild-install 按目标版本拉预编译二进制。

    Write-Host "  预装 better-sqlite3（SQLite 记忆库）..." -ForegroundColor Cyan

    $sqliteDir = Join-Path $ProjectDir "src-tauri\resources\sqlite-runtime"

    if (Test-Path $sqliteDir) {

        Remove-Item -Recurse -Force $sqliteDir

    }

    New-Item -ItemType Directory -Path $sqliteDir -Force | Out-Null

    $sqlitePkgJson = @"

{

  "name": "sqlite-runtime",

  "private": true,

  "version": "1.0.0",

  "dependencies": { "better-sqlite3": "12.11.1" }

}

"@

    Set-Content -Path (Join-Path $sqliteDir "package.json") -Value $sqlitePkgJson -Encoding utf8

    Push-Location $sqliteDir

    $ErrorActionPreference = "Continue"

    $null = & npm.cmd install --no-audit --no-fund --no-save --ignore-scripts 2>$null

    Pop-Location

    if ($LASTEXITCODE -ne 0) {

        throw "better-sqlite3 主包预装失败"

    }

    $bundledNode = Join-Path $ProjectDir "src-tauri\resources\nodejs\node.exe"

    $bundledNodeVer = (& $bundledNode -v).TrimStart('v')

    # prebuild-install 读「最近一层 package.json」决定拉哪个包的预编译件——

    # 必须进入 better-sqlite3 模块目录里跑（在外层跑会去拉 sqlite-runtime 自己的，落空）。

    Push-Location (Join-Path $sqliteDir "node_modules\better-sqlite3")

    $null = & $bundledNode ..\prebuild-install\bin.js --runtime node --target $bundledNodeVer 2>$null

    Pop-Location

    $sqliteNative = Join-Path $sqliteDir "node_modules\better-sqlite3\build\Release\better_sqlite3.node"

    if (-not (Test-Path $sqliteNative)) {

        throw "better_sqlite3.node 缺失（prebuild 目标 node $bundledNodeVer）"

    }

    Write-Host "    OK - better-sqlite3 预装完成 (node $bundledNodeVer)" -ForegroundColor Green

    # 1.4.0：node-pty 交互终端运行时（attach 真终端的原生模块）。
    # @lydell/node-pty 是 N-API 预编译件（ABI 稳定，跨 Node 版本），不像
    # better-sqlite3（NAN）需要按内置 Node 版本重编——普通 install 即拉
    # 平台 prebuild（win32-x64 包自动装进 node_modules/@lydell/node-pty*）。
    # 回落路径对齐 term-pty.ts::loadNodePty 的 `<scriptDir>/pty-runtime/
    # node_modules/@lydell/node-pty`。
    Write-Host "  预装 @lydell/node-pty（attach 终端）..." -ForegroundColor Cyan

    $ptyDir = Join-Path $ProjectDir "src-tauri\resources\pty-runtime"
    if (Test-Path $ptyDir) {
        Remove-Item -Recurse -Force $ptyDir
    }
    New-Item -ItemType Directory -Path $ptyDir -Force | Out-Null

    $ptyPkgJson = @"
{
  "name": "pty-runtime",
  "private": true,
  "version": "1.0.0",
  "dependencies": { "@lydell/node-pty": "^1.2.0-beta.15" }
}
"@
    Set-Content -Path (Join-Path $ptyDir "package.json") -Value $ptyPkgJson -Encoding utf8

    Push-Location $ptyDir
    $ErrorActionPreference = "Continue"
    $null = & npm.cmd install --no-audit --no-fund --no-save 2>$null
    Pop-Location
    if ($LASTEXITCODE -ne 0) {
        throw "@lydell/node-pty 预装失败"
    }

    $ptyNative = Join-Path $ptyDir "node_modules\@lydell\node-pty-win32-x64"
    if (-not (Test-Path $ptyNative)) {
        throw "@lydell/node-pty-win32-x64 平台包缺失（prebuild 未拉取）"
    }
    Write-Host "    OK - @lydell/node-pty 预装完成" -ForegroundColor Green

    # 前端 GUI（React，frontendDist=src/gui/dist）与 server/cli bundle 由
    # tauri build 的 beforeBuildCommand 构建；本脚本只管原生运行时预装。

    Write-Host "  OK - 服务端构建完成" -ForegroundColor Green

    Write-Host ""



    # ========================================

    # 构建 Tauri 应用

    # ========================================

    # 1.2.3：zhishi-updater（externalBin）是本地 crate，随构建产出——缺这步
    # tauri_build 会因 binaries/zhishi-updater-<triple>.exe 缺失而失败。
    Write-Host "  构建 zhishi-updater (externalBin)..." -ForegroundColor Cyan
    & cargo build --release -p zhishi-updater --manifest-path "$ProjectDir\src-tauri\Cargo.toml"
    if ($LASTEXITCODE -ne 0) { throw "zhishi-updater 构建失败" }
    Copy-Item "$ProjectDir\src-tauri\target\release\zhishi-updater.exe" "$ProjectDir\src-tauri\binaries\zhishi-updater-x86_64-pc-windows-msvc.exe" -Force

    Write-Host "[6/7] 构建 Tauri 应用 (Release)..." -ForegroundColor Blue

    if ($SkipBundle) {
        Write-Host "  ⚠ 跳过 NSIS 打包 (--bundles none)" -ForegroundColor Yellow
    }
    Write-Host "  这可能需要几分钟，请耐心等待..." -ForegroundColor Yellow



    # Tauri v2 在 Windows 上对 gitignored/大体积资源的收集不稳定（nodejs、
    # server-dist.js 等关键文件会随机丢失）。我们通过自定义 NSIS 模板显式复制所有资源，
    # 生成的临时配置只负责注入 Windows NSIS hooks，不再通过 bundle.resources 让 Tauri 收集资源。

    $generatedConfPath = Join-Path $ProjectDir "src-tauri\tauri.windows.generated.conf.json"
    $winConf = [ordered]@{
        '$schema' = "../node_modules/@tauri-apps/cli/config.schema.json"
        bundle = [ordered]@{
            windows = [ordered]@{
                nsis = [ordered]@{
                    installerHooks = "nsis/hooks.nsh"
                }
            }
        }
    }

    if ($USBMode) {
        $winConf.bundle["createUpdaterArtifacts"] = "none"
        $winConf.bundle.windows.nsis.installerHooks = "nsis/hooks-usb.nsh"
        Write-Host "  USB 模式: 禁用自动更新，使用 hooks-usb.nsh" -ForegroundColor Magenta
    }

    $winConfJson = $winConf | ConvertTo-Json -Depth 10
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($generatedConfPath, $winConfJson, $utf8NoBom)

    # 备份并打补丁：在自定义 NSIS 模板中嵌入显式资源复制宏
    $nsiPath = Join-Path $ProjectDir "src-tauri\nsis\installer.nsi"
    $nsiBackup = "$nsiPath.bak"
    if (-not (Test-Path $nsiBackup)) {
        Copy-Item $nsiPath $nsiBackup -Force
    }
    $python = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $python) {
        $python = (Get-Command python3 -ErrorAction SilentlyContinue).Source
    }
    if (-not $python) {
        throw "需要 Python 来打补丁 NSIS 模板，但未找到 python/python3"
    }
    & $python (Join-Path $ProjectDir "scripts\build\patch_nsis.py") $ProjectDir
    if ($LASTEXITCODE -ne 0) {
        throw "NSIS 模板补丁失败"
    }

    $tauriBuildArgs = @("--target", "x86_64-pc-windows-msvc", "--config", "src-tauri/tauri.windows.generated.conf.json")
    if ($SkipBundle) { $tauriBuildArgs += "--bundles"; $tauriBuildArgs += "none" }



    $ErrorActionPreference = "Continue"
    & npm.cmd run tauri:build -- @tauriBuildArgs
    $ErrorActionPreference = "Stop"

    if ($LASTEXITCODE -ne 0) {
        # 检查 NSIS exe 是否已生成（可能只是签名步骤失败）
        $nsisDir = Join-Path $ProjectDir "src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis"
        $nsisExeExists = Test-Path (Join-Path $nsisDir "ZhiShi_${Version}_x64-setup.exe")
        if ($nsisExeExists) {
            Write-Host "  ⚠ Tauri 构建退出码非零，但 NSIS 安装包已生成" -ForegroundColor Yellow
            Write-Host "    原因: TAURI_SIGNING_PRIVATE_KEY 未设置，updater 签名跳过" -ForegroundColor Yellow
            Write-Host "    自动更新将不可用，其他功能正常" -ForegroundColor Yellow
        } else {
            throw "Tauri 构建失败"
        }
    }



    # 清理临时生成的 Windows 配置
    $generatedConfPath = Join-Path $ProjectDir "src-tauri\tauri.windows.generated.conf.json"
    if (Test-Path $generatedConfPath) {
        Remove-Item $generatedConfPath -ErrorAction SilentlyContinue
    }
    # 恢复被补丁修改的 NSIS 模板
    $nsiBackup = Join-Path $ProjectDir "src-tauri\nsis\installer.nsi.bak"
    $nsiPath = Join-Path $ProjectDir "src-tauri\nsis\installer.nsi"
    if (Test-Path $nsiBackup) {
        Move-Item $nsiBackup $nsiPath -Force
    }
    if ($USBMode -and (Test-Path (Join-Path $ProjectDir "src-tauri\tauri.windows.usb.conf.json"))) {
        Remove-Item (Join-Path $ProjectDir "src-tauri\tauri.windows.usb.conf.json") -ErrorAction SilentlyContinue
    }



    Write-Host "  OK - Tauri 构建完成" -ForegroundColor Green

    Write-Host ""



    # ========================================

    # 创建便携版 ZIP

    # ========================================

    if (-not $SkipPortable -and -not $SkipBundle) {

        Write-Host "[6.5/7] 创建便携版 ZIP..." -ForegroundColor Blue



        $targetDir = "src-tauri\target\x86_64-pc-windows-msvc\release"

        $nsisDir = "$targetDir\bundle\nsis"

        # Cargo package name is `zhishi` (lowercase), so Tauri's main binary is

        # zhishi.exe — NOT ZhiShi.exe (that's only the productName / shortcut).

        # The old ZhiShi.exe path worked by luck on case-insensitive NTFS; use the

        # real name so this stays correct on case-sensitive filesystems too.

        $exePath = "$targetDir\zhishi.exe"



        if (Test-Path $exePath) {

            $portableDir = Join-Path $targetDir "portable"

            $zipName = "ZhiShi_${Version}_x86_64-portable.zip"

            $zipPath = Join-Path $nsisDir $zipName



            if (Test-Path $portableDir) {

                Remove-Item -Recurse -Force $portableDir

            }

            New-Item -ItemType Directory -Path $portableDir -Force | Out-Null



            Copy-Item $exePath $portableDir -Force



            # Copy VC++ Runtime DLLs for portable version (app-local deployment)

            foreach ($dll in @("vcruntime140.dll", "vcruntime140_1.dll")) {

                $dllSrc = Join-Path "src-tauri\resources" $dll

                if (Test-Path $dllSrc) {

                    Copy-Item $dllSrc $portableDir -Force

                }

            }



            # 1.2.3: portable ZIP now mirrors the NSIS macro resource list
            # (patch_nsis.py) + tauri.conf bundle.resources. The old logic copied
            # target/release/resources which Tauri never produces, so the zip
            # shipped exe+DLLs only and died at runtime.
            $resourceItems = @(
                @{ Src = "src-tauri\resources\server-dist.js"; Dst = "server-dist.js"; Dir = $false },
                @{ Src = "src-tauri\resources\sharp-runtime"; Dst = "sharp-runtime"; Dir = $true },
                @{ Src = "src-tauri\resources\sqlite-runtime"; Dst = "sqlite-runtime"; Dir = $true },
                @{ Src = "src-tauri\resources\tsx-runtime"; Dst = "tsx-runtime"; Dir = $true },
                @{ Src = "src-tauri\resources\nodejs"; Dst = "nodejs"; Dir = $true },
                @{ Src = "src\shared"; Dst = "shared"; Dir = $true },
                @{ Src = "bundled-skills"; Dst = "bundled-skills"; Dir = $true },
                @{ Src = "bundled-environments"; Dst = "bundled-environments"; Dir = $true },
                @{ Src = "bundled-agents"; Dst = "bundled-agents"; Dir = $true },
                @{ Src = "src-tauri\resources\cli"; Dst = "cli"; Dir = $true },
                @{ Src = "src-tauri\infoplist\en.lproj"; Dst = "en.lproj"; Dir = $true },
                @{ Src = "src-tauri\infoplist\zh-Hans.lproj"; Dst = "zh-Hans.lproj"; Dir = $true }
            )
            foreach ($item in $resourceItems) {
                if (Test-Path $item.Src) {
                    if ($item.Dir) { Copy-Item $item.Src (Join-Path $portableDir $item.Dst) -Recurse -Force }
                    else { Copy-Item $item.Src (Join-Path $portableDir $item.Dst) -Force }
                } else {
                    Write-Host "  WARN: portable resource missing $($item.Src)" -ForegroundColor Yellow
                }
            }

            if (Test-Path $zipPath) {

                Remove-Item -Force $zipPath

            }

            Compress-Archive -Path "$portableDir\*" -DestinationPath $zipPath -Force



            Remove-Item -Recurse -Force $portableDir



            Write-Host "  OK - 便携版 ZIP: $zipName" -ForegroundColor Green

        }

        else {

            Write-Host "  警告: 未找到 zhishi.exe，跳过便携版创建" -ForegroundColor Yellow

        }

        Write-Host ""

    }



    # ========================================

    # 恢复配置

    # ========================================

    Write-Host "[7/7] 恢复开发配置..." -ForegroundColor Blue



    if (Test-Path "$TauriConfPath.bak") {

        Move-Item "$TauriConfPath.bak" $TauriConfPath -Force

        Write-Host "  OK - 配置已恢复" -ForegroundColor Green

    }

    Write-Host ""



    # ========================================

    # 显示构建产物

    # ========================================

    $bundleDir = "src-tauri\target\x86_64-pc-windows-msvc\release\bundle"

    $nsisDir = Join-Path $bundleDir "nsis"



    Write-Host "=========================================" -ForegroundColor Green

    Write-Host "  构建成功!" -ForegroundColor Green

    Write-Host "=========================================" -ForegroundColor Green

    Write-Host ""

    Write-Host "  版本: $Version" -ForegroundColor Cyan

    Write-Host ""

    Write-Host "  构建产物:" -ForegroundColor Blue



    if ($SkipBundle) {
        $exe = Join-Path $ProjectDir "src-tauri\target\x86_64-pc-windows-msvc\release\zhishi.exe"
        if (Test-Path $exe) {
            $size = "{0:N2} MB" -f ((Get-Item $exe).Length / 1MB)
            Write-Host "    EXE:  zhishi.exe ($size)" -ForegroundColor Cyan
            Write-Host "    路径: $exe" -ForegroundColor Cyan
            Write-Host ""
            Write-Host "  ⚠ 已跳过 NSIS 打包，无安装程序" -ForegroundColor Yellow
            Write-Host "    网络恢复后不加 -SkipBundle 重新构建以生成安装包" -ForegroundColor Yellow
        }
    } else {

    $nsisFiles = Get-ChildItem -Path $nsisDir -Filter "*.exe" -ErrorAction SilentlyContinue

    foreach ($file in $nsisFiles) {

        $size = "{0:N2} MB" -f ($file.Length / 1MB)

        Write-Host "    NSIS: $($file.Name) ($size)" -ForegroundColor Cyan

    }



    $zipFiles = Get-ChildItem -Path $nsisDir -Filter "*portable*.zip" -ErrorAction SilentlyContinue

    foreach ($file in $zipFiles) {

        $size = "{0:N2} MB" -f ($file.Length / 1MB)

        Write-Host "    ZIP:  $($file.Name) ($size)" -ForegroundColor Cyan

    }



    $tarFiles = Get-ChildItem -Path $nsisDir -Filter "*.nsis.zip" -ErrorAction SilentlyContinue

    foreach ($file in $tarFiles) {

        $size = "{0:N2} MB" -f ($file.Length / 1MB)

        Write-Host "    更新包: $($file.Name) ($size)" -ForegroundColor Cyan

    }



    Write-Host ""

    Write-Host "  输出目录:" -ForegroundColor Blue

    Write-Host "    $nsisDir" -ForegroundColor Cyan

    Write-Host ""



    $sigFiles = Get-ChildItem -Path $nsisDir -Filter "*.sig" -ErrorAction SilentlyContinue

    if ($sigFiles) {

        Write-Host "  OK - 自动更新签名已生成" -ForegroundColor Green

    }

    else {

        Write-Host "  警告: 未生成自动更新签名 (TAURI_SIGNING_PRIVATE_KEY 未设置)" -ForegroundColor Yellow

    }

    } # end of SkipBundle else block



    Write-Host ""

    Write-Host "后续步骤:" -ForegroundColor Blue

    Write-Host "  1. 测试安装包" -ForegroundColor White

    Write-Host "  2. 运行 .\scripts\release\publish_windows.ps1 发布到 R2" -ForegroundColor White

    Write-Host ""



    $BuildSuccess = $true



} catch {

    Write-Host ""

    Write-Host "=========================================" -ForegroundColor Red

    Write-Host "  构建失败!" -ForegroundColor Red

    Write-Host "=========================================" -ForegroundColor Red

    Write-Host ""

    Write-Host "错误: $_" -ForegroundColor Red

    Write-Host ""

    if ($_.InvocationInfo.PositionMessage) {

        Write-Host "位置: $($_.InvocationInfo.PositionMessage)" -ForegroundColor Yellow

    }

    Write-Host ""



    # 尝试恢复配置

    $TauriConfPath = Join-Path $ProjectDir "src-tauri\tauri.conf.json"

    if (Test-Path "$TauriConfPath.bak") {

        Move-Item "$TauriConfPath.bak" $TauriConfPath -Force

        Write-Host "已恢复 tauri.conf.json" -ForegroundColor Yellow

    }

    $generatedConfPath = Join-Path $ProjectDir "src-tauri\tauri.windows.generated.conf.json"
    if (Test-Path $generatedConfPath) {
        Remove-Item $generatedConfPath -ErrorAction SilentlyContinue
    }
    $nsiBackup = Join-Path $ProjectDir "src-tauri\nsis\installer.nsi.bak"
    $nsiPath = Join-Path $ProjectDir "src-tauri\nsis\installer.nsi"
    if (Test-Path $nsiBackup) {
        Move-Item $nsiBackup $nsiPath -Force
    }

}



Write-Host ""

if ($BuildSuccess) {

    Write-Host "构建成功" -ForegroundColor Green

} else {

    Write-Host "构建失败" -ForegroundColor Red

}



