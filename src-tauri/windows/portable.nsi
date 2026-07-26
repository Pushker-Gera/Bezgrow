Unicode true
RequestExecutionLevel user
SilentInstall silent
SetCompressor /SOLID lzma

Name "Bezgrow Portable"
OutFile "${OUTPUT_FILE}"
Icon "${ICON_FILE}"

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\Bezgrow"
  File /r "${APP_SOURCE}\*"
  ExecWait '"$PLUGINSDIR\Bezgrow\Bezgrow.exe"'
SectionEnd
