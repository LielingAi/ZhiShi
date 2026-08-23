!define _ZHISHI_HOOKS_INCLUDED 1

; ZhiShi NSIS Installer Hooks
; - PREINSTALL: Kill all ZhiShi processes before file replacement

; Shared cleanup logic - kill processes launched from install directory,
; plus orphan SDK/MCP processes that reference .zhishi in command line.
!macro _ZHISHI_KILL_PROCESSES
  DetailPrint "Cleaning up ZhiShi background processes..."

  nsExec::ExecToLog '"powershell" -NoProfile -Command "$$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -like \"$INSTDIR\*\" } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"'

  nsExec::ExecToLog '"powershell" -NoProfile -Command "$$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $$_.CommandLine -like \"*claude-agent-sdk*\" -and $$_.CommandLine -like \"*.zhishi*\" } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"'

  nsExec::ExecToLog '"powershell" -NoProfile -Command "$$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $$_.CommandLine -like \"*.zhishi\mcp\*\" } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"'

  Sleep 1500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro _ZHISHI_KILL_PROCESSES
  Delete "$INSTDIR\bun.exe"
!macroend

; 1.2.10 — zhishi CLI 入 PATH：安装即落 ~/.zhishi/bin 三件套（zhishi /
; zhishi.cmd / package.json，cmd 烘焙 bundled node 绝对路径），并把 bin
; 注册进用户 PATH（HKCU，去重 + WM_SETTINGCHANGE 广播）。脚本本体经
; bundle resources 随包安装到 $INSTDIR\nsis\（Windows 上资源落在安装
; 根目录,不是 resources\ 子目录;ASCII-only,PS5.1 无 BOM 兼容）。
!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog '"powershell" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\nsis\install-cli.ps1" "$INSTDIR"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro _ZHISHI_KILL_PROCESSES
  Delete "$INSTDIR\bun.exe"
  ; 1.2.10 — POSTUNINSTALL 时 $INSTDIR 文件可能已删,先把卸载脚本存到 TEMP。
  CopyFiles "$INSTDIR\nsis\uninstall-cli.ps1" "$TEMP\zhishi-uninstall-cli.ps1"
!macroend

; 1.2.10 — 卸载时移除用户 PATH 里的 ~/.zhishi/bin（bin 目录本体保留,
; 属用户数据）。
!macro NSIS_HOOK_POSTUNINSTALL
  nsExec::ExecToLog '"powershell" -NoProfile -ExecutionPolicy Bypass -File "$TEMP\zhishi-uninstall-cli.ps1"'
  Delete "$TEMP\zhishi-uninstall-cli.ps1"
!macroend