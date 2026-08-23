# ZhiShi uninstaller: remove ~/.zhishi/bin from the user PATH (HKCU).
# ASCII-only file (PowerShell 5.1 reads UTF-8 without BOM as ANSI).
# The bin directory itself is left in place (user data retention).
$ErrorActionPreference = 'SilentlyContinue'

$bin = Join-Path $env:USERPROFILE '.zhishi\bin'
$binTrim = $bin.TrimEnd('\')

$p = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($p) {
  $entries = $p -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $binTrim) }
  $newPath = ($entries -join ';')
  if ($newPath -ne $p) {
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    if (-not ('Win32.Native' -as [type])) {
      Add-Type -Namespace Win32 -Name Native -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'
    }
    $result = [System.UIntPtr]::Zero
    [Win32.Native]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) | Out-Null
  }
}
Write-Host "zhishi CLI removed from user PATH"
