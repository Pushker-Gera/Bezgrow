import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const readJson = (path) => JSON.parse(read(path))

const config = readJson("src-tauri/tauri.windows.conf.json")
const baseConfig = readJson("src-tauri/tauri.conf.json")
const cargo = read("src-tauri/Cargo.toml")
const rust = read("src-tauri/src/lib.rs")
const service = read("lib/offline/local/service.ts")
const printEngine = read("components/print/PrintEngine.tsx")
const updates = read("lib/app-updates.ts")
const updatesPanel = read("components/AppUpdatesPanel.tsx")
const installerHook = read("src-tauri/windows/installer-hooks.nsh")
const portable = read("scripts/build-windows-portable.mjs")
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
assert.match(installerHook, /NSIS_HOOK_POSTINSTALL[\s\S]*CreateOrUpdateDesktopShortcut/, "Silent installs must create the desktop shortcut.")
assert.match(config.app.trayIcon.iconPath, /32x32\.png$/, "Notification-area icon is missing.")
assert.match(cargo, /"tray-icon"[\s\S]*"image-png"/, "The Windows notification-area icon features are not compiled.")

assert.match(rust, /var_os\("LOCALAPPDATA"\)[\s\S]*WINDOWS_APP_DATA_DIR/, "Windows data must resolve from %LOCALAPPDATA%\\Bezgrow.")
assert.match(rust, /var_os\("APPDATA"\)[\s\S]*copy_directory_missing/, "Legacy %APPDATA% data must migrate without deletion.")
for (const directory of ["Database", "business-assets/logos", "Settings", "PDFs", "Exports", "Temporary", "Backups", "Logs", "WebView"]) {
  assert.ok(rust.includes(`"${directory}"`), `Managed Windows data folder missing: ${directory}`)
}
assert.match(rust, /legacy_database[\s\S]*destination_database/, "Existing Windows databases must migrate without deletion.")
assert.match(rust, /SqliteSynchronous::Full/, "Native SQLite connections must use FULL durability.")
assert.match(service, /PRAGMA synchronous = FULL/, "SQLite bootstrap must use FULL durability.")
assert.match(service, /PRAGMA wal_autocheckpoint = 1000/, "SQLite WAL checkpoint policy is missing.")
assert.doesNotMatch(service, /@tauri-apps\/plugin-sql/, "Windows must not split SQLite between native and plugin paths.")

assert.match(rust, /cfg\(target_os = "windows"\)[\s\S]*window\.print\(\)/, "Windows WebView2 printing is missing.")
assert.match(printEngine, /58mm[\s\S]*80mm/, "Thermal 58mm and 80mm sizes must remain supported.")
assert.match(printEngine, /dynamic-thermal-page-size/, "Long thermal invoices must receive a measured page height.")

assert.match(portable, /portable\.zip/, "A Windows ZIP release must be generated.")
assert.match(portable, /portable\.exe/, "A single-file portable Windows release must be generated.")
assert.match(portable, /signtool\.exe/, "Portable public executables must be Authenticode signed.")
assert.match(portable, /Get-AuthenticodeSignature/, "Portable executable signatures must be verified.")
assert.match(workflow, /x86_64-pc-windows-msvc/, "Windows x64 release target is missing.")
assert.doesNotMatch(workflow, /matrix:/, "The production Windows workflow must build one explicit x64 target.")
assert.match(rust, /__BEZGROW_ARCH__[\s\S]*runtime_architecture/, "The native runtime must expose its architecture.")
assert.match(updates, /desktopArchitecture\(\) === "arm64"[\s\S]*windowsArm64/, "ARM64 update checks must select native ARM64 installers.")
assert.match(updates, /verifiedInstallerRouteForCurrentPlatform/, "Manual updates must use the integrity-validating download route.")
assert.match(updatesPanel, /Code signing:[\s\S]*SHA-256:/, "The update card must show signing and checksum status.")
assert.match(workflow, /npm run lint[\s\S]*npm run typecheck[\s\S]*npm test[\s\S]*npm run build/, "Windows CI must run the complete validation pipeline.")
assert.match(workflow, /push:[\s\S]*tags:[\s\S]*v\*/, "Version tags must trigger the genuine Windows release workflow.")
assert.match(workflow, /npm run desktop:validate-env/, "Windows CI must reject incomplete public desktop configuration.")
assert.match(workflow, /makensis\.exe[\s\S]*GITHUB_PATH/, "Windows CI must add the installed NSIS directory to later build steps.")
assert.match(workflow, /cargo fmt[\s\S]*cargo check/, "Windows CI must compile-check the native application.")
assert.match(workflow, /verify-production-windows-download\.mjs/, "Release CI must verify the deployed Windows binary endpoint.")
assert.match(workflow, /test-windows-installer\.ps1/, "Windows CI must validate the installer lifecycle.")
assert.match(installerTest, /ProgramFiles[\s\S]*CommonDesktopDirectory[\s\S]*CommonPrograms/, "Installer QA must verify Program Files and shortcuts.")
assert.match(installerTest, /update-preservation-test[\s\S]*\/UPDATE[\s\S]*Uninstall removed Bezgrow user data/, "Installer QA must verify update and uninstall data preservation.")
assert.match(installerTest, /bundled server[\s\S]*\/login[\s\S]*authoritative SQLite database/i, "Installer QA must launch the installed app and verify its local server and database.")
assert.match(installerTest, /orphan bundled Node process/i, "Installer QA must reject orphaned background server processes.")
assert.match(
  iconGenerator,
  /windowsIconSizes = \[16, 20, 24, 32, 40, 48, 64, 128, 256\]/,
  "The Windows ICO generator must include every required resolution."
)
assert.match(artifactVerifier, /peOffset[\s\S]*toString\("binary"\)[\s\S]*0x8664/, "Windows artifacts must be verified as genuine x64 PE binaries.")

console.log("windows-contract-ok")
