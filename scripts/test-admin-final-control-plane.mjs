import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
const originalMigration = read("supabase/migrations/20260726120000_admin_control_plane.sql")
const correctiveMigration = read("supabase/migrations/20260727000000_admin_control_plane_corrective.sql")
const updaterMigration = read("supabase/migrations/20260801090000_desktop_updater_delivery.sql")
const deviceMigration = read("supabase/migrations/20260811000000_device_bound_platform_admin.sql")
const provenanceMigration = read("supabase/migrations/20260814090000_desktop_release_build_provenance.sql")
const readinessMigration = read("supabase/migrations/20260821010000_current_admin_control_plane_readiness.sql")
const runtimeCompatibilityMigration = read("supabase/migrations/20260821020000_license_control_plane_runtime_compatibility.sql")
const dashboard = read("app/api/admin/dashboard/route.ts")
const checkin = read("app/api/devices/checkin/route.ts")
const deviceAuth = read("lib/device/report-auth.ts")
const offlineLicense = read("lib/offline/local/license.ts")
const publicReleases = read("lib/releases/public.ts")
const artifactValidation = read("lib/releases/artifact-validation.ts")
const workflow = read(".github/workflows/desktop-release.yml")
const publication = read("scripts/publish-release-metadata.mjs")

assert.match(correctiveMigration, /dashboard_payload jsonb/, "Dashboard variable collision must be corrected.")
assert.match(correctiveMigration, /admin_control_plane_dashboard_v2/, "Isolated dashboard aggregate is missing.")
for (const section of ["licenses", "devices", "businesses", "customers", "releases", "backups", "support", "audit", "analytics"]) {
  assert.match(dashboard, new RegExp(`${section}`), `Dashboard section missing: ${section}`)
}
assert.match(dashboard, /Promise\.all/, "Fallback section queries must run in parallel.")
assert.match(dashboard, /admin-dashboard-section/, "Section errors need request-scoped server logging.")
assert.match(dashboard, /date_range[\s\S]*generated_at[\s\S]*metric_name[\s\S]*metric_value[\s\S]*status[\s\S]*source[\s\S]*notes/, "Dashboard CSV evidence columns are incomplete.")

assert.match(correctiveMigration, /register_device_checkin/, "Transactional device registration RPC is missing.")
assert.match(correctiveMigration, /device is already assigned to another license or customer/, "Device reassignment protection is missing.")
assert.match(checkin, /\.rpc\("register_device_checkin"/, "Device endpoint must use transactional registration.")
assert.match(checkin, /DEVICE_REGISTERED[\s\S]*DEVICE_CHECKIN/, "Device registration and check-in events must be audited.")
assert.match(deviceAuth, /device_assigned_elsewhere/, "Device authentication must prevent cross-customer overwrite.")
assert.match(offlineLicense, /reportActivatedDevice/, "Desktop activation must report minimal device metadata.")
assert.match(offlineLicense, /can never roll back or block offline ERP access/, "Check-in failure must not block local ERP.")

for (const field of ["artifact_type", "file_name", "update_signature"]) {
  assert.match(correctiveMigration, new RegExp(field), `Release artifact field missing: ${field}`)
}
assert.match(artifactValidation, /HTML, JSON, or text/, "Artifact verifier must reject non-installer responses.")
assert.match(artifactValidation, /not a macOS .* installer|not a Windows .* installer/, "Artifact verifier must reject wrong platforms.")
assert.match(artifactValidation, /SHA-256 does not match/, "Artifact verifier must reject checksum mismatch.")
assert.match(publicReleases, /validateInstallerCandidate/, "Public releases must use independent integrity validation.")
assert.match(artifactValidation, /productionRecommended/, "Public release trust must be independent from availability.")

assert.match(workflow, /runs-on:\s*windows-latest/, "Windows release must run on windows-latest.")
assert.match(workflow, /npm ci[\s\S]*npm run build/, "Windows workflow must install and build.")
assert.match(workflow, /Compute release checksums/, "Release workflow must compute SHA-256.")
assert.match(workflow, /publish-release-metadata\.mjs/, "Workflow must publish authoritative release metadata.")
assert.match(publication, /SUPABASE_SERVICE_ROLE_KEY/, "CI publication must use a server-only secret.")
assert.doesNotMatch(workflow, /NEXT_PUBLIC_SUPABASE_SERVICE_ROLE/, "Service role must never be exposed as NEXT_PUBLIC.")

assert.match(originalMigration, /force row level security/, "Control-plane tables must keep forced RLS.")
assert.doesNotMatch(originalMigration + correctiveMigration + updaterMigration + deviceMigration + provenanceMigration + readinessMigration, /disable row level security/i, "No migration may disable RLS.")
assert.match(originalMigration, /admin_audit_logs_append_only/, "Audit log must remain append-only.")
for (const field of ["mandatory_after", "updater_url", "updater_sha256", "updater_signature_status"]) {
  assert.match(updaterMigration, new RegExp(field), `Updater control-plane field missing: ${field}`)
}
for (const field of ["platform_admin_allowed", "allowed_admin_user_id", "platform_admin_public_key"]) {
  assert.match(deviceMigration, new RegExp(field), `Device authorization field missing: ${field}`)
}
for (const field of ["build_commit", "build_timestamp"]) {
  assert.match(provenanceMigration, new RegExp(field), `Release provenance field missing: ${field}`)
}
assert.match(readinessMigration, /admin_control_plane_current_schema_status/, "Current schema readiness RPC is missing.")
assert.match(readinessMigration, /2026082101/, "Current schema readiness version is missing.")
assert.match(runtimeCompatibilityMigration, /license\.architecture/, "Licence runtime view must expose architecture.")
assert.match(runtimeCompatibilityMigration, /license_control_plane\.architecture/, "Current readiness must verify the licence architecture view column.")
assert.match(runtimeCompatibilityMigration, /2026082102/, "Runtime compatibility schema version is missing.")
assert.match(readinessMigration, /missing_privileges/, "Current readiness must verify service-role-only table privileges.")
assert.match(readinessMigration, /unexpected_policies/, "Replay-nonce policy verification is missing.")
assert.doesNotMatch(readinessMigration, /public\.(?:customers|products|invoices|orders|organizations)\b/i, "Current control-plane readiness must not touch customer ERP tables.")

console.log("admin-final-control-plane-contract-ok")
