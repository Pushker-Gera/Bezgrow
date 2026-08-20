import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

const repositories = read("lib/offline/local/repositories.ts");
const db = read("lib/offline/db.ts");
const erp = read("lib/offline/local/erp.ts");
const api = read("lib/offline/local/api.ts");
const settings = read("app/dashboard/settings/page.tsx");
const schema = read("lib/offline/local/schema.ts");
const rust = read("src-tauri/src/lib.rs");

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

assert.match(settings, /Download Backup/, "Settings must expose backup download.");
assert.match(settings, /Restore Backup/, "Settings must expose backup restore.");
assert.match(settings, /desktop_export_backup/, "Settings must use native desktop backup export.");
assert.match(settings, /desktop_restore_backup/, "Settings must use native desktop backup restore.");
assert.match(rust, /DesktopBackupManifest/, "Native backup packages need a manifest.");
assert.match(rust, /database_checksum_sha256/, "Native backup packages need a database checksum.");
assert.match(rust, /pre_restore_backup_path/, "Native restore must create a pre-restore backup.");
assert.match(rust, /BEGIN IMMEDIATE[\s\S]*ROLLBACK[\s\S]*COMMIT/, "Native restore must be transactional.");
assert.match(rust, /name NOT IN \('schema_migrations', 'license_state', 'device_activations'\)/, "Restore must preserve installation-bound license and device identity.");
assert.match(rust, /MAX_BACKUP_DATABASE_BYTES/, "Native restore must enforce a database extraction limit.");
assert.match(rust, /entry\.size\(\) != manifest\.database_bytes/, "Native restore must reject database size mismatches before extraction.");
assert.match(rust, /verify_backup_database\(&current_database, &organization_id\)/, "Native restore must verify the live database after commit.");
assert.match(rust, /corrupted_backup_database_is_rejected_before_restore/, "Native restore needs a corrupt-database rejection test.");

assert.match(schema, /CREATE TABLE IF NOT EXISTS backup_manifest/, "Backup manifest table is missing.");
assert.match(schema, /idx_backup_org_created/, "Backup manifest created-at index is missing.");
assert.match(schema, /idx_backup_verification/, "Backup verification index is missing.");

console.log("backup-contract-ok");
