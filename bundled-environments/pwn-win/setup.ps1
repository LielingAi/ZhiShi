# pwn-win 环境初始化与自检 —— 在 Windows guest 内以提升会话运行
#
# 幂等（1.6.4 起配方纪律：可被「补齐环境」重放）：每个组件装前探测，
# 已装跳过不重装不升级。包管理器 choco 兜底（裸 VM 常缺 App Installer，
# winget 未必可用）；重型组件走 ZHISHI_PWN_WIN_HEAVY=1 可选段。
#
# 提升预检由 provision 链路负责（net session）；直接手跑也会被 #requires 拦下。
#requires -RunAsAdministrator
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) { Write-Host "[pwn-win] $msg" }

# choco 安装（官方安装脚本；ExecutionPolicy 只放当前进程作用域）。
function Ensure-Choco {
  if (Get-Command choco -ErrorAction SilentlyContinue) { return }
  Write-Step 'installing chocolatey...'
  Set-ExecutionPolicy Bypass -Scope Process -Force
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-Expression ((New-Object Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
  # 当前会话 PATH 即时生效（choco 装完只改机器级 PATH）
  $env:Path = "$env:ALLUSERSPROFILE\chocolatey\bin;$env:Path"
}

# 幂等安装：$command 探测命中则跳过；否则 choco install。
function Ensure-ChocoPackage([string]$command, [string]$package) {
  if (Get-Command $command -ErrorAction SilentlyContinue) {
    Write-Step "$package 已装（$command 在场），跳过"
    return
  }
  Write-Step "installing $package..."
  # --no-progress 压输出（provision 日志尾部只留 2000 字符）
  & choco install -y --no-progress $package
  if ($LASTEXITCODE -ne 0) { throw "choco install $package 失败（exit=$LASTEXITCODE）" }
}

Write-Step '== 包管理器 =='
Ensure-Choco

Write-Step '== 核心工具链 =='
Ensure-ChocoPackage git git
Ensure-ChocoPackage python python
# LLVM（clang-cl + libFuzzer/ASan 运行时）——源码可见 fuzz 的构建链
Ensure-ChocoPackage clang-cl llvm
# Sysinternals 套件（procdump 在内）
Ensure-ChocoPackage procdump sysinternals
# Ghidra headless（analyzeHeadless；choco 包自带 JRE 依赖）
if (Get-Command analyzeHeadless -ErrorAction SilentlyContinue) {
  Write-Step 'ghidra 已装（analyzeHeadless 在场），跳过'
} else {
  Write-Step 'installing ghidra...'
  & choco install -y --no-progress ghidra
  if ($LASTEXITCODE -ne 0) { Write-Host '[pwn-win] WARN: ghidra 安装失败（不影响核心链）——手动: choco install ghidra' }
}

# cdb（Windows SDK Debugging Tools）——choco 的 windbg 包名历史上漂移过，
# 失败不阻断：给手动指引（winget Microsoft.WinDbg / SDK 安装器勾选
# Debugging Tools for Windows）。
if (Get-Command cdb -ErrorAction SilentlyContinue) {
  Write-Step 'cdb 已在场，跳过'
} else {
  Write-Step 'installing Debugging Tools for Windows（cdb）...'
  & choco install -y --no-progress windows-sdk-10-version-2104-windbg
  if ($LASTEXITCODE -ne 0) {
    Write-Host '[pwn-win] WARN: cdb 自动安装失败——手动: winget install Microsoft.WinDbg，或 Windows SDK 安装器勾选 Debugging Tools for Windows'
  } else {
    # SDK 调试工具不进 PATH——补用户级 PATH（新会话生效）
    $dbgDir = "${env:ProgramFiles(x86)}\Windows Kits\10\Debuggers\x64"
    if (Test-Path $dbgDir) {
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      if ($userPath -notlike "*$dbgDir*") {
        [Environment]::SetEnvironmentVariable('Path', "$userPath;$dbgDir", 'User')
      }
      $env:Path = "$env:Path;$dbgDir"
    }
  }
}

Write-Step '== 环境配置 =='
# 工作目录约定 + Defender 排除（fuzz 语料不被实时扫描拖慢/误杀）
$workDir = 'C:\zhishi-work'
foreach ($sub in @('', 'corpus', 'crashes', 'targets')) {
  $p = if ($sub) { Join-Path $workDir $sub } else { $workDir }
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p | Out-Null }
}
try {
  Add-MpPreference -ExclusionPath $workDir
  Write-Step "Defender 排除项已加：$workDir"
} catch {
  Write-Host "[pwn-win] WARN: Defender 排除项未加上（$($_.Exception.Message)）——fuzz 性能可能受损"
}

# MS 公共符号服务器（用户级，不影响其他用户）
if ([Environment]::GetEnvironmentVariable('_NT_SYMBOL_PATH', 'User') -ne 'SRV*C:\symbols*https://msdl.microsoft.com/download/symbols') {
  [Environment]::SetEnvironmentVariable('_NT_SYMBOL_PATH', 'SRV*C:\symbols*https://msdl.microsoft.com/download/symbols', 'User')
}
# WER LocalDumps：崩溃自动落全 dump 到 %LOCALAPPDATA%\CrashDumps
$ld = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps'
if (-not (Test-Path $ld)) {
  New-Item -Path $ld -Force | Out-Null
  New-ItemProperty -Path $ld -Name DumpFolder -Value '%LOCALAPPDATA%\CrashDumps' -PropertyType ExpandString | Out-Null
  New-ItemProperty -Path $ld -Name DumpType -Value 2 -PropertyType DWord | Out-Null
}

# ── 可选重型段（ZHISHI_PWN_WIN_HEAVY=1 才进场）──────────────────────────
if ($env:ZHISHI_PWN_WIN_HEAVY -eq '1') {
  Write-Step '== 重型可选段（ZHISHI_PWN_WIN_HEAVY=1）=='
  # VS Build Tools（MSVC 编译链；多 GB 下载，偶发需重试）
  if (-not (Test-Path "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC")) {
    Write-Step 'installing VS Build Tools（VCTools 工作负载，多 GB——慢属正常）...'
    & choco install -y --no-progress visualstudio2022buildtools --package-parameters '--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive --norestart'
    if ($LASTEXITCODE -ne 0) { Write-Host '[pwn-win] WARN: VS Build Tools 安装失败——重放本脚本重试' }
  } else {
    Write-Step 'VS Build Tools 已装，跳过'
  }
  # 闭源 fuzz：DynamoRIO + WinAFL（官方 release zip 部署，不进 choco）
  $winaflDir = 'C:\tools\winafl'
  if (-not (Test-Path "$winaflDir\winafl.dll")) {
    Write-Step "WinAFL/DynamoRIO 未装——手动部署到 $winaflDir（release zip 解压；harness 选型与目标函数定位为 per-target 人工环节，见 SKILL.md）"
  }
  # x64dbg（脚本化 GUI 调试）
  Ensure-ChocoPackage x64dbg x64dbg.portable
} else {
  Write-Step '重型可选段跳过（设 ZHISHI_PWN_WIN_HEAVY=1 后重放本脚本进场：VS Build Tools / WinAFL+DynamoRIO / x64dbg）'
}

Write-Step '== 自检 =='
$missing = @()
foreach ($t in @('git', 'python', 'clang-cl', 'cdb', 'procdump')) {
  if (Get-Command $t -ErrorAction SilentlyContinue) {
    Write-Step "OK: $t"
  } else {
    Write-Host "[pwn-win] MISS: $t"
    $missing += $t
  }
}
if (Get-Command analyzeHeadless -ErrorAction SilentlyContinue) {
  Write-Step 'OK: analyzeHeadless (ghidra)'
} else {
  Write-Host '[pwn-win] MISS: analyzeHeadless (ghidra)——不阻断（choco shim 可能未进 PATH，手动定位 ghidra\support\analyzeHeadless.bat）'
}
if ($missing.Count -gt 0) { throw "自检未过，缺失工具：$($missing -join ', ')" }

Write-Step 'ready —— 现在做快照：vmrun -T ws snapshot <本VM.vmx> zhishi-clean'
