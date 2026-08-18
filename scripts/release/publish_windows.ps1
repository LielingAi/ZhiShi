# ZhiShi Windows 发布脚本

# 将构建产物上传到 Cloudflare R2，并生成更新清单

#

# 前置条件：

# 1. 已运行 ./scripts/build/build_windows.ps1 完成构建

# 2. .env 中配置了 R2 凭证：

#    - R2_ACCESS_KEY_ID

#    - R2_SECRET_ACCESS_KEY

#    - R2_ACCOUNT_ID

# 3. .env 中配置了 Cloudflare 缓存清除凭证（可选但推荐）：

#    - CF_ZONE_ID

#    - CF_API_TOKEN

# 4. 安装 rclone: https://rclone.org/downloads/



$ErrorActionPreference = "Stop"

$PublishSuccess = $false



# 用于清理的临时文件路径

$script:rcloneConfig = $null

$script:ManifestDir = $null



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

    if ($script:ManifestDir -and (Test-Path $script:ManifestDir)) {

        Remove-Item $script:ManifestDir -Recurse -Force -ErrorAction SilentlyContinue

    }

}



try {



$ProjectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

Set-Location $ProjectDir



# 读取版本号

$TauriConf = Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json

$Version = $TauriConf.version

$BundleDir = Join-Path $ProjectDir "src-tauri\target"

$EnvFile = Join-Path $ProjectDir ".env"



# 配置

$R2Bucket = "zhishi-releases"

$DownloadBaseUrl = "https://ticket.zhishi.help"



Write-Host ""

Write-Host "=========================================" -ForegroundColor Cyan

Write-Host "  ZhiShi Windows 发布到 R2" -ForegroundColor Green

Write-Host "  Version: $Version" -ForegroundColor Blue

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



        Set-Item -Path "env:$name" -Value $value

    }

}

Write-Host "[OK] 已加载 .env" -ForegroundColor Green



# 验证 R2 配置（可选 — 没有则跳过 R2 上传）

$R2AccessKeyId = $env:R2_ACCESS_KEY_ID

$R2SecretAccessKey = $env:R2_SECRET_ACCESS_KEY

$R2AccountId = $env:R2_ACCOUNT_ID

$R2Skip = $false

if (-not $R2AccessKeyId -or -not $R2SecretAccessKey -or -not $R2AccountId) {

    Write-Host "[!] R2 未配置，跳过 R2 上传（仍会上传到工单服务）" -ForegroundColor Yellow

    $R2Skip = $true

} else {

    Write-Host "[OK] R2 配置已验证" -ForegroundColor Green

}

Write-Host ""



# ========================================

# 检查 rclone

if (-not $R2Skip) {
# ========================================

Write-Host "[2/7] 检查 rclone..." -ForegroundColor Blue



# 优先检查项目目录下的 rclone.exe

$localRclone = Join-Path $ProjectDir "rclone.exe"

if (Test-Path $localRclone) {

    $rclonePath = $localRclone

    Write-Host "[OK] 使用项目目录 rclone.exe" -ForegroundColor Green

} else {

    # 检查系统 PATH

    $rclone = Get-Command rclone -ErrorAction SilentlyContinue

    if (-not $rclone) {

        Write-Host "[X] rclone 未找到" -ForegroundColor Red

        Write-Host "请将 rclone.exe 放到项目根目录，或添加到系统 PATH" -ForegroundColor Yellow

        Write-Host "下载地址: https://rclone.org/downloads/" -ForegroundColor Yellow

        throw "rclone 未找到"

    }

    $rclonePath = $rclone.Source

    Write-Host "[OK] 使用系统 rclone" -ForegroundColor Green

}



# 创建临时 rclone 配置 (凭证通过环境变量传递，更安全)

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



# 设置 rclone 环境变量 (避免在配置文件中存储明文凭证)

$env:RCLONE_CONFIG_R2_ACCESS_KEY_ID = $R2AccessKeyId

$env:RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = $R2SecretAccessKey



Write-Host ""

} # end of if (-not $R2Skip) — skip R2 rclone setup



# ========================================

# 物料完整性检查

