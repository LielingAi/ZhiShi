<#

.SYNOPSIS

    ZhiShi Windows 开发环境初始化脚本

.DESCRIPTION

    首次 clone 仓库后运行此脚本

#>



$ErrorActionPreference = "Stop"



try {

    $ProjectDir = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))

    Set-Location $ProjectDir



    Write-Host "`n=========================================" -ForegroundColor Blue

    Write-Host "  ZhiShi Windows 开发环境初始化" -ForegroundColor Green

    Write-Host "=========================================`n" -ForegroundColor Blue



    function Test-Dependency {

        param($Name, $Command, $InstallHint)

        Write-Host "  检查 $Name... " -NoNewline

        try {

            Invoke-Expression $Command 2>&1 | Out-Null

            if ($LASTEXITCODE -eq 0 -or $?) {

                Write-Host "OK" -ForegroundColor Green

                return $true

            }

        } catch { }

        Write-Host "MISSING" -ForegroundColor Red

        return $false

    }



    function Install-WithWinget {

        param($Name, $WingetId, $ExtraArgs)

        Write-Host "  自动安装 $Name..." -ForegroundColor Cyan

        $cmd = "winget install --id $WingetId -e --accept-source-agreements --accept-package-agreements"

        if ($ExtraArgs) { $cmd += " $ExtraArgs" }

        Invoke-Expression $cmd

        # winget exit codes: 0=success, -1978335189=already installed/no upgrade

        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {

            Write-Host "  $Name 安装失败，请手动安装: winget install $WingetId" -ForegroundColor Red

            return $false

        }

        Write-Host "  $Name 安装完成" -ForegroundColor Green

        return $true

    }



    function Get-GitInstaller {

        # Git for Windows version - update this when upgrading

        # Also update version comment in: src-tauri/nsis/installer.nsi (search "Current version: Git for Windows")

        # Download page: https://git-scm.com/downloads/win

        $GitVersion = "2.52.0"

        $GitUrl = "https://github.com/git-for-windows/git/releases/download/v$GitVersion.windows.1/Git-$GitVersion-64-bit.exe"



        $NsisDir = Join-Path $ProjectDir "src-tauri\nsis"

        if (-not (Test-Path $NsisDir)) {

            New-Item -ItemType Directory -Path $NsisDir -Force | Out-Null

        }



        $GitFile = Join-Path $NsisDir "Git-Installer.exe"



        Write-Host "下载 Git for Windows (v$GitVersion)..." -ForegroundColor Blue



        if (-not (Test-Path $GitFile)) {

            Write-Host "  下载 Git 安装包..." -ForegroundColor Cyan

            try {

                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

                Invoke-WebRequest -Uri $GitUrl -OutFile $GitFile -UseBasicParsing -TimeoutSec 300

                Write-Host "  OK - Git installer downloaded" -ForegroundColor Green

            } catch {

                Write-Host "  下载失败: $_" -ForegroundColor Red

                Write-Host "  请手动下载: $GitUrl" -ForegroundColor Yellow

                Write-Host "  并保存到: $GitFile" -ForegroundColor Yellow

                throw "Git installer download failed"

            }

        } else {

            Write-Host "  OK - Git installer (already exists)" -ForegroundColor Green

        }

        Write-Host "OK - Git installer ready" -ForegroundColor Green

    }



    function Get-NodeJSBinary {

        $NodeVersion = "24.14.0"

        $NodeDir = Join-Path $ProjectDir "src-tauri\resources\nodejs"

        if (-not (Test-Path $NodeDir)) {

            New-Item -ItemType Directory -Path $NodeDir -Force | Out-Null

        }



        Write-Host "下载 Node.js 运行时 (v$NodeVersion)..." -ForegroundColor Blue



        $NodeExe = Join-Path $NodeDir "node.exe"

        if (Test-Path $NodeExe) {

            # Check version

            $existingVer = & $NodeExe --version 2>$null

            if ($existingVer -eq "v$NodeVersion") {

                Write-Host "  OK - Node.js v$NodeVersion (already exists)" -ForegroundColor Green

                # Node.js 已存在，但仍需确保 npm 已升级

                $npmDir = Join-Path $NodeDir "node_modules\npm"

                if (Test-Path $npmDir) {

                    $npmCli = Join-Path $npmDir "bin\npm-cli.js"

                    $curVer = & $NodeExe $npmCli --version 2>&1

                    if ("$curVer" -match "^11\.[0-9]\.") {

                        Write-Host "  npm v$curVer 需要升级..." -ForegroundColor Yellow

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

                                $newVer = & $NodeExe (Join-Path $npmDir "bin\npm-cli.js") --version 2>&1

                                Write-Host "  npm 升级: v$curVer → v$newVer ✓" -ForegroundColor Green

                            }

                            Remove-Item -Recurse -Force $npmTmpDir -ErrorAction SilentlyContinue

                        } catch {

                            Write-Host "  npm 升级失败: $_" -ForegroundColor Red

                        }

                    } else {

                        Write-Host "  npm v$curVer ✓" -ForegroundColor Green

                    }

                }

                Write-Host "OK - Node.js runtime ready" -ForegroundColor Green

                return

            }

            Write-Host "  版本不匹配 ($existingVer), 重新下载..." -ForegroundColor Yellow

        }



        Write-Host "  下载 Windows x64 版本..." -ForegroundColor Cyan

        $ZipName = "node-v$NodeVersion-win-x64.zip"

        $DownloadUrl = "https://nodejs.org/dist/v$NodeVersion/$ZipName"

        $TempZip = Join-Path $env:TEMP "node-windows.zip"

        $TempDir = Join-Path $env:TEMP "node-windows-extract"



        try {

            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

            Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempZip -UseBasicParsing -TimeoutSec 300



            if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }

            Expand-Archive -Path $TempZip -DestinationPath $TempDir -Force



            $ExtractedDir = Join-Path $TempDir "node-v$NodeVersion-win-x64"



            # Clean and copy full distribution (node.exe + npm + npx)

            if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }

            New-Item -ItemType Directory -Path $NodeDir -Force | Out-Null



            # Copy top-level files

            Copy-Item -Path (Join-Path $ExtractedDir "node.exe") -Destination $NodeDir -Force

            Copy-Item -Path (Join-Path $ExtractedDir "npm.cmd") -Destination $NodeDir -Force

            Copy-Item -Path (Join-Path $ExtractedDir "npx.cmd") -Destination $NodeDir -Force

            Copy-Item -Path (Join-Path $ExtractedDir "npm") -Destination $NodeDir -Force

            Copy-Item -Path (Join-Path $ExtractedDir "npx") -Destination $NodeDir -Force

            # Use robocopy for node_modules to handle deep paths beyond MAX_PATH (260 chars).

            # PowerShell's Copy-Item -Recurse silently skips files with long paths, corrupting

            # npm's internal dependencies (minizlib/minipass → "Class extends undefined" error).

            $SrcModules = Join-Path $ExtractedDir "node_modules"

            $DstModules = Join-Path $NodeDir "node_modules"

            if (Test-Path $SrcModules) {

                & robocopy $SrcModules $DstModules /E /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null

                # robocopy returns 0-7 for success, 8+ for errors

                if ($LASTEXITCODE -ge 8) {

                    throw "robocopy failed with exit code $LASTEXITCODE"

                }

            }



            # Remove corepack (not needed)

            $corepackCmd = Join-Path $NodeDir "corepack.cmd"

            $corepackDir = Join-Path $NodeDir "node_modules\corepack"

            if (Test-Path $corepackCmd) { Remove-Item -Force $corepackCmd }

            if (Test-Path $corepackDir) { Remove-Item -Recurse -Force $corepackDir }



            # Upgrade npm — bundled npm 11.9.0 has minizlib CJS bug on Windows.

            # CANNOT use `npm install npm@latest` (catch-22: broken npm can't upgrade itself).

            Write-Host "  升级 npm (curl + tar)..." -ForegroundColor Cyan

            $npmDir = Join-Path $NodeDir "node_modules\npm"

            try {

                $nodeExe = Join-Path $NodeDir "node.exe"

                $oldNpmCli = Join-Path $npmDir "bin\npm-cli.js"

                $oldVer = if (Test-Path $oldNpmCli) { & $nodeExe $oldNpmCli --version 2>&1 } else { "unknown" }

                Write-Host "  当前: v$oldVer" -ForegroundColor Gray



                $npmTmpDir = Join-Path $env:TEMP "npm_upgrade_$(Get-Random)"

                New-Item -ItemType Directory -Path $npmTmpDir -Force | Out-Null

                $registryJson = Invoke-RestMethod -Uri "https://registry.npmjs.org/npm/latest" -TimeoutSec 30

                $tarballUrl = $registryJson.dist.tarball

                Write-Host "  下载: $($registryJson.version) ← $tarballUrl"

                $tgzPath = Join-Path $npmTmpDir "npm.tgz"

                Invoke-WebRequest -Uri $tarballUrl -OutFile $tgzPath -TimeoutSec 60

                tar -xzf $tgzPath -C $npmTmpDir 2>&1 | Out-Null

                $extractedPkg = Join-Path $npmTmpDir "package"

                if (Test-Path $extractedPkg) {

                    Remove-Item -Recurse -Force $npmDir

                    Move-Item -Path $extractedPkg -Destination $npmDir

                    $newNpmCli = Join-Path $npmDir "bin\npm-cli.js"

                    $newVer = & $nodeExe $newNpmCli --version 2>&1

                    Write-Host "  npm 已升级: v$oldVer → v$newVer" -ForegroundColor Green

                } else {

                    Write-Host "  npm 解压失败" -ForegroundColor Red

                }

                Remove-Item -Recurse -Force $npmTmpDir -ErrorAction SilentlyContinue

            } catch {

                Write-Host "  npm 升级失败: $_" -ForegroundColor Red

                Write-Host "  ⚠ 插件安装可能失败，请检查网络后重试" -ForegroundColor Yellow

                Remove-Item -Recurse -Force $npmTmpDir -ErrorAction SilentlyContinue

            }



            Write-Host "  OK - Windows x64" -ForegroundColor Green

        } catch {

            Write-Host "  下载失败: $_" -ForegroundColor Red

            Write-Host "  请手动下载: $DownloadUrl" -ForegroundColor Yellow

            throw "Node.js download failed"

        } finally {

            if (Test-Path $TempZip) { Remove-Item -Force $TempZip }

            if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }

        }



        Write-Host "OK - Node.js runtime ready" -ForegroundColor Green

    }



    function Get-VCRuntime {

        $ResourcesDir = Join-Path $ProjectDir "src-tauri\resources"

        if (-not (Test-Path $ResourcesDir)) {

            New-Item -ItemType Directory -Path $ResourcesDir -Force | Out-Null

        }



        Write-Host "提取 VC++ Runtime DLL (app-local deployment)..." -ForegroundColor Blue



        # Native binaries (SDK Claude etc.) on Windows may require VCRUNTIME140.dll.

        # App-local deployment: copy DLLs into resources/ so end users don't need to install

        # VC++ Redistributable separately.

        $dlls = @("vcruntime140.dll", "vcruntime140_1.dll")

        foreach ($dll in $dlls) {

            $destFile = Join-Path $ResourcesDir $dll

            $systemFile = Join-Path $env:SystemRoot "System32\$dll"



            if (-not (Test-Path $destFile)) {

                if (Test-Path $systemFile) {

                    Copy-Item -Path $systemFile -Destination $destFile -Force

                    Write-Host "  OK - $dll" -ForegroundColor Green

                } else {

                    # vcruntime140_1.dll may not exist on older MSVC versions, only warn

                    if ($dll -eq "vcruntime140.dll") {

                        throw "$dll not found in $env:SystemRoot\System32. Please install Visual C++ Build Tools."

                    } else {

                        Write-Host "  SKIP - $dll (not found, optional)" -ForegroundColor Yellow

                    }

                }

            } else {

                Write-Host "  OK - $dll (already exists)" -ForegroundColor Green

            }

        }

        Write-Host "OK - VC++ Runtime ready" -ForegroundColor Green

    }



    function Test-MSVC {

        Write-Host "  检查 MSVC Build Tools... " -NoNewline



        # Method 1: cl.exe in PATH (Developer Command Prompt)

        $cl = Get-Command cl.exe -ErrorAction SilentlyContinue

        if ($cl) {

            Write-Host "OK" -ForegroundColor Green

            return $true

        }



        # Method 2: vswhere (standard VS installer location)

        $programFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")

        $vsWhere = Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"

        if (Test-Path $vsWhere) {

            $vsPath = & $vsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null

            if ($vsPath) {

                Write-Host "OK" -ForegroundColor Green

                return $true

            }

            # Fallback: any VS/BuildTools installation

            $vsPath = & $vsWhere -latest -products * -property installationPath 2>$null

            if ($vsPath) {

                Write-Host "OK (found VS installation)" -ForegroundColor Green

                return $true

            }

        }



        # Method 3: check common BuildTools paths directly

        $btPaths = @(

            "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools",

            "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools",

            "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\Community",

            "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community"

        )

        foreach ($p in $btPaths) {

            if (Test-Path $p) {

                Write-Host "OK" -ForegroundColor Green

                return $true

            }

        }



        # Method 4: winget list check

        try {

            $wingetList = winget list --id Microsoft.VisualStudio.2022.BuildTools 2>$null

            if ($LASTEXITCODE -eq 0 -and $wingetList -match "BuildTools") {

                Write-Host "OK (winget)" -ForegroundColor Green

                return $true

            }

        } catch { }



        Write-Host "MISSING" -ForegroundColor Red

        return $false

    }



    # Main

    Write-Host "Step 1/8: 检查并安装依赖" -ForegroundColor Blue

    # NB: total step count = 8 (cuse/terminator fetch steps removed with AppCraft in 1.2.3).

    # Step 1 was already labelled 1/N from a previous mismatch — now correct.



    # Check winget availability for auto-install

    $HasWinget = $false

    try {

        winget --version 2>&1 | Out-Null

        if ($LASTEXITCODE -eq 0 -or $?) { $HasWinget = $true }

    } catch { }



    $NeedRestart = $false



    # Node.js (needed for typecheck/lint)

    if (-not (Test-Dependency "Node.js" "node --version" "")) {

        if ($HasWinget) {

            Install-WithWinget "Node.js LTS" "OpenJS.NodeJS.LTS"

            $NeedRestart = $true

        } else {

            Write-Host "    请安装: https://nodejs.org" -ForegroundColor Yellow

        }

    }



    # Rust + Cargo

    if (-not (Test-Dependency "Rust" "rustc --version" "")) {

        if ($HasWinget) {

            Install-WithWinget "Rust (rustup)" "Rustlang.Rustup"

            $NeedRestart = $true

        } else {

            Write-Host "    请安装: https://rustup.rs" -ForegroundColor Yellow

        }

    }



    # MSVC Build Tools (required by Rust on Windows)

    if (-not (Test-MSVC)) {

        if ($HasWinget) {

            Write-Host "  自动安装 Visual Studio Build Tools (C++ 工作负载)..." -ForegroundColor Cyan

            winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

            if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {

                Write-Host "  MSVC 安装失败，请手动安装 Visual Studio Build Tools" -ForegroundColor Red

            } else {

                Write-Host "  MSVC Build Tools 安装完成" -ForegroundColor Green

            }

            $NeedRestart = $true

        } else {

            Write-Host "    请安装 Visual Studio Build Tools: https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor Yellow

        }

    }



    if ($NeedRestart) {

        Write-Host "`n=========================================" -ForegroundColor Yellow

        Write-Host "  依赖已安装，请关闭此窗口，打开新的 PowerShell 重新运行本脚本" -ForegroundColor Yellow

        Write-Host "  (新安装的工具需要新终端才能生效)" -ForegroundColor Yellow

        Write-Host "=========================================`n" -ForegroundColor Yellow

        Write-Host "按回车键退出..." -ForegroundColor Cyan

        Read-Host

        exit 0

    }



    # Final check — all must be present now

    $Missing = $false

    if (-not (Test-Dependency "Node.js" "node --version" "")) { $Missing = $true }

    if (-not (Test-Dependency "Rust" "rustc --version" "")) { $Missing = $true }

    if (-not (Test-Dependency "Cargo" "cargo --version" "")) { $Missing = $true }

    if (-not (Test-MSVC)) { $Missing = $true }



    if ($Missing) {

        Write-Host "`n仍有缺失依赖，请手动安装后重新运行" -ForegroundColor Red

        Write-Host "按回车键退出..." -ForegroundColor Yellow

        Read-Host

        exit 1

    }



    Write-Host "`nStep 2/8: 下载 Node.js 运行时 (Sidecar + MCP Server + 社区工具统一 runtime)" -ForegroundColor Blue

    Get-NodeJSBinary



    Write-Host "`nStep 3/8: 下载 Git 安装包 (用于 NSIS 打包)" -ForegroundColor Blue

    Get-GitInstaller



    Write-Host "`nStep 4/8: 提取 VC++ Runtime DLL" -ForegroundColor Blue

    Get-VCRuntime



    Write-Host "`nStep 5/8: 安装前端/后端依赖" -ForegroundColor Blue

    # 使用 npm.cmd 避免系统上 npm.ps1 包装器的参数解析 bug
    $npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $npmCmd) { $npmCmd = "npm.cmd" }
    & $npmCmd install

    if ($LASTEXITCODE -ne 0) {

        Write-Host "依赖安装失败" -ForegroundColor Red

        Write-Host "`n按回车键退出..." -ForegroundColor Yellow

        Read-Host

        exit 1

    }

    Write-Host "OK - 依赖安装完成" -ForegroundColor Green



    Write-Host "`nStep 6/8: 下载 Rust 依赖" -ForegroundColor Blue

    Write-Host "  正在下载 Rust 依赖包，请稍候..." -ForegroundColor Cyan

    Push-Location (Join-Path $ProjectDir "src-tauri")

    & cargo fetch

    if ($LASTEXITCODE -ne 0) {

        Write-Host "  Rust 依赖下载失败" -ForegroundColor Red

        Pop-Location

        Write-Host "`n按回车键退出..." -ForegroundColor Yellow

        Read-Host

        exit 1

    }

    Pop-Location

    Write-Host "OK - Rust 依赖下载完成" -ForegroundColor Green



    # 准备默认工作区 (novo)

    # .git 不保留：避免 Tauri 资源打包权限问题 + rerun-if-changed 性能问题

    Write-Host "`nStep 7/8: 准备默认工作区 (novo)" -ForegroundColor Blue

    $NovoDir = Join-Path $ProjectDir "novo"

    if (-not (Test-Path $NovoDir) -or -not (Test-Path (Join-Path $NovoDir "CLAUDE.md"))) {

        Write-Host "错误: novo/ 目录不存在或不完整!" -ForegroundColor Red

        Write-Host "`n按回车键退出..." -ForegroundColor Yellow

        Read-Host

        exit 1

    }

    $NovoGit = Join-Path $NovoDir ".git"

    if (Test-Path $NovoGit) {

        Remove-Item -Recurse -Force $NovoGit

    }

    Write-Host "OK - novo 默认工作区已就绪" -ForegroundColor Green



    Write-Host "`nStep 8/8: 初始化完成!" -ForegroundColor Blue

    Write-Host "`n=========================================" -ForegroundColor Green

    Write-Host "  开发环境准备就绪!" -ForegroundColor Green

    Write-Host "=========================================`n" -ForegroundColor Green

    Write-Host "后续步骤:"

    Write-Host "  npm run tauri:dev      - 运行开发版"

    Write-Host "  .\scripts\build\build_windows.ps1    - 构建安装包`n"



} catch {

    Write-Host "`n=========================================" -ForegroundColor Red

    Write-Host "  发生错误!" -ForegroundColor Red

    Write-Host "=========================================`n" -ForegroundColor Red

    Write-Host "错误信息: $_" -ForegroundColor Red

    Write-Host "位置: $($_.InvocationInfo.PositionMessage)" -ForegroundColor Yellow

}



Write-Host "`n按回车键退出..." -ForegroundColor Cyan

Read-Host

