# ZhiShi 版本回滚脚本 (PowerShell)

# 从 R2 上已有的旧版本数据重建更新清单，实现版本回滚

#

# 原理：R2 上 releases/v{VERSION}/ 目录保留了所有历史版本的完整产物

# 回滚 = 用旧版本的数据重建 update/*.json 清单并上传覆盖当前版本

#

# 默认回滚全部 5 个清单（macOS + Windows），也可选择仅回滚单平台

# macOS/Linux 上请运行 ./scripts/release/rollback_release.sh（功能完全相同，Bash 版本）

#

# 前置条件：

# 1. .env 中配置了 R2 凭证 (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID)

# 2. .env 中配置了 Cloudflare 缓存清除凭证（可选但强烈推荐）

# 3. 安装 rclone: https://rclone.org/downloads/



$ErrorActionPreference = "Stop"

$RollbackSuccess = $false



$script:rcloneConfig = $null

$script:WorkDir = $null



function Exit-WithPause {

    param([int]$Code = 0)

    Write-Host ""

    if ($Code -eq 0) {

        Write-Host "按回车键退出..." -ForegroundColor Cyan

    } else {

        Write-Host "按回车键退出..." -ForegroundColor Yellow

    }

    Read-Host

    exit $Code

}



function Cleanup-TempFiles {

    if ($script:rcloneConfig -and (Test-Path $script:rcloneConfig)) {

        Remove-Item $script:rcloneConfig -Force -ErrorAction SilentlyContinue

    }

    if ($script:WorkDir -and (Test-Path $script:WorkDir)) {

        Remove-Item $script:WorkDir -Recurse -Force -ErrorAction SilentlyContinue

    }

}



function Format-FileSize {

    param([long]$Bytes)

    if ($Bytes -ge 1GB) { return "{0:N2} GiB" -f ($Bytes / 1GB) }

    if ($Bytes -ge 1MB) { return "{0:N1} MiB" -f ($Bytes / 1MB) }

    if ($Bytes -ge 1KB) { return "{0:N1} KiB" -f ($Bytes / 1KB) }

    return "$Bytes B"

}



