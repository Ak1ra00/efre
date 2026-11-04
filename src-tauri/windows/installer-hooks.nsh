; efre: hooks for tauri-bundler's NSIS installer template (tauri.conf.json:
; bundle > windows > nsis > installerHooks). See docs/ARCHITECTURE.md section 9.
;
; The per-user template installs to $LOCALAPPDATA\<productName>, which for efre is the
; vault folder. These hooks install to $LOCALAPPDATA\Programs\efre instead, the Windows
; folder for per-user programs, so the program and the vault never share a folder. The
; uninstaller then only ever works in $LOCALAPPDATA\Programs\efre.
;
; The template includes this file before it defines PRODUCTNAME, so "efre" is spelled out.
; Keep this file ASCII: makensis reads it as UTF-8.

!define EFRE_VAULT_DIR "$LOCALAPPDATA\efre"
!define EFRE_INSTALL_DIR "$LOCALAPPDATA\Programs\efre"

; Interactive and passive installs. The template's .onInit has chosen $INSTDIR (the
; default, the previous install location, or /D=). Modern UI calls this from .onGUIInit,
; before the directory page shows $INSTDIR.
!define MUI_CUSTOMFUNCTION_GUIINIT EfreKeepOutOfVaultFolder
Function EfreKeepOutOfVaultFolder
  ${If} $INSTDIR == "${EFRE_VAULT_DIR}"
    StrCpy $INSTDIR "${EFRE_INSTALL_DIR}"
  ${EndIf}
FunctionEnd

; Every install, before any file is copied. This covers silent installs (they never run
; .onGUIInit) and the vault folder typed into the directory page.
!macro NSIS_HOOK_PREINSTALL
  ${If} $INSTDIR == "${EFRE_VAULT_DIR}"
    StrCpy $INSTDIR "${EFRE_INSTALL_DIR}"
    SetOutPath $INSTDIR
  ${EndIf}
!macroend

; Moving from an earlier build that installed into the vault folder: delete exactly that
; build's two program files there and point its desktop shortcut at the new copy. Nothing
; else in the vault folder is touched. A file still in use stays; the next install retries.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $INSTDIR != "${EFRE_VAULT_DIR}"
    Delete "${EFRE_VAULT_DIR}\efre.exe"
    Delete "${EFRE_VAULT_DIR}\uninstall.exe"
    !insertmacro IsShortcutTarget "$DESKTOP\efre.lnk" "${EFRE_VAULT_DIR}\efre.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro SetShortcutTarget "$DESKTOP\efre.lnk" "$INSTDIR\efre.exe"
    ${EndIf}
  ${EndIf}
!macroend

; efre adds itself to the per-user Windows Error Reporting exclusion list on every start
; (WerAddExcludedApplication). Remove that value, unless this uninstall is part of an update.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\Windows Error Reporting\ExcludedApplications" "efre.exe"
  ${EndIf}
!macroend
