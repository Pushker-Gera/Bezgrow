; Tauri creates the desktop shortcut from the Finish page during an
; interactive install. Calling the same idempotent helper here also creates it
; for silent `/S` installs, where the Finish page is intentionally skipped.
!macro NSIS_HOOK_POSTINSTALL
  Call CreateOrUpdateDesktopShortcut
!macroend
