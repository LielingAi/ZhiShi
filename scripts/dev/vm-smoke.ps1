# VM channel smoke (read-only): vmrun / Hyper-V availability and VM inventory.
#
# Why a separate script: VM support is a per-platform, per-hypervisor
# maintenance surface. Every release must confirm both channels still work.
# This script only probes (never starts or modifies a VM), so it is safe to
# run anywhere.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev/vm-smoke.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev/vm-smoke.ps1 -Strict
# -Strict: any installed hypervisor that fails a probe -> exit 1.
#
# ASCII-only on purpose: PowerShell 5.1 reads UTF-8 without BOM as ANSI.

param([switch]$Strict)

$ErrorActionPreference = 'SilentlyContinue'
$failures = 0

function Report([string]$name, [bool]$ok, [string]$detail) {
    if ($ok) {
        Write-Host ("  OK   {0}  {1}" -f $name, $detail) -ForegroundColor Green
    } else {
        Write-Host ("  MISS {0}  {1}" -f $name, $detail) -ForegroundColor Yellow
    }
}

Write-Host "VM channel smoke (read-only)" -ForegroundColor Cyan

# --- 1. vmrun (VMware Workstation / Fusion) -----------------------------
$vmrunPath = $null
$cmd = Get-Command vmrun -ErrorAction SilentlyContinue
if ($cmd) { $vmrunPath = $cmd.Source }
if (-not $vmrunPath) {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'VMware\VMware Workstation\vmrun.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'VMware\VMware Workstation\vmrun.exe'),
        (Join-Path $env:ProgramFiles 'VMware\VMware Fusion\Contents\Library\vmrun')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { $vmrunPath = $c; break }
    }
}
if ($vmrunPath) {
    $list = & $vmrunPath list 2>&1
    if ($LASTEXITCODE -eq 0) {
        $count = @($list | Where-Object { $_ -and ($_ -notmatch '^Total running VMs') }).Count
        Report 'vmrun' $true "$vmrunPath (running VMs: $count)"
    } else {
        $failures++
        Report 'vmrun' $false "$vmrunPath list failed: $($list | Select-Object -First 2)"
    }
} else {
    Report 'vmrun' $false 'not installed / not in PATH or default install paths'
}

# --- 2. Hyper-V (Windows hosts only) ------------------------------------
$hyperv = Get-Command Get-VM -ErrorAction SilentlyContinue
if ($hyperv) {
    $vms = @(Get-VM 2>&1)
    if ($?) {
        $running = @($vms | Where-Object { $_.State -eq 'Running' }).Count
        Report 'Hyper-V' $true ("VMs: {0} (running: {1})" -f $vms.Count, $running)
    } else {
        $failures++
        Report 'Hyper-V' $false 'Get-VM failed (needs admin rights / Hyper-V feature not enabled)'
    }
} else {
    # Hyper-V absent is a valid state, not a failure.
    Report 'Hyper-V' $false 'Hyper-V PowerShell module unavailable (not enabled or non-Windows)'
}

# --- 3. Cross-check: VM entries and their channels ---------------------
$configPath = Join-Path $env:USERPROFILE '.zhishi\config.json'
if (Test-Path $configPath) {
    try {
        $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
        $vmEntries = @($cfg.environments | Where-Object { $_.kind -eq 'vm' })
        Write-Host ("  INFO VM entries: {0}" -f $vmEntries.Count)
        foreach ($e in $vmEntries) {
            $channel = if ($e.address) { 'ssh' } else { 'guest(vmrun)' }
            Write-Host ("       - {0}  channel={1}  address={2}" -f $e.id, $channel, $e.address)
        }
    } catch {
        Write-Host "  INFO config.json parse failed (skip VM entry check)" -ForegroundColor Yellow
    }
}

if ($Strict -and $failures -gt 0) {
    Write-Host ""
    Write-Host "Strict mode: $failures failure(s)" -ForegroundColor Red
    exit 1
}
Write-Host ""
Write-Host "Done ($failures failure(s))"
exit 0