# ========================================

Write-Host "[3/7] 物料完整性检查..." -ForegroundColor Blue

Write-Host ""



$TargetDir = Join-Path $BundleDir "x86_64-pc-windows-msvc\release\bundle\nsis"



# 查找文件

$NsisExe = Get-ChildItem -Path $TargetDir -Filter "*.exe" -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch "portable" } | Select-Object -First 1

$PortableZip = Get-ChildItem -Path $TargetDir -Filter "*portable*.zip" -ErrorAction SilentlyContinue | Select-Object -First 1

$UpdateZip = Get-ChildItem -Path $TargetDir -Filter "*.nsis.zip" -ErrorAction SilentlyContinue | Select-Object -First 1

$SigFile = Get-ChildItem -Path $TargetDir -Filter "*.nsis.zip.sig" -ErrorAction SilentlyContinue | Select-Object -First 1



Write-Host "  物料清单 - v$Version" -ForegroundColor Cyan

Write-Host "  -----------------------------------------"



if ($NsisExe) {

    Write-Host "    [OK] NSIS:    $($NsisExe.Name)" -ForegroundColor Green

}

else {

    Write-Host "    [X] NSIS:    缺失" -ForegroundColor Red

}



if ($PortableZip) {

    Write-Host "    [OK] ZIP:     $($PortableZip.Name) (本地保留，不上传)" -ForegroundColor Green

}

else {

    Write-Host "    [X] ZIP:     缺失" -ForegroundColor Yellow

}



if ($UpdateZip) {

    Write-Host "    [OK] 更新包:  $($UpdateZip.Name)" -ForegroundColor Green

}

else {

    Write-Host "    [X] 更新包:  缺失" -ForegroundColor Red

}



if ($SigFile) {

    Write-Host "    [OK] 签名:    $($SigFile.Name)" -ForegroundColor Green

}

else {

    Write-Host "    [X] 签名:    缺失" -ForegroundColor Yellow

}



Write-Host ""



# 检查关键文件

if (-not $NsisExe) {

    Write-Host "[X] NSIS 安装包缺失，无法继续" -ForegroundColor Red

    Write-Host "请先运行 .\scripts\build\build_windows.ps1 完成构建" -ForegroundColor Yellow

    throw "NSIS 安装包缺失"

}



if (-not $UpdateZip) {

    Write-Host "[!] 更新包缺失，自动更新将不可用" -ForegroundColor Yellow

    $continue = Read-Host "是否继续? (y/N)"

    if ($continue -ne "y" -and $continue -ne "Y") {

        Write-Host "发布已取消" -ForegroundColor Red

        throw "用户取消发布"

    }

}



Write-Host ""



# ========================================

# 生成更新清单

# ========================================

Write-Host "[4/7] 生成更新清单..." -ForegroundColor Blue



$ManifestDir = [System.IO.Path]::GetTempPath() + "zhishi-manifest-" + [System.Guid]::NewGuid().ToString("N")

$script:ManifestDir = $ManifestDir

New-Item -ItemType Directory -Path $ManifestDir -Force | Out-Null



$PubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")



# 读取签名

$Signature = ""

if ($SigFile) {

    $Signature = Get-Content $SigFile.FullName -Raw

    $Signature = $Signature.Trim()

}



# 生成 windows-x86_64.json

