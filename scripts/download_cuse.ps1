#Requires -Version 5.1

<#

.SYNOPSIS

    Fetch the latest cuse (computer-use MCP) binary from Cloudflare R2 and

    install it under src-tauri\binaries\ using Tauri's externalBin naming

    convention (binary-<target-triple>).



.DESCRIPTION

    Downloads cuse-v{VERSION}-windows-x64.zip from

    https://download.zhishi.help/cuse/releases/v{VERSION}/, verifies SHA-256,

    and extracts cuse.exe as cuse-x86_64-pc-windows-msvc.exe.



    Source of truth for cuse releases is GitHub

    (https://github.com/J0hnFFFF/ZhiShi-Cuse), but that repo is PRIVATE.

    The cuse maintainer mirrors each release onto R2 (see

    ZhiShi-Cuse/publish_r2.sh) so this script can pull artifacts over

    plain HTTPS without any auth — fork / contributor / public CI all work.



.EXAMPLE

    .\scripts\download_cuse.ps1                 # Latest version (reads R2 latest.json)

    .\scripts\download_cuse.ps1 -Version v0.2.0 # Pin a specific version

    .\scripts\download_cuse.ps1 -Force          # Re-download even if up-to-date

    .\scripts\download_cuse.ps1 -Clean          # Remove existing first

#>

[CmdletBinding()]

param(

    [string]$Version = "",

    [switch]$Force,

    [switch]$Clean

)



$ErrorActionPreference = 'Stop'



$DownloadBaseUrl  = "https://download.zhishi.help"

$LatestUrl        = "$DownloadBaseUrl/cuse/latest.json"

$ReleasesBaseUrl  = "$DownloadBaseUrl/cuse/releases"



$ScriptDir     = Split-Path -Parent $MyInvocation.MyCommand.Path

$ProjectDir    = Split-Path -Parent $ScriptDir

$BinariesDir   = Join-Path $ProjectDir "src-tauri\binaries"

$VersionMarker = Join-Path $BinariesDir ".cuse-version"

$TargetTriple  = "x86_64-pc-windows-msvc"

$TargetBinary  = Join-Path $BinariesDir "cuse-$TargetTriple.exe"



function Write-Info  { param($msg) Write-Host "[cuse] $msg" -ForegroundColor Cyan }

function Write-Ok    { param($msg) Write-Host "[cuse] $msg" -ForegroundColor Green }

function Write-Warn2 { param($msg) Write-Host "[cuse] $msg" -ForegroundColor Yellow }

function Write-Err   { param($msg) Write-Host "[cuse] $msg" -ForegroundColor Red }



# ── Preflight ─────────────────────────────────────────────────────────────



# Force TLS 1.2 — Windows PowerShell 5.1 defaults to SSL3/TLS 1.0 which

# Cloudflare rejects. PS 7+ already negotiates TLS 1.2/1.3 by default.

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12



if (-not (Test-Path $BinariesDir)) {

    New-Item -ItemType Directory -Path $BinariesDir -Force | Out-Null

}



# Sweep stale .tmp.<pid> orphans from prior runs killed mid-install.

# They're inert (Tauri externalBin matches exact filenames) but accumulate.

Get-ChildItem $BinariesDir -Filter "cuse-*.tmp.*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue



if ($Clean) {

    Write-Info "Cleaning existing cuse binaries..."

    Get-ChildItem $BinariesDir -Filter "cuse-*.exe" -ErrorAction SilentlyContinue | Remove-Item -Force

    if (Test-Path $VersionMarker) { Remove-Item $VersionMarker -Force }

}



# ── Resolve version ───────────────────────────────────────────────────────



if (-not $Version) {

    Write-Info "Querying latest cuse version from $LatestUrl..."

    try {

        # Invoke-RestMethod auto-parses JSON into a PSCustomObject.

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

# shell strings. Normal cuse tags are `vMAJOR.MINOR.PATCH[-PRERELEASE]`.

if ($Version -notmatch '^v?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$') {

    Write-Err "Refusing unsafe version string: $Version"

    exit 1

}



# Normalize to v-prefixed form for URL composition.

if ($Version -notmatch '^v') { $Version = "v$Version" }



Write-Info "Target version: $Version"



# Short-circuit if already up-to-date AND the installed binary passes a

# PE-header smoke check. A bare version-marker match is insufficient — a

# prior run killed mid-copy can leave the marker from an earlier success

# next to a truncated file.

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

            Write-Ok "cuse $Version already present, skipping download (use -Force to re-download)"

            exit 0

        }

        Write-Warn2 "Marker says $Version but binary is missing/corrupt - re-downloading"

    }

}



