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
$diagnosticsRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  Join-Path $env:TEMP "bezgrow-installer-smoke"
} else {
  Join-Path $env:RUNNER_TEMP "bezgrow-installer-smoke"
}
$installedNode = Join-Path $installDirectory "node\node.exe"
$installedServer = Join-Path $installDirectory "next-server\server.js"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BezgrowWindowTest {
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsZoomed(IntPtr hWnd);
}
"@

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

function Get-ExternalBrowserProcessIds {
  return @(
    Get-Process -Name "chrome", "msedge", "firefox" -ErrorAction SilentlyContinue |
      ForEach-Object { $_.Id }
  )
}

function Test-BezgrowWindowControls([System.Diagnostics.Process]$ApplicationProcess, [int]$Cycle) {
  Wait-Until {
    $ApplicationProcess.Refresh()
    $ApplicationProcess.MainWindowHandle -ne [IntPtr]::Zero
  } 20 "Launch cycle $Cycle did not expose a native application window."

  $handle = $ApplicationProcess.MainWindowHandle
  [BezgrowWindowTest]::ShowWindowAsync($handle, 6) | Out-Null
  Wait-Until { [BezgrowWindowTest]::IsIconic($handle) } 10 "Launch cycle $Cycle could not minimize."
  [BezgrowWindowTest]::ShowWindowAsync($handle, 3) | Out-Null
  Wait-Until { [BezgrowWindowTest]::IsZoomed($handle) } 10 "Launch cycle $Cycle could not maximize."
  [BezgrowWindowTest]::ShowWindowAsync($handle, 9) | Out-Null
  Wait-Until {
    -not [BezgrowWindowTest]::IsIconic($handle) -and
    -not [BezgrowWindowTest]::IsZoomed($handle)
  } 10 "Launch cycle $Cycle could not restore."
}

function Invoke-Installer([string[]]$Arguments) {
  $process = Start-Process -FilePath $installer -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installer exited with code $($process.ExitCode)."
  }
}

function Write-SmokeDiagnostics(
  [string]$Reason,
  [System.Diagnostics.Process]$ApplicationProcess
) {
  New-Item -ItemType Directory -Force $diagnosticsRoot | Out-Null
  $status = @(
    "reason=$Reason"
    "application=$application"
    "applicationExists=$(Test-Path -LiteralPath $application)"
    "startupLog=$startupLog"
    "startupLogExists=$(Test-Path -LiteralPath $startupLog)"
    "localAppData=$env:LOCALAPPDATA"
    "appData=$env:APPDATA"
    "temp=$env:TEMP"
  )
  if ($ApplicationProcess) {
    $ApplicationProcess.Refresh()
    $status += "applicationPid=$($ApplicationProcess.Id)"
    $status += "applicationExited=$($ApplicationProcess.HasExited)"
    if ($ApplicationProcess.HasExited) {
      $status += "applicationExitCode=$($ApplicationProcess.ExitCode)"
    }
  }
  $status | Set-Content -LiteralPath (Join-Path $diagnosticsRoot "status.txt")

  if (Test-Path -LiteralPath $startupLog) {
    Copy-Item -LiteralPath $startupLog -Destination (Join-Path $diagnosticsRoot "bezgrow-startup.log") -Force
  }
  $temporaryLog = Join-Path $env:TEMP "Bezgrow\bezgrow-startup.log"
  if ((Test-Path -LiteralPath $temporaryLog) -and $temporaryLog -ne $startupLog) {
    Copy-Item -LiteralPath $temporaryLog -Destination (Join-Path $diagnosticsRoot "bezgrow-temporary-startup.log") -Force
  }

  Get-ChildItem -LiteralPath $installDirectory -Recurse -Force -ErrorAction SilentlyContinue |
    Select-Object FullName, Length, LastWriteTimeUtc |
    Format-Table -AutoSize |
    Out-String -Width 4096 |
    Set-Content -LiteralPath (Join-Path $diagnosticsRoot "installed-files.txt")

  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -in @("Bezgrow.exe", "node.exe") -or
      ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDirectory, [System.StringComparison]::OrdinalIgnoreCase))
    } |
    Select-Object Name, ProcessId, ParentProcessId, ExecutablePath, CommandLine |
    Format-List |
    Out-String -Width 4096 |
    Set-Content -LiteralPath (Join-Path $diagnosticsRoot "processes.txt")

  Get-WinEvent -FilterHashtable @{
    LogName = "Application"
    StartTime = (Get-Date).AddMinutes(-10)
  } -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProviderName -in @("Application Error", "Windows Error Reporting", ".NET Runtime") -or
      $_.Message -match "Bezgrow\.exe"
    } |
    Select-Object TimeCreated, ProviderName, Id, LevelDisplayName, Message |
    Format-List |
    Out-String -Width 4096 |
    Set-Content -LiteralPath (Join-Path $diagnosticsRoot "windows-application-events.txt")

  Write-Host "Bezgrow installer smoke diagnostics:"
  $status | ForEach-Object { Write-Host $_ }
  if (Test-Path -LiteralPath $startupLog) {
    Write-Host "Bezgrow startup log:"
    Get-Content -LiteralPath $startupLog -Tail 200 | ForEach-Object { Write-Host $_ }
  }
  Write-Host "Installed runtime roots:"
  Get-ChildItem -LiteralPath $installDirectory -Force -ErrorAction SilentlyContinue |
    Select-Object Name, Length, Mode |
    Format-Table -AutoSize |
    Out-String |
    Write-Host
}

