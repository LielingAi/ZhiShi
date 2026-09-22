# office-lab 环境初始化与自检 —— 在 Windows guest 内以提升会话运行
#
# 幂等（配方纪律）：每个组件装前探测，已装跳过不重装不升级，可被「补齐环境」重放。
# 供应链纪律（D-T2 配方级落地）：头部下载常量区 URL + sha256 钉死——常量留
# TODO 占位时对应安装块拒绝执行并打印获取指引；已填值下载后 Get-FileHash
# 校验，不符即删并报错。宁可装不上，不裸装未知来源。脚本不落任何凭据
# （Office 激活是 operator 场外事项）。
#
# 提升预检由 provision 链路负责（net session）；直接手跑也会被 #requires 拦下。
#requires -RunAsAdministrator
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) { Write-Host "[office-lab] $msg" }

# ── 下载供应链常量（operator 维护区；TODO 占位 = 对应安装块拒绝执行）────────
$OFFICE_2019_URL    = 'TODO: 填入 Office 2019 离线包 URL（获取指引见下）'
$OFFICE_2019_SHA256 = 'TODO'
$OFFICE_2019_GUIDANCE = @'
获取指引（office-2019 安装块拒绝执行时原样打印）：
  1. 微软下载中心搜索 "Office Deployment Tool"（页面 id=49117）获取 ODT；
  2. 写 configuration.xml 钉死目标 build（OfficeClientEdition=64、
     Channel=PerpetualVL2019、Version=<钉死的 16.0.x 完整号>），执行
     setup.exe /download configuration.xml 产出离线包目录；
  3. 离线包目录打 zip，传到 guest 可达镜像（内网共享/对象存储均可）；
  4. 在源机器上 Get-FileHash .\office2019.zip -Algorithm SHA256，
     把 URL 与哈希填进 setup.ps1 头部两个常量，重放本脚本进场。
  版本钉死发生在第 2 步（ODT 的 Version 属性）——离线包即钉死现场。
'@

function Test-PlaceholderConstant([string]$value) {
  return [string]::IsNullOrWhiteSpace($value) -or $value.StartsWith('TODO')
}

