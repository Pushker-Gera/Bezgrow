import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const readJson = (path) => JSON.parse(read(path))

const config = readJson("src-tauri/tauri.windows.conf.json")
const baseConfig = readJson("src-tauri/tauri.conf.json")
const packageLock = readJson("package-lock.json")
const cargo = read("src-tauri/Cargo.toml")
const rust = read("src-tauri/src/lib.rs")
const service = read("lib/offline/local/service.ts")
const printEngine = read("components/print/PrintEngine.tsx")
const documentPipeline = read("lib/invoice-document.ts")
const updates = read("lib/app-updates.ts")
const updatesPanel = read("components/AppUpdatesPanel.tsx")
const downloadPage = read("app/download/page.tsx")
const installerHook = read("src-tauri/windows/installer-hooks.nsh")
const nsisTemplate = read("src-tauri/windows/installer-template.nsi")
const wixTemplate = read("src-tauri/windows/main-template.wxs")
const portableTemplate = read("src-tauri/windows/portable.nsi")
const portable = read("scripts/build-windows-portable.mjs")
const desktopBuild = read("scripts/build-desktop.mjs")
const workflow = read(".github/workflows/desktop-release.yml")
const installerTest = read("scripts/test-windows-installer.ps1")
const iconGenerator = read("scripts/generate-bezgrow-icons.mjs")
const artifactVerifier = read("scripts/verify-release-artifact.mjs")

assert.equal(baseConfig.mainBinaryName, "Bezgrow", "The Windows executable must use the product name.")
assert.deepEqual(config.bundle.targets, ["msi", "nsis"], "Windows must produce NSIS and MSI installers.")
assert.equal(config.bundle.windows.nsis.installMode, "perMachine", "NSIS must install under Program Files.")
assert.equal(config.bundle.windows.nsis.startMenuFolder, "Bezgrow", "Start Menu shortcut folder is missing.")
assert.equal(config.bundle.windows.nsis.installerIcon, "icons/icon.ico", "Installer icon is missing.")
assert.equal(config.bundle.windows.nsis.uninstallerIcon, "icons/icon.ico", "Uninstaller icon is missing.")
assert.equal(config.bundle.windows.allowDowngrades, false, "Older builds must not overwrite a newer installation.")
assert.equal(config.bundle.windows.webviewInstallMode.type, "offlineInstaller", "Clean Windows installs must include WebView2.")
assert.equal(config.bundle.windows.nsis.template, "windows/installer-template.nsi", "NSIS must use Bezgrow's pre-WebView OS guard.")
assert.equal(config.bundle.windows.wix.template, "windows/main-template.wxs", "MSI must use Bezgrow's pre-WebView OS guard.")
assert.match(installerHook, /NSIS_HOOK_POSTINSTALL[\s\S]*CreateOrUpdateDesktopShortcut/, "Silent installs must create the desktop shortcut.")
const tauriCliVersion = packageLock.packages["node_modules/@tauri-apps/cli"].version
assert.match(nsisTemplate, new RegExp(`Tauri CLI ${tauriCliVersion.replaceAll(".", "\\.")}`), "Vendored NSIS template must identify the installed Tauri CLI version.")
assert.match(wixTemplate, new RegExp(`Tauri CLI ${tauriCliVersion.replaceAll(".", "\\.")}`), "Vendored WiX template must identify the installed Tauri CLI version.")
assert.ok(nsisTemplate.indexOf("CurrentBuildNumber") < nsisTemplate.indexOf("Section WebView2"), "NSIS must reject unsupported Windows before starting WebView2.")
assert.match(nsisTemplate, /Function \.onInit[\s\S]*RunningX64[\s\S]*CurrentBuildNumber[\s\S]*IntCmpU \$R9 17763[\s\S]*SetErrorLevel 1150[\s\S]*requires 64-bit Windows 10 version 1809/, "NSIS must stop unsupported or 32-bit Windows with one clear message.")
assert.ok(wixTemplate.indexOf("WindowsBuild >= 17763") < wixTemplate.indexOf("InvokeStandalone"), "MSI must reject unsupported Windows before starting WebView2.")
assert.match(wixTemplate, /REMOVE="ALL" OR \(VersionNT64 >= 1000 AND WindowsBuild >= 17763\)/, "MSI must enforce 64-bit Windows 10 1809 while preserving uninstall.")
assert.match(portableTemplate, /Function \.onInit[\s\S]*RunningX64[\s\S]*CurrentBuildNumber[\s\S]*IntCmpU \$R9 17763[\s\S]*SetErrorLevel 1150/, "Portable Windows builds must reject unsupported systems before launching Bezgrow.")
assert.match(config.app.trayIcon.iconPath, /32x32\.png$/, "Notification-area icon is missing.")
assert.match(cargo, /"tray-icon"[\s\S]*"image-png"/, "The Windows notification-area icon features are not compiled.")

