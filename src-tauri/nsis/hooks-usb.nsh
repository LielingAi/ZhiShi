; ZhiShi NSIS Installer Hooks — USB Portable Edition
; Writes the `.data_mode` marker file so the app runs in portable mode.

; Shared cleanup logic — identical to hooks.nsh
!macro _ZHISHI_KILL_PROCESSES
  DetailPrint "Cleaning up ZhiShi background processes..."

  nsExec::ExecToLog 'powershell -NoProfile -Command "$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like \"$INSTDIR\*\" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"'

  nsExec::ExecToLog 'powershell -NoProfile -Command "$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \"*claude-agent-sdk*\" -and $_.CommandLine -like \"*.zhishi*\" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"'
  nsExec::ExecToLog 'powershell -NoProfile -Command "$ErrorActionPreference=\"SilentlyContinue\"; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \"*.zhishi\mcp\*\" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"'

  Sleep 1500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro _ZHISHI_KILL_PROCESSES

  Delete "$INSTDIR\bun.exe"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; USB portable mode: write the marker file next to the main binary
  FileOpen $0 "$INSTDIR\.data_mode" w
  FileWrite $0 "portable"
  FileClose $0

  !insertmacro _ZHISHI_KILL_PROCESSES

  Delete "$INSTDIR\bun.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove the portable marker on uninstall
  Delete "$INSTDIR\.data_mode"

  !insertmacro _ZHISHI_KILL_PROCESSES

  Delete "$INSTDIR\bun.exe"
!macroend
