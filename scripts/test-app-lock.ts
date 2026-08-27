import assert from "node:assert/strict"
import { pbkdf2Sync, randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import {
  APP_LOCK_ALGORITHM,
  APP_LOCK_ITERATIONS,
  APP_LOCK_KEY_BYTES,
  APP_LOCK_MIN_PASSWORD_LENGTH,
  appPasswordPolicyError,
  isAppLockProvisioning,
  type AppLockProvisioning,
} from "../lib/app-lock/shared"
import { verifyAppLockPassword } from "../lib/app-lock/verification"
import { evaluateStoredLicense } from "../lib/license/policy"

const read = (path: string) => readFileSync(path, "utf8")
const deviceId = "BZG-WINDOWS-APP-LOCK-DEVICE-0001"
const businessId = "business-app-lock-test"
const licenseId = "license-app-lock-test"

function provisioning(password: string, device = deviceId): AppLockProvisioning {
  const salt = randomBytes(16)
  return {
    version: 1,
    algorithm: APP_LOCK_ALGORITHM,
    iterations: APP_LOCK_ITERATIONS,
    salt: salt.toString("base64url"),
    verifier: pbkdf2Sync(`${device}\u0000${password}`, salt, APP_LOCK_ITERATIONS, APP_LOCK_KEY_BYTES, "sha256").toString("base64url"),
    device_id: device,
    credential_id: randomUUID(),
    issued_at: new Date().toISOString(),
    reset_authorization: null,
  }
}

async function main() {
const firstPassword = "StrongFirst9"
const first = provisioning(firstPassword)
assert.equal(isAppLockProvisioning(first), true)
assert.equal(await verifyAppLockPassword(firstPassword, first), true, "The correct app password must verify.")
assert.equal(await verifyAppLockPassword("WrongPassword9", first), false, "A wrong app password must be rejected.")
assert.equal(
  await verifyAppLockPassword(firstPassword, { ...first, device_id: "BZG-ANOTHER-DEVICE-0002" }),
  false,
  "A verifier must be cryptographically bound to its Device ID.",
)

const changedPassword = "ChangedSecure8"
const changed = provisioning(changedPassword)
assert.equal(await verifyAppLockPassword(changedPassword, changed), true, "A changed password must verify against its new salt and hash.")
assert.equal(await verifyAppLockPassword(firstPassword, changed), false, "The previous password must stop working after a password change.")
assert.equal(await verifyAppLockPassword(changedPassword, JSON.parse(JSON.stringify(changed))), true, "The one-way credential must survive secure local persistence and app updates.")
assert.equal(APP_LOCK_MIN_PASSWORD_LENGTH, 6, "The app-access password minimum must remain the user-approved six characters.")
assert.equal(appPasswordPolicyError("Aa1bb"), "Use at least 6 characters.")
assert.equal(appPasswordPolicyError("abcdef"), "Use at least one uppercase letter, one lowercase letter, and one number.")
assert.equal(appPasswordPolicyError("Aa1bbb"), null, "Exactly six policy-compliant characters must be accepted.")
assert.equal(appPasswordPolicyError(changedPassword), null)

const signedReset: AppLockProvisioning = {
  ...provisioning("ResetSecure7"),
  reset_authorization: {
    id: randomUUID(),
    issued_at: "2026-08-24T00:00:00.000Z",
    expires_at: "2026-08-24T00:30:00.000Z",
  },
}
assert.equal(isAppLockProvisioning(signedReset), true)
assert.equal(isAppLockProvisioning({ ...signedReset, reset_authorization: { ...signedReset.reset_authorization, expires_at: "invalid" } }), false)

const licensedRow = {
  id: licenseId,
  device_id: deviceId,
  status: "active",
  expiry_date: "2099-12-31",
  grace_period_days: 0,
  grace_until: "2099-12-31T23:59:59.999Z",
  last_verified_at: "2026-08-24T00:00:00.000Z",
  issued_at: "2026-08-24T00:00:00.000Z",
}
assert.equal((await verifyAppLockPassword(firstPassword, first)) && evaluateStoredLicense([{ ...licensedRow, status: "revoked" }], { deviceId }).allowed, false, "A correct app password must not bypass revocation.")
assert.equal((await verifyAppLockPassword(firstPassword, first)) && evaluateStoredLicense([{ ...licensedRow, expiry_date: "2020-01-01", grace_until: "2020-01-01T23:59:59.999Z" }], { deviceId }).allowed, false, "A correct app password must not bypass expiry.")

const client = read("lib/app-lock/client.ts")
const provisioningPolicy = read("lib/app-lock/provisioning-policy.ts")
const server = read("lib/app-lock/server.ts")
const gate = read("components/security/AppLockGate.tsx")
const layout = read("app/dashboard/layout.tsx")
const settings = read("app/dashboard/settings/page.tsx")
const profile = read("app/profile/page.tsx")
const localLicense = read("lib/offline/local/license.ts")
const adminRoute = read("app/api/admin/licenses/route.ts")
const resetMigration = read("supabase/migrations/20260824010000_app_lock_password_reset.sql")
const localApi = read("lib/offline/local/api.ts")
const repositories = read("lib/offline/local/repositories.ts")
const products = read("app/dashboard/products/page.tsx")
const customers = read("app/dashboard/customers/page.tsx")

assert.match(server, /pbkdf2Sync[\s\S]*APP_LOCK_ITERATIONS[\s\S]*sha256/, "Initial passwords must become salted one-way verifiers on the server.")
assert.match(client, /store_secret[\s\S]*APP_LOCK_SECRET_KEY/, "The local verifier must use the OS credential store, not SQLite business data.")
assert.match(client + provisioningPolicy, /APP_LOCK_WATERMARK_KEY[\s\S]*watermarkRecognizesSignedCredential/, "A non-secret persistence watermark must prevent an update or keychain loss from rolling a locally changed password back to the initial signed verifier.")
assert.doesNotMatch(client, /putOfflineData|localStorage\.setItem\([^\n]*password/, "The app password must not enter SQLite or browser storage.")
assert.match(localLicense, /verifyLicenseSignature[\s\S]*provisionAppLockFromLicense/, "Only a verified signed licence may provision App Lock.")
assert.match(adminRoute, /createAppLockProvisioning\(input\.app_password, input\.device_id\)/, "Licence generation must provision the first device password.")
assert.match(adminRoute, /APP_PASSWORD_RESET_AUTHORIZED/, "The control plane must expose an explicit audited password-reset action.")
assert.match(resetMigration, /pg_advisory_xact_lock[\s\S]*admin_license_mutations[\s\S]*license_events[\s\S]*admin_audit_logs/, "Password reset must be atomic, idempotent, and audited.")
assert.match(resetMigration, /service_role/, "Only the server-side service role may execute reset authorization.")
assert.doesNotMatch(resetMigration, /plaintext_password|password_hash\s+(?:text|varchar)/i, "The reset control plane must not add a plaintext or reusable password column.")

assert.match(gate, /GateState = "checking" \| "missing" \| "locked" \| "unlocked"/, "ERP content must remain unmounted until App Lock succeeds.")
assert.match(gate, /window\.addEventListener\("blur"[\s\S]*window\.addEventListener\("focus"/, "App Lock must respond to background/focus transitions.")
assert.match(gate, /window\.addEventListener\(APP_LOCK_CREDENTIAL_CHANGED_EVENT, credentialChanged\)/, "A reset credential must move a missing or locked screen back to password entry.")
assert.match(gate, /document\.addEventListener\("visibilitychange"/, "App Lock must detect minimize and hidden-window transitions.")
assert.match(gate, /throttleDelay[\s\S]*blockedUntil/, "Repeated wrong passwords must be rate limited.")
assert.ok(layout.indexOf('desktopDatabase.status === "failed"') < layout.indexOf("<AppLockGate"), "Licence/database gating must run before password access; a password cannot bypass licence restrictions.")
assert.match(layout, /<AppLockGate[\s\S]*<FinancialYearProvider[\s\S]*<FinancialYearScopedContent>/, "The lock gate must keep the ERP provider tree and business content unmounted.")
assert.doesNotMatch(layout, />\s*Logout\s*</, "Logout must not remain in the dashboard sidebar or mobile navigation.")
assert.doesNotMatch(profile, />\s*Logout Workspace\s*</, "Profile must not duplicate ordinary logout.")
assert.match(settings, /App Lock[\s\S]*Change App Password[\s\S]*Lock Now[\s\S]*Auto-lock|Lock after backgrounding/, "Settings must own password change and lock controls.")
assert.match(settings, /Workspace session[\s\S]*Signed in as[\s\S]*>Logout</, "Ordinary logout must be located in Settings.")

assert.match(localApi, /saveNormalizedProductAtomic/, "Product mutations must use a row-level atomic SQLite write.")
assert.match(localApi, /saveNormalizedCustomerAtomic/, "Customer mutations must use a row-level atomic SQLite write.")
assert.match(repositories, /saveNormalizedProductAtomic[\s\S]*upsert\(db, "products"[\s\S]*upsert\(db, "inventory_items"/, "Product and opening-stock rows must commit together.")
const productSave = products.slice(products.indexOf("async function saveProduct"), products.indexOf("async function", products.indexOf("async function saveProduct") + 20))
const customerSave = customers.slice(customers.indexOf("async function saveCustomer"), customers.indexOf("async function", customers.indexOf("async function saveCustomer") + 20))
assert.doesNotMatch(productSave, /router\.refresh|location\.reload|await refreshData/, "Product save must patch local state without a full refresh.")
assert.doesNotMatch(customerSave, /router\.refresh|location\.reload|await fetchData/, "Customer save must patch local state without a full refresh.")

console.log(`app-lock-contract-ok device=${deviceId} business=${businessId} minimum=${APP_LOCK_MIN_PASSWORD_LENGTH} password_hashing=pbkdf2-sha256 reset=audited`)
}

void main()
