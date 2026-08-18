# embed-test-manifest.ps1 — 修复本机 cargo test 二进制无法启动的问题。
#
# 背景：lib 单测二进制不会链接 tauri-build 的 resource.lib（归档成员按需
# 拉取），缺少 comctl32 v6 清单（TaskDialogIndirect 无导出），进程启动即
# STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)。构建脚本的 rustc-link-arg 指令
# 覆盖不到 lib 单测目标，所以这里用 Windows SDK 的 mt.exe 事后把
# app.manifest（含 Common-Controls v6 依赖）嵌入每个测试二进制。幂等。
#
# 用法：cargo test 报 0xc0000139 时运行一次（新构建的测试二进制需重跑）：
#   powershell -File scripts/dev/embed-test-manifest.ps1

$ErrorActionPreference = 'Stop'
$srcTauri = Join-Path $PSScriptRoot '..\..\src-tauri'
$manifest = Join-Path $srcTauri 'app.manifest'
$deps = Join-Path $srcTauri 'target\debug\deps'

$mt = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\mt.exe' |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $mt) { Write-Error 'mt.exe not found (install Windows SDK)'; exit 1 }

$exes = Get-ChildItem $deps -Filter '*.exe' | Where-Object { $_.Name -notmatch '\.d\.exe$' }
$fixed = 0
foreach ($exe in $exes) {
  $bytes = [System.IO.File]::ReadAllBytes($exe.FullName)
  $text = [System.Text.Encoding]::ASCII.GetString($bytes)
  if ($text.Contains('Common-Controls')) { continue }  # 已嵌入
  & $mt.FullName -manifest $manifest "-outputresource:$($exe.FullName);1" | Out-Null
  if ($LASTEXITCODE -eq 0) { $fixed++; Write-Host "embedded: $($exe.Name)" }
}
Write-Host "done ($fixed embedded, $($exes.Count - $fixed) already ok)"
