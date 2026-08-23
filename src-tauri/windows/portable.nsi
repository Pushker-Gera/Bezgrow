Unicode true
RequestExecutionLevel user
SilentInstall silent
SetCompressor /SOLID lzma
!include LogicLib.nsh
!include x64.nsh

Name "Bezgrow Portable"
OutFile "${OUTPUT_FILE}"
Icon "${ICON_FILE}"

Function .onInit
  ${IfNot} ${RunningX64}
    Goto bezgrow_unsupported_windows
  ${EndIf}

  ReadRegStr $R9 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ${If} $R9 == ""
    Goto bezgrow_unsupported_windows
  ${EndIf}
  IntCmpU $R9 17763 bezgrow_supported_windows bezgrow_unsupported_windows bezgrow_supported_windows

  bezgrow_unsupported_windows:
    SetErrorLevel 1150
    MessageBox MB_ICONSTOP|MB_OK "Bezgrow cannot run on this version of Windows.$\r$\n$\r$\nBezgrow requires 64-bit Windows 10 version 1809 or newer, or Windows 11. Please update Windows and try again." /SD IDOK
    Quit

  bezgrow_supported_windows:
FunctionEnd

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\Bezgrow"
  File /r "${APP_SOURCE}\*"
  ExecWait '"$PLUGINSDIR\Bezgrow\Bezgrow.exe"'
SectionEnd
