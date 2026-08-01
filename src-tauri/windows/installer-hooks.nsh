; Interactive installs keep Tauri's optional Finish-page desktop-shortcut
; choice. Silent `/S` installs have no Finish page, so create the shortcut for
; that mode only.
!macro NSIS_HOOK_POSTINSTALL
  IfSilent 0 bezgrow_interactive_install
  Call CreateOrUpdateDesktopShortcut
  bezgrow_interactive_install:
!macroend
