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
foreach ($sub in @('', 'corpus', 'crashes', 'targets', 'bin')) {
  $p = if ($sub) { Join-Path $workDir $sub } else { $workDir }
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p | Out-Null }
}
try {
  Add-MpPreference -ExclusionPath $workDir
  Write-Step "Defender 排除项已加：$workDir"
} catch {
  Write-Host "[pwn-win] WARN: Defender 排除项未加上（$($_.Exception.Message)）——fuzz 性能可能受损"
}

# stack-hash.ps1 落 bin 并进用户 PATH（崩溃指纹工具，crash-triager 验证门用；
# 内嵌同文本写出——provision/adopt 只上传 setup.ps1 本体，examples/ 不会随行进
# guest，同 fuzz-vm setup.sh 的单文件惯例）。
$stackHashDst = 'C:\zhishi-work\bin\stack-hash.ps1'
@'
# stack-hash.ps1 — Windows 版批量栈指纹（1.6.4 M3）
# 与 fuzz 配方 examples/stack-hash.sh 同语义同输出协议，供 crash-triager
# 深挖模式的验证门使用（新崩溃类 = 崩溃 且 指纹 ≠ 基准指纹）。
#
# 用法:
#   powershell -File stack-hash.ps1 -TargetExe <exe> -Samples <file...>
#       样本作 argv[1]（目标从文件读的典型形态）
#   ... -TargetExe <exe> -TargetArgs 'arg1 @@ arg3' -Samples <file...>
#       参数模板，@@ 替换为样本路径
#
# 输出（与 .sh 版同一协议）: 每行 <sample>\t<指纹hash>\t<指纹描述>
# 指纹优先取 ASan（SUMMARY 类型 + 首个目标帧——clang-cl /fsanitize=address
# 的输出格式与 Linux 一致），其次 cdb 通道（.lastevent 异常码 + kb 顶 5 帧，
# 地址归一化——ASLR 下同一站点指纹稳定）。
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TargetExe,
  [string]$TargetArgs = '',
  [Parameter(Mandatory = $true)][string[]]$Samples
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue' # 单样本失败不拖垮整批（坏样本 → no-crash 行）

# 指纹文本 → 8 位 hash（SHA1 前缀；cksum 的 Windows 等价，只要求稳定）。
function Get-FpHash([string]$text) {
  $sha = [System.Security.Cryptography.SHA1]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-', '').Substring(0, 8).ToLower()
  } finally {
    $sha.Dispose()
  }
}

# ASan 输出解析（两平台同格式）：SUMMARY 类型 + 首个源码帧（去地址）。
function Get-AsanFingerprint([string]$out) {
  if ($out -notmatch 'SUMMARY: AddressSanitizer') { return $null }
  $sum = ([regex]::Match($out, 'SUMMARY: AddressSanitizer: [^\r\n]+')).Value -replace '^SUMMARY: AddressSanitizer: ', ''
  $frame = ([regex]::Match($out, '(?m)#[0-9]+ \S+ in [^\r\n]+')).Value -replace '0x[0-9a-fA-F]+', ''
  return "asan:$($sum.Split(' ')[0])|$frame"
}

# cdb 通道：异常码 + kb 顶 5 帧（地址归一化，取 module!func 站点）。
function Get-CdbFingerprint([string[]]$targetArgv) {
  $cdbOut = & cdb -g -G -c '.lastevent; kb 5; q' @targetArgv 2>&1 | Out-String
  $code = ''
  $m = [regex]::Match($cdbOut, '(?i)code ([0-9a-f]{8})')
  if ($m.Success) { $code = $m.Groups[1].Value }
  $frames = @()
  foreach ($line in ($cdbOut -split "`n")) {
    # kb 帧行：地址列 + module!func+0xoff
    $fm = [regex]::Match($line.Trim(), '([A-Za-z0-9_.]+![A-Za-z0-9_.<>?@]+)(\+0x[0-9a-f]+)?')
    if ($fm.Success -and $fm.Groups[1].Value -notmatch '^(ntdll|KERNEL32|KERNELBASE|ucrtbase)!') {
      $frames += $fm.Groups[1].Value
    }
    if ($frames.Count -ge 5) { break }
  }
  if ($frames.Count -eq 0 -and -not $code) { return $null }
  return "cdb:$code|$($frames -join '|')"
}

foreach ($s in $Samples) {
  $argv = @()
  if ($TargetArgs -match '@@') {
    $argv = ($TargetArgs -split ' ') | ForEach-Object { $_ -replace '@@', $s }
  } elseif ($TargetArgs) {
    $argv = ($TargetArgs -split ' ') + $s
  } else {
    $argv = @($s)
  }
  $fp = $null
  # 直跑一遍取 ASan 输出（进程自己打印）；非 ASan 构建直崩也进 cdb 通道
  $direct = & $TargetExe @argv 2>&1 | Out-String
  $fp = Get-AsanFingerprint $direct
  if (-not $fp) {
    $fp = Get-CdbFingerprint (@($TargetExe) + $argv)
  }
  if ($fp) {
    $h = Get-FpHash $fp
    $desc = $fp
    if ($desc.Length -gt 160) { $desc = $desc.Substring(0, 160) }
    Write-Output "$s`t$h`t$desc"
  } else {
    Write-Output "$s`tno-crash`t-"
  }
}
'@ | Out-File -FilePath $stackHashDst -Encoding utf8 # utf8 带 BOM（PS 5.1 无 BOM 按 ANSI 读）
Write-Step "stack-hash.ps1 → $stackHashDst"
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike '*zhishi-work\bin*') {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;C:\zhishi-work\bin", 'User')
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
