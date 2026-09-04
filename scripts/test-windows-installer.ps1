param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [string]$PreviousInstallerPath = "",
  [string]$PreviousVersion = "",
  [string]$ExpectedVersion = "",
  [string]$ExpectedCommit = ""
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
$runtimeState = Join-Path $dataRoot "Runtime\runtime.json"
$sentinel = Join-Path $dataRoot "update-preservation-test.txt"
$diagnosticsRoot = if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
  Join-Path $env:TEMP "bezgrow-installer-smoke"
} else {
  Join-Path $env:RUNNER_TEMP "bezgrow-installer-smoke"
}
$installedNode = Join-Path $installDirectory "node\node.exe"
$installedServer = Join-Path $installDirectory "next-server\server.js"
$installedBuildIdentity = Join-Path $installDirectory "next-server\public\desktop-build.json"
$installedSqliteTest = Join-Path $PSScriptRoot "test-windows-installed-sqlite.mjs"
$offlineFirewallRules = @(
  "BezgrowReleaseSmokeApplication",
  "BezgrowReleaseSmokeRuntime"
)

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

function Get-BezgrowProcessTree([int]$RootProcessId) {
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($RootProcessId)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($process in $all) {
      if ($ids.Contains([int]$process.ParentProcessId) -and $ids.Add([int]$process.ProcessId)) {
        $changed = $true
      }
    }
  }
  return @($all | Where-Object { $ids.Contains([int]$_.ProcessId) })
}

function Assert-NoVisibleConsoleProcess([System.Diagnostics.Process]$ApplicationProcess, [int]$Cycle) {
  $tree = @(Get-BezgrowProcessTree $ApplicationProcess.Id)
  $visibleConsoles = @(
    $tree |
      Where-Object { $_.Name -in @("cmd.exe", "powershell.exe", "pwsh.exe", "conhost.exe", "WindowsTerminal.exe") } |
      ForEach-Object {
        $process = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        if ($process -and $process.MainWindowHandle -ne [IntPtr]::Zero) { $_ }
      }
  )
  if ($visibleConsoles.Count -gt 0) {
    throw "Launch cycle $Cycle exposed a visible console/terminal window: $($visibleConsoles.Name -join ', ')."
  }
  foreach ($node in @(Get-BezgrowNodeProcesses)) {
    $process = Get-Process -Id $node.ProcessId -ErrorAction SilentlyContinue
    if ($process -and $process.MainWindowHandle -ne [IntPtr]::Zero) {
      throw "Launch cycle $Cycle exposed a visible bundled Node window."
    }
  }
}

function Start-Bezgrow([string]$LaunchPath) {
  if (-not $LaunchPath.ToLowerInvariant().EndsWith(".lnk")) {
    return Start-Process -FilePath $LaunchPath -PassThru
  }
  $before = @(Get-Process -Name "Bezgrow" -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  Start-Process -FilePath $LaunchPath | Out-Null
  Wait-Until {
    $candidate = Get-Process -Name "Bezgrow" -ErrorAction SilentlyContinue |
      Where-Object { $before -notcontains $_.Id } |
      Select-Object -First 1
    $null -ne $candidate
  } 20 "Shortcut launch did not start Bezgrow."
  return Get-Process -Name "Bezgrow" -ErrorAction SilentlyContinue |
    Where-Object { $before -notcontains $_.Id } |
    Select-Object -First 1
}

function Get-ExternalBrowserProcessIds {
  return @(
    Get-Process -Name "chrome", "msedge", "firefox" -ErrorAction SilentlyContinue |
      ForEach-Object { $_.Id }
  )
}

function Remove-BezgrowOfflineRules {
  foreach ($ruleName in $offlineFirewallRules) {
    Remove-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
  }
}

function Enable-BezgrowOfflineMode {
  Remove-BezgrowOfflineRules
  New-NetFirewallRule `
    -Name $offlineFirewallRules[0] `
    -DisplayName "Bezgrow release smoke - block app internet" `
    -Direction Outbound `
    -Action Block `
    -Program $application `
    -RemoteAddress Internet `
    -Profile Any | Out-Null
  New-NetFirewallRule `
    -Name $offlineFirewallRules[1] `
    -DisplayName "Bezgrow release smoke - block bundled runtime internet" `
    -Direction Outbound `
    -Action Block `
    -Program $installedNode `
    -RemoteAddress Internet `
    -Profile Any | Out-Null

  & $installedNode -e "fetch('https://www.bezgrow.com', { signal: AbortSignal.timeout(5000) }).then(() => process.exit(42)).catch(() => process.exit(0))"
  if ($LASTEXITCODE -ne 0) {
    throw "The bundled runtime could still reach the public internet during the offline test."
  }
}

function Invoke-InstalledSqliteCrud([string]$Mode, [string]$ExpectedSchema = "") {
  Assert-Path $installedSqliteTest "Installed SQLite CRUD test script is missing."
  $arguments = @(
    "--disable-warning=ExperimentalWarning",
    $installedSqliteTest,
    "--database", $database,
    "--mode", $Mode
  )
  if (-not [string]::IsNullOrWhiteSpace($ExpectedSchema)) {
    $arguments += @("--expected-schema", $ExpectedSchema)
  }
  & $installedNode $arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Installed SQLite CRUD verification failed in $Mode mode."
  }
}

