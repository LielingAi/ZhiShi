#!/usr/bin/env pwsh
<#
.SYNOPSIS
    一条命令验证 npm 发行形态（M3）：装到临时前缀 → 隔离数据目录 → 跑 TUI 自检 → 清理。

.DESCRIPTION
    只碰两个临时目录，不动你的 ~/.zhishi 和全局 npm：
      <TEMP>\zhishi-npm-test\        npm 全局前缀（zhishi.cmd 在这里）
      <TEMP>\zhishi-tui-test-data\   隔离的数据目录（从 ~/.zhishi 拷 config.json，
                                     所以模型/key 是你自己的，但 sidecar 是新的）

    为什么必须隔离数据目录：~/.zhishi\sidecar.port 可能指向桌面版留下的旧
    sidecar（同为 2.0.8 时版本检查不会报错，但那是个旧 bundle）。隔离后就是
    这个包自己拉起的 sidecar。

.PARAMETER NoBuild
    跳过 node scripts/build/npm-package.mjs，直接复用 dist\npm（快速重跑）。

.PARAMETER Launch
    自检通过后直接进真 TUI（需要当前终端是 TTY）。退出 TUI 后脚本继续清理。

.PARAMETER KeepRunning
    结束后保留临时目录与 sidecar（方便手工翻日志 / 再进一次界面）。

.PARAMETER DataDir
    自定义数据目录（默认 <TEMP>\zhishi-tui-test-data）。

.PARAMETER Prefix
    自定义 npm 前缀（默认 <TEMP>\zhishi-npm-test）。

.NOTES
    兼容 Windows PowerShell 5.1 与 PowerShell 7。本机只有 5.1（没有 pwsh）
    时用下面的 powershell -File 形式；-ExecutionPolicy Bypass 是为了绕开
    「禁止运行本地脚本」的默认策略。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\test-npm-package.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\test-npm-package.ps1 -NoBuild -Launch
#>
param(
    [switch]$NoBuild,
    [switch]$Launch,
    [switch]$KeepRunning,
    [string]$DataDir,
    [string]$Prefix
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $RepoRoot 'package.json'))) {
    throw "找不到仓库根目录（从 $PSScriptRoot 推出来的是 $RepoRoot）"
}

if (-not $Prefix)  { $Prefix  = Join-Path $env:TEMP 'zhishi-npm-test' }
if (-not $DataDir) { $DataDir = Join-Path $env:TEMP 'zhishi-tui-test-data' }

# 注意：PowerShell 5.1 的 Get-Content 默认按 ANSI 读，UTF-8 里的中文会把 JSON 读坏；
# 显式指定 UTF8 才稳（WREN 之前 ConvertFrom-Json 报错就是这个问题，不是文件坏了）。
$PkgRaw  = [System.IO.File]::ReadAllText((Join-Path $RepoRoot 'package.json'), [System.Text.Encoding]::UTF8)
$Version = ($PkgRaw | ConvertFrom-Json).version
$OutDir  = Join-Path $RepoRoot 'dist\npm'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "✘ $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 1. 构建产物
Step "1/5 构建 npm 包（版本 $Version）"
if ($NoBuild) {
    Write-Host "    跳过构建（-NoBuild），复用 $OutDir"
} else {
    Push-Location $RepoRoot
    try {
        node scripts/build/npm-package.mjs --pack
        if ($LASTEXITCODE -ne 0) { Fail "构建失败（exit $LASTEXITCODE）" }
    } finally { Pop-Location }
}

$MainTgz = @(Get-ChildItem (Join-Path $OutDir 'zhishi\*.tgz') -ErrorAction SilentlyContinue)
$TuiTgz  = @(Get-ChildItem (Join-Path $OutDir 'zhishi-tui-win32-x64\*.tgz') -ErrorAction SilentlyContinue)
if ($MainTgz.Count -eq 0 -or $TuiTgz.Count -eq 0) {
    Fail "缺少 tgz（$OutDir）。先跑 node scripts/build/npm-package.mjs --pack，或去掉 -NoBuild。"
}

