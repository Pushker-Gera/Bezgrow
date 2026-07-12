import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

const repositories = read("lib/offline/local/repositories.ts");
const db = read("lib/offline/db.ts");
const erp = read("lib/offline/local/erp.ts");
const api = read("lib/offline/local/api.ts");
const statusBar = read("components/offline/OfflineStatusBar.tsx");
const settings = read("app/dashboard/settings/page.tsx");
const schema = read("lib/offline/local/schema.ts");

assert.match(repositories, /export async function exportNormalizedBackup\(\)/, "Normalized SQLite backup export is missing.");
assert.match(repositories, /storage:\s*"sqlite-normalized"/, "SQLite backup payload must identify its storage format.");
assert.match(repositories, /integrity:\s*await service\.integrityReport\(\)/, "Backup export must include an integrity report.");
assert.match(repositories, /actions:\s*await listNormalizedActions\(\)/, "Backup export must include pending local actions.");
assert.match(repositories, /offline_sync_conflicts/, "Backup export must include unresolved sync conflicts.");

assert.match(db, /export async function restoreOfflineBackup/, "Backup restore entry point is missing.");
assert.match(db, /backup\.app !== "Bezgrow"/, "Backup restore must reject non-Bezgrow payloads.");
assert.match(db, /window\.dispatchEvent\(new Event\("bezgrow:offline-data-changed"\)\)/, "Backup restore must notify open screens after restore.");

assert.match(erp, /export async function verifyLocalBackup/, "Local backup verification endpoint implementation is missing.");
assert.match(erp, /checksum\(backup\)/, "Backup verification must record a checksum.");
assert.match(erp, /integrityReport\(\)/, "Backup verification must include database integrity.");
assert.match(api, /"\/api\/backup\/verify"/, "Local API must route backup verification.");

assert.match(statusBar, /Download Backup/, "Offline status bar must expose backup download.");
assert.match(statusBar, /Restore Backup/, "Offline status bar must expose backup restore.");
assert.match(settings, /Download Backup/, "Settings must expose backup download.");
assert.match(settings, /Restore Backup/, "Settings must expose backup restore.");

assert.match(schema, /CREATE TABLE IF NOT EXISTS backup_manifest/, "Backup manifest table is missing.");
assert.match(schema, /idx_backup_org_created/, "Backup manifest created-at index is missing.");
assert.match(schema, /idx_backup_verification/, "Backup verification index is missing.");

console.log("backup-contract-ok");