try {



$ProjectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

Set-Location $ProjectDir



# 配置

$R2Bucket = "zhishi-releases"

$DownloadBaseUrl = "https://download.zhishi.help"

$EnvFile = Join-Path $ProjectDir ".env"



Write-Host ""

Write-Host "=========================================" -ForegroundColor Cyan

Write-Host "  ZhiShi 版本回滚" -ForegroundColor Yellow

Write-Host "=========================================" -ForegroundColor Cyan

Write-Host ""



# ========================================

# 加载环境变量

# ========================================

Write-Host "[1/7] 加载配置..." -ForegroundColor Blue



if (-not (Test-Path $EnvFile)) {

    Write-Host "[X] .env 文件不存在!" -ForegroundColor Red

    throw ".env 文件不存在"

}



Get-Content $EnvFile | ForEach-Object {

    if ($_ -match '^([^#=]+)=(.*)$') {

        $name = $Matches[1].Trim()

        $value = $Matches[2].Trim()

        if ($value -match '^"([^"]*)"' -or $value -match "^'([^']*)'") {

            $value = $Matches[1]

        } else {

            $value = $value -replace '\s+#.*$', ''

            $value = $value.Trim()

        }

        [Environment]::SetEnvironmentVariable($name, $value, "Process")

    }

}

Write-Host "[OK] 已加载 .env" -ForegroundColor Green



$R2AccessKeyId = $env:R2_ACCESS_KEY_ID

$R2SecretAccessKey = $env:R2_SECRET_ACCESS_KEY

$R2AccountId = $env:R2_ACCOUNT_ID



if (-not $R2AccessKeyId -or -not $R2SecretAccessKey -or -not $R2AccountId) {

    Write-Host "[X] R2 配置不完整!" -ForegroundColor Red

    throw "R2 配置不完整"

}

Write-Host "[OK] R2 配置已验证" -ForegroundColor Green

Write-Host ""



# ========================================

# 检查 rclone

# ========================================

Write-Host "[2/7] 检查 rclone..." -ForegroundColor Blue



$localRclone = Join-Path $ProjectDir "rclone.exe"

if (Test-Path $localRclone) {

    $rclonePath = $localRclone

    Write-Host "[OK] 使用项目目录 rclone.exe" -ForegroundColor Green

} else {

    $rclone = Get-Command rclone -ErrorAction SilentlyContinue

    if (-not $rclone) {

        Write-Host "[X] rclone 未找到" -ForegroundColor Red

        throw "rclone 未找到"

    }

    $rclonePath = $rclone.Source

    Write-Host "[OK] 使用系统 rclone" -ForegroundColor Green

}



$rcloneConfig = [System.IO.Path]::GetTempFileName()

$script:rcloneConfig = $rcloneConfig

@"

[r2]

type = s3

provider = Cloudflare

env_auth = true

endpoint = https://$R2AccountId.r2.cloudflarestorage.com

acl = private

"@ | Set-Content $rcloneConfig -Encoding UTF8



$env:RCLONE_CONFIG_R2_ACCESS_KEY_ID = $R2AccessKeyId

$env:RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = $R2SecretAccessKey



$WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ("zhishi-rollback-" + [System.Guid]::NewGuid().ToString("N"))

$script:WorkDir = $WorkDir

New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null



Write-Host ""



# ========================================

# 查询当前线上版本

# ========================================

Write-Host "[3/7] 查询版本信息..." -ForegroundColor Blue



$CurrentMacVersion = "(未知)"

$CurrentWinVersion = "(未知)"



Write-Host "  获取当前线上版本..." -ForegroundColor Cyan



# 放宽错误处理（rclone 进度输出会触发 PowerShell 错误）

$prevEAP = $ErrorActionPreference

$ErrorActionPreference = "Continue"



$currentUpdateDir = Join-Path $WorkDir "current_update"

New-Item -ItemType Directory -Path $currentUpdateDir -Force | Out-Null

& $rclonePath --config=$rcloneConfig copy "r2:$R2Bucket/update/" $currentUpdateDir --s3-no-check-bucket 2>$null



$macManifest = Join-Path $currentUpdateDir "darwin-aarch64.json"

if (Test-Path $macManifest) {

    $json = Get-Content $macManifest -Raw | ConvertFrom-Json

    $CurrentMacVersion = $json.version

}

$winManifest = Join-Path $currentUpdateDir "windows-x86_64.json"

if (Test-Path $winManifest) {

    $json = Get-Content $winManifest -Raw | ConvertFrom-Json

    $CurrentWinVersion = $json.version

}



Write-Host "  [OK] 当前线上: macOS v$CurrentMacVersion / Windows v$CurrentWinVersion" -ForegroundColor Green

Write-Host ""



# 列出 R2 上所有版本

Write-Host "  扫描 R2 上的历史版本..." -ForegroundColor Cyan



$lsdOutput = & $rclonePath --config=$rcloneConfig lsd "r2:$R2Bucket/releases/" --s3-no-check-bucket 2>$null

$Versions = @()

foreach ($line in $lsdOutput) {

    if ($line -match '\s(v\d+\.\d+\.\d+)\s*$') {

        $Versions += $Matches[1].Substring(1)

    }

}



if ($Versions.Count -eq 0) {

    $ErrorActionPreference = $prevEAP

    Write-Host "[X] R2 上没有找到任何版本" -ForegroundColor Red

    throw "无可用版本"

}



$Versions = $Versions | Sort-Object { [version]$_ } -Descending



Write-Host ""

Write-Host "  -----------------------------------------" -ForegroundColor Cyan

Write-Host "  可用版本" -ForegroundColor Blue

Write-Host "  -----------------------------------------" -ForegroundColor Cyan



for ($i = 0; $i -lt $Versions.Count; $i++) {

    $ver = $Versions[$i]

    $markers = @()

    if ($ver -eq $CurrentMacVersion) { $markers += "mac" }

    if ($ver -eq $CurrentWinVersion) { $markers += "win" }

    $idx = $i + 1

    if ($markers.Count -gt 0) {

        $tag = $markers -join " "

        Write-Host ("  [{0,2}] v{1}  <- 当前线上({2})" -f $idx, $ver, $tag) -ForegroundColor Yellow

    } else {

        Write-Host ("  [{0,2}] v{1}" -f $idx, $ver)

    }

}



Write-Host "  -----------------------------------------" -ForegroundColor Cyan

Write-Host ""



# 用户选择版本

$TargetInput = Read-Host "输入要回滚到的版本号 (如 0.1.48) 或序号"



$TargetVersion = $null

if ($TargetInput -match '^\d+$') {

    $idx = [int]$TargetInput

    if ($idx -ge 1 -and $idx -le $Versions.Count) {

        $TargetVersion = $Versions[$idx - 1]

    }

}

if (-not $TargetVersion) {

    $TargetVersion = $TargetInput -replace '^v', ''

}



if ($TargetVersion -notin $Versions) {

    $ErrorActionPreference = $prevEAP

    Write-Host "[X] 版本 v$TargetVersion 不存在于 R2" -ForegroundColor Red

    throw "版本不存在"

}



Write-Host ""

Write-Host "  [OK] 目标版本: v$TargetVersion" -ForegroundColor Green

Write-Host ""



# ========================================

# 选择回滚范围

# ========================================

Write-Host "[4/7] 选择回滚范围..." -ForegroundColor Blue

Write-Host ""

Write-Host "  [1] 全部回滚 (macOS + Windows)  <- 默认" -ForegroundColor Yellow

Write-Host "  [2] 仅 macOS  (darwin-aarch64.json + darwin-x86_64.json + latest.json)"

Write-Host "  [3] 仅 Windows (windows-x86_64.json + latest_win.json)"

Write-Host ""

$ScopeInput = Read-Host "选择 (1/2/3, 回车默认全部)"



$RollbackMac = $false

$RollbackWin = $false



switch ($ScopeInput) {

    ""  { $RollbackMac = $true; $RollbackWin = $true }

    "1" { $RollbackMac = $true; $RollbackWin = $true }

    "2" { $RollbackMac = $true }

    "3" { $RollbackWin = $true }

    default {

        $ErrorActionPreference = $prevEAP

        Write-Host "[X] 无效选择" -ForegroundColor Red

        throw "无效选择"

    }

}



# 防止回滚到当前版本

$allCurrent = $true

if ($RollbackMac -and $TargetVersion -ne $CurrentMacVersion) { $allCurrent = $false }

if ($RollbackWin -and $TargetVersion -ne $CurrentWinVersion) { $allCurrent = $false }



if ($allCurrent) {

    $ErrorActionPreference = $prevEAP

    Write-Host "[!] 选定平台已经全部是 v$TargetVersion，无需回滚" -ForegroundColor Yellow

    Exit-WithPause 0

}



$skipMsgs = @()

if ($RollbackMac -and $TargetVersion -eq $CurrentMacVersion) { $skipMsgs += "macOS" }

if ($RollbackWin -and $TargetVersion -eq $CurrentWinVersion) { $skipMsgs += "Windows" }

if ($skipMsgs.Count -gt 0) {

    Write-Host ("  [!] {0} 已经是 v{1}，将跳过" -f ($skipMsgs -join ", "), $TargetVersion) -ForegroundColor Yellow

}



Write-Host ""



# ========================================

# 从 R2 获取旧版本数据并重建清单

# ========================================

Write-Host "[5/7] 从 R2 获取旧版本数据并重建清单..." -ForegroundColor Blue



$r2FilesRaw = & $rclonePath --config=$rcloneConfig ls "r2:$R2Bucket/releases/v$TargetVersion/" --s3-no-check-bucket 2>$null



if (-not $r2FilesRaw) {

    $ErrorActionPreference = $prevEAP

    Write-Host "[X] R2 上 releases/v$TargetVersion/ 目录为空或不存在" -ForegroundColor Red

    throw "目录为空"

}



Write-Host "  R2 上 v${TargetVersion} 的文件:" -ForegroundColor Cyan

foreach ($line in $r2FilesRaw) {

    if ($line -match '^\s*(\d+)\s+(.+)$') {

        $size = [long]$Matches[1]

        $name = $Matches[2].Trim()

        Write-Host ("    - {0,-50} {1}" -f $name, (Format-FileSize $size))

    }

}

Write-Host ""



$ManifestDir = Join-Path $WorkDir "manifests"

New-Item -ItemType Directory -Path $ManifestDir -Force | Out-Null



$PubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")



# 下载 sig 文件

$SigDir = Join-Path $WorkDir "sigs"

New-Item -ItemType Directory -Path $SigDir -Force | Out-Null



Write-Host "  下载签名文件..." -ForegroundColor Cyan

& $rclonePath --config=$rcloneConfig copy "r2:$R2Bucket/releases/v$TargetVersion/" $SigDir --include="*.sig" --s3-no-check-bucket 2>$null



# --- macOS 清单 ---

if ($RollbackMac -and $TargetVersion -ne $CurrentMacVersion) {

    Write-Host ""

    Write-Host "  重建 macOS 清单..." -ForegroundColor Cyan



    # darwin-aarch64.json

    $armSigPath = Join-Path $SigDir "ZhiShi_${TargetVersion}_aarch64.app.tar.gz.sig"

    $armTarName = "ZhiShi_${TargetVersion}_aarch64.app.tar.gz"

    if (-not (Test-Path $armSigPath)) {

        $armSigPath = Join-Path $SigDir "ZhiShi_aarch64.app.tar.gz.sig"

        $armTarName = "ZhiShi_aarch64.app.tar.gz"

    }



    if (Test-Path $armSigPath) {

        $armSig = (Get-Content $armSigPath -Raw).Trim()

        $armManifest = @{ version = $TargetVersion; notes = "ZhiShi v$TargetVersion"; pub_date = $PubDate; signature = $armSig; url = "$DownloadBaseUrl/releases/v$TargetVersion/$armTarName" }

        [System.IO.File]::WriteAllText((Join-Path $ManifestDir "darwin-aarch64.json"), ($armManifest | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))

        Write-Host "    [OK] darwin-aarch64.json" -ForegroundColor Green

    } else {

        Write-Host "    [!] 未找到 ARM 签名文件，跳过 darwin-aarch64.json" -ForegroundColor Yellow

    }



    # darwin-x86_64.json

    $intelSigPath = Join-Path $SigDir "ZhiShi_${TargetVersion}_x86_64.app.tar.gz.sig"

    $intelTarName = "ZhiShi_${TargetVersion}_x86_64.app.tar.gz"

    if (-not (Test-Path $intelSigPath)) {

        $intelSigPath = Join-Path $SigDir "ZhiShi_x86_64.app.tar.gz.sig"

        $intelTarName = "ZhiShi_x86_64.app.tar.gz"

    }

    if (-not (Test-Path $intelSigPath)) {

        $intelSigPath = Join-Path $SigDir "ZhiShi_${TargetVersion}_x64.app.tar.gz.sig"

        $intelTarName = "ZhiShi_${TargetVersion}_x64.app.tar.gz"

    }



    if (Test-Path $intelSigPath) {

        $intelSig = (Get-Content $intelSigPath -Raw).Trim()

        $intelManifest = @{ version = $TargetVersion; notes = "ZhiShi v$TargetVersion"; pub_date = $PubDate; signature = $intelSig; url = "$DownloadBaseUrl/releases/v$TargetVersion/$intelTarName" }

        [System.IO.File]::WriteAllText((Join-Path $ManifestDir "darwin-x86_64.json"), ($intelManifest | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))

        Write-Host "    [OK] darwin-x86_64.json" -ForegroundColor Green

    } else {

        Write-Host "    [!] 未找到 Intel 签名文件，跳过 darwin-x86_64.json" -ForegroundColor Yellow

    }



    # latest.json

    $armDmg = $null; $intelDmg = $null

    foreach ($line in $r2FilesRaw) {

        if ($line -match '\s+(.*aarch64.*\.dmg)\s*$') { $armDmg = $Matches[1].Trim() }

        if ($line -match '\s+(.*x64.*\.dmg)\s*$') { $intelDmg = $Matches[1].Trim() }

    }



    if ($armDmg -or $intelDmg) {

        $downloads = @{}

        if ($armDmg) { $downloads["mac_arm64"] = @{ name = "Apple Silicon"; url = "$DownloadBaseUrl/releases/v$TargetVersion/$armDmg" } }

        if ($intelDmg) { $downloads["mac_intel"] = @{ name = "Intel Mac"; url = "$DownloadBaseUrl/releases/v$TargetVersion/$intelDmg" } }

        $latestManifest = @{ version = $TargetVersion; pub_date = $PubDate; release_notes = "ZhiShi v$TargetVersion"; downloads = $downloads }

        [System.IO.File]::WriteAllText((Join-Path $ManifestDir "latest.json"), ($latestManifest | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))

        Write-Host "    [OK] latest.json (ARM: $($armDmg ?? '无'), Intel: $($intelDmg ?? '无'))" -ForegroundColor Green

    } else {

        Write-Host "    [!] 未找到 DMG 文件，跳过 latest.json" -ForegroundColor Yellow

    }

}



# --- Windows 清单 ---

if ($RollbackWin -and $TargetVersion -ne $CurrentWinVersion) {

    Write-Host ""

    Write-Host "  重建 Windows 清单..." -ForegroundColor Cyan



    # windows-x86_64.json

    $winSigPath = Join-Path $SigDir "ZhiShi_${TargetVersion}_x86_64.nsis.zip.sig"

    $winZipName = "ZhiShi_${TargetVersion}_x86_64.nsis.zip"

    if (-not (Test-Path $winSigPath)) {

        $fallback = Get-ChildItem -Path $SigDir -Filter "*.nsis.zip.sig" -ErrorAction SilentlyContinue | Select-Object -First 1

        if ($fallback) {

            $winSigPath = $fallback.FullName

            $winZipName = $fallback.Name -replace '\.sig$', ''

        }

    }



    if (Test-Path $winSigPath) {

        $winSig = (Get-Content $winSigPath -Raw).Trim()

        $winManifest = @{ version = $TargetVersion; notes = "ZhiShi v$TargetVersion"; pub_date = $PubDate; signature = $winSig; url = "$DownloadBaseUrl/releases/v$TargetVersion/$winZipName" }

        [System.IO.File]::WriteAllText((Join-Path $ManifestDir "windows-x86_64.json"), ($winManifest | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))

        Write-Host "    [OK] windows-x86_64.json" -ForegroundColor Green

    } else {

        Write-Host "    [!] 未找到 Windows 签名文件，跳过 windows-x86_64.json" -ForegroundColor Yellow

    }



    # latest_win.json

    $winExe = $null

    foreach ($line in $r2FilesRaw) {

        if ($line -match '\s+(.*setup\.exe)\s*$') { $winExe = $Matches[1].Trim(); break }

    }



    if ($winExe) {

        $latestWin = @{

            version = $TargetVersion; pub_date = $PubDate; release_notes = "ZhiShi v$TargetVersion"

            downloads = @{ "win_x64" = @{ name = "Windows x64"; url = "$DownloadBaseUrl/releases/v$TargetVersion/$winExe" } }

        }

        [System.IO.File]::WriteAllText((Join-Path $ManifestDir "latest_win.json"), ($latestWin | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))

        Write-Host "    [OK] latest_win.json ($winExe)" -ForegroundColor Green

    } else {

        Write-Host "    [!] 未找到 setup.exe，跳过 latest_win.json" -ForegroundColor Yellow

    }

}



# 检查是否有清单生成

$manifestFiles = Get-ChildItem -Path $ManifestDir -Filter "*.json" -ErrorAction SilentlyContinue

if (-not $manifestFiles -or $manifestFiles.Count -eq 0) {

    $ErrorActionPreference = $prevEAP

    Write-Host "[X] 没有成功生成任何清单文件，无法回滚" -ForegroundColor Red

    throw "无清单"

}



Write-Host ""



# ========================================

# 确认回滚

# ========================================

Write-Host "[6/7] 确认回滚..." -ForegroundColor Blue

Write-Host ""

Write-Host "  即将上传的清单:" -ForegroundColor Cyan

foreach ($f in $manifestFiles) {

    Write-Host "    - $($f.Name)"

}

Write-Host ""

Write-Host "  回滚方向:" -ForegroundColor Cyan

if ($RollbackMac -and $TargetVersion -ne $CurrentMacVersion) {

    Write-Host "    macOS:   v$CurrentMacVersion -> v$TargetVersion"

}

if ($RollbackWin -and $TargetVersion -ne $CurrentWinVersion) {

    Write-Host "    Windows: v$CurrentWinVersion -> v$TargetVersion"

}



Write-Host ""

Write-Host "  [!] 此操作将覆盖线上更新清单，所有用户将看到回滚后的版本!" -ForegroundColor Red

$confirm = Read-Host "确认回滚? (输入 'rollback' 继续)"

if ($confirm -ne "rollback") {

    $ErrorActionPreference = $prevEAP

    Write-Host "回滚已取消" -ForegroundColor Red

    throw "用户取消回滚"

}



Write-Host ""



# ========================================

# 上传清单到 R2

# ========================================

Write-Host "[7/7] 上传回滚清单到 R2..." -ForegroundColor Blue



& $rclonePath --config=$rcloneConfig copy "$ManifestDir/" "r2:$R2Bucket/update/" --s3-no-check-bucket --progress

if ($LASTEXITCODE -ne 0) {

    $ErrorActionPreference = $prevEAP

    Write-Host "[X] 清单上传失败" -ForegroundColor Red

    throw "上传失败"

}



Write-Host "[OK] 清单已上传" -ForegroundColor Green

Write-Host ""



# ========================================

# 清除 CDN 缓存

# ========================================

$CfZoneId = $env:CF_ZONE_ID

$CfApiToken = $env:CF_API_TOKEN



if ($CfZoneId -and $CfApiToken) {

    Write-Host "清除 Cloudflare CDN 缓存..." -ForegroundColor Cyan



    $purgeUrls = @()

    foreach ($f in $manifestFiles) {

        $purgeUrls += "$DownloadBaseUrl/update/$($f.Name)"

    }



    $purgeBody = @{ files = $purgeUrls } | ConvertTo-Json



    try {

        $response = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/zones/$CfZoneId/purge_cache" `

            -Method Post `

            -Headers @{ "Authorization" = "Bearer $CfApiToken"; "Content-Type" = "application/json" } `

            -Body $purgeBody



        if ($response.success) {

            Write-Host "  [OK] CDN 缓存已清除 ($($purgeUrls.Count) 个文件)" -ForegroundColor Green

        } else {

            Write-Host "  [!] CDN 缓存清除可能失败" -ForegroundColor Yellow

        }

    } catch {

        Write-Host "  [!] CDN 缓存清除请求失败: $_" -ForegroundColor Yellow

    }

} else {

    Write-Host "[!] 未配置 CF_ZONE_ID 或 CF_API_TOKEN，跳过 CDN 缓存清除" -ForegroundColor Yellow

    Write-Host "    强烈建议手动清除缓存以确保回滚立即生效" -ForegroundColor Yellow

}



Write-Host ""



# ========================================

# 验证

# ========================================

Write-Host "验证回滚结果..." -ForegroundColor Cyan

Write-Host ""



$verifyFailed = $false



foreach ($f in $manifestFiles) {

    $fname = $f.Name

    Write-Host -NoNewline "    检查 ${fname}... "

    try {

        $resp = Invoke-RestMethod -Uri "$DownloadBaseUrl/update/$fname" -Method Get -ErrorAction Stop

        if ($resp.version -eq $TargetVersion) {

            Write-Host "[OK] v$($resp.version)" -ForegroundColor Green

        } else {

            Write-Host "[!] 版本仍为 v$($resp.version) (CDN 缓存未刷新?)" -ForegroundColor Yellow

            $verifyFailed = $true

        }

    } catch {

        Write-Host "[X] 请求失败" -ForegroundColor Red

        $verifyFailed = $true

    }

}



Write-Host ""



if ($verifyFailed) {

    Write-Host "[!] 部分验证未通过，可能是 CDN 缓存延迟，请稍后手动验证" -ForegroundColor Yellow

}



$ErrorActionPreference = $prevEAP

$RollbackSuccess = $true



# ========================================

# 完成

# ========================================

Write-Host ""

Write-Host "=========================================" -ForegroundColor Green

Write-Host "  回滚完成!" -ForegroundColor Green

Write-Host "=========================================" -ForegroundColor Green

Write-Host ""

Write-Host "  已回滚到: v$TargetVersion" -ForegroundColor Cyan

Write-Host ""

Write-Host "  手动验证命令:" -ForegroundColor Blue

Write-Host "    curl -s $DownloadBaseUrl/update/latest.json | jq ." -ForegroundColor White

Write-Host "    curl -s $DownloadBaseUrl/update/darwin-aarch64.json | jq ." -ForegroundColor White

Write-Host "    curl -s $DownloadBaseUrl/update/windows-x86_64.json | jq ." -ForegroundColor White

Write-Host ""



Cleanup-TempFiles



} catch {

    Write-Host ""

    Write-Host "=========================================" -ForegroundColor Red

    Write-Host "  回滚失败!" -ForegroundColor Red

    Write-Host "=========================================" -ForegroundColor Red

    Write-Host ""

    Write-Host "错误: $_" -ForegroundColor Red

    Write-Host ""

    Cleanup-TempFiles

}



Write-Host ""

if ($RollbackSuccess) {

    Write-Host "按回车键退出..." -ForegroundColor Cyan

} else {

    Write-Host "按回车键退出..." -ForegroundColor Yellow

}

Read-Host

