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
const capability = readJson("src-tauri/capabilities/default.json");
const cargo = read("src-tauri/Cargo.toml");
const rust = read("src-tauri/src/lib.rs");
const prepare = read("scripts/prepare-desktop-build.mjs");
const runtime = read("lib/desktop/tauri.ts");
const loginPage = read("app/login/page.tsx");
const authCallback = read("app/auth/callback/route.ts");
const desktopAuthCallbackRoute = read("app/api/desktop-auth/callback/route.ts");

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

assert.match(cargo, /tauri-plugin-sql\s*=.*features\s*=\s*\[[^\]]*"sqlite"/s, "Tauri SQL plugin must be compiled with sqlite support.");
assert.match(rust, /tauri_plugin_sql::Builder::default\(\)\.build\(\)/, "Tauri SQL plugin is not registered.");
assert.match(rust, /__BEZGROW_RUNTIME__/, "Desktop webview must inject an explicit runtime marker.");
assert.match(runtime, /tauri-packaged/, "Client runtime detection must distinguish packaged desktop.");
assert.match(runtime, /isPackagedDesktopRuntime/, "Packaged desktop runtime helper is missing.");

assert.deepEqual(tauriConfig.plugins?.sql?.preload, ["sqlite:bezgrow-offline.db"], "SQLite database must be preloaded by Tauri.");
assert.equal(tauriConfig.bundle?.resources?.["../desktop-runtime/node/"], "node", "Bundled Node runtime resource is missing.");
assert.equal(tauriConfig.bundle?.resources?.["../desktop-runtime/next-server/"], "next-server", "Bundled Next server resource is missing.");
assert.ok(capability.permissions.includes("sql:default"), "Tauri capability must allow SQL defaults.");
assert.ok(capability.permissions.includes("sql:allow-execute"), "Tauri capability must allow SQL execute.");
assert.ok(capability.windows.includes("main"), "Main window capability is missing.");

assert.match(prepare, /BEZGROW_DESKTOP_BUILD/, "Desktop prepare must build with the desktop build flag.");
assert.match(prepare, /serverSource\s*=\s*join\(root,\s*"\.next",\s*"server"\)/, "Desktop prepare must read .next/server assets.");
assert.match(prepare, /"chunks"/, "Desktop prepare must copy server chunks into standalone output.");
assert.match(prepare, /"interception-route-rewrite-manifest\.js"/, "Desktop prepare must copy required server manifests into standalone output.");
assert.match(loginPage, /desktop_callback_origin/, "Desktop OAuth must tell the web callback where the local desktop app is listening.");
assert.match(authCallback, /trustedDesktopCallbackOrigin/, "Web auth callback must validate the local desktop callback origin.");
assert.match(authCallback, /\/api\/desktop-auth\/callback/, "Web auth callback must hand desktop OAuth sessions back to the local app.");
assert.match(desktopAuthCallbackRoute, /isLocalDesktopRequest/, "Desktop OAuth callback receiver must be localhost-only.");
assert.match(desktopAuthCallbackRoute, /storeDesktopOAuthExchange/, "Desktop OAuth callback receiver must store the session in the local app process.");

if (existsSync(".next/standalone/server.js")) {
  assert.ok(existsSync(".next/standalone/.next/static"), "Standalone output is missing static assets.");
  assert.ok(existsSync(".next/standalone/.next/server/chunks"), "Standalone output is missing server chunks.");
}

if (existsSync("desktop-runtime/next-server/server.js")) {
  assert.ok(existsSync("desktop-runtime/next-server/.next/static"), "Desktop runtime server is missing static assets.");
  assert.ok(existsSync("desktop-runtime/next-server/.next/server/chunks"), "Desktop runtime server is missing server chunks.");
}

console.log("desktop-runtime-config-ok");