if ($UpdateZip) {

    $UpdateFileName = $UpdateZip.Name

    # 重命名上传文件名，添加版本和架构标识

    $UpdateUploadName = "ZhiShi_${Version}_x86_64.nsis.zip"



    $manifest = @{

        version   = $Version

        notes     = "ZhiShi v$Version"

        pub_date  = $PubDate

        signature = $Signature

        url       = "$DownloadBaseUrl/releases/v$Version/$UpdateUploadName"

    }



    # 添加下载链接

    $downloads = @{}

    if ($NsisExe) {

        $downloads["installer"] = "$DownloadBaseUrl/releases/v$Version/$($NsisExe.Name)"

    }

    if ($PortableZip) {

        $downloads["portable"] = "$DownloadBaseUrl/releases/v$Version/$($PortableZip.Name)"

    }

    if ($downloads.Count -gt 0) {

        $manifest["downloads"] = $downloads

    }



    $manifestJson = $manifest | ConvertTo-Json -Depth 5

    # 使用 .NET 写入无 BOM 的 UTF-8（PowerShell 5.x 的 -Encoding UTF8 会添加 BOM，导致 JSON 解析失败）

    [System.IO.File]::WriteAllText((Join-Path $ManifestDir "windows-x86_64.json"), $manifestJson, [System.Text.UTF8Encoding]::new($false))



    Write-Host "  [OK] windows-x86_64.json 已生成" -ForegroundColor Green



    if (-not $Signature) {

        Write-Host "  [!] 警告: 签名为空，自动更新将验证失败" -ForegroundColor Yellow

    }

}

else {

    Write-Host "  [!] 跳过更新清单生成 (无更新包)" -ForegroundColor Yellow

}



# 生成 latest_win.json (网站下载页 API)

# 注意：只发布 NSIS 安装包，便携版暂不对外发布

if ($NsisExe) {

    $latestWinDownloads = @{

        "win_x64" = @{

            name = "Windows x64"

            url  = "$DownloadBaseUrl/releases/v$Version/$($NsisExe.Name)"

        }

    }



    $latestWinManifest = @{

        version       = $Version

        pub_date      = $PubDate

        release_notes = "ZhiShi v$Version"

        downloads     = $latestWinDownloads

    }



    $latestWinJson = $latestWinManifest | ConvertTo-Json -Depth 5

    # 使用 .NET 写入无 BOM 的 UTF-8

    [System.IO.File]::WriteAllText((Join-Path $ManifestDir "latest_win.json"), $latestWinJson, [System.Text.UTF8Encoding]::new($false))



    Write-Host "  [OK] latest_win.json 已生成" -ForegroundColor Green

}



Write-Host ""



# ========================================

# 上传确认

# ========================================

Write-Host "[5/7] 上传前确认..." -ForegroundColor Blue

Write-Host ""

Write-Host "  即将上传的文件:" -ForegroundColor Cyan



$uploadFiles = @()

if ($NsisExe) {

    $size = "{0:N2} MB" -f ($NsisExe.Length / 1MB)

    Write-Host "    - $($NsisExe.Name) ($size)"

    $uploadFiles += $NsisExe

}

if ($UpdateZip) {

    $size = "{0:N2} MB" -f ($UpdateZip.Length / 1MB)

    Write-Host "    - $UpdateUploadName ($size)"

    $uploadFiles += $UpdateZip

}

if ($SigFile) {

    Write-Host "    - ZhiShi_${Version}_x86_64.nsis.zip.sig"

    $uploadFiles += $SigFile

}



Write-Host ""

Write-Host "  即将上传的清单:" -ForegroundColor Cyan

Write-Host "    - windows-x86_64.json (Tauri Updater)"

Write-Host "    - latest_win.json (网站下载 API)"

Write-Host ""

Write-Host "  目标位置:" -ForegroundColor Cyan

Write-Host "    - 文件: $DownloadBaseUrl/releases/v$Version/"

Write-Host "    - 清单: $DownloadBaseUrl/update/"

Write-Host ""



$confirm = Read-Host "确认上传? (Y/n)"

if ($confirm -eq "n" -or $confirm -eq "N") {

    Write-Host "发布已取消" -ForegroundColor Red

    throw "用户取消发布"

}



Write-Host ""



# ========================================

# 上传构建产物

