import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

const service = read("lib/offline/local/service.ts");
const sqlite = read("lib/offline/sqlite.ts");
const localApi = read("lib/offline/local/api.ts");
const localErp = read("lib/offline/local/erp.ts");
const adapters = read("lib/offline/local/adapters.ts");
const schema = read("lib/offline/local/schema.ts");
const dashboardLayout = read("app/dashboard/layout.tsx");
const offlinePage = read("app/offline/page.tsx");
const recovery = read("components/offline/LocalDatabaseRecovery.tsx");
const proxy = read("proxy.ts");
const startupRedirect = read("lib/auth/startup-redirect.ts");
const loginPage = read("app/login/page.tsx");

assert.match(service, /class LocalDatabaseUnavailableError extends Error/, "Desktop database failures need a typed error.");
assert.match(service, /isDesktopRuntime/, "Local database availability must be tied to desktop runtime detection.");
assert.match(service, /throw this\.unavailableError\(\)/, "Desktop database connection failures must throw instead of silently falling back.");
assert.match(service, /diagnostics\(\)/, "Local database diagnostics are required for recovery exports.");
assert.match(service, /PRAGMA quick_check/, "Startup integrity check must run PRAGMA quick_check.");
assert.match(service, /PRAGMA foreign_key_check/, "Startup integrity check must run PRAGMA foreign_key_check.");

assert.match(sqlite, /if \(desktopRuntime\) throw/, "SQLite initialization must fail closed in desktop mode.");
assert.match(localApi, /if \(desktopRuntime\) throw error/, "Local API writes must not fall back to IndexedDB in desktop mode.");
assert.match(localErp, /if \(desktopRuntime\) throw error/, "Local ERP writes must not fall back to IndexedDB in desktop mode.");
assert.match(adapters, /desktopRuntime[\s\S]*throw new Error\("Bezgrow local database is required in desktop mode\."\)/, "Repository adapter must require SQLite in desktop mode.");

for (const table of ["database_health", "license_state", "device_activations", "backup_manifest", "offline_sync_queue"]) {
  assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`), `Required local table missing: ${table}`);
}

const indexes = schema.match(/CREATE INDEX IF NOT EXISTS/g) || [];
assert.ok(indexes.length >= 40, `Expected broad offline indexes; found ${indexes.length}.`);
assert.match(schema, /LOCAL_DB_VERSION\s*=\s*6/, "Local DB version should reflect the current normalized schema.");

assert.match(dashboardLayout, /LocalDatabaseRecovery/, "Dashboard must render the local database recovery screen.");
assert.match(dashboardLayout, /integrityReport\(\)/, "Dashboard must verify local database integrity before opening.");
assert.match(dashboardLayout, /startupStartedRef/, "Dashboard startup guard must run only once.");
assert.match(dashboardLayout, /restoreLicensedWorkspaceContext\(\)/, "Dashboard must restore licensed desktop workspace before redirect decisions.");
assert.match(dashboardLayout, /status: "initializing" \| "database-ready" \| "license-valid" \| "business-ready"/, "Dashboard must keep explicit desktop startup phases.");
assert.match(offlinePage, /LocalDatabaseRecovery/, "Offline activation must render the local database recovery screen.");
assert.match(offlinePage, /integrityReport\(\)/, "Offline activation must verify local database integrity before writes.");
assert.match(offlinePage, /restoreLicensedWorkspaceContext\(\)/, "Offline activation must restore valid desktop licenses before trapping users on activation.");
assert.match(offlinePage, /snapshot\?\.allowed && requestedNextPath\.startsWith\("\/dashboard"\)/, "Offline activation must release valid licensed dashboard redirects.");
assert.match(recovery, /Download Diagnostics/, "Recovery screen must support diagnostics download.");
assert.match(recovery, /Copy Diagnostics/, "Recovery screen must support diagnostics copy.");
assert.doesNotMatch(recovery, /license_key|SUPABASE|PASSWORD|PRIVATE_KEY/i, "Diagnostics UI must not expose secret fields.");

assert.match(proxy, /BEZGROW_DESKTOP_BUILD === "1"/, "Proxy must distinguish packaged desktop from ordinary localhost web.");
assert.match(proxy, /localDesktopHost && desktopServerBuild && protectedRoute[\s\S]*NextResponse\.next\(\)/, "Packaged desktop protected routes must reach the client license guard.");
assert.match(startupRedirect, /integrityReport\(\)/, "Startup redirect must wait for local database readiness.");
assert.match(startupRedirect, /restoreLicensedWorkspaceContext\(\)/, "Startup redirect must restore licensed workspace before deciding.");
assert.match(loginPage, /integrityReport\(\)/, "Login startup check must wait for local database readiness.");
assert.match(loginPage, /restoreLicensedWorkspaceContext\(\)/, "Login startup check must restore licensed workspace before deciding.");

console.log("offline-contract-ok");
