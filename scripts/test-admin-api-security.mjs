import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

const protectedRoutes = [
  "app/api/admin/session/route.ts",
  "app/api/admin/dashboard/route.ts",
  "app/api/admin/licenses/route.ts",
  "app/api/admin/licenses/[id]/download/route.ts",
  "app/api/admin/licenses/[id]/events/route.ts",
  "app/api/admin/devices/route.ts",
  "app/api/admin/customers/route.ts",
  "app/api/admin/businesses/route.ts",
  "app/api/admin/releases/route.ts",
  "app/api/admin/backups/route.ts",
  "app/api/admin/support/route.ts",
  "app/api/admin/audit-logs/route.ts",
  "app/api/admin/analytics/route.ts",
  "app/api/admin/settings/route.ts",
]

for (const route of protectedRoutes) {
  const source = read(route)
  assert.match(source, /requireAdmin(?:ControlPlane)?\(request\)/, `${route} must enforce server-side admin authorization.`)
  assert.match(source, /Cache-Control|adminOk|adminFail/, `${route} must opt out of unsafe caching and return controlled errors.`)
}

for (const route of [
  "app/api/admin/licenses/route.ts",
  "app/api/admin/devices/route.ts",
  "app/api/admin/customers/route.ts",
  "app/api/admin/releases/route.ts",
  "app/api/admin/support/route.ts",
  "app/api/admin/settings/route.ts",
]) {
  const source = read(route)
  assert.match(source, /\.safeParse\(/, `${route} must schema-validate mutation input.`)
  assert.match(source, /writeAdminAudit|recordLicenseEvent/, `${route} must audit mutations.`)
}

const auth = read("lib/api/auth.ts")
const readiness = read("lib/admin/schema-readiness.ts")
const deviceAuthorization = read("lib/platform-admin/device-authorization.ts")
const desktopAdminClient = read("lib/platform-admin/client.ts")
const deviceMigration = read("supabase/migrations/20260811000000_device_bound_platform_admin.sql")
assert.match(auth, /validateMutationOrigin/, "Admin mutations must validate origins.")
assert.match(auth, /verifyPlatformAdminDeviceRequest\(request, \{ adminUserId: user\.id \}\)/, "Every admin API must jointly verify the authenticated account and native device.")
assert.match(auth, /checkRateLimit/, "Admin mutations must be rate limited.")
assert.match(auth, /admin_audit_logs/, "Audit records must include full request context.")
assert.match(auth, /verifyAdminControlPlaneSchema/, "Admin data routes must verify the complete schema before service-role access.")
assert.match(readiness, /admin_control_plane_current_schema_status/, "Schema readiness must use the current catalog-backed server RPC.")
assert.match(readiness, /2026082401/, "Schema readiness must require every current control-plane migration.")
assert.match(readiness, /expectedVersion === ADMIN_CONTROL_PLANE_SCHEMA_VERSION/, "An older readiness RPC must fail closed after a source schema-version bump.")
assert.doesNotMatch(readiness, /NEXT_PUBLIC_.*SERVICE_ROLE|NEXT_PUBLIC_.*PRIVATE/, "Readiness checks must not expose server secrets.")
assert.match(deviceAuthorization, /createPublicKey[\s\S]*verify\(/, "Server authorization must cryptographically verify native Ed25519 proofs.")
assert.match(deviceAuthorization, /platform_admin_allowed !== true[\s\S]*platform_admin_revoked_at/, "Disabled or revoked devices must be rejected.")
assert.match(deviceAuthorization, /allowed_admin_user_id !== options\.adminUserId/, "Admin credentials must be bound to the authorized device row.")
assert.match(deviceAuthorization, /platform_admin_request_nonces[\s\S]*\.insert/, "Device proofs must have server-side replay protection.")
assert.match(desktopAdminClient, /desktop_platform_admin_proof/, "The browser bundle must obtain signatures only from the native shell.")
assert.doesNotMatch(desktopAdminClient, /privateKey|service.role|SUPABASE_SERVICE_ROLE_KEY/i, "No privileged secret may enter the desktop admin client.")
assert.match(deviceMigration, /revoke all on public\.%I from authenticated/, "Browser admin JWTs must lose direct control-plane table access.")

const licenseRoute = read("app/api/admin/licenses/route.ts")
assert.match(licenseRoute, /signLicensePayload/, "License generation must be server-side.")
assert.match(licenseRoute, /\.from\("licenses"\)[\s\S]*\.insert/, "Generated licenses must be persisted.")
assert.match(licenseRoute, /const mutationName[\s\S]*admin_reset_app_password[\s\S]*admin_mutate_license/, "Licence changes must select an explicit atomic server-side mutation boundary.")
assert.match(licenseRoute, /\.rpc\(mutationName/, "Licence changes must execute the selected atomic server-side mutation.")
assert.match(licenseRoute, /licenseActionStateError/, "Licence transitions must be rejected server-side before signing.")
assert.doesNotMatch(licenseRoute, /BEZGROW_LICENSE_PRIVATE_KEY/, "Admin route must not read or expose the private key directly.")

for (const clientFile of [
  "app/admin/licenses/page.tsx",
  "components/desktop/PlatformAdminLauncher.tsx",
  "lib/desktop/tauri.ts",
  "src-tauri/src/lib.rs",
]) {
  assert.doesNotMatch(read(clientFile), /BEZGROW_LICENSE_PRIVATE_KEY|SUPABASE_SERVICE_ROLE_KEY/, `${clientFile} must not contain server secrets.`)
}

const releaseRoute = read("app/api/admin/releases/route.ts")
const publicUrl = read("lib/security/public-url.ts")
const artifactValidation = read("lib/releases/artifact-validation.ts")
assert.match(releaseRoute, /publicationError/, "Release publication must use a validation gate.")
assert.match(artifactValidation, /not an allowed public HTTPS location/, "Artifact verification must block local/private URL targets.")
assert.match(artifactValidation, /isPublicHttpsUrl/, "Artifact verification must validate public HTTPS destinations.")
assert.match(publicUrl, /lookup\(url\.hostname/, "Artifact verification must resolve DNS before fetching.")
assert.match(publicUrl, /addresses\.every\(\(\{ address \}\) => !isPrivateAddress\(address\)\)/, "Artifact verification must reject DNS results that resolve to private addresses.")
assert.match(artifactValidation, /redirect:\s*"manual"/, "Artifact verification must not follow unchecked redirects.")
assert.match(releaseRoute, /validation_status !== "valid"/, "Invalid artifacts must not publish.")
assert.match(releaseRoute, /const manualChannel = \["manual", "internal"\]\.includes/, "Unsigned releases must be restricted to explicit manual channels.")
assert.match(releaseRoute, /artifact\.code_signing_status === "valid"/, "Stable releases must require code signing.")
assert.match(releaseRoute, /artifact\.notarization_status === "valid"/, "Stable macOS releases must require notarization.")

const diagnostics = read("app/api/diagnostics/upload/route.ts")
assert.match(diagnostics, /\.strict\(\)/, "Diagnostic packages must reject undeclared sensitive fields.")
assert.match(diagnostics, /Support case is not linked to this device or license/, "Diagnostic uploads must not attach to unrelated support cases.")
for (const secret of ["password", "refresh_token", "access_token", "private_key", "invoice", "customer_data"]) {
  assert.doesNotMatch(diagnostics, new RegExp(`${secret}\\s*:`), `Diagnostics must not accept ${secret}.`)
}

const checkin = read("app/api/devices/checkin/route.ts")
assert.match(checkin, /compareVersions\(release\.version, input\.app_version\) > 0/, "Update checks must not offer the installed version.")
assert.match(checkin, /isInRollout\(input\.device_id, release\.id, release\.rollout_percentage\)/, "Update checks must apply deterministic rollout percentages.")
assert.match(checkin, /minimum_supported_version/, "Update checks must enforce the minimum supported version policy.")

console.log("admin-api-security-contract-ok")
