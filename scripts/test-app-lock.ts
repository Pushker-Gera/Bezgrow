import assert from "node:assert/strict"
import { pbkdf2Sync, randomBytes, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import {
  APP_LOCK_ALGORITHM,
  APP_LOCK_ITERATIONS,
  APP_LOCK_KEY_BYTES,
  APP_LOCK_MAX_PASSWORD_LENGTH,
  APP_LOCK_MIN_PASSWORD_LENGTH,
  appPasswordPolicyError,
  generateAppPassword,
  isAppLockProvisioning,
  isValidAppPassword,
  type AppLockProvisioning,
} from "../lib/app-lock/shared"
import { verifyAppLockPassword } from "../lib/app-lock/verification"
import { appLockProvisioningDecision } from "../lib/app-lock/provisioning-policy"
import {
  APP_LOCK_STATES,
  appLockStateFrom,
  transitionAppLockState,
} from "../lib/app-lock/state"
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
assert.equal(APP_LOCK_MAX_PASSWORD_LENGTH, 64, "The app-access password maximum must remain 64 characters.")

for (const password of [
  "123456",
  "000000",
  "001234",
  "999999999999",
  "abc123",
  "ABC123",
  "Bezgrow2026",
  "a1b2c3",
]) {
  assert.equal(appPasswordPolicyError(password), null, `${JSON.stringify(password)} must satisfy the canonical password rule.`)
  assert.equal(isValidAppPassword(password), true)
}

for (const password of [
  "12345",
  "abc12",
  "abcdef",
  "ABCDEF",
  "abc def",
  "123 456",
  "abc@123",
  "123456!",
  "",
]) {
  assert.notEqual(appPasswordPolicyError(password), null, `${JSON.stringify(password)} must fail the canonical password rule.`)
  assert.equal(isValidAppPassword(password), false)
}

assert.equal(appPasswordPolicyError("12345"), "Password must contain at least 6 characters.")
assert.equal(appPasswordPolicyError("abc@123"), "Password can contain only letters and numbers.")
assert.equal(appPasswordPolicyError("abcdef"), "Use either numbers only or include at least one number with the letters.")
assert.equal(appPasswordPolicyError(`A1${"a".repeat(62)}`), null, "A 64-character password must be accepted.")
assert.equal(appPasswordPolicyError(`A1${"a".repeat(63)}`), "Password must contain no more than 64 characters.")
for (let index = 0; index < 256; index += 1) {
  const generated = generateAppPassword()
  assert.equal(isValidAppPassword(generated), true, "Every generated password must satisfy the canonical rule.")
  assert.ok(generated.length >= 10 && generated.length <= 14, "Generated passwords must remain readable in length.")
  assert.doesNotMatch(generated, /[O0Iil1]/, "Generated passwords should omit confusing characters.")
}

const leadingZeroPassword = "001234"
const leadingZeroCredential = provisioning(leadingZeroPassword)
assert.equal(await verifyAppLockPassword(leadingZeroPassword, leadingZeroCredential), true, "Leading zeroes must be preserved during verification.")
assert.equal(await verifyAppLockPassword("1234", leadingZeroCredential), false, "A numeric password must never be parsed as a number.")
assert.equal(await verifyAppLockPassword(leadingZeroPassword, JSON.parse(JSON.stringify(leadingZeroCredential))), true, "Leading zeroes must survive app restart persistence.")
const caseSensitiveCredential = provisioning("ABC123")
assert.equal(await verifyAppLockPassword("ABC123", caseSensitiveCredential), true, "Password case must be preserved exactly.")
assert.equal(await verifyAppLockPassword("abc123", caseSensitiveCredential), false, "Password verification must remain case-sensitive.")
const completedResetCredential = JSON.parse(JSON.stringify(provisioning("654321"))) as AppLockProvisioning
assert.equal(await verifyAppLockPassword("654321", completedResetCredential), true, "The reset password must work after app restart.")
assert.equal(await verifyAppLockPassword("001234", completedResetCredential), false, "The old password must stop working after reset completion.")
assert.equal(
  await verifyAppLockPassword("654321", { ...completedResetCredential, device_id: "BZG-ANOTHER-DEVICE-0002" }),
  false,
  "The reset password verifier must remain bound to the target Device ID.",
)
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

let regressionState = appLockStateFrom({ licenceValid: true, credentialExists: false })
assert.equal(regressionState, APP_LOCK_STATES.provisioningRequired, "A licensed device without a local verifier must require provisioning.")
assert.equal(
  appLockProvisioningDecision({
    appLock: signedReset,
    expectedDeviceId: deviceId,
    licenseId,
    businessId,
    existing: null,
    watermark: null,
    nowMs: Date.parse("2026-08-24T00:10:00.000Z"),
  }),
  "apply",
  "A fresh device-bound reset credential must be accepted for secure installation.",
)
const persistedReset = JSON.parse(JSON.stringify(signedReset)) as AppLockProvisioning
regressionState = transitionAppLockState(regressionState, "CREDENTIAL_INSTALLED")
assert.equal(regressionState, APP_LOCK_STATES.locked, "Installing a verified credential must immediately leave provisioning and enter LOCKED.")
regressionState = transitionAppLockState(regressionState, "PASSWORD_REJECTED")
assert.equal(regressionState, APP_LOCK_STATES.locked, "A wrong password must keep the device locked.")
assert.equal(await verifyAppLockPassword("WrongReset7", persistedReset), false)
assert.equal(await verifyAppLockPassword("ResetSecure7", persistedReset), true)
regressionState = transitionAppLockState(regressionState, "PASSWORD_ACCEPTED")
assert.equal(regressionState, APP_LOCK_STATES.unlocked, "The new password must unlock without reloading the app.")
const restartedState = appLockStateFrom({ licenceValid: true, credentialExists: Boolean(persistedReset) })
assert.equal(restartedState, APP_LOCK_STATES.locked, "Restart and update must reuse the persisted credential and return to LOCKED.")
assert.equal(await verifyAppLockPassword("ResetSecure7", JSON.parse(JSON.stringify(persistedReset))), true, "Offline restart must verify using only the persisted local credential.")
assert.equal(appLockStateFrom({ licenceValid: false, credentialExists: true }), APP_LOCK_STATES.noValidLicence, "An app password must never bypass an invalid licence.")

const originalPasswordCredential = provisioning("123456")
originalPasswordCredential.issued_at = "2026-08-23T00:00:00.000Z"
const replacementPasswordCredential: AppLockProvisioning = {
  ...provisioning("ABC123"),
  reset_authorization: signedReset.reset_authorization,
}
assert.equal(
  appLockProvisioningDecision({
    appLock: replacementPasswordCredential,
    expectedDeviceId: deviceId,
    licenseId,
    businessId,
    existing: { ...originalPasswordCredential, license_id: licenseId, business_id: businessId },
    watermark: { ...originalPasswordCredential, license_id: licenseId, business_id: businessId },
    nowMs: Date.parse("2026-08-24T00:10:00.000Z"),
  }),
  "apply",
  "A fresh admin reset must replace the old credential for the same licence and Device ID.",
)
assert.equal(await verifyAppLockPassword("123456", replacementPasswordCredential), false, "The original password must fail after reset.")
assert.equal(await verifyAppLockPassword("ABC123", replacementPasswordCredential), true, "The replacement password must unlock after reset.")
for (const state of [APP_LOCK_STATES.noValidLicence, APP_LOCK_STATES.provisioningRequired]) {
  assert.equal(transitionAppLockState(state, "PASSWORD_REJECTED"), state, "A stale rejection must never bypass licence or credential gating.")
  assert.equal(transitionAppLockState(state, "PASSWORD_ACCEPTED"), state, "Only LOCKED can accept a password.")
}
assert.equal(transitionAppLockState(APP_LOCK_STATES.unlocked, "CREDENTIAL_INSTALLED"), APP_LOCK_STATES.locked, "A reset must lock an already-unlocked workspace.")

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
const adminLicensePage = read("app/admin/licenses/page.tsx")
const adminLicenseDialog = read("components/admin/LicenseActionDialog.tsx")
const nativeManifest = read("src-tauri/Cargo.toml")
const native = read("src-tauri/src/lib.rs")
assert.match(nativeManifest, /keyring = \{[^\n]*features = \["apple-native", "windows-native"\]/, "Both native backends must be explicitly enabled; keyring v3 otherwise uses a nonpersistent mock.")
assert.match(native, /get_credential\(\)\.is::<keyring::mock::MockCredential>\(\)/, "Native code must fail closed if the wrong backend is compiled.")
assert.match(client, /const persisted = await readCredential\(\)/, "Installation must verify read-back before dispatching readiness.")

assert.match(server, /pbkdf2Sync[\s\S]*APP_LOCK_ITERATIONS[\s\S]*sha256/, "Initial passwords must become salted one-way verifiers on the server.")
assert.match(client, /store_secret[\s\S]*APP_LOCK_SECRET_KEY/, "The local verifier must use the OS credential store, not SQLite business data.")
assert.match(client + provisioningPolicy, /APP_LOCK_WATERMARK_KEY[\s\S]*watermarkRecognizesSignedCredential/, "A non-secret persistence watermark must prevent an update or keychain loss from rolling a locally changed password back to the initial signed verifier.")
assert.match(client, /setOfflineMeta\(APP_LOCK_WATERMARK_KEY, JSON\.stringify\(watermark\), "global"\)/, "The non-secret object watermark must be serialized into normalized SQLite metadata instead of becoming a NULL row.")
assert.doesNotMatch(client, /putOfflineData|localStorage\.setItem\([^\n]*password/, "The app password must not enter SQLite or browser storage.")
assert.doesNotMatch(
  [client, gate, settings, adminLicensePage, adminLicenseDialog, adminRoute].join("\n"),
  /(?:parseInt|Number)\([^\n)]*(?:password|appPassword|app_password)/i,
  "Passwords must never be converted to numbers.",
)
assert.doesNotMatch(adminLicensePage + adminLicenseDialog, /function generateAppPassword/, "Admin screens must use the canonical shared generator.")
assert.match(localLicense, /verifyLicenseSignature[\s\S]*provisionAppLockFromLicense/, "Only a verified signed licence may provision App Lock.")
assert.match(localLicense, /reconcileLocalAppLockCredential[\s\S]*verifyLicenseSignature[\s\S]*isAppLockProvisioning[\s\S]*provisionAppLockFromLicense/, "A locally stored verified licence must repair a missing secure credential even when control-plane check-in returns the same signed key.")
assert.match(adminRoute, /createAppLockProvisioning\(input\.app_password, input\.device_id\)/, "Licence generation must provision the first device password.")
assert.match(adminRoute, /APP_PASSWORD_RESET_AUTHORIZED/, "The control plane must expose an explicit audited password-reset action.")
assert.match(resetMigration, /pg_advisory_xact_lock[\s\S]*admin_license_mutations[\s\S]*license_events[\s\S]*admin_audit_logs/, "Password reset must be atomic, idempotent, and audited.")
assert.match(resetMigration, /service_role/, "Only the server-side service role may execute reset authorization.")
assert.doesNotMatch(resetMigration, /plaintext_password|password_hash\s+(?:text|varchar)/i, "The reset control plane must not add a plaintext or reusable password column.")

assert.match(gate, /GateState = AppLockState \| "CHECKING" \| "FAILED"/, "ERP content must remain unmounted until the explicit App Lock state machine succeeds.")
assert.match(gate, /revalidateLocalLicenseWithControlPlane/, "The provisioning screen must fetch the authoritative refreshed signed licence.")
assert.match(gate, /window\.addEventListener\("online"[\s\S]*window\.addEventListener\("focus"[\s\S]*setInterval\(refreshWhenAvailable, 30_000\)/, "Provisioning must retry automatically at startup, on reconnect, on return from Platform Admin, and while waiting.")
assert.match(gate, /Refresh App Lock[\s\S]*Import \/ Refresh Licence/, "Provisioning must expose both secure online refresh and signed licence import recovery actions.")
assert.match(gate, /Credential received\.[\s\S]*Installing secure credential…[\s\S]*App Lock ready\./, "Provisioning must expose useful credential delivery and installation statuses.")
assert.match(gate, /Enter App Password[\s\S]*Forgot password\? Contact your administrator\./, "The locked state must render the production password-entry screen.")
assert.doesNotMatch(gate, /location\.reload|router\.refresh/, "App Lock provisioning and unlock must not reload the application.")
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