if (-not $R2Skip) {
# ========================================

Write-Host "[6/7] 上传构建产物到 R2..." -ForegroundColor Blue



# 外部命令 (rclone/gh) 的 stderr 进度输出在 $ErrorActionPreference="Stop" 下

# 会被 PowerShell 当作终止性错误，导致脚本意外崩溃。

# 在外部命令执行区域统一放宽为 Continue，通过 $LASTEXITCODE 手动判断成败。

$prevEAP = $ErrorActionPreference

$ErrorActionPreference = "Continue"



$uploadSuccess = 0

$uploadFailed = 0



# 上传 NSIS 安装包

if ($NsisExe) {

    Write-Host "  上传 NSIS 安装包..." -ForegroundColor Cyan

    & $rclonePath --config=$rcloneConfig copy $NsisExe.FullName "r2:$R2Bucket/releases/v$Version/" --s3-no-check-bucket --progress

    if ($LASTEXITCODE -eq 0) {

        Write-Host "    [OK] $($NsisExe.Name)" -ForegroundColor Green

        $uploadSuccess++

    }

    else {

        Write-Host "    [X] NSIS 上传失败" -ForegroundColor Red

        $uploadFailed++

    }

}



# 便携版 ZIP 保留在本地构建产物，不再上传到服务器（官网只提供 NSIS 安装包）



# 上传更新包 (使用新文件名)

if ($UpdateZip) {

    Write-Host "  上传更新包..." -ForegroundColor Cyan

    & $rclonePath --config=$rcloneConfig copyto $UpdateZip.FullName "r2:$R2Bucket/releases/v$Version/$UpdateUploadName" --s3-no-check-bucket --progress

    if ($LASTEXITCODE -eq 0) {

        Write-Host "    [OK] $UpdateUploadName" -ForegroundColor Green

        $uploadSuccess++

    }

    else {

        Write-Host "    [X] 更新包上传失败" -ForegroundColor Red

        $uploadFailed++

    }

}



# 上传签名文件

if ($SigFile) {

    Write-Host "  上传签名文件..." -ForegroundColor Cyan

    $sigUploadName = "ZhiShi_${Version}_x86_64.nsis.zip.sig"

    & $rclonePath --config=$rcloneConfig copyto $SigFile.FullName "r2:$R2Bucket/releases/v$Version/$sigUploadName" --s3-no-check-bucket --progress

    if ($LASTEXITCODE -eq 0) {

        Write-Host "    [OK] $sigUploadName" -ForegroundColor Green

        $uploadSuccess++

    }

    else {

        Write-Host "    [X] 签名上传失败" -ForegroundColor Red

        $uploadFailed++

    }

}



Write-Host ""

Write-Host "  上传统计: 成功 $uploadSuccess / 失败 $uploadFailed" -ForegroundColor Cyan



if ($uploadFailed -gt 0) {

    Write-Host "[!] 部分文件上传失败!" -ForegroundColor Yellow

}



Write-Host ""



# ========================================

# 上传清单

# ========================================

Write-Host "[7/7] 上传更新清单..." -ForegroundColor Blue



& $rclonePath --config=$rcloneConfig copy "$ManifestDir/" "r2:$R2Bucket/update/" --s3-no-check-bucket --progress

if ($LASTEXITCODE -eq 0) {

    Write-Host "[OK] 清单已上传" -ForegroundColor Green

}

else {

    Write-Host "[X] 清单上传失败" -ForegroundColor Red

}



Write-Host ""



# ========================================

# 清除 CDN 缓存

# ========================================

$CfZoneId = $env:CF_ZONE_ID

$CfApiToken = $env:CF_API_TOKEN



if ($CfZoneId -and $CfApiToken) {

    Write-Host "清除 Cloudflare CDN 缓存..." -ForegroundColor Cyan



    $purgeUrls = @(

        "$DownloadBaseUrl/update/windows-x86_64.json",

        "$DownloadBaseUrl/update/latest_win.json"

    )



    if ($NsisExe) {

        $purgeUrls += "$DownloadBaseUrl/releases/v$Version/$($NsisExe.Name)"

    }
    if ($UpdateZip) {

        $purgeUrls += "$DownloadBaseUrl/releases/v$Version/$UpdateUploadName"

    }



    $purgeBody = @{ files = $purgeUrls } | ConvertTo-Json



    try {

        $response = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/zones/$CfZoneId/purge_cache" `

            -Method Post `

            -Headers @{ "Authorization" = "Bearer $CfApiToken"; "Content-Type" = "application/json" } `

            -Body $purgeBody



        if ($response.success) {

            Write-Host "  [OK] CDN 缓存已清除 ($($purgeUrls.Count) 个文件)" -ForegroundColor Green

        }

        else {

            Write-Host "  [!] CDN 缓存清除可能失败" -ForegroundColor Yellow

        }

    }

    catch {

        Write-Host "  [!] CDN 缓存清除请求失败: $_" -ForegroundColor Yellow

    }

}

else {

    Write-Host "[!] 未配置 CF_ZONE_ID 或 CF_API_TOKEN，跳过 CDN 缓存清除" -ForegroundColor Yellow

    Write-Host "    建议在 .env 中配置以确保更新立即生效" -ForegroundColor Yellow

}



Write-Host ""



# ========================================

# 上传到 GitHub Release (调用独立脚本)

# ========================================

Write-Host "上传到 GitHub Release..." -ForegroundColor Cyan



$ghScript = Join-Path $ProjectDir "scripts\release\upload_github_release_win.ps1"

try {

    & $ghScript

    Write-Host "  [OK] GitHub Release 上传完成" -ForegroundColor Green

} catch {

    Write-Host "  [!] GitHub Release 上传失败: $_" -ForegroundColor Yellow

    Write-Host "  [!] 可稍后运行 .\scripts\release\upload_github_release_win.ps1 重试" -ForegroundColor Yellow

}



# 恢复严格错误处理

$ErrorActionPreference = $prevEAP

} # end of if (-not $R2Skip) — skip R2 upload steps

