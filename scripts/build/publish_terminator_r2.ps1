#Requires -Version 5.1

<#
.SYNOPSIS
    Build terminator-mcp-agent from the ZhiShi fork clone and produce the
    R2 publish artifacts (zip + .sha256 + latest.json), optionally uploading.

.DESCRIPTION
    Maintainer-side script (the counterpart of scripts/download_terminator.ps1).

    1. Builds terminator-mcp-agent from a local clone of the ZhiShi fork of
       mediar-ai/terminator (which carries our chcp stdout-pollution patch).
    2. Packages target\release\terminator-mcp-agent.exe as
       terminator-mcp-agent-v{VERSION}-windows-x64.zip + .sha256.
    3. Writes latest.json.
    4. With -Upload, mirrors the artifacts to R2 (needs R2_ACCESS_KEY_ID /
       R2_SECRET_ACCESS_KEY / R2_ACCOUNT_ID in the repo-root .env, and rclone
       or aws CLI on PATH — same channel as publish_release.sh).

    Version scheme: v{upstream}.{patch}, e.g. upstream 0.24.32 + our patch 1
    => v0.24.32.1. Bump the patch number every time the fork changes.

.EXAMPLE
    .\scripts\build\publish_terminator_r2.ps1 -SourceDir E:\code\u-disk\terminator -Version v0.24.32.1
    .\scripts\build\publish_terminator_r2.ps1 -SourceDir E:\code\u-disk\terminator -Version v0.24.32.1 -Upload
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceDir,

    [Parameter(Mandatory = $true)]
    [string]$Version,

    [string]$OutDir = "",

    [switch]$Upload
)

$ErrorActionPreference = 'Stop'

function Write-Info { param($msg) Write-Host "[publish-terminator] $msg" -ForegroundColor Cyan }
function Write-Ok   { param($msg) Write-Host "[publish-terminator] $msg" -ForegroundColor Green }
function Write-Err  { param($msg) Write-Host "[publish-terminator] $msg" -ForegroundColor Red }

if ($Version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?$') {
    Write-Err "Version must look like v0.24.32.1 (upstream.patch)"
    exit 1
}

if (-not $OutDir) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $OutDir = Join-Path (Split-Path -Parent $ScriptDir) "output\terminator-r2"
}
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

# ── Build ─────────────────────────────────────────────────────────────────

Write-Info "Building terminator-mcp-agent (release) from $SourceDir ..."
Push-Location $SourceDir
try {
    cargo build --release -p terminator-mcp-agent --bin terminator-mcp-agent
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }
} finally {
    Pop-Location
}

$Bin = Join-Path $SourceDir "target\release\terminator-mcp-agent.exe"
if (-not (Test-Path $Bin)) {
    Write-Err "Built binary not found: $Bin"
    exit 1
}

# ── Package ───────────────────────────────────────────────────────────────

$ArchiveName = "terminator-mcp-agent-${Version}-windows-x64.zip"
$Stage = Join-Path $OutDir "stage"
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Path $Stage | Out-Null
Copy-Item $Bin (Join-Path $Stage "terminator-mcp-agent.exe")

$ArchivePath = Join-Path $OutDir $ArchiveName
if (Test-Path $ArchivePath) { Remove-Item $ArchivePath }
Compress-Archive -Path (Join-Path $Stage "terminator-mcp-agent.exe") -DestinationPath $ArchivePath
Remove-Item -Recurse -Force $Stage

$Hash = (Get-FileHash $ArchivePath -Algorithm SHA256).Hash.ToLower()
Set-Content -Path "$ArchivePath.sha256" -Value "$Hash  $ArchiveName" -NoNewline

$LatestPath = Join-Path $OutDir "latest.json"
@{ version = $Version } | ConvertTo-Json | Set-Content $LatestPath -NoNewline

Write-Ok "Artifacts ready in $OutDir :"
Write-Ok "  $ArchiveName"
Write-Ok "  $ArchiveName.sha256"
Write-Ok "  latest.json"

# ── Upload (optional) ─────────────────────────────────────────────────────

if (-not $Upload) {
    Write-Info "Skipping upload (pass -Upload to mirror to R2)."
    Write-Info "R2 target layout:"
    Write-Info "  terminator/releases/$Version/$ArchiveName(.sha256)"
    Write-Info "  terminator/latest.json"
    exit 0
}

# Load R2 credentials from repo-root .env (same names as publish_release.sh).
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path (Split-Path -Parent $ScriptDir) ".env"
$R2 = @{}
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^(R2_[A-Z_]+)=(.*)$') { $R2[$Matches[1]] = $Matches[2] }
    }
}
foreach ($k in @('R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID')) {
    if (-not $R2[$k]) { Write-Err "Missing $k in .env (required for -Upload)"; exit 1 }
}

$Bucket = if ($R2['R2_BUCKET']) { $R2['R2_BUCKET'] } else { 'zhishi-download' }
$Prefix = "terminator/releases/$Version"

if (Get-Command rclone -ErrorAction SilentlyContinue) {
    $env:RCLONE_CONFIG_R2_TYPE = 's3'
    $env:RCLONE_CONFIG_R2_PROVIDER = 'Cloudflare'
    $env:RCLONE_CONFIG_R2_ACCESS_KEY_ID = $R2['R2_ACCESS_KEY_ID']
    $env:RCLONE_CONFIG_R2_SECRET_ACCESS_KEY = $R2['R2_SECRET_ACCESS_KEY']
    $env:RCLONE_CONFIG_R2_ENDPOINT = "https://$($R2['R2_ACCOUNT_ID']).r2.cloudflarestorage.com"
    rclone copy $ArchivePath "r2:$Bucket/$Prefix/"
    rclone copy "$ArchivePath.sha256" "r2:$Bucket/$Prefix/"
    rclone copy $LatestPath "r2:$Bucket/terminator/"
} elseif (Get-Command aws -ErrorAction SilentlyContinue) {
    $env:AWS_ACCESS_KEY_ID = $R2['R2_ACCESS_KEY_ID']
    $env:AWS_SECRET_ACCESS_KEY = $R2['R2_SECRET_ACCESS_KEY']
    $Endpoint = "https://$($R2['R2_ACCOUNT_ID']).r2.cloudflarestorage.com"
    aws s3 cp $ArchivePath "s3://$Bucket/$Prefix/$ArchiveName" --endpoint-url $Endpoint
    aws s3 cp "$ArchivePath.sha256" "s3://$Bucket/$Prefix/$ArchiveName.sha256" --endpoint-url $Endpoint
    aws s3 cp $LatestPath "s3://$Bucket/terminator/latest.json" --endpoint-url $Endpoint
} else {
    Write-Err "Neither rclone nor aws CLI found on PATH; cannot upload."
    exit 1
}

Write-Ok "Uploaded to R2: $Bucket/$Prefix/"
Write-Ok "latest.json updated to $Version"
