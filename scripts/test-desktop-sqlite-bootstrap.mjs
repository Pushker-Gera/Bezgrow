import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

const service = read("lib/offline/local/service.ts");
const sqlite = read("lib/offline/sqlite.ts");
const offlineDb = read("lib/offline/db.ts");
const profilePage = read("app/profile/page.tsx");
const rust = read("src-tauri/src/lib.rs");
const cargo = read("src-tauri/Cargo.toml");
const buildDesktop = read("scripts/build-desktop.mjs");

assert.doesNotMatch(service, /POOL_SIZE|private readonly pool|poolCursor/, "Desktop SQLite startup must not use a connection pool before bootstrap completes.");
assert.match(service, /primaryConnectionPromise/, "Desktop SQLite must share one primary connection during startup.");
assert.match(service, /startupPromise/, "Concurrent desktop SQLite callers must await one startup promise.");
assert.match(service, /startupFailure/, "Permanent startup failures must be retained until an explicit retry or relaunch.");
assert.match(service, /desktop_database_diagnostics/, "Desktop SQLite bootstrap must collect native path and permission diagnostics.");
assert.match(service, /desktop_database_backup/, "Desktop SQLite migrations must request a native backup before schema changes.");
assert.match(service, /PRAGMA journal_mode = WAL/, "Desktop SQLite must request WAL mode.");
assert.match(service, /PRAGMA foreign_keys = ON/, "Desktop SQLite must enable foreign keys.");
assert.match(service, /PRAGMA busy_timeout = 5000/, "Desktop SQLite must configure a bounded busy timeout.");
assert.match(service, /BEGIN IMMEDIATE[\s\S]*COMMIT[\s\S]*ROLLBACK/, "SQLite transactions must use explicit rollback on failure.");

for (const stage of [
  "tauri_runtime_detection",
  "frontend_bridge_availability",
  "database_file_path",
  "parent_directory",
  "database_open",
  "connection_creation",
  "pragma_configuration",
  "migration_backup",
  "migration_execution",
  "schema_version_check",
  "integrity_check",
  "repository_initialisation",
]) {
  assert.match(service, new RegExp(stage), `Missing SQLite startup diagnostic stage: ${stage}`);
}

assert.match(sqlite, /rethrowInDesktop/, "SQLite repository wrappers must fail closed in desktop runtime.");
assert.match(offlineDb, /isDesktopRuntime/, "Offline storage facade must detect desktop runtime explicitly.");
assert.match(offlineDb, /desktopSqliteRequiredError/, "Offline storage facade must fail closed when desktop SQLite is unavailable.");
assert.match(offlineDb, /if \(await strictDesktopStorage\(\)\) throw desktopSqliteRequiredError\(`writing \$\{collection\}`\)/, "Desktop writes must not fall back to IndexedDB.");
assert.match(offlineDb, /if \(await strictDesktopStorage\(\)\) return fallback/, "Desktop reads with no SQLite hit must not read IndexedDB.");
assert.match(offlineDb, /if \(await strictDesktopStorage\(\)\) throw desktopSqliteRequiredError\("exporting backup"\)/, "Desktop backup export must not fall back to IndexedDB.");

assert.doesNotMatch(profilePage, /clearOfflineData/, "Logout must not erase the local SQLite database or license.");

assert.match(cargo, /sha2\s*=\s*"0\.10"/, "Native desktop backup checksums require sha2.");
assert.match(rust, /LOCAL_DATABASE_NAME: &str = "bezgrow-offline\.db"/, "Native diagnostics must target the Tauri SQL database name.");
assert.match(rust, /fn desktop_database_diagnostics/, "Native database diagnostics command is missing.");
assert.match(rust, /fn desktop_database_backup/, "Native migration backup command is missing.");
assert.match(rust, /sha256_file/, "Native migration backups must include a checksum.");
assert.match(rust, /desktop_database_diagnostics,[\s\S]*desktop_database_backup,/, "Native database commands must be registered with Tauri.");
assert.match(buildDesktop, /function tauriBuildEnv\(\)/, "Desktop build wrapper must control the Tauri bundler environment.");
assert.match(buildDesktop, /process\.platform === "darwin"[\s\S]*env\.CI = "true"/, "macOS DMG packaging must run in CI mode to skip fragile Finder automation.");

console.log("desktop-sqlite-bootstrap-ok");
