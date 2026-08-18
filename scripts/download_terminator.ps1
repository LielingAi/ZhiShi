#Requires -Version 5.1

<#
.SYNOPSIS
    Fetch the terminator-mcp-agent (UIA desktop automation) binary from
    Cloudflare R2 and install it under src-tauri\binaries\ using Tauri's
    externalBin naming convention (binary-<target-triple>).

.DESCRIPTION
    Downloads terminator-mcp-agent-v{VERSION}-windows-x64.zip from
    https://download.zhishi.help/terminator/releases/v{VERSION}/, verifies
    SHA-256, and extracts terminator-mcp-agent.exe as
    terminator-mcp-agent-x86_64-pc-windows-msvc.exe.

    The binary is self-built from the ZhiShi fork of mediar-ai/terminator
    (includes the chcp stdout-pollution patch). The maintainer mirrors each
    build onto R2 (see scripts/build/publish_terminator_r2.ps1) so this
    script can pull artifacts over plain HTTPS without any auth.

    Terminator is Windows-only; there is no macOS/Linux artifact.

.EXAMPLE
    .\scripts\download_terminator.ps1                 # Latest version (reads R2 latest.json)
    .\scripts\download_terminator.ps1 -Version v0.24.32.1 # Pin a specific version
    .\scripts\download_terminator.ps1 -Force          # Re-download even if up-to-date
    .\scripts\download_terminator.ps1 -Clean          # Remove existing first
#>

