# win-kernel 环境初始化与自检 —— 在 Windows guest 内以提升会话运行
#
# 幂等（配方纪律）：每个组件装前探测，已装跳过不重装不升级，可被「补齐环境」
# 重放。界内全自动：bcdedit 调试串口 + testsigning、完整转储、符号配置都是
# guest 内持久变更（边界规则只管 env.kind==='local'，不触发宿主 system-config
# 边界）。供应链纪律（D-T2）：下载常量区 URL + sha256 钉死——TODO 占位时对应
# 安装块拒绝执行并打印获取指引，已填值下载后 Get-FileHash 校验，不符即删
# 报错。脚本不落任何凭据。
#
# 调试管道另一半在宿主侧：配方 debug 段（pipe: kd_win-kernel）由 env up
# 注入 vmx（guest = server，宿主 WinDbg = client）；本脚本负责把 guest 侧
# 调试串口开成 COM1 115200（vmware serial0 ↔ COM1 ↔ debugport:1）。
#
# 提升预检由 provision 链路负责（net session）；直接手跑也会被 #requires 拦下。
#requires -RunAsAdministrator
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) { Write-Host "[win-kernel] $msg" }

# ── 下载供应链常量（operator 维护区；TODO 占位 = 对应安装块拒绝执行）────────
$WDK_URL    = 'TODO: 填入 WDK 安装包 URL（获取指引见下）'
$WDK_SHA256 = 'TODO'
$WDK_GUIDANCE = @'
获取指引（wdk 回落下载块拒绝执行时原样打印）：
  首选：本脚本已先试 winget（Microsoft.WindowsWDK）——多数现场无需填本块。
  回落：Microsoft Learn「下载 Windows Driver Kit (WDK)」页面的官方安装包
  （learn.microsoft.com/windows-hardware/drivers/download-the-wdk），
  下载后在源机器上 Get-FileHash .\wdksetup.exe -Algorithm SHA256，
  把 URL 与哈希填进头部两个常量，重放本脚本。
  注意：WDK 版本要与 guest 的 Windows 版本配套（WDK/SDK 不跨大版本混装）。
'@
$OSRLOADER_URL    = 'TODO: 填入 OSR Loader v3 zip URL（获取指引见下）'
$OSRLOADER_SHA256 = 'TODO'
$OSRLOADER_GUIDANCE = @'
获取指引（osr-loader 安装块拒绝执行时原样打印）：
  OSR Loader 是 OSR Online 免费分发的驱动加载工具（osr.com →
  Articles → Downloads → OSRLOADER V3），下载 zip 后在源机器上
  Get-FileHash .\osrloaderv3.zip -Algorithm SHA256，把 URL 与哈希填进
  头部两个常量，重放本脚本。
  部署位约定：C:\tools\osr-loader\OSRLOADER.exe（探测词 osr-loader 同口径）。
'@

function Test-PlaceholderConstant([string]$value) {
  return [string]::IsNullOrWhiteSpace($value) -or $value.StartsWith('TODO')
}

# 下载 → Get-FileHash 校验 → 不符即删报错（D-T2）。占位 → $null（拒绝执行）。
function Invoke-PinnedDownload([string]$name, [string]$url, [string]$sha256, [string]$guidance) {
  if ((Test-PlaceholderConstant $url) -or (Test-PlaceholderConstant $sha256)) {
    Write-Host "[win-kernel] SKIP: $name 下载常量为 TODO 占位——拒绝裸装未知来源。"
    Write-Host $guidance
    return $null
  }
  $out = Join-Path $env:TEMP (($name -replace '[^\w.-]', '_') + '.pkg')
  Write-Step "downloading $name..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
  $actual = (Get-FileHash $out -Algorithm SHA256).Hash
  if ($actual -ne $sha256.ToUpperInvariant()) {
    Remove-Item $out -Force -ErrorAction SilentlyContinue
    throw "$name sha256 校验失败（期望 $($sha256.ToUpperInvariant())，实际 $actual）——下载件已删，拒绝安装"
  }
  Write-Step "$name sha256 校验通过"
  return $out
}

Write-Step '== 符号自动配置（第一事）=='
$symbolsDir = 'C:\Symbols'
if (-not (Test-Path $symbolsDir)) { New-Item -ItemType Directory -Path $symbolsDir | Out-Null }
$symPath = 'srv*C:\Symbols*https://msdl.microsoft.com/download/symbols'
if ([Environment]::GetEnvironmentVariable('_NT_SYMBOL_PATH', 'Machine') -ne $symPath) {
  [Environment]::SetEnvironmentVariable('_NT_SYMBOL_PATH', $symPath, 'Machine')
  Write-Step "_NT_SYMBOL_PATH（Machine）→ $symPath"
} else {
  Write-Step '_NT_SYMBOL_PATH（Machine）已配，跳过'
}
$env:_NT_SYMBOL_PATH = $symPath  # 本会话即时生效

