import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

const migration = read("supabase/migrations/20260726120000_admin_control_plane.sql")
const finalSql = read("supabase/FINAL_ADMIN_CONTROL_PLANE_MIGRATION.sql")
const role = read("lib/admin-role.ts")
const auth = read("lib/api/auth.ts")
const dashboard = read("app/api/admin/dashboard/route.ts")
const analytics = read("app/api/admin/analytics/route.ts")
const businesses = read("app/api/admin/businesses/route.ts")
const legacyApproval = read("lib/api/legacy-approval-disabled.ts")

for (const table of [
  "platform_customers",
  "platform_businesses",
  "licenses",
  "license_events",
  "registered_devices",
  "device_checkins",
  "desktop_releases",
  "release_artifacts",
  "backup_status",
  "support_cases",
  "diagnostic_uploads",
  "admin_audit_logs",
  "platform_settings",
]) {
  assert.match(migration, new RegExp(`create table if not exists public\\.${table}\\b`), `Missing ${table} migration.`)
}

assert.equal(finalSql, migration, "SQL Editor migration must exactly match the canonical migration.")
assert.equal((migration.match(/\$\$/g) || []).length % 2, 0, "Migration dollar-quoted blocks must be balanced.")
assert.match(role, /role === "admin" \|\| role === "platform_admin"/, "Both supported admin roles must be explicit.")
assert.doesNotMatch(role, /ADMIN_EMAIL/, "Environment email must not bypass the server-side profile role.")
assert.match(auth, /\.from\("profiles"\)[\s\S]*\.select\("id, role, is_suspended"\)/, "Admin authorization must query the server profile.")
assert.match(auth, /writeAdminAudit/, "Admin mutations need the shared audit writer.")
assert.match(migration, /admin_audit_logs_append_only/, "Audit records must be append-only.")
assert.match(migration, /license_events_append_only/, "License history must be append-only.")
assert.match(migration, /revoke all on public\.%I from public, anon, authenticated/, "Control-plane privileges must be revoked before scoped grants.")
assert.match(migration, /platform admins insert %s[\s\S]*public\.is_platform_admin/, "Admin writes must be authorized by RLS.")
assert.doesNotMatch(migration, /using\s*\(\s*true\s*\)|with check\s*\(\s*true\s*\)/i, "Control-plane policies must not be permissive.")
assert.match(migration, /role in \('admin', 'platform_admin'\)/, "RLS admin function must support both platform roles.")
assert.match(migration, /Licensed workspaces no longer depend on the legacy approved flag/, "Current membership must not depend on approval.")
assert.match(migration, /admin_control_plane_schema_status/, "Migration must expose an exact server-only readiness check.")
assert.match(migration, /2026072601/, "Migration must record the current control-plane schema version.")
assert.match(migration, /\nbegin;[\s\S]*commit;\s*$/, "The final control-plane migration must be transactional.")
assert.match(legacyApproval, /status:\s*410/, "Legacy approval mutations must be disabled.")

assert.match(dashboard, /admin_control_plane_dashboard/, "Dashboard statistics must use server-side platform aggregation.")
assert.match(analytics, /admin_control_plane_analytics/, "Analytics must use server-side aggregation instead of loading full tables.")
assert.doesNotMatch(analytics, /\.limit\(10000\)/, "Analytics must not load large raw record sets into the application server.")
assert.doesNotMatch(dashboard, /\.from\("(?:invoices|products|customers)"\)/, "Dashboard must not read local ERP business tables.")
assert.match(businesses, /\.from\("platform_businesses"\)/, "Businesses page must use cloud-known platform metadata.")
assert.doesNotMatch(businesses, /\.from\("(?:invoices|products|customers)"\)/, "Businesses API must not infer local ERP activity.")

console.log("admin-control-plane-contract-ok")