function Invoke-AppLaunchCycle([int]$Cycle, [switch]$TestRuntimeRecovery) {
  $beforeNodeIds = @(Get-BezgrowNodeProcesses | ForEach-Object { $_.ProcessId })
  $beforeBrowserIds = @(Get-ExternalBrowserProcessIds)
  $initialLogLength = if (Test-Path -LiteralPath $startupLog) {
    (Get-Item -LiteralPath $startupLog).Length
  } else {
    0
  }
  $appProcess = Start-Process -FilePath $application -PassThru
  try {
    Wait-Until {
      if ($appProcess.HasExited -or -not (Test-Path -LiteralPath $startupLog)) {
        return $false
      }
      $currentLog = Get-Content -LiteralPath $startupLog -Raw
      $cycleLog = if ($currentLog.Length -gt $initialLogLength) {
        $currentLog.Substring($initialLogLength)
      } else {
        ""
      }
      if ($cycleLog -match "Startup failed before main window opened") {
        throw "Launch cycle $Cycle logged a fatal native startup error."
      }
      $cycleLog -match "Bundled Next server is ready on port"
    } 60 "Launch cycle $Cycle did not report a new ready bundled server."
  } catch {
    Write-SmokeDiagnostics "Launch cycle $Cycle failed readiness: $($_.Exception.Message)" $appProcess
    throw
  }

  if ($appProcess.HasExited) {
    Write-SmokeDiagnostics "Launch cycle $Cycle exited before smoke verification." $appProcess
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
  $health = Invoke-WebRequest `
    -Uri "http://127.0.0.1:$port/api/desktop-health" `
    -UseBasicParsing `
    -MaximumRedirection 0 `
    -SkipHttpErrorCheck
  if ($health.StatusCode -ne 200 -or $health.Content -notmatch '"runtime":"bezgrow-embedded"') {
    throw "Launch cycle $Cycle embedded health route did not return the expected Bezgrow runtime identity."
  }
  $response = Invoke-WebRequest `
    -Uri "http://127.0.0.1:$port/login" `
    -UseBasicParsing `
    -MaximumRedirection 0 `
    -SkipHttpErrorCheck
  if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 500) {
    throw "Launch cycle $Cycle local route returned HTTP $($response.StatusCode)."
  }
  $newBrowserIds = @(
    Get-ExternalBrowserProcessIds |
      Where-Object { $beforeBrowserIds -notcontains $_ }
  )
  if ($newBrowserIds.Count -gt 0) {
    throw "Launch cycle $Cycle opened an external browser process: $($newBrowserIds -join ', ')."
  }

  Wait-Until {
    (Test-Path -LiteralPath $database) -and
    (Get-Item -LiteralPath $database).Length -gt 0
  } 30 "Launch cycle $Cycle did not create or reopen the authoritative SQLite database."

  Test-BezgrowWindowControls $appProcess $Cycle

  if ($TestRuntimeRecovery) {
    $recoveryLogLength = (Get-Item -LiteralPath $startupLog).Length
    $bundledProcess = Get-BezgrowNodeProcesses |
      Where-Object { $beforeNodeIds -notcontains $_.ProcessId } |
      Select-Object -First 1
    if (-not $bundledProcess) {
      throw "Launch cycle $Cycle could not find the supervised bundled Node process."
    }
    Stop-Process -Id $bundledProcess.ProcessId -Force
    Wait-Until {
      $currentLog = Get-Content -LiteralPath $startupLog -Raw
      $recoveryLog = if ($currentLog.Length -gt $recoveryLogLength) {
        $currentLog.Substring($recoveryLogLength)
      } else {
        ""
      }
      $recoveryLog -match "Bundled runtime supervisor restored the ERP window"
    } 75 "Launch cycle $Cycle did not recover after the bundled runtime was terminated."
    Wait-Until {
      $replacement = @(
        Get-BezgrowNodeProcesses |
          Where-Object {
            $_.ProcessId -ne $bundledProcess.ProcessId -and
            $beforeNodeIds -notcontains $_.ProcessId
          }
      )
      $replacement.Count -eq 1
    } 20 "Launch cycle $Cycle did not replace the terminated bundled runtime cleanly."
    if ($appProcess.HasExited) {
      throw "Launch cycle $Cycle closed the desktop process during bundled runtime recovery."
    }
  }

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
Assert-Path $installedNode "Bundled Node runtime was not installed."
Assert-Path $installedServer "Bundled Next server was not installed."
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
Invoke-AppLaunchCycle 1 -TestRuntimeRecovery
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

Write-Host "windows-installer-smoke-ok cycles=4 health=ok route=ok sqlite=ok runtime_recovery=ok window_controls=ok external_browser=none orphan_processes=0"