# ========================================
# 上传到 ZhiShi 自有服务器 (ticket.zhishi.help)
# ========================================
Write-Host ""
Write-Host "[上传] 发布到 ZhiShi 自有服务器..." -ForegroundColor Blue

$TicketApiKey = $env:API_KEY
# Fallback: read from .env directly if env var is not set
if (-not $TicketApiKey -and (Test-Path $EnvFile)) {
    try {
        $envLine = Select-String -Path $EnvFile -Pattern '^API_KEY=(.+)$'
        if ($envLine) {
            $TicketApiKey = $envLine.Matches[0].Groups[1].Value
        }
    } catch {
        # silent fallback - continue without API key
    }
}
$TicketBaseUrl = $env:TICKET_BASE_URL
if (-not $TicketBaseUrl) {
    $TicketBaseUrl = "https://ticket.zhishi.help"
}

if (-not $TicketApiKey) {
    Write-Host "  [!] 跳过自有服务器上传 (未设置 API_KEY 环境变量)" -ForegroundColor Yellow
} else {
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"

    # 1) 上传 Tauri 自动更新产物 (nsis.zip + sig + manifest)
    if ($UpdateZip -and $SigFile) {
        Write-Host "  上传 Tauri 自动更新产物..." -ForegroundColor Cyan

        $manifestPath = Join-Path $ManifestDir "windows-x86_64.json"
        $UpdateUploadName = "ZhiShi_${Version}_x86_64.nsis.zip"
        $SigUploadName = "ZhiShi_${Version}_x86_64.nsis.zip.sig"

        $tempRespFile = [System.IO.Path]::GetTempFileName()
        $curlArgs = @(
            "-s", "-S",
            "-X", "POST",
            "${TicketBaseUrl}/api/v1/client-version/upload-update-artifacts",
            "-H", "X-API-Key: $TicketApiKey",
            "-F", "nsis_zip=@$($UpdateZip.FullName);filename=$UpdateUploadName",
            "-F", "nsis_sig=@$($SigFile.FullName);filename=$SigUploadName",
            "-F", "manifest_json=@$manifestPath;filename=windows-x86_64.json",
            "-F", "version=$Version",
            "-F", "minimum_version=0.2.30",
            "-F", "force_update_below=0.2.28",
            "-F", "release_date=$(Get-Date -Format 'yyyy-MM-dd')",
            "-F", "release_notes=ZhiShi v$Version",
            "-o", $tempRespFile,
            "-w", "%{http_code}"
        )
        $httpCode = & curl.exe @curlArgs
        if ($httpCode -eq 201 -or $httpCode -eq 200) {
            $TicketResp = Get-Content $tempRespFile -Raw | ConvertFrom-Json
            Write-Host "    [OK] 自动更新产物上传成功 (v$($TicketResp.version))" -ForegroundColor Green
        } else {
            $respBody = Get-Content $tempRespFile -Raw -ErrorAction SilentlyContinue
            Write-Host "    [X] 自动更新产物上传失败: HTTP $httpCode`n$respBody" -ForegroundColor Red
        }
        Remove-Item $tempRespFile -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "  [!] 跳过 Tauri 自动更新产物上传 (无 nsis.zip 或签名)" -ForegroundColor Yellow
    }

    # 2) 上传/同步 NSIS 安装包（供官网下载页使用）
    if ($NsisExe) {
        Write-Host "  上传 NSIS 安装包到服务器..." -ForegroundColor Cyan
        $tempRespFile = [System.IO.Path]::GetTempFileName()
        $curlArgs = @(
            "-s", "-S",
            "-X", "POST",
            "${TicketBaseUrl}/api/v1/client-version/upload-installer",
            "-H", "X-API-Key: $TicketApiKey",
            "-F", "file=@$($NsisExe.FullName)",
            "-F", "version=$Version",
            "-o", $tempRespFile,
            "-w", "%{http_code}"
        )
        $httpCode = & curl.exe @curlArgs
        if ($httpCode -eq 201 -or $httpCode -eq 200) {
            Write-Host "    [OK] NSIS 安装包上传成功" -ForegroundColor Green
        } else {
            $respBody = Get-Content $tempRespFile -Raw -ErrorAction SilentlyContinue
            Write-Host "    [X] NSIS 安装包上传失败: HTTP $httpCode`n$respBody" -ForegroundColor Red
        }
        Remove-Item $tempRespFile -Force -ErrorAction SilentlyContinue
    }

    $ErrorActionPreference = $prevEAP
}