[CmdletBinding()]
param(
    [string]$Version = "",
    [switch]$Force,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$DownloadBaseUrl  = "https://download.zhishi.help"
$LatestUrl        = "$DownloadBaseUrl/terminator/latest.json"
$ReleasesBaseUrl  = "$DownloadBaseUrl/terminator/releases"

$ScriptDir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir    = Split-Path -Parent $ScriptDir
$BinariesDir   = Join-Path $ProjectDir "src-tauri\binaries"
$VersionMarker = Join-Path $BinariesDir ".terminator-version"
$TargetTriple  = "x86_64-pc-windows-msvc"
$TargetBinary  = Join-Path $BinariesDir "terminator-mcp-agent-$TargetTriple.exe"

function Write-Info  { param($msg) Write-Host "[terminator] $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "[terminator] $msg" -ForegroundColor Green }
function Write-Warn2 { param($msg) Write-Host "[terminator] $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "[terminator] $msg" -ForegroundColor Red }

# ── Preflight ─────────────────────────────────────────────────────────────

# Force TLS 1.2 — Windows PowerShell 5.1 defaults to SSL3/TLS 1.0 which
# Cloudflare rejects. PS 7+ already negotiates TLS 1.2/1.3.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not (Test-Path $BinariesDir)) {
    New-Item -ItemType Directory -Path $BinariesDir -Force | Out-Null
}

# Sweep stale .tmp.<pid> orphans from prior runs killed mid-install.
Get-ChildItem $BinariesDir -Filter "terminator-mcp-agent-*.tmp.*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

if ($Clean) {
    Write-Info "Cleaning existing terminator binaries..."
    Get-ChildItem $BinariesDir -Filter "terminator-mcp-agent-*.exe" -ErrorAction SilentlyContinue | Remove-Item -Force
    if (Test-Path $VersionMarker) { Remove-Item $VersionMarker }
}

# ── Resolve version ───────────────────────────────────────────────────────

if (-not $Version) {
    Write-Info "Querying latest terminator version from $LatestUrl..."
    try {
        $latest = Invoke-RestMethod -Uri $LatestUrl -TimeoutSec 30 -ErrorAction Stop
        $Version = $latest.version
    } catch {
        Write-Err "Failed to fetch ${LatestUrl}: $($_.Exception.Message)"
        Write-Err "  Check network or pin -Version <tag>."
        exit 1
    }
    if (-not $Version) {
        Write-Err "Could not parse 'version' from latest.json"
        exit 1
    }
}
$Version = $Version.Trim()

# Defensive: reject unusual tag shapes before they flow into filenames and
# shell strings. Versions look like v0.24.32 or v0.24.32.1 (our patch suffix).
if ($Version -notmatch '^v?[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?(-[A-Za-z0-9.]+)?$') {
    Write-Err "Refusing unsafe version string: $Version"
    exit 1
}
if ($Version -notmatch '^v') { $Version = "v$Version" }

Write-Info "Target version: $Version"

# Short-circuit if already up-to-date AND the installed binary passes a
# PE-header smoke check.
if (-not $Force -and (Test-Path $VersionMarker)) {
    $current = (Get-Content $VersionMarker -Raw).Trim()
    if ($current -eq $Version -and (Test-Path $TargetBinary)) {
        $ok = $false
        try {
            $fs = [System.IO.File]::OpenRead($TargetBinary)
            $buf = New-Object byte[] 2
            $read = $fs.Read($buf, 0, 2)
            $fs.Close()
            if ($read -eq 2 -and $buf[0] -eq 0x4D -and $buf[1] -eq 0x5A) { $ok = $true }
        } catch { $ok = $false }
        if ($ok) {
            Write-Ok "terminator $Version already present, skipping download (use -Force to re-download)"
            exit 0
        }
        Write-Warn2 "Marker says $Version but binary is missing/corrupt - re-downloading"
    }
}

# ── Download ──────────────────────────────────────────────────────────────

$ArchiveName = "terminator-mcp-agent-${Version}-windows-x64.zip"
$ArchiveUrl  = "$ReleasesBaseUrl/$Version/$ArchiveName"
$ShaUrl      = "$ArchiveUrl.sha256"

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "zhishi-terminator-$(Get-Random)"
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null

try {
    $ArchivePath = Join-Path $TmpDir $ArchiveName
    $HashFile    = Join-Path $TmpDir "$ArchiveName.sha256"

    Write-Info "Downloading $ArchiveName + .sha256..."
    try {
        $oldProgress = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $ArchiveUrl -OutFile $ArchivePath -UseBasicParsing -TimeoutSec 300 -ErrorAction Stop
        Invoke-WebRequest -Uri $ShaUrl     -OutFile $HashFile    -UseBasicParsing -TimeoutSec 30  -ErrorAction Stop
    } catch {
        Write-Err "Download failed: $($_.Exception.Message)"
        Write-Err "  URL: $ArchiveUrl"
        Write-Err "  (Maintainer may have forgotten to run publish_terminator_r2.ps1 after the build.)"
        exit 1
    } finally {
        $ProgressPreference = $oldProgress
    }

    # ── Verify checksum ───────────────────────────────────────────────────
    Write-Info "Verifying SHA-256..."
    $expected = ((Get-Content $HashFile -Raw) -split '\s+')[0].Trim().ToLower()
    if ($expected -notmatch '^[a-f0-9]{64}$') {
        $preview = if ($expected.Length -gt 80) { $expected.Substring(0, 80) } else { $expected }
        Write-Err "Malformed .sha256 sidecar (expected 64 hex chars, got: '$preview')"
        exit 1
    }
    $actual = (Get-FileHash $ArchivePath -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) {
        Write-Err "SHA-256 mismatch!"
        Write-Err "  expected: $expected"
        Write-Err "  actual:   $actual"
        exit 1
    }
    Write-Ok "SHA-256 verified"

    # ── Extract and install ───────────────────────────────────────────────
    Write-Info "Extracting..."
    $ExtractDir = Join-Path $TmpDir "extract"
    Expand-Archive -Path $ArchivePath -DestinationPath $ExtractDir -Force

    $SrcBin = Join-Path $ExtractDir "terminator-mcp-agent.exe"
    if (-not (Test-Path $SrcBin)) {
        $SrcBin = Get-ChildItem $ExtractDir -Recurse -Filter "terminator-mcp-agent.exe" -File | Select-Object -First 1 -ExpandProperty FullName
        if (-not $SrcBin) {
            Write-Err "Archive does not contain terminator-mcp-agent.exe"
            exit 1
        }
    }

    # Sanity check: verify PE magic (MZ) before installing.
    try {
        $fs = [System.IO.File]::OpenRead($SrcBin)
        $buf = New-Object byte[] 2
        $read = $fs.Read($buf, 0, 2)
        $fs.Close()
        if ($read -ne 2 -or $buf[0] -ne 0x4D -or $buf[1] -ne 0x5A) {
            Write-Err "Downloaded binary is not a valid Windows PE executable"
            exit 1
        }
    } catch {
        Write-Err "Could not verify PE header on downloaded binary: $($_.Exception.Message)"
        exit 1
    }

    # Install atomically: copy to per-PID tmp next to the target, then move.
    $TmpTarget = "$TargetBinary.tmp.$PID"
    Copy-Item $SrcBin $TmpTarget -Force
    Move-Item -Path $TmpTarget -Destination $TargetBinary -Force

    Set-Content -Path $VersionMarker -Value $Version -NoNewline

    Write-Ok "terminator $Version installed:"
    Write-Ok "  $TargetBinary"

} finally {
    if (Test-Path $TmpDir) {
        Remove-Item $TmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
