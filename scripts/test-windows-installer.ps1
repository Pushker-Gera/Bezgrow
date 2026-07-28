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
$dataRoot = Join-Path $env:LOCALAPPDATA "Bezgrow"
$database = Join-Path $dataRoot "Database\bezgrow-offline.db"
$startupLog = Join-Path $dataRoot "Logs\bezgrow-startup.log"
$sentinel = Join-Path $dataRoot "update-preservation-test.txt"

function Assert-Path([string]$Path, [string]$Message) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$Message Missing path: $Path"
  }
}

function Wait-Until([scriptblock]$Condition, [int]$Seconds, [string]$Failure) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 250
  }
  throw $Failure
}

function Get-BezgrowNodeProcesses {
  return @(
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($installDirectory, [System.StringComparison]::OrdinalIgnoreCase)
      }
  )
}

function Invoke-Installer([string[]]$Arguments) {
  $process = Start-Process -FilePath $installer -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installer exited with code $($process.ExitCode)."
  }
}

function Invoke-AppLaunchCycle([int]$Cycle) {
  $beforeNodeIds = @(Get-BezgrowNodeProcesses | ForEach-Object { $_.ProcessId })
  $appProcess = Start-Process -FilePath $application -PassThru
  Wait-Until {
    -not $appProcess.HasExited -and
    (Test-Path -LiteralPath $startupLog) -and
    ((Get-Content -LiteralPath $startupLog -Raw) -match "Bundled Next server is ready on port")
  } 45 "Launch cycle $Cycle did not report a ready bundled server."

  if ($appProcess.HasExited) {
    throw "Launch cycle $Cycle exited before smoke verification."
  }
  $logText = Get-Content -LiteralPath $startupLog -Raw
  if ($logText -match "Startup failed before main window opened") {
    throw "Launch cycle $Cycle logged a fatal native startup error."
  }
  $portMatches = [regex]::Matches($logText, "Bundled Next server is ready on port (\d+)")
  if ($portMatches.Count -eq 0) {
    throw "Launch cycle $Cycle did not record its loopback port."
  }
  $port = [int]$portMatches[$portMatches.Count - 1].Groups[1].Value
  $response = Invoke-WebRequest `
    -Uri "http://127.0.0.1:$port/login" `
    -UseBasicParsing `
    -MaximumRedirection 0 `
    -SkipHttpErrorCheck
  if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 500) {
    throw "Launch cycle $Cycle local route returned HTTP $($response.StatusCode)."
  }

  Wait-Until {
    (Test-Path -LiteralPath $database) -and
    (Get-Item -LiteralPath $database).Length -gt 0
  } 30 "Launch cycle $Cycle did not create or reopen the authoritative SQLite database."

  if (-not $appProcess.CloseMainWindow()) {
    throw "Launch cycle $Cycle could not request a normal window close."
  }
  Wait-Until { $appProcess.HasExited } 20 "Launch cycle $Cycle did not exit after its normal close request."
  Wait-Until {
    $remaining = @(
      Get-BezgrowNodeProcesses |
        Where-Object { $beforeNodeIds -notcontains $_.ProcessId }
    )
    $remaining.Count -eq 0
  } 15 "Launch cycle $Cycle left an orphan bundled Node process."
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
Invoke-AppLaunchCycle 1
Invoke-AppLaunchCycle 2
Invoke-AppLaunchCycle 3

Invoke-Installer @("/S", "/UPDATE")
Assert-Path $sentinel "The update removed Bezgrow user data."
Assert-Path $database "The update removed the Bezgrow SQLite database."

$uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList @("/S") -Wait -PassThru
if ($uninstallProcess.ExitCode -ne 0) {
  throw "Uninstaller exited with code $($uninstallProcess.ExitCode)."
}
Assert-Path $sentinel "Uninstall removed Bezgrow user data."
Assert-Path $database "Uninstall removed the Bezgrow SQLite database."

Invoke-Installer @("/S")
Assert-Path $application "Reinstall did not restore the application."
Assert-Path $sentinel "Reinstall did not preserve Bezgrow user data."
Assert-Path $database "Reinstall did not preserve the Bezgrow SQLite database."
Invoke-AppLaunchCycle 4

Write-Host "windows-installer-smoke-ok cycles=4 route=ok sqlite=ok orphan_processes=0"