# ---------------------------------------------------------------- 2. 临时前缀
Step "2/5 安装到临时前缀：$Prefix"
Remove-Item -Recurse -Force $Prefix -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $Prefix | Out-Null

# --omit=optional：平台包还没发布，靠下面显式装 tarball 顶上
# 必须用 npm.cmd：npm.ps1 靠 MyInvocation.Statement 截参数，经 & 调用时会把
# "& npm" 截成 "pm"（Unknown command: pm）。cmd 垫片没这个问题。
$NpmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $NpmCmd) { $NpmCmd = (Get-Command npm -ErrorAction Stop).Source }
& $NpmCmd i -g --prefix $Prefix $TuiTgz.FullName $MainTgz.FullName --omit=optional --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Fail "npm i -g 失败（exit $LASTEXITCODE）" }

$Cli = Join-Path $Prefix 'zhishi.cmd'
if (-not (Test-Path $Cli)) { Fail "没有生成 $Cli" }

# ---------------------------------------------------------------- 3. 隔离数据
Step "3/5 准备隔离数据目录：$DataDir"
Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $DataDir | Out-Null

$UserConfig = Join-Path $env:USERPROFILE '.zhishi\config.json'
if (Test-Path $UserConfig) {
    Copy-Item $UserConfig (Join-Path $DataDir 'config.json')
    Write-Host "    已拷入 config.json（模型/key 用你自己的）"
} else {
    Write-Host "    没有 ~/.zhishi/config.json——TUI 能进，但聊天会提示缺 provider（先 zhishi model 配一个）" -ForegroundColor Yellow
}
$env:ZHISHI_DATA_DIR = $DataDir

# ---------------------------------------------------------------- 4. 自检
Step "4/5 TUI 自检（--probe）"
& $Cli tui --probe
$ProbeExit = $LASTEXITCODE
if ($ProbeExit -ne 0) {
    Write-Host "`n--- sidecar 日志（最后 50 行）---" -ForegroundColor Yellow
    Get-ChildItem (Join-Path $DataDir 'logs') -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1 |
        ForEach-Object { Get-Content $_.FullName -Tail 50 }
    if (-not $KeepRunning) {
        # 失败也清理，避免下次被旧 sidecar 干扰
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like "*$DataDir*" } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    Fail "TUI 自检失败（exit $ProbeExit）"
}

# ---------------------------------------------------------------- 5. 交互 / 清理
if ($Launch) {
    Step "5/5 进入 TUI（Ctrl-C 或按界面提示退出）"
    & $Cli
    Write-Host "`nTUI 退出码：$LASTEXITCODE"
} else {
    Step "5/5 跳过交互（加 -Launch 才进 TUI）"
    Write-Host "    手工进界面： `$env:ZHISHI_DATA_DIR='$DataDir'; & '$Cli'"
}

# 收尾：默认连 sidecar 一起停（它是 detached 的，不清理会一直挂着）
if (-not $KeepRunning) {
    $stopped = 0
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$DataDir*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $script:stopped++ }
    Write-Host "    已停止 $stopped 个临时 sidecar 进程"
    Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue
    Write-Host "    已清理 $DataDir"
    Write-Host "    保留 $Prefix（zhishi.cmd 还在），要删：Remove-Item -Recurse -Force '$Prefix'"
} else {
    Write-Host "`n-KeepRunning：保留 $DataDir 与 sidecar" -ForegroundColor Yellow
    Write-Host "  数据目录：$DataDir"
    Write-Host "  日志：    $(Join-Path $DataDir 'logs')"
    Write-Host "  再进界面：`$env:ZHISHI_DATA_DIR='$DataDir'; & '$Cli'"
}

Write-Host "`n✓ 通过" -ForegroundColor Green