assert.match(rust, /var_os\("LOCALAPPDATA"\)[\s\S]*WINDOWS_APP_DATA_DIR/, "Windows data must resolve from %LOCALAPPDATA%\\Bezgrow.")
assert.match(rust, /var_os\("APPDATA"\)[\s\S]*copy_directory_missing/, "Legacy %APPDATA% data must migrate without deletion.")
assert.match(
  rust,
  /fn external_process_path[\s\S]*strip_prefix[\s\S]*fn start_next_server[\s\S]*external_process_path\(app\.path\(\)\.resource_dir/,
  "Windows must normalize verbatim resource paths before passing the bundled server path to Node."
)
for (const directory of ["Database", "business-assets/logos", "Settings", "PDFs", "Exports", "Temporary", "Backups", "Logs", "Runtime", "WebView"]) {
  assert.ok(rust.includes(`"${directory}"`), `Managed Windows data folder missing: ${directory}`)
}
assert.match(rust, /legacy_database[\s\S]*destination_database/, "Existing Windows databases must migrate without deletion.")
assert.match(rust, /SqliteSynchronous::Full/, "Native SQLite connections must use FULL durability.")
assert.match(service, /PRAGMA synchronous = FULL/, "SQLite bootstrap must use FULL durability.")
assert.match(service, /PRAGMA wal_autocheckpoint = 1000/, "SQLite WAL checkpoint policy is missing.")
assert.doesNotMatch(service, /@tauri-apps\/plugin-sql/, "Windows must not split SQLite between native and plugin paths.")

assert.match(rust, /ICoreWebView2_16[\s\S]*ShowPrintUI\(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM\)/, "Windows must open the system print dialog for the validated PDF through WebView2.")
assert.match(rust, /"invoice-native-print"[\s\S]*visible\(false\)[\s\S]*skip_taskbar\(true\)/, "The Windows native PDF bridge must stay hidden and off the taskbar.")
assert.doesNotMatch(rust, /fn open_pdf_with_default_application/, "Windows invoice printing must not launch the registered PDF application.")
assert.doesNotMatch(rust, /window\.print\(\)|desktop_print_current_webview/, "Windows must not retain WebView HTML printing.")
assert.match(printEngine, /58mm[\s\S]*80mm/, "Thermal 58mm and 80mm sizes must remain supported.")
assert.match(documentPipeline, /continuous-paper contract/, "Long thermal invoices must use the canonical dynamic-height PDF contract.")

assert.match(portable, /portable\.zip/, "A Windows ZIP release must be generated.")
assert.match(portable, /portable\.exe/, "A single-file portable Windows release must be generated.")
assert.match(
  portable,
  /BEZGROW_PORTABLE_SOURCE[\s\S]*BEZGROW_PORTABLE_ZIP/,
  "Portable ZIP assembly must pass Windows paths without fragile positional PowerShell arguments."
)
assert.match(portable, /signtool\.exe/, "Portable public executables must be Authenticode signed.")
assert.match(portable, /Get-AuthenticodeSignature/, "Portable executable signatures must be verified.")
assert.match(
  desktopBuild,
  /node_modules", "@tauri-apps", "cli", "tauri\.js"[\s\S]*run\(process\.execPath, \[[\s\S]*tauriCli/,
  "Windows packaging must invoke the project-local Tauri CLI without relying on a global PATH entry."
)
assert.match(workflow, /x86_64-pc-windows-msvc/, "Windows x64 release target is missing.")
assert.doesNotMatch(workflow, /matrix:/, "The production Windows workflow must build one explicit x64 target.")
assert.match(rust, /__BEZGROW_ARCH__[\s\S]*runtime_architecture/, "The native runtime must expose its architecture.")
assert.match(rust, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE[\s\S]*AssignProcessToJobObject/, "Windows must own the complete bundled process tree in a kill-on-close job object.")
assert.match(rust, /CREATE_NO_WINDOW/, "Windows bundled runtime and cleanup commands must never open a console window.")
assert.match(updates, /desktopArchitecture\(\) === "arm64"[\s\S]*windowsArm64/, "ARM64 update checks must select native ARM64 installers.")
assert.match(updates, /verifiedInstallerRouteForCurrentPlatform/, "Manual updates must use the integrity-validating download route.")
assert.match(updatesPanel, /Code signing:[\s\S]*SHA-256:/, "The update card must show signing and checksum status.")
assert.match(downloadPage, /Windows 10 version 1809\+ or Windows 11/, "The download page must show the exact supported Windows range before installation.")
assert.match(workflow, /npm run lint[\s\S]*npm run typecheck[\s\S]*npm test[\s\S]*npm run build/, "Windows CI must run the complete validation pipeline.")
assert.match(
  workflow,
  /Build the secret-free production desktop bundle[\s\S]*BEZGROW_DESKTOP_BUILD: "1"[\s\S]*SUPABASE_SERVICE_ROLE_KEY: ""[\s\S]*BEZGROW_LICENSE_PRIVATE_KEY: ""/,
  "Windows CI must build the desktop bundle without server-only Supabase or license signing secrets."
)
assert.match(workflow, /push:[\s\S]*tags:[\s\S]*v\*/, "Version tags must trigger the genuine Windows release workflow.")
assert.match(workflow, /npm run desktop:validate-env/, "Windows CI must reject incomplete public desktop configuration.")
assert.match(workflow, /makensis\.exe[\s\S]*GITHUB_PATH/, "Windows CI must add the installed NSIS directory to later build steps.")
assert.match(workflow, /cargo fmt[\s\S]*cargo check/, "Windows CI must compile-check the native application.")
assert.match(workflow, /cargo test[\s\S]*x86_64-pc-windows-msvc/, "Windows CI must run native tests for the release target.")
assert.match(workflow, /verify-production-windows-download\.mjs/, "Release CI must verify the deployed Windows binary endpoint.")
assert.doesNotMatch(workflow, /Publish Windows desktop release.*\[skip ci\]/, "Release metadata commits must trigger production website deployment.")
assert.match(workflow, /SUPABASE_URL:.*NEXT_PUBLIC_SUPABASE_URL/, "Control-plane publication must reuse the configured Supabase project URL.")
assert.match(workflow, /test-windows-installer\.ps1/, "Windows CI must validate the installer lifecycle.")
assert.match(workflow, /Bezgrow-Setup-\$\{version\}-x64\.exe/, "The published NSIS filename must be stable, versioned, and platform-specific.")
assert.match(workflow, /Bezgrow-\$\{version\}-x64\.msi/, "The published MSI filename must be stable, versioned, and platform-specific.")
assert.match(installerTest, /ProgramFiles[\s\S]*CommonDesktopDirectory[\s\S]*CommonPrograms/, "Installer QA must verify Program Files and shortcuts.")
assert.match(installerTest, /visibleConsoles[\s\S]*MainWindowHandle -ne \[IntPtr\]::Zero/, "Installer QA must distinguish a real visible console window from an invisible Windows console host.")
assert.match(installerTest, /finally[\s\S]*Get-Process -Name "Bezgrow"[\s\S]*Get-BezgrowNodeProcesses/, "Installer QA must clean the application and managed server after every failure path.")
assert.match(installerTest, /update-preservation-test[\s\S]*\/UPDATE[\s\S]*Uninstall removed Bezgrow user data/, "Installer QA must verify update and uninstall data preservation.")
assert.match(installerTest, /bundled server[\s\S]*\/login[\s\S]*authoritative SQLite database/i, "Installer QA must launch the installed app and verify its local server and database.")
assert.match(installerTest, /orphan bundled Node process/i, "Installer QA must reject orphaned background server processes.")
assert.match(installerTest, /Stop-Process[\s\S]*Bundled runtime supervisor restored the ERP window/, "Installer QA must prove recovery after the embedded server is terminated.")
assert.match(installerTest, /ShowWindowAsync[\s\S]*IsIconic[\s\S]*IsZoomed/, "Installer QA must exercise minimize, maximize, and restore.")
assert.match(installerTest, /Invoke-AppLaunchCycle 1 -TestRuntimeRecovery -TestWindowControls/, "Window controls must be exercised once on a ready installed app.")
assert.match(installerTest, /Get-ExternalBrowserProcessIds[\s\S]*opened an external browser process/, "Installer QA must reject an externally opened browser.")
assert.match(installerTest, /New-NetFirewallRule[\s\S]*RemoteAddress Internet/, "Installer QA must prove startup with external network access blocked.")
assert.match(installerTest, /test-windows-installed-sqlite\.mjs[\s\S]*sqlite_crud=ok[\s\S]*license_persistence=ok/, "Installer QA must exercise installed SQLite CRUD and license persistence.")
assert.match(installerTest, /All installer smoke checks completed successfully/, "Successful installer QA must export workflow diagnostics.")
assert.match(
  iconGenerator,
  /windowsIconSizes = \[16, 20, 24, 32, 40, 48, 64, 128, 256\]/,
  "The Windows ICO generator must include every required resolution."
)
assert.match(
  artifactVerifier,
  /peOffset[\s\S]*toString\("binary"\)[\s\S]*0x14c[\s\S]*0x8664[\s\S]*is32BitInstallerBootstrap/,
  "Windows artifacts must verify native x64 PE files and genuine NSIS bootstrap PE wrappers."
)

console.log("windows-contract-ok")