function Get-InstalledSchemaVersion {
  if (-not (Test-Path -LiteralPath $database) -or -not (Test-Path -LiteralPath $installedNode)) {
    return 0
  }
  $schema = & $installedNode `
    --disable-warning=ExperimentalWarning `
    -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); console.log(db.prepare('PRAGMA user_version').get().user_version); db.close();" `
    $database `
    2>$null
  if ($LASTEXITCODE -ne 0 -or "$schema" -notmatch '^\d+$') {
    return 0
  }
  return [int]"$schema"
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

function Invoke-InstallerAt([string]$InstallerFile, [string[]]$Arguments) {
  $process = Start-Process -FilePath $InstallerFile -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "Installer exited with code $($process.ExitCode)."
  }
}

function Invoke-Installer([string[]]$Arguments) {
  Invoke-InstallerAt $installer $Arguments
}

function Assert-InstalledBuildIdentity([string]$Version, [string]$Commit = "") {
  Assert-Path $installedBuildIdentity "Installed build identity is missing."
  $identity = Get-Content -Raw -LiteralPath $installedBuildIdentity | ConvertFrom-Json
  if (-not [string]::IsNullOrWhiteSpace($Version) -and $identity.applicationVersion -ne $Version) {
    throw "Installed app reports version $($identity.applicationVersion) instead of $Version."
  }
  if (-not [string]::IsNullOrWhiteSpace($Commit) -and $identity.gitCommit -ne $Commit) {
    throw "Installed app reports build $($identity.gitCommit) instead of $Commit."
  }
  if ([string]::IsNullOrWhiteSpace($identity.gitCommit) -or [string]::IsNullOrWhiteSpace($identity.builtAt)) {
    throw "Installed app build identity is incomplete."
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

function Invoke-AppLaunchCycle(
  [int]$Cycle,
  [string]$LaunchPath = $application,
  [int]$ExpectedSchema = 0,
  [switch]$TestRuntimeRecovery,
  [switch]$TestWindowControls
) {
  $beforeNodeIds = @(Get-BezgrowNodeProcesses | ForEach-Object { $_.ProcessId })
  $beforeBrowserIds = @(Get-ExternalBrowserProcessIds)
  $initialLogLength = if (Test-Path -LiteralPath $startupLog) {
    (Get-Item -LiteralPath $startupLog).Length
  } else {
    0
  }
  $appProcess = Start-Bezgrow $LaunchPath
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
      $cycleLog -match "Bundled Next server authenticated and ready"
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
  Assert-Path $runtimeState "Launch cycle $Cycle did not persist authoritative runtime ownership."
  $runtime = Get-Content -LiteralPath $runtimeState -Raw | ConvertFrom-Json
  $port = [int]$runtime.port
  if ($port -ne 43124) {
    throw "Launch cycle $Cycle used unexpected fallback port $port instead of the fixed packaged port 43124."
  }
  if ([int]$runtime.shellPid -ne $appProcess.Id -or [string]::IsNullOrWhiteSpace($runtime.token)) {
    throw "Launch cycle $Cycle runtime ownership did not match the active Bezgrow shell."
  }
  Assert-NoVisibleConsoleProcess $appProcess $Cycle
  $health = Invoke-WebRequest `
    -Uri "http://127.0.0.1:$port/api/desktop-health" `
    -Headers @{ "X-Bezgrow-Runtime-Token" = $runtime.token } `
    -UseBasicParsing `
    -MaximumRedirection 0 `
    -SkipHttpErrorCheck
  if ($health.StatusCode -ne 200 -or $health.Content -notmatch '"runtime":"bezgrow-embedded"') {
    throw "Launch cycle $Cycle embedded health route did not return the expected Bezgrow runtime identity."
  }
  $unauthenticatedHealth = Invoke-WebRequest `
    -Uri "http://127.0.0.1:$port/api/desktop-health" `
    -UseBasicParsing `
    -MaximumRedirection 0 `
    -SkipHttpErrorCheck
  if ($unauthenticatedHealth.StatusCode -ne 404) {
    throw "Launch cycle $Cycle exposed an unauthenticated desktop health endpoint."
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

  if ($ExpectedSchema -gt 0) {
    Wait-Until {
      (Get-InstalledSchemaVersion) -eq $ExpectedSchema
    } 45 "Launch cycle $Cycle did not finish migrating the authoritative SQLite database to schema $ExpectedSchema."
  }

  if ($TestWindowControls) {
    Test-BezgrowWindowControls $appProcess $Cycle
  }

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

try {
$previousInstaller = if ([string]::IsNullOrWhiteSpace($PreviousInstallerPath)) { "" } else { (Resolve-Path -LiteralPath $PreviousInstallerPath).Path }
$initialInstaller = if ([string]::IsNullOrWhiteSpace($previousInstaller)) { $installer } else { $previousInstaller }
Invoke-InstallerAt $initialInstaller @("/S")
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
Invoke-AppLaunchCycle 1 -TestRuntimeRecovery -TestWindowControls
Invoke-InstalledSqliteCrud "seed"
if (-not [string]::IsNullOrWhiteSpace($previousInstaller)) {
  Assert-InstalledBuildIdentity $PreviousVersion
  Invoke-Installer @("/S", "/UPDATE")
  Assert-Path $sentinel "The in-place upgrade removed Bezgrow user data."
  Assert-Path $database "The in-place upgrade removed the Bezgrow SQLite database."
  Invoke-InstalledSqliteCrud "verify"
  Assert-InstalledBuildIdentity $ExpectedVersion $ExpectedCommit
}
Invoke-AppLaunchCycle 2 -LaunchPath $startMenuShortcut -ExpectedSchema 19
Invoke-InstalledSqliteCrud "verify" "19"

try {
  Enable-BezgrowOfflineMode
  Invoke-AppLaunchCycle 3 -ExpectedSchema 19
  Invoke-InstalledSqliteCrud "verify" "19"
} finally {
  Remove-BezgrowOfflineRules
}

Invoke-Installer @("/S", "/UPDATE")
Assert-Path $sentinel "The update removed Bezgrow user data."
Assert-Path $database "The update removed the Bezgrow SQLite database."
Invoke-InstalledSqliteCrud "verify" "19"

$uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList @("/S") -Wait -PassThru
if ($uninstallProcess.ExitCode -ne 0) {
  throw "Uninstaller exited with code $($uninstallProcess.ExitCode)."
}
Assert-Path $sentinel "Uninstall removed Bezgrow user data."
Assert-Path $database "Uninstall removed the Bezgrow SQLite database."
& node `
  --disable-warning=ExperimentalWarning `
  $installedSqliteTest `
  --database $database `
  --mode verify
if ($LASTEXITCODE -ne 0) {
  throw "SQLite CRUD data was not readable after uninstall."
}

Invoke-Installer @("/S")
Assert-Path $application "Reinstall did not restore the application."
Assert-Path $sentinel "Reinstall did not preserve Bezgrow user data."
Assert-Path $database "Reinstall did not preserve the Bezgrow SQLite database."
Invoke-AppLaunchCycle 4 -LaunchPath $desktopShortcut -ExpectedSchema 19
Invoke-InstalledSqliteCrud "verify" "19"

Write-SmokeDiagnostics "All installer smoke checks completed successfully." $null
Write-Host "windows-installer-smoke-ok cycles=4 start_menu=ok desktop_shortcut=ok console_windows=none fixed_port=43124 health=ok route=ok sqlite_crud=ok accounting_schema=19 accounting_defaults=32 accounting_migration_idempotent=ok historical_invoice_backpost=none license_persistence=ok offline=ok runtime_recovery=ok window_controls=ok external_browser=none orphan_processes=0 previous_version_upgrade=$(-not [string]::IsNullOrWhiteSpace($previousInstaller)) update_preservation=ok uninstall_preservation=ok reinstall=ok"
} catch {
  Write-SmokeDiagnostics "Installer smoke failed: $($_.Exception.Message)" $null
  throw
} finally {
  Remove-BezgrowOfflineRules
  Get-Process -Name "Bezgrow" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-BezgrowNodeProcesses | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
