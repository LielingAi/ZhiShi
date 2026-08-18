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

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro _ZHISHI_KILL_PROCESSES
  Delete "$INSTDIR\bun.exe"
!macroend