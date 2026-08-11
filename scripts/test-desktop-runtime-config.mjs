import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

function readJson(path) {
  return JSON.parse(read(path));
}

const packageJson = readJson("package.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const windowsConfig = readJson("src-tauri/tauri.windows.conf.json");
const capability = readJson("src-tauri/capabilities/default.json");
const cargo = read("src-tauri/Cargo.toml");
const tauriBuild = read("src-tauri/build.rs");
const rust = read("src-tauri/src/lib.rs");
const prepare = read("scripts/prepare-desktop-build.mjs");
const runtime = read("lib/desktop/tauri.ts");
const loginPage = read("app/login/page.tsx");
const authCallback = read("app/auth/callback/route.ts");
const desktopAuthCallbackRoute = read("app/api/desktop-auth/callback/route.ts");
const desktopHealthRoute = read("app/api/desktop-health/route.ts");

for (const script of [
  "desktop:prepare",
  "desktop:build",
  "test:e2e",
  "test:integration",
  "test:offline",
  "test:backup",
  "test:performance",
]) {
  assert.ok(packageJson.scripts?.[script], `Package script missing: ${script}`);
}

assert.match(cargo, /sqlx\s*=.*features\s*=\s*\[[^\]]*"sqlite"/s, "Native SQLite support must be compiled with sqlx.");
assert.doesNotMatch(cargo, /tauri-plugin-sql/, "The desktop runtime must not compile a second JavaScript SQLite authority.");
assert.doesNotMatch(rust, /tauri_plugin_sql/, "The desktop runtime must not register a second SQLite plugin.");
assert.match(rust, /__BEZGROW_RUNTIME__/, "Desktop webview must inject an explicit runtime marker.");
assert.match(runtime, /tauri-packaged/, "Client runtime detection must distinguish packaged desktop.");
assert.match(runtime, /isPackagedDesktopRuntime/, "Packaged desktop runtime helper is missing.");

for (const command of [
  "desktop_database_diagnostics",
  "desktop_database_backup",
  "desktop_execute",
  "desktop_select",
  "desktop_execute_transaction",
  "desktop_startup_log",
  "store_secret",
  "read_secret",
  "delete_secret",
  "desktop_save_file",
  "desktop_open_pdf_for_print",
  "desktop_open_file",
  "desktop_exit",
  "desktop_retry_startup",
  "open_external_url",
]) {
  const permission = `allow-${command.replaceAll("_", "-")}`;
  assert.ok(tauriBuild.includes(`"${command}"`), `Tauri app manifest must declare ${command}.`);
  assert.ok(capability.permissions.includes(permission), `Desktop capability must grant ${permission}.`);
}
assert.equal(tauriConfig.bundle?.resources?.["../desktop-runtime/node/"], "node", "Bundled Node runtime resource is missing.");
assert.equal(tauriConfig.bundle?.resources?.["../desktop-runtime/next-server/"], "next-server", "Bundled Next server resource is missing.");
assert.ok(!capability.permissions.some((permission) => permission.startsWith("sql:")), "A removed SQL plugin must not retain broad capabilities.");
assert.ok(capability.windows.includes("main"), "Main window capability is missing.");
assert.equal(windowsConfig.bundle.windows.nsis.installMode, "perMachine", "Windows installer must use Program Files.");
assert.equal(windowsConfig.bundle.windows.nsis.installerIcon, "icons/icon.ico", "Windows installer icon is missing.");
assert.equal(windowsConfig.bundle.windows.webviewInstallMode.type, "offlineInstaller", "Clean Windows installs must work without downloading WebView2.");
assert.equal(windowsConfig.app.trayIcon.iconPath, "icons/32x32.png", "Windows notification-area icon is missing.");

assert.match(prepare, /BEZGROW_DESKTOP_BUILD/, "Desktop prepare must build with the desktop build flag.");
assert.match(prepare, /BEZGROW_DESKTOP_NODE_BINARY/, "Cross-architecture Windows builds must bundle the matching Node runtime.");
assert.match(prepare, /serverSource\s*=\s*join\(root,\s*"\.next",\s*"server"\)/, "Desktop prepare must read .next/server assets.");
assert.match(prepare, /"chunks"/, "Desktop prepare must copy server chunks into standalone output.");
assert.match(prepare, /"interception-route-rewrite-manifest\.js"/, "Desktop prepare must copy required server manifests into standalone output.");
assert.match(loginPage, /desktop_callback_origin/, "Desktop OAuth must tell the web callback where the local desktop app is listening.");
assert.match(authCallback, /trustedDesktopCallbackOrigin/, "Web auth callback must validate the local desktop callback origin.");
assert.match(authCallback, /\/api\/desktop-auth\/callback/, "Web auth callback must hand desktop OAuth sessions back to the local app.");
assert.match(desktopAuthCallbackRoute, /isLocalDesktopRequest/, "Desktop OAuth callback receiver must be localhost-only.");
assert.match(desktopAuthCallbackRoute, /storeDesktopOAuthExchange/, "Desktop OAuth callback receiver must store the session in the local app process.");
assert.match(rust, /port_is_available\(DESKTOP_SERVER_PORT\)/, "Desktop startup must prefer the stable local origin.");
assert.match(rust, /TcpListener::bind\(\("127\.0\.0\.1", 0\)\)/, "An unrelated fixed-port owner must use an OS-selected controlled fallback.");
assert.match(rust, /unrelated or unverifiable process[\s\S]*leaving it untouched[\s\S]*authenticated fallback port/, "Fallback diagnostics must prove unrelated processes are preserved.");
assert.match(rust, /recover_recorded_runtime[\s\S]*runtime_process_identity_matches[\s\S]*terminate_verified_runtime_pid/, "Recorded stale runtimes must be identity-verified before termination.");
assert.match(rust, /recover_legacy_orphaned_runtimes[\s\S]*legacy_runtime_identity_matches/, "The broken pre-metadata runtime must have a safe orphan recovery path.");
assert.match(rust, /fn start_server_with_retries[\s\S]*for attempt in 1\.\.=3/, "Packaged runtime startup must use bounded automatic retries.");
assert.match(rust, /fn start_runtime_supervisor[\s\S]*local_runtime_responds\(&ownership\)/, "The bundled runtime must remain authenticated and health-checked after the window opens.");
assert.match(rust, /RUNTIME_HEALTH_HEADER[\s\S]*local_runtime_responds/, "The native health check must send the per-launch runtime credential.");
assert.match(desktopHealthRoute, /timingSafeEqual[\s\S]*BEZGROW_RUNTIME_TOKEN[\s\S]*bezgrow-embedded/, "The embedded health route must require the per-launch token and remain hidden on the hosted site.");
assert.match(rust, /RuntimeOwnership[\s\S]*shell_pid[\s\S]*server_pid[\s\S]*app_version[\s\S]*token[\s\S]*started_at/, "Runtime ownership must persist shell, server, version, token, and timestamp identity.");
assert.match(rust, /tauri_plugin_single_instance[\s\S]*focus_running_bezgrow/, "A second launch must focus the existing Bezgrow window.");
assert.match(rust, /main\.hide\(\)[\s\S]*create_startup_error_window/, "A failed bundled runtime must hide the ERP webview before showing recovery.");
assert.match(rust, /desktop_retry_startup/, "The customer recovery screen must be able to restart the bundled runtime.");
assert.match(
  rust,
  /cfg!\(debug_assertions\)\s*&&\s*parsed\.scheme\(\)\s*==\s*"http"/,
  "A packaged build must never send an embedded loopback URL to an external browser."
);

if (existsSync(".next/standalone/server.js")) {
  assert.ok(existsSync(".next/standalone/.next/static"), "Standalone output is missing static assets.");
  assert.ok(existsSync(".next/standalone/.next/server/chunks"), "Standalone output is missing server chunks.");
}

if (existsSync("desktop-runtime/next-server/server.js")) {
  assert.ok(existsSync("desktop-runtime/next-server/.next/static"), "Desktop runtime server is missing static assets.");
  assert.ok(existsSync("desktop-runtime/next-server/.next/server/chunks"), "Desktop runtime server is missing server chunks.");
}

console.log("desktop-runtime-config-ok");
