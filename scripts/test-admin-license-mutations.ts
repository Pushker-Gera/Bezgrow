import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  addLicenseDays,
  addLicenseMonths,
  licenseActionStateError,
  renewedExpiry,
} from "../lib/license/admin-license-actions"
import {
  MODERN_LICENSE_FEATURES,
  updateLicenseSchema,
} from "../lib/license/admin-license-validation"

const read = (path: string) => readFileSync(path, "utf8")

assert.equal(addLicenseDays("2027-08-11", 30), "2027-09-10")
assert.equal(addLicenseMonths("2027-01-31", 1), "2027-02-28", "Month extension must clamp to the target month's last day.")
assert.equal(renewedExpiry("2027-08-11", 12, "2026-08-22"), "2028-08-11", "Active renewal must extend from current expiry.")
assert.equal(renewedExpiry("2020-01-01", 12, "2026-08-22"), "2027-08-22", "Expired renewal must extend from today.")

assert.match(licenseActionStateError("renew", "revoked") || "", /revoked/i)
assert.match(licenseActionStateError("suspend", "suspended") || "", /already suspended/i)
assert.match(licenseActionStateError("reactivate", "active") || "", /only a suspended/i)
assert.equal(licenseActionStateError("reactivate", "suspended"), null)
assert.equal(licenseActionStateError("revoke", "suspended"), null)

const common = {
  id: "LIC-ADMIN-MUTATION-0001",
  idempotency_key: "123e4567-e89b-12d3-a456-426614174000",
  expected_updated_at: "2026-08-22T00:00:00.000Z",
}
for (const candidate of [
  { ...common, action: "renew", renew_months: 12 },
  { ...common, action: "extend", extend_days: 30 },
  { ...common, action: "change_grace", grace_days: 14 },
  { ...common, action: "update_features", plan_name: "Growth", allowed_features: [...MODERN_LICENSE_FEATURES] },
  { ...common, action: "replace_device", new_device_id: "BZG-NEW-DEVICE-0001", confirmed_device_id: "BZG-NEW-DEVICE-0001", reason: "Hardware replacement" },
  { ...common, action: "transfer", new_device_id: "BZG-NEW-DEVICE-0002", confirmed_device_id: "BZG-NEW-DEVICE-0002", reason: "Owner requested transfer" },
  { ...common, action: "suspend", confirmation: "SUSPEND", reason: "Payment review" },
  { ...common, action: "reactivate", confirmation: "REACTIVATE", reason: "Payment cleared" },
  { ...common, action: "revoke", confirmation: "REVOKE", reason: "Confirmed licence termination" },
]) {
  assert.equal(updateLicenseSchema.safeParse(candidate).success, true, `${candidate.action} mutation contract was rejected.`)
}
assert.equal(updateLicenseSchema.safeParse({ ...common, action: "revoke", confirmation: "REVOKE" }).success, false, "Revocation needs a reason.")
assert.equal(updateLicenseSchema.safeParse({ ...common, action: "suspend", confirmation: "yes" }).success, false, "Suspension needs explicit confirmation.")
assert.equal(updateLicenseSchema.safeParse({ ...common, action: "update_features", plan_name: "Legacy", allowed_features: ["orders"] }).success, false, "Legacy orders must not be offered as a current module.")
assert.equal(updateLicenseSchema.safeParse({ ...common, action: "replace_device", new_device_id: "BZG-NEW-DEVICE-0003", confirmed_device_id: "BZG-DIFFERENT", reason: "Mismatch" }).success, false, "Device replacement confirmation must match exactly.")

const page = read("app/admin/licenses/page.tsx")
const dialog = read("components/admin/LicenseActionDialog.tsx")
const controls = read("components/admin/ControlPlaneUi.tsx")
const route = read("app/api/admin/licenses/route.ts")
const migration = read("supabase/migrations/20260822010000_atomic_license_mutations.sql")
const deviceAuth = read("lib/device/report-auth.ts")
const checkin = read("app/api/devices/checkin/route.ts")
const localLicense = read("lib/offline/local/license.ts")
const platformClient = read("lib/platform-admin/client.ts")
const desktopShell = read("src-tauri/src/lib.rs")
const history = read("app/api/admin/licenses/[id]/events/route.ts")

assert.doesNotMatch(page + dialog, /window\.(?:prompt|confirm)\(/, "Licence actions must not depend on blocking WebView dialogs.")
assert.match(page, /list\.upsert\(result\.license\)/, "Successful mutations must patch the returned row.")
assert.doesNotMatch(page, /runAction[\s\S]*list\.reload\(\)/, "Mutations must not reload the full licence page.")
assert.match(controls, /activeAdminMutations/, "Client duplicate submissions must be suppressed.")
assert.match(route, /p_idempotency_key:\s*input\.idempotency_key/, "Server mutation must receive the stable dialog idempotency key.")
assert.match(route, /signLicensePayload[\s\S]*\.rpc\("admin_mutate_license"/, "Signing must complete before the atomic database mutation.")
assert.match(migration, /select \* into current_license[\s\S]*for update/, "Atomic mutations must lock the licence row.")
assert.match(migration, /pg_advisory_xact_lock[\s\S]*bezgrow-license-device:/, "Concurrent claims for an unseen target Device ID must be serialized.")
assert.match(migration, /insert into public\.license_events[\s\S]*insert into public\.admin_audit_logs[\s\S]*insert into public\.admin_license_mutations/, "History, audit, and idempotency must commit in the mutation transaction.")
assert.match(migration, /device_status = 'replaced'/, "Old replacement devices must be invalidated.")
assert.match(migration, /device_status = 'revoked'/, "Revocation must invalidate the registered device.")
assert.match(deviceAuth, /refreshedLicenseKey/, "A valid stale signed key must receive the current authoritative key after renewal.")
assert.match(checkin, /refreshedLicenseKey/, "Device check-in must deliver the current signed key.")
assert.match(localLicense, /installRefreshedLicenseKey[\s\S]*verifyLicenseSignature[\s\S]*writeDesktopSecret/, "Desktop must verify and persist refreshed signed state locally.")
assert.match(localLicense, /sameBinding[\s\S]*license_id[\s\S]*device_id[\s\S]*business_id/, "Refreshed signed state must preserve licence, device, and business binding.")
assert.match(history, /hiddenHistoryKeys/, "History responses must remove legacy secret-like fields.")
assert.match(platformClient, /isTauriRuntimeAsync[\s\S]*desktop_copy_text/, "Packaged admin copy must use the native desktop clipboard command.")
assert.match(desktopShell, /fn desktop_copy_text[\s\S]*CREATE_NO_WINDOW/, "The native clipboard must support macOS and hidden-console Windows copy.")
assert.doesNotMatch(route + page + dialog, /BEZGROW_LICENSE_PRIVATE_KEY|SUPABASE_SERVICE_ROLE_KEY/, "Private signing or service-role material must not enter mutation UI or routes.")

console.log("admin-license-mutations-ok actions=9 atomic=true idempotent=true desktop-refresh=true")
