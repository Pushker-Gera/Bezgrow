param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

$ErrorActionPreference = "Stop"
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$installDirectory = Join-Path $env:ProgramFiles "Bezgrow"
$application = Join-Path $installDirectory "Bezgrow.exe"
$uninstaller = Join-Path $installDirectory "uninstall.exe"
$desktopShortcut = Join-Path ([Environment]::GetFolderPath("CommonDesktopDirectory")) "Bezgrow.lnk"
$startMenuShortcut = Join-Path ([Environment]::GetFolderPath("CommonPrograms")) "Bezgrow\Bezgrow.lnk"
$dataRoot = Join-Path $env:APPDATA "Bezgrow"
$sentinel = Join-Path $dataRoot "update-preservation-test.txt"

function Assert-Path([string]$Path, [string]$Message) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$Message Missing path: $Path"
  }
}

function Invoke-Installer([string[]]$Arguments) {
  $process = Start-Process -FilePath $installer -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installer exited with code $($process.ExitCode)."
  }
}

Invoke-Installer @("/S")
Assert-Path $application "Program Files application was not installed."
Assert-Path $uninstaller "Uninstaller was not registered."
Assert-Path $desktopShortcut "The all-users desktop shortcut was not created."
Assert-Path $startMenuShortcut "The Start Menu shortcut was not created."

$uninstallEntry = Get-ChildItem `
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall", `
  "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall" `
  -ErrorAction SilentlyContinue |
  Get-ItemProperty |
  Where-Object { $_.DisplayName -eq "Bezgrow" } |
  Select-Object -First 1
if (-not $uninstallEntry) {
  throw "Bezgrow is missing from Add/Remove Programs."
}

New-Item -ItemType Directory -Force $dataRoot | Out-Null
Set-Content -LiteralPath $sentinel -Value "preserve-across-update-and-uninstall" -Encoding UTF8

# Installing the same signed package exercises the update path. The managed
# data root must never be part of the installer payload or uninstall manifest.
Invoke-Installer @("/S", "/UPDATE")
Assert-Path $sentinel "The update removed Bezgrow user data."

$uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList @("/S") -Wait -PassThru
if ($uninstallProcess.ExitCode -ne 0) {
  throw "Uninstaller exited with code $($uninstallProcess.ExitCode)."
}
Assert-Path $sentinel "Uninstall removed Bezgrow user data."

Invoke-Installer @("/S")
Assert-Path $application "Reinstall did not restore the application."
Assert-Path $sentinel "Reinstall did not preserve Bezgrow user data."

Write-Host "windows-installer-contract-ok"