# 下载 → Get-FileHash 校验 → 不符即删报错（D-T2）。占位 → $null（拒绝执行）。
function Invoke-PinnedDownload([string]$name, [string]$url, [string]$sha256, [string]$guidance) {
  if ((Test-PlaceholderConstant $url) -or (Test-PlaceholderConstant $sha256)) {
    Write-Host "[office-lab] SKIP: $name 下载常量为 TODO 占位——拒绝裸装未知来源。"
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
# oletools（olevba/oleid/mraptor）：pip 钉死版本，探测命中即跳过
if (Get-Command olevba -ErrorAction SilentlyContinue) {
  Write-Step 'oletools 已装（olevba 在场），跳过'
} else {
  Write-Step 'installing oletools（pip 钉死版本）...'
  & python -m pip install --no-input 'oletools==0.60.2'
  if ($LASTEXITCODE -ne 0) { Write-Host '[office-lab] WARN: oletools 安装失败——重放本脚本重试' }
}

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
    Write-Host '[office-lab] WARN: cdb 自动安装失败——手动: winget install Microsoft.WinDbg，或 Windows SDK 安装器勾选 Debugging Tools for Windows'
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
# 工作目录约定 + Defender 排除（样本/语料不被实时扫描抢先处决）
$workDir = 'C:\zhishi-work'
foreach ($sub in @('', 'samples', 'crashes', 'traces', 'bin')) {
  $p = if ($sub) { Join-Path $workDir $sub } else { $workDir }
  if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p | Out-Null }
}
try {
  Add-MpPreference -ExclusionPath $workDir
  Write-Step "Defender 排除项已加：$workDir"
} catch {
  Write-Host "[office-lab] WARN: Defender 排除项未加上（$($_.Exception.Message)）——分析性能可能受损"
}
# WER LocalDumps：崩溃自动落全 dump 到 %LOCALAPPDATA%\CrashDumps
$ld = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps'
if (-not (Test-Path $ld)) {
  New-Item -Path $ld -Force | Out-Null
  New-ItemProperty -Path $ld -Name DumpFolder -Value '%LOCALAPPDATA%\CrashDumps' -PropertyType ExpandString | Out-Null
  New-ItemProperty -Path $ld -Name DumpType -Value 2 -PropertyType DWord | Out-Null
}

Write-Step '== Office 2019 钉死目标（firstRunTools 大件）=='
# 探测与 capability 探测词 office-2019 同口径：Uninstall 注册表粗探
# （reg query 搜索 0 命中也退 0，故输出还需含匹配文本才算在场）。
function Test-OfficeInstalled {
  $out = & reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" /s /f "Microsoft Office" 2>$null
  return ($LASTEXITCODE -eq 0 -and (($out -join ' ') -match 'Microsoft Office'))
}
if (Test-OfficeInstalled) {
  Write-Step 'Office 已装（Uninstall 注册表命中），跳过'
} else {
  $pkg = Invoke-PinnedDownload 'office-2019' $OFFICE_2019_URL $OFFICE_2019_SHA256 $OFFICE_2019_GUIDANCE
  if ($pkg) {
    Write-Step 'installing Office 2019（离线包 + configuration.xml）...'
    $odir = Join-Path $env:TEMP 'office2019-pkg'
    Expand-Archive -Path $pkg -DestinationPath $odir -Force
    $setup = Join-Path $odir 'setup.exe'
    if (-not (Test-Path $setup)) { $setup = Join-Path $odir 'Office\setup.exe' }  # ODT 目录布局兼容
    if (-not (Test-Path $setup)) { throw "Office 离线包内未找到 setup.exe（$odir）——包结构与 ODT 产出不符" }
    # 版本钉死在离线包制作环节（ODT /download 的 Version 属性），此处不重复
    # 指定；Volume 通道激活（KMS/MAK）是 operator 场外事项，脚本不碰凭据。
    $cfgPath = Join-Path $odir 'zhishi-install.xml'
    @'
<Configuration>
  <Add OfficeClientEdition="64" Channel="PerpetualVL2019">
    <Product ID="ProPlus2019Volume">
      <Language ID="zh-cn" />
      <Language ID="en-us" />
    </Product>
  </Add>
  <Property Name="AUTOACTIVATE" Value="0" />
  <Display Level="None" AcceptEULA="TRUE" />
</Configuration>
'@ | Out-File -FilePath $cfgPath -Encoding utf8
    & $setup /configure $cfgPath
    if ($LASTEXITCODE -ne 0) { throw "Office 2019 安装失败（exit=$LASTEXITCODE）" }
    Write-Step 'Office 2019 安装完成'
  }
}

Write-Step '== 自检 =='
$missing = @()
foreach ($t in @('python', 'olevba', 'procmon', 'cdb')) {
  if (Get-Command $t -ErrorAction SilentlyContinue) {
    Write-Step "OK: $t"
  } else {
    Write-Host "[office-lab] MISS: $t"
    $missing += $t
  }
}
if (Test-OfficeInstalled) {
  Write-Step 'OK: office-2019'
} elseif ((Test-PlaceholderConstant $OFFICE_2019_URL) -or (Test-PlaceholderConstant $OFFICE_2019_SHA256)) {
  Write-Host '[office-lab] WARN: office-2019 未装且下载常量为 TODO 占位——按头部获取指引填常量后重放本脚本（不阻断：钉死现场是 operator 职责）'
} else {
  $missing += 'office-2019'
}
if ($missing.Count -gt 0) { throw "自检未过，缺失工具：$($missing -join ', ')" }

Write-Step 'ready —— 现在做快照：vmrun -T ws snapshot <本VM.vmx> zhishi-clean'