Write-Step '== 内核调试三连（bcdedit，幂等）=='
# 探测现状，只对不齐的项下刀；bcdedit 变更立即生效于下次启动。
$enum = (& bcdedit /enum '{current}' 2>$null | Out-String)
if ($enum -notmatch '(?m)^\s*debug\s+Yes') {
  Write-Step 'bcdedit /debug on ...'
  & bcdedit /debug on
  if ($LASTEXITCODE -ne 0) { throw "bcdedit /debug on 失败（exit=$LASTEXITCODE）" }
} else {
  Write-Step 'debug 已开，跳过'
}
$dbg = (& bcdedit /dbgsettings 2>$null | Out-String)
if ($dbg -notmatch '(?m)^\s*debugtype\s+Serial' -or $dbg -notmatch '(?m)^\s*debugport\s+1\b' -or $dbg -notmatch '(?m)^\s*baudrate\s+115200') {
  Write-Step 'bcdedit /dbgsettings serial debugport:1 baudrate:115200 ...'
  & bcdedit /dbgsettings serial debugport:1 baudrate:115200
  if ($LASTEXITCODE -ne 0) { throw "bcdedit /dbgsettings 失败（exit=$LASTEXITCODE）" }
} else {
  Write-Step 'dbgsettings（serial 1/115200）已配，跳过'
}
if ($enum -notmatch '(?m)^\s*testsigning\s+Yes') {
  Write-Step 'bcdedit /set testsigning on ...'
  & bcdedit /set '{current}' testsigning on
  if ($LASTEXITCODE -ne 0) {
    throw "bcdedit testsigning 失败（exit=$LASTEXITCODE）——Secure Boot 开启时 testsigning 被拒：关 Secure Boot（VM 设置）或改用 Attestation 签名"
  }
} else {
  Write-Step 'testsigning 已开，跳过'
}

Write-Step '== 完整转储配置（蓝屏证据落盘）=='
# CrashControl：CrashDumpEnabled=1 完整转储 + 覆盖写——内核态分析重度依赖
# 完整转储（minidump 栈/池信息不够）。
$crashControl = 'HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl'
$curDump = (Get-ItemProperty -Path $crashControl -Name CrashDumpEnabled -ErrorAction SilentlyContinue).CrashDumpEnabled
if ($curDump -ne 1) {
  New-ItemProperty -Path $crashControl -Name CrashDumpEnabled -Value 1 -PropertyType DWord -Force | Out-Null
  Write-Step 'CrashDumpEnabled → 1（完整转储）'
} else {
  Write-Step '完整转储已配，跳过'
}
$curOw = (Get-ItemProperty -Path $crashControl -Name Overwrite -ErrorAction SilentlyContinue).Overwrite
if ($curOw -ne 1) {
  New-ItemProperty -Path $crashControl -Name Overwrite -Value 1 -PropertyType DWord -Force | Out-Null
  Write-Step 'Overwrite → 1（转储覆盖写）'
} else {
  Write-Step '转储覆盖写已配，跳过'
}

Write-Step '== WDK（firstRunTools 大件）=='
# 探测与 capability 探测词 wdk 同口径：KitsRoot10 注册表值在场即跳过。
function Test-WdkInstalled {
  & reg query "HKLM\SOFTWARE\Microsoft\Windows Kits\Installed Roots" /v KitsRoot10 >$null 2>&1
  return ($LASTEXITCODE -eq 0)
}
if (Test-WdkInstalled) {
  Write-Step 'WDK 已装（KitsRoot10 在场），跳过'
} else {
  # 首选 winget（Microsoft Learn 官方安装路径）；不可用/失败回落下载块
  $installed = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Step 'trying winget: Microsoft.WindowsWDK ...'
    & winget install -e --id Microsoft.WindowsWDK --accept-package-agreements --accept-source-agreements --silent
    $installed = ($LASTEXITCODE -eq 0)
    if (-not $installed) { Write-Host '[win-kernel] winget WDK 安装未成功——回落下载块' }
  } else {
    Write-Host '[win-kernel] winget 不在场——回落下载块'
  }
  if (-not $installed) {
    $pkg = Invoke-PinnedDownload 'wdk' $WDK_URL $WDK_SHA256 $WDK_GUIDANCE
    if ($pkg) {
      Write-Step 'installing WDK（静默）...'
      & $pkg /quiet /norestart
      if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 3010) { throw "WDK 安装失败（exit=$LASTEXITCODE）" }
      Write-Step 'WDK 安装完成'
    }
  }
}