Write-Host ""



# ========================================

# 清理临时文件

# ========================================

# 旧的单接口上传已在上方"上传到 ZhiShi 自有服务器"段处理，此处保留注释以避免重复调用。

# ========================================

Cleanup-TempFiles



# 标记发布成功

$PublishSuccess = $true



# ========================================

# 完成

# ========================================

Write-Host "=========================================" -ForegroundColor Green

Write-Host "  发布完成!" -ForegroundColor Green

Write-Host "=========================================" -ForegroundColor Green

Write-Host ""

Write-Host "  版本: v$Version" -ForegroundColor Cyan

Write-Host ""

Write-Host "  下载地址 (NSIS):" -ForegroundColor Blue

if ($NsisExe) {

    Write-Host "    $DownloadBaseUrl/releases/v$Version/$($NsisExe.Name)" -ForegroundColor Cyan

}

Write-Host ""

Write-Host ""

Write-Host "  自动更新清单 (Tauri Updater):" -ForegroundColor Blue

Write-Host "    $DownloadBaseUrl/update/windows-x86_64.json" -ForegroundColor Cyan

Write-Host ""

Write-Host "  网站下载 API:" -ForegroundColor Blue

Write-Host "    $DownloadBaseUrl/update/latest_win.json" -ForegroundColor Cyan

Write-Host ""

Write-Host "  验证命令:" -ForegroundColor Blue

Write-Host "    curl -s $DownloadBaseUrl/update/windows-x86_64.json | jq ." -ForegroundColor White

Write-Host "    curl -s $DownloadBaseUrl/update/latest_win.json | jq ." -ForegroundColor White

Write-Host ""



} catch {

    Write-Host ""

    Write-Host "=========================================" -ForegroundColor Red

    Write-Host "  发布失败!" -ForegroundColor Red

    Write-Host "=========================================" -ForegroundColor Red

    Write-Host ""

    Write-Host "错误: $_" -ForegroundColor Red

    Write-Host ""

    Cleanup-TempFiles

}



# ========================================

# 暂停退出 (防止窗口直接关闭)

# ========================================

Write-Host ""

if ($PublishSuccess) {

    Write-Host "按回车键退出..." -ForegroundColor Cyan

} else {

    Write-Host "按回车键退出..." -ForegroundColor Yellow

}

Read-Host

