# browser-lab 环境初始化与自检 —— 在 Windows guest 内以提升会话运行
#
# 幂等（配方纪律）：每个组件装前探测，已装跳过不重装不升级，可被「补齐环境」重放。
# 供应链纪律（D-T2 配方级落地）：Chrome 目标版本钉死——首选 winget 钉死版，
# winget 不可用/无该版本时回落 Chrome for Testing 官方仓库下载块（URL +
# sha256 钉死在头部常量区；TODO 占位时拒绝执行并打印获取指引，已填值下载后
# Get-FileHash 校验，不符即删报错）。安装后关闭自动更新（组策略键 + 更新器
# 重命名）——复现现场最怕目标自己升级。脚本不落任何凭据。
#
# 提升预检由 provision 链路负责（net session）；直接手跑也会被 #requires 拦下。
#requires -RunAsAdministrator
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) { Write-Host "[browser-lab] $msg" }

# ── 下载供应链常量（operator 维护区；TODO 占位 = 回落下载块拒绝执行）──────
# 钉死版本：Chrome for Testing 官方 known-good-versions 清单在册的真实稳定版。
$CHROME_WINGET_VERSION = '131.0.6778.204'
# CfT 官方仓库钉死版 zip（URL 真实在册；sha256 需 operator 下载后自算填入——
# 清单 JSON 不带哈希字段，见 $CHROME_CFT_GUIDANCE）。
$CHROME_CFT_URL       = 'https://storage.googleapis.com/chrome-for-testing-public/131.0.6778.204/win64/chrome-for-testing-131.0.6778.204-win64.zip'
$CHROME_CFT_SHA256    = 'TODO'
$CHROME_CFT_GUIDANCE = @'
获取指引（chrome-old 回落下载块拒绝执行时原样打印）：
  1. 打开 Chrome for Testing 官方仓库
     https://googlechromelabs.github.io/chrome-for-testing/
     （known-good-versions-with-downloads.json 列出全部在册版本与 URL）；
  2. 在 guest 可达的机器上下载本常量区 URL 指向的 win64 zip；
  3. Get-FileHash .\chrome-for-testing-<ver>-win64.zip -Algorithm SHA256，
     把哈希填进 $CHROME_CFT_SHA256，重放本脚本。
  Chrome for Testing 是谷歌官方为自动化/测试发的发行线：历史版本常驻、
  无自动更新——正是漏洞研究要的「钉死且可复得」形态。
'@

function Test-PlaceholderConstant([string]$value) {
  return [string]::IsNullOrWhiteSpace($value) -or $value.StartsWith('TODO')
}

