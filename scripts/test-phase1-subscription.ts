import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { localMigrations, LOCAL_DB_VERSION } from "../lib/offline/local/schema"
import { phase1BusinessOnboardingSchema } from "../lib/onboarding/validation"
import { evaluateStoredLicense } from "../lib/license/policy"
import { canonicalLicenseText, encodeLicenseKey, type LicensePayload } from "../lib/license/codec"
import { verifyStoredLicenseRows } from "../lib/license/verification"

async function main() {
const read = (path: string) => readFileSync(path, "utf8")
const migration = read("supabase/migrations/20260908101925_phase1_trial_entitlements.sql")
const endpoint = read("app/api/entitlements/onboard/route.ts")
const onboarding = read("lib/onboarding/local.ts")
const startup = read("lib/startup/state-machine.ts")
const localApi = read("lib/offline/local/api.ts")
const appLockGate = read("components/security/AppLockGate.tsx")
const subscription = read("app/subscription/page.tsx")
const nativeRuntime = read("src-tauri/src/lib.rs")

assert.match(migration, /clock_timestamp\(\)[\s\S]*interval '30 days'/, "Trial timestamps must be computed by the database server.")
assert.match(migration, /entitlements_one_self_service_trial_per_device/, "A device must not receive a second self-service trial.")
assert.match(migration, /where platform_customer_id = customer_record\.id[\s\S]*status not in \('draft', 'replaced'\)/, "A legacy or support-entitled customer must not be forced into a second trial.")
assert.match(migration, /pg_advisory_xact_lock/, "Concurrent retries must serialize per device.")
assert.match(migration, /idempotency_key[\s\S]*on conflict/, "The trial workflow must be idempotent and migrate legacy licences.")
assert.match(migration, /provider_customer_id text[\s\S]*provider_subscription_id/, "Provider identifiers must exist but remain nullable for Phase 2.")
assert.match(migration, /force row level security[\s\S]*revoke all[\s\S]*service_role/, "Control-plane metadata must be fail-closed to customer roles.")
assert.match(migration, /source <> 'self_service_trial'[\s\S]*trial_ends_at = valid_until/, "Trial entitlement records must carry coherent authoritative intervals.")
assert.doesNotMatch(migration, /create table[^;]*public\.(?:products|sales_invoices|inventory_items|customers)\s*\(/i, "The subscription migration must not reintroduce cloud ERP tables.")

assert.match(endpoint, /signInWithPassword[\s\S]*auth\.signUp[\s\S]*email_verification_required/, "Account creation must use genuine password authentication and resumable email confirmation.")
assert.doesNotMatch(endpoint, /email_confirm\s*:\s*true/, "Self-service onboarding must not fabricate verified email ownership.")
assert.match(endpoint, /verifyOnboardingDeviceProof[\s\S]*idempotency-key/, "Onboarding must be bound to the native installation proof and saved retry key.")
assert.match(endpoint, /begin_phase1_trial[\s\S]*signLicensePayload[\s\S]*signed_entitlement/, "Only the server route may turn authoritative trial rows into a signed local entitlement.")
assert.doesNotMatch(onboarding, /request_json[^\n]*password|JSON\.stringify\([^)]*password/, "The account password must not enter the local recovery record.")
assert.match(onboarding, /const \{ password: _password, termsAccepted: _termsAccepted, \.\.\.safe \}/, "Local staging must explicitly strip account secrets.")
assert.match(onboarding, /financial_years[\s\S]*DEFAULT_ACCOUNTS[\s\S]*accounting_settings[\s\S]*INITIALIZED/, "A fresh empty business must initialize a balanced accounting foundation.")
assert.match(onboarding, /onboarding_attempts[\s\S]*LOCAL_READY/, "A failed online step must remain recoverable from local staging.")

assert.match(startup, /BUSINESS_ONBOARDING_REQUIRED[\s\S]*ACCOUNT_REQUIRED[\s\S]*ENTITLEMENT_REQUIRED[\s\S]*APP_LOCK_REQUIRED[\s\S]*READ_ONLY_EXPIRED[\s\S]*RECOVERY_REQUIRED/, "Startup must use explicit deterministic states.")
assert.match(startup, /read-only:/, "Expired access must require an explicit per-session read-only continuation.")
assert.match(localApi, /mutation = !\["GET", "HEAD", "OPTIONS"\][\s\S]*assertLocalWriteAllowed/, "Every local API mutation must pass through the central entitlement guard.")
assert.match(appLockGate, /licenceValid: true/, "App Lock must remain independent from subscription state.")
assert.match(subscription, /Continue read-only/, "Expiry UX must preserve reads.")
assert.match(subscription, /Online payment is not available in this release/, "Subscription UX must state that payment is not yet available.")
assert.match(nativeRuntime, /authorize_desktop_statement[\s\S]*decode_native_entitlement[\s\S]*entitlement_deadline/, "Native SQLite mutations must verify the signed entitlement and precise deadline.")

const validInput = {
  localBusinessId: "11111111-1111-4111-8111-111111111111",
  idempotencyKey: "22222222-2222-4222-8222-222222222222",
  ownerName: "Asha Mehta", email: "ASHA@example.com", mobile: "+91 98765 43210", password: "Strong123",
  businessName: "Asha Traders", businessType: "Proprietorship", industry: "Retail", gstRegistered: true,
  gstin: "27AAPFU0939F1ZV", pan: "AAPFU0939F", address: "12 Market Road", city: "Pune", state: "Maharashtra",
  postalCode: "411001", financialYearStartMonth: 4, invoicePrefix: "INV", deviceId: "BZG-PHASE1-DEVICE-0001",
  platform: "macos" as const, architecture: "arm64" as const, appVersion: "0.3.1", termsAccepted: true as const,
}
const validation = phase1BusinessOnboardingSchema.safeParse(validInput)
assert.equal(validation.success, true, validation.success ? "" : validation.error.issues.map((issue) => issue.message).join(", "))
if (validation.success) {
  assert.equal(validation.data.email, "asha@example.com")
  assert.equal(validation.data.mobile, "9876543210")
}
assert.equal(phase1BusinessOnboardingSchema.safeParse({ ...validInput, gstin: "27AAPFU0939F1ZA" }).success, false, "A bad GSTIN checksum must fail.")
assert.equal(phase1BusinessOnboardingSchema.safeParse({ ...validInput, gstRegistered: true, gstin: "" }).success, false, "GSTIN is mandatory when GST registered.")

const deviceId = validInput.deviceId
const baseRow = {
  id: "trial_test", license_key: "signed", status: "trial", device_id: deviceId,
  expiry_date: "2099-01-01", grace_period_days: 0, allowed_features: '["accounting","invoices"]',
  issued_at: "2026-09-08T10:00:00.000Z", last_verified_at: "2026-09-08T10:00:00.000Z",
  server_verified_at: "2026-09-08T10:00:00.000Z", valid_until: "2026-10-08T10:00:00.000Z",
}
assert.equal(evaluateStoredLicense([baseRow], { deviceId, now: new Date("2026-10-08T09:59:59.000Z") }).allowed, true)
assert.equal(evaluateStoredLicense([baseRow], { deviceId, now: new Date("2026-10-08T10:00:00.000Z") }).status, "expired", "Writes must stop at the exact signed expiry instant.")
assert.equal(evaluateStoredLicense([baseRow], { deviceId, now: new Date("2026-10-08T10:00:00.001Z") }).status, "expired", "Precise signed valid_until must override the date-only legacy field.")
assert.equal(evaluateStoredLicense([{ ...baseRow, server_verified_at: "2026-10-09T10:00:00.000Z" }], { deviceId, now: new Date("2026-10-08T10:00:00.000Z") }).status, "clock_rollback")

const keypair = generateKeyPairSync("ed25519")
const publicJwk = keypair.publicKey.export({ format: "jwk" }) as JsonWebKey
const signedPayload: LicensePayload = {
  schema_version: 1,
  license_id: "trial-business-binding",
  customer_id: "customer-a",
  customer_name: "Asha",
  customer_email: null,
  business_id: validInput.localBusinessId,
  business_name: validInput.businessName,
  device_id: deviceId,
  plan_name: "Bezgrow Monthly",
  expiry_date: "2099-01-01",
  grace_period_days: 0,
  allowed_features: ["accounting", "invoices"],
  issued_by_admin: "test",
  issued_at: "2026-09-08T10:00:00.000Z",
  signature_algorithm: "ed25519",
  issuer_key_id: "test-key",
  entitlement_source: "self_service_trial",
  entitlement_status: "trialing",
  valid_from: "2026-09-08T10:00:00.000Z",
  valid_until: "2099-01-01T00:00:00.000Z",
  notes: null,
}
const signature = sign(null, Buffer.from(canonicalLicenseText(signedPayload)), keypair.privateKey)
const signedLicenseKey = encodeLicenseKey(signedPayload, signature)
const signedRow = { ...baseRow, id: signedPayload.license_id, license_key: signedLicenseKey }
assert.equal((await verifyStoredLicenseRows([signedRow], {
  publicKey: String(publicJwk.x), deviceId, expectedBusinessId: validInput.localBusinessId,
})).length, 1, "The matching business/device signature must be accepted.")
assert.equal((await verifyStoredLicenseRows([signedRow], {
  publicKey: String(publicJwk.x), deviceId, expectedBusinessId: "another-business",
})).length, 0, "A valid global cache row must not authorize another business.")

assert.equal(LOCAL_DB_VERSION, 23)
const database = new DatabaseSync(":memory:")
database.exec("PRAGMA foreign_keys = ON")
for (const migrationStep of localMigrations) {
  for (const statement of migrationStep.sql) {
    try { database.exec(statement) }
    catch (error) {
      if (!/^ALTER\s+TABLE/i.test(statement) || !/duplicate column name/i.test(String(error))) throw error
    }
  }
}
const columns = (table: string) => new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name))
assert.ok(columns("organizations").has("platform_business_id"))
assert.ok(columns("license_state").has("valid_until"))
assert.ok(columns("license_state").has("server_verified_at"))
assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_attempts'").get()?.name, "onboarding_attempts")
assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0)
database.close()

console.log("phase1-subscription-ok server_time=authoritative trial=30d local_erp=true read_only=true app_lock=independent migration=v23")
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