# ── Download ──────────────────────────────────────────────────────────────



$ArchiveName = "cuse-${Version}-windows-x64.zip"

$ArchiveUrl  = "$ReleasesBaseUrl/$Version/$ArchiveName"

$ShaUrl      = "$ArchiveUrl.sha256"



$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "zhishi-cuse-$(Get-Random)"

New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null



try {

    $ArchivePath = Join-Path $TmpDir $ArchiveName

    $HashFile    = Join-Path $TmpDir "$ArchiveName.sha256"



    Write-Info "Downloading $ArchiveName + .sha256..."

    try {

        # `Invoke-WebRequest` honors $ProgressPreference to silence the slow

        # Write-Progress UI on PS 5.1 (which is ~10x slower without this).

        $oldProgress = $ProgressPreference

        $ProgressPreference = 'SilentlyContinue'

        Invoke-WebRequest -Uri $ArchiveUrl -OutFile $ArchivePath -UseBasicParsing -TimeoutSec 300 -ErrorAction Stop

        Invoke-WebRequest -Uri $ShaUrl     -OutFile $HashFile    -UseBasicParsing -TimeoutSec 30  -ErrorAction Stop

    } catch {

        Write-Err "Download failed: $($_.Exception.Message)"

        Write-Err "  URL: $ArchiveUrl"

        Write-Err "  (Maintainer may have forgotten to run publish_r2.sh after the GH Release.)"

        exit 1

    } finally {

        $ProgressPreference = $oldProgress

    }



    # ── Verify checksum ───────────────────────────────────────────────────



    Write-Info "Verifying SHA-256..."

    $expected = ((Get-Content $HashFile -Raw) -split '\s+')[0].Trim().ToLower()

    # Defensive: a corrupt/empty .sha256 file silently turns into a "mismatch"

    # with a useless first token. Fail with a clear diagnostic instead.

    if ($expected -notmatch '^[a-f0-9]{64}$') {

        $preview = if ($expected.Length -gt 80) { $expected.Substring(0, 80) } else { $expected }

        Write-Err "Malformed .sha256 sidecar (expected 64 hex chars, got: '$preview')"

        exit 1

    }

    $actual   = (Get-FileHash $ArchivePath -Algorithm SHA256).Hash.ToLower()



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



    $SrcBin = Join-Path $ExtractDir "cuse.exe"

    if (-not (Test-Path $SrcBin)) {

        # Some zip layouts nest under a subdir — find it

        $SrcBin = Get-ChildItem $ExtractDir -Recurse -Filter "cuse.exe" -File | Select-Object -First 1 -ExpandProperty FullName

        if (-not $SrcBin) {

            Write-Err "Archive does not contain cuse.exe"

            exit 1

        }

    }



    # Sanity check: verify PE magic (MZ) before installing. If the archive

    # was corrupted or built with the wrong target, fail loudly here — the

    # short-circuit on the next run uses the same MZ check, so accepting a

    # bad binary now would just produce an infinite re-download loop.

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



    # Install atomically: copy to per-PID tmp next to the target on the

    # same filesystem, then Move-Item -Force into place. A kill between

    # copy and move leaves the old binary intact; a kill after move but

    # before marker write leaves a fresh binary with a stale marker —

    # next run's MZ-header check will either pass (fine) or fail (re-

    # download). Marker is written LAST so we never falsely report

    # up-to-date after an interrupted install.

    $TmpTarget = "$TargetBinary.tmp.$PID"

    Copy-Item $SrcBin $TmpTarget -Force

    Move-Item -Path $TmpTarget -Destination $TargetBinary -Force



    Set-Content -Path $VersionMarker -Value $Version -NoNewline



    Write-Ok "cuse $Version installed:"

    Write-Ok "  $TargetBinary"

} finally {

    if (Test-Path $TmpDir) {

        Remove-Item $TmpDir -Recurse -Force -ErrorAction SilentlyContinue

    }

}