# 下载 → Get-FileHash 校验 → 不符即删报错（D-T2）。占位 → $null（拒绝执行）。
function Invoke-PinnedDownload([string]$name, [string]$url, [string]$sha256, [string]$guidance) {
  if ((Test-PlaceholderConstant $url) -or (Test-PlaceholderConstant $sha256)) {
    Write-Host "[browser-lab] SKIP: $name 下载常量为 TODO 占位——拒绝裸装未知来源。"
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

# choco 安装（官方安装脚本；裸 VM 常缺 App Installer，winget 未必可用）。
function Ensure-Choco {
  if (Get-Command choco -ErrorAction SilentlyContinue) { return }
  Write-Step 'installing chocolatey...'
  Set-ExecutionPolicy Bypass -Scope Process -Force
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-Expression ((New-Object Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
  $env:Path = "$env:ALLUSERSPROFILE\chocolatey\bin;$env:Path"
}

# 幂等安装：$command 探测命中则跳过；否则 choco install。
function Ensure-ChocoPackage([string]$command, [string]$package) {
  if (Get-Command $command -ErrorAction SilentlyContinue) {
    Write-Step "$package 已装（$command 在场），跳过"
    return
  }
  Write-Step "installing $package..."
  & choco install -y --no-progress $package
  if ($LASTEXITCODE -ne 0) { throw "choco install $package 失败（exit=$LASTEXITCODE）" }
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

Write-Step '== 包管理器 =='
Ensure-Choco

Write-Step '== 核心工具链 =='
Ensure-ChocoPackage python python

# Sysinternals 套件：官方 zip 是滚动发布（微软不定期更新，sha256 随发布
# 漂移，钉 hash 会频繁假失败）——完整性靠 Authenticode 验签（微软签名，
# 与钉 hash 同一信任根的官方验签纪律）。探测 procmon 命中即跳过。
$sysinternalsDir = 'C:\tools\Sysinternals'
if (Get-Command procmon -ErrorAction SilentlyContinue) {
  Write-Step 'sysinternals 已装（procmon 在场），跳过'
} else {
  Write-Step 'deploying Sysinternals Suite（官方 zip + Authenticode 验签）...'
  $siZip = Join-Path $env:TEMP 'SysinternalsSuite.zip'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri 'https://download.sysinternals.com/files/SysinternalsSuite.zip' -OutFile $siZip -UseBasicParsing
  if (-not (Test-Path $sysinternalsDir)) { New-Item -ItemType Directory -Path $sysinternalsDir | Out-Null }
  Expand-Archive -Path $siZip -DestinationPath $sysinternalsDir -Force
  Remove-Item $siZip -Force
  $sig = Get-AuthenticodeSignature (Join-Path $sysinternalsDir 'procmon.exe')
  if ($sig.Status -ne 'Valid') {
    Remove-Item $sysinternalsDir -Recurse -Force -ErrorAction SilentlyContinue
    throw "Sysinternals Authenticode 验签失败（$($sig.Status)）——套件已删，拒绝使用"
  }
  Write-Step "sysinternals Authenticode 验签通过（$($sig.SignerCertificate.Subject)）"
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$sysinternalsDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$sysinternalsDir", 'User')
  }
  $env:Path = "$env:Path;$sysinternalsDir"
}

# cdb（Windows SDK Debugging Tools；TTD 随其入场）——探测命中即跳过安装，
# winget 优先，失败不阻断（给手动指引）。
$cdbDir = "${env:ProgramFiles(x86)}\Windows Kits\10\Debuggers\x64"
if (Get-Command cdb -ErrorAction SilentlyContinue) {
  Write-Step 'cdb 已在场，跳过'
} else {
  Write-Step 'installing Debugging Tools for Windows（cdb）...'
  $installed = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    & winget install -e --id Microsoft.WinDbg --accept-package-agreements --accept-source-agreements --silent
    $installed = ($LASTEXITCODE -eq 0)
  }
  if (-not $installed) {
    Write-Host '[browser-lab] WARN: cdb 自动安装失败——手动: winget install Microsoft.WinDbg，或 Windows SDK 安装器勾选 Debugging Tools for Windows'
  }
}
# SDK 调试工具常不进 PATH——补用户级 PATH（新会话生效）
if ((Test-Path (Join-Path $cdbDir 'cdb.exe')) -and ($env:Path -notlike "*$cdbDir*")) {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$cdbDir*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$cdbDir", 'User')
  }
  $env:Path = "$env:Path;$cdbDir"
}

Write-Step '== 环境配置 =='
# 工作目录约定 + Defender 排除（JS 样本不被实时扫描抢先处决）
$workDir = 'C:\zhishi-work'
foreach ($sub in @('', 'samples', 'crashes', 'traces', 'bin')) {
  $p = if ($sub) { Join-Path $workDir $sub } else { $workDir }
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p | Out-Null }
}
try {
  Add-MpPreference -ExclusionPath $workDir
  Write-Step "Defender 排除项已加：$workDir"
} catch {
  Write-Host "[browser-lab] WARN: Defender 排除项未加上（$($_.Exception.Message)）——分析性能可能受损"
}
# WER LocalDumps：崩溃自动落全 dump 到 %LOCALAPPDATA%\CrashDumps
$ld = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps'
if (-not (Test-Path $ld)) {
  New-Item -Path $ld -Force | Out-Null
  New-ItemProperty -Path $ld -Name DumpFolder -Value '%LOCALAPPDATA%\CrashDumps' -PropertyType ExpandString | Out-Null
  New-ItemProperty -Path $ld -Name DumpType -Value 2 -PropertyType DWord | Out-Null
}

Write-Step '== Chrome 旧版钉死目标（firstRunTools 大件）=='
# 探测安装位与版本（winget 装 Program Files；CfT 便携部署 C:\tools\chrome-old）
$chromeOldDir = 'C:\tools\chrome-old'
function Get-ChromeExe {
  foreach ($exe in @(
      'C:\Program Files\Google\Chrome\Application\chrome.exe',
      'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
      (Join-Path $chromeOldDir 'chrome.exe'))) {
    if (Test-Path $exe) { return $exe }
  }
  return $null
}
$chromeExe = Get-ChromeExe
if ($chromeExe -and (Get-Item $chromeExe).VersionInfo.FileVersion -eq $CHROME_WINGET_VERSION) {
  Write-Step "Chrome 钉死版已在场（$chromeExe，$CHROME_WINGET_VERSION），跳过"
} else {
  if ($chromeExe) {
    Write-Host "[browser-lab] WARN: 在场 Chrome 版本（$((Get-Item $chromeExe).VersionInfo.FileVersion)）≠ 钉死版（$CHROME_WINGET_VERSION）——按钉死版重装"
  }
  # 首选 winget 钉死版；不可用/无该版本 → 回落 CfT 下载块（供应链纪律在块内）
  $installed = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Step "trying winget: Google.Chrome --version $CHROME_WINGET_VERSION ..."
    & winget install -e --id Google.Chrome --version $CHROME_WINGET_VERSION --accept-package-agreements --accept-source-agreements --silent
    $installed = ($LASTEXITCODE -eq 0)
    if (-not $installed) { Write-Host '[browser-lab] winget 钉死版不可得——回落 CfT 下载块' }
  } else {
    Write-Host '[browser-lab] winget 不在场——回落 CfT 下载块'
  }
  if (-not $installed) {
    $pkg = Invoke-PinnedDownload 'chrome-for-testing' $CHROME_CFT_URL $CHROME_CFT_SHA256 $CHROME_CFT_GUIDANCE
    if ($pkg) {
      Write-Step 'deploying Chrome for Testing（便携，无自动更新器）...'
      $cdir = Join-Path $env:TEMP 'cft-pkg'
      Expand-Archive -Path $pkg -DestinationPath $cdir -Force
      $inner = Join-Path $cdir "chrome-for-testing-$CHROME_WINGET_VERSION-win64"
      if (-not (Test-Path (Join-Path $inner 'chrome.exe'))) { throw "CfT zip 内未找到 chrome.exe（$inner）——包结构不符预期" }
      if (Test-Path $chromeOldDir) { Remove-Item $chromeOldDir -Recurse -Force }
      Move-Item $inner $chromeOldDir
      Write-Step "Chrome for Testing → $chromeOldDir"
    }
  }
}
# 自动更新关闭纪律（幂等）：组策略键 + 更新器重命名——复现现场最怕目标自升级
$updPolicy = 'HKLM:\SOFTWARE\Policies\Google\Update'
if (-not (Test-Path $updPolicy)) { New-Item -Path $updPolicy -Force | Out-Null }
foreach ($kv in @(@('UpdateDefault', 0), @('AutoUpdateCheckPeriodMinutes', 0), @('DisableAutoUpdateChecksCheckboxValue', 1))) {
  $cur = (Get-ItemProperty -Path $updPolicy -Name $kv[0] -ErrorAction SilentlyContinue).$($kv[0])
  if ($cur -ne $kv[1]) { New-ItemProperty -Path $updPolicy -Name $kv[0] -Value $kv[1] -PropertyType DWord -Force | Out-Null }
}
Write-Step 'Chrome 自动更新策略键已关（HKLM\SOFTWARE\Policies\Google\Update）'
$updater = 'C:\Program Files (x86)\Google\Update\GoogleUpdate.exe'
if (Test-Path $updater) {
  Rename-Item $updater 'GoogleUpdate.exe.zhishi-disabled' -Force
  Write-Step 'GoogleUpdate.exe 已重命名禁用'
}

Write-Step '== 自检 =='
$missing = @()
foreach ($t in @('python', 'procmon', 'cdb')) {
  if (Get-Command $t -ErrorAction SilentlyContinue) {
    Write-Step "OK: $t"
  } else {
    Write-Host "[browser-lab] MISS: $t"
    $missing += $t
  }
}
$chromeExe = Get-ChromeExe
if ($chromeExe -and (Get-Item $chromeExe).VersionInfo.FileVersion -eq $CHROME_WINGET_VERSION) {
  Write-Step "OK: chrome-old（$CHROME_WINGET_VERSION）"
} elseif (Test-PlaceholderConstant $CHROME_CFT_SHA256) {
  Write-Host '[browser-lab] WARN: chrome-old 未装且 CfT 哈希为 TODO 占位——winget 不可用；按头部获取指引填 $CHROME_CFT_SHA256 后重放本脚本'
} else {
  $missing += 'chrome-old'
}
if ($missing.Count -gt 0) { throw "自检未过，缺失工具：$($missing -join ', ')" }

Write-Step 'ready —— 现在做快照：vmrun -T ws snapshot <本VM.vmx> zhishi-clean'