Write-Step '== OSR Loader（测试驱动加载器）=='
# 探测与 capability 探测词 osr-loader 同口径：部署位文件在场即跳过。
$osrDir = 'C:\tools\osr-loader'
if (Test-Path (Join-Path $osrDir 'OSRLOADER.exe')) {
  Write-Step 'OSR Loader 已装（部署位在场），跳过'
} else {
  $pkg = Invoke-PinnedDownload 'osr-loader' $OSRLOADER_URL $OSRLOADER_SHA256 $OSRLOADER_GUIDANCE
  if ($pkg) {
    Write-Step 'deploying OSR Loader...'
    if (-not (Test-Path 'C:\tools')) { New-Item -ItemType Directory -Path 'C:\tools' | Out-Null }
    $odir = Join-Path $env:TEMP 'osr-pkg'
    Expand-Archive -Path $pkg -DestinationPath $odir -Force
    $exe = Get-ChildItem -Path $odir -Recurse -Filter 'OSRLOADER.exe' | Select-Object -First 1
    if (-not $exe) { throw "OSR Loader zip 内未找到 OSRLOADER.exe（$odir）——包结构不符预期" }
    if (Test-Path $osrDir) { Remove-Item $osrDir -Recurse -Force }
    New-Item -ItemType Directory -Path $osrDir | Out-Null
    Copy-Item $exe.FullName (Join-Path $osrDir 'OSRLOADER.exe')
    Write-Step "OSR Loader → $osrDir"
  }
}

Write-Step '== 环境配置 =='
# 工作目录约定 + Defender 排除（驱动产物不被实时扫描抢先处决）
$workDir = 'C:\zhishi-work'
foreach ($sub in @('', 'drivers', 'dumps', 'bin')) {
  $p = if ($sub) { Join-Path $workDir $sub } else { $workDir }
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p | Out-Null }
}
try {
  Add-MpPreference -ExclusionPath $workDir
  Write-Step "Defender 排除项已加：$workDir"
} catch {
  Write-Host "[win-kernel] WARN: Defender 排除项未加上（$($_.Exception.Message)）——加载测试驱动可能被实时扫描干扰"
}

Write-Step '== 自检 =='
$enum = (& bcdedit /enum '{current}' 2>$null | Out-String)
if ($enum -match '(?m)^\s*debug\s+Yes') { Write-Step 'OK: bcdedit debug' } else { $missing += 'bcdedit debug' }
$dbg = (& bcdedit /dbgsettings 2>$null | Out-String)
if ($dbg -match '(?m)^\s*debugtype\s+Serial' -and $dbg -match '(?m)^\s*debugport\s+1\b' -and $dbg -match '(?m)^\s*baudrate\s+115200') {
  Write-Step 'OK: bcdedit dbgsettings（serial 1/115200）'
} else { $missing += 'bcdedit dbgsettings' }
if ($enum -match '(?m)^\s*testsigning\s+Yes') { Write-Step 'OK: bcdedit testsigning' } else { $missing += 'bcdedit testsigning' }
if (Get-Command verifier -ErrorAction SilentlyContinue) { Write-Step 'OK: verifier' } else { $missing += 'verifier' }
# wdk / osr-loader：常量已填 → 必须装好；常量占位 → WARN 待办（不阻断：
# 钉死来源是 operator 职责，宁可装不上不可裸装未知来源）
if (Test-WdkInstalled) {
  Write-Step 'OK: wdk'
} elseif ((Test-PlaceholderConstant $WDK_URL) -or (Test-PlaceholderConstant $WDK_SHA256)) {
  Write-Host '[win-kernel] WARN: wdk 未装且下载常量为 TODO 占位——按头部获取指引填常量后重放本脚本'
} else {
  $missing += 'wdk'
}
if (Test-Path (Join-Path $osrDir 'OSRLOADER.exe')) {
  Write-Step 'OK: osr-loader'
} elseif ((Test-PlaceholderConstant $OSRLOADER_URL) -or (Test-PlaceholderConstant $OSRLOADER_SHA256)) {
  Write-Host '[win-kernel] WARN: osr-loader 未装且下载常量为 TODO 占位——按头部获取指引填常量后重放本脚本'
} else {
  $missing += 'osr-loader'
}
if ($missing.Count -gt 0) { throw "自检未过，缺失项：$($missing -join ', ')" }

Write-Step 'ready —— 现在做快照：vmrun -T ws snapshot <本VM.vmx> zhishi-clean'
