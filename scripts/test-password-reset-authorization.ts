import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createAppLockResetAuthorization, APP_LOCK_RESET_AUTHORIZATION_TTL_MS } from "../lib/app-lock/reset-authorization"
import { isAppLockProvisioning, type AppLockProvisioning } from "../lib/app-lock/shared"
import { appLockProvisioningDecision } from "../lib/app-lock/provisioning-policy"
import { licenseAuditSnapshot } from "../lib/license/admin-license-actions"
import { updateLicenseSchema } from "../lib/license/admin-license-validation"
import { canonicalUtcDateTime, timestampsRepresentSameInstant } from "../lib/time/canonical"

const commonReset = {
  id: "LIC-RESET-DATETIME-0001",
  action: "reset_app_password" as const,
  idempotency_key: "reset-request-0001",
  reason: "Customer-authorized recovery",
  app_password: "Replacement9Password",
}

const acceptedTimestamps = [
  ["UTC with milliseconds", "2026-08-26T07:55:00.000Z", "2026-08-26T07:55:00.000Z"],
  ["UTC without milliseconds", "2026-08-26T07:55:00Z", "2026-08-26T07:55:00.000Z"],
  ["IST client", "2026-08-26T13:25:00.000+05:30", "2026-08-26T07:55:00.000Z"],
  ["negative offset client", "2026-08-26T02:55:00.000-05:00", "2026-08-26T07:55:00.000Z"],
  ["DST offset client", "2026-08-26T03:55:00.000-04:00", "2026-08-26T07:55:00.000Z"],
  ["Postgres microseconds", "2026-08-26T07:55:00.123456+00:00", "2026-08-26T07:55:00.123Z"],
  ["positive offset boundary", "2026-08-26T07:55:00+14:00", "2026-08-25T17:55:00.000Z"],
  ["negative offset boundary", "2026-08-26T07:55:00-12:00", "2026-08-26T19:55:00.000Z"],
  ["valid leap day", "2028-02-29T23:59:59Z", "2028-02-29T23:59:59.000Z"],
  ["year boundary", "2026-12-31T23:59:59Z", "2026-12-31T23:59:59.000Z"],
] as const

for (const [name, input, expected] of acceptedTimestamps) {
  const parsed = updateLicenseSchema.safeParse({ ...commonReset, expected_updated_at: input })
  assert.equal(parsed.success, true, `${name} must be accepted.`)
  if (parsed.success) assert.equal(parsed.data.expected_updated_at, expected, `${name} must normalize to UTC.`)
  assert.equal(canonicalUtcDateTime(input), expected)
}

for (const input of [
  "",
  "26/08/2026 1:25 PM",
  "2026-08-26 07:55:00+00",
  "2026-02-29T00:00:00Z",
  "2026-04-31T00:00:00Z",
  "2026-08-26T07:55:00",
  "not-a-date",
]) {
  assert.equal(
    updateLicenseSchema.safeParse({ ...commonReset, expected_updated_at: input }).success,
    false,
    `Malformed or ambiguous datetime ${JSON.stringify(input)} must be rejected.`,
  )
}
assert.equal(updateLicenseSchema.safeParse(commonReset).success, false, "A missing concurrency timestamp must be rejected.")
assert.equal(
  timestampsRepresentSameInstant("2026-08-26T13:25:00.000+05:30", "2026-08-26T07:55:00.000Z"),
  true,
  "Concurrency checks must compare instants rather than serialized offset text.",
)

const serverNow = new Date("2026-08-26T07:55:00.000Z")
const reset = createAppLockResetAuthorization("reset-auth-0001", serverNow)
assert.deepEqual(reset, {
  id: "reset-auth-0001",
  issued_at: "2026-08-26T07:55:00.000Z",
  expires_at: "2026-08-26T08:25:00.000Z",
})
assert.equal(Date.parse(reset.expires_at) - Date.parse(reset.issued_at), APP_LOCK_RESET_AUTHORIZATION_TTL_MS)

const provisioning: AppLockProvisioning = {
  version: 1,
  algorithm: "pbkdf2-sha256",
  iterations: 600_000,
  salt: "c2FsdC1ieXRlcy1mb3ItcmVzZXQ",
  verifier: "dmVyaWZpZXItYnl0ZXMtZm9yLWRldmljZS1ib3VuZC1yZXNldA",
  device_id: "BZG-RESET-DEVICE-0001",
  credential_id: "reset-credential-0001",
  issued_at: reset.issued_at,
  reset_authorization: reset,
}
assert.equal(isAppLockProvisioning(provisioning), true, "A canonical reset provisioning payload must be accepted.")
assert.equal(
  isAppLockProvisioning({ ...provisioning, reset_authorization: { ...reset, expires_at: "2026-08-26 08:25:00" } }),
  false,
  "Offset-less reset expiry must not enter the signed credential contract.",
)
assert.equal(
  isAppLockProvisioning({ ...provisioning, reset_authorization: { ...reset, expires_at: reset.issued_at } }),
  false,
  "Reset expiry must be after issuance.",
)

const binding = {
  license_id: "LIC-RESET-DATETIME-0001",
  business_id: "BUSINESS-RESET-0001",
  credential_id: "previous-credential-0001",
  applied_reset_authorization_id: null,
}
const decisionInput = {
  appLock: provisioning,
  expectedDeviceId: provisioning.device_id,
  licenseId: binding.license_id,
  businessId: binding.business_id,
  existing: binding,
  watermark: binding,
}
assert.equal(
  appLockProvisioningDecision({ ...decisionInput, nowMs: Date.parse("2026-08-26T08:24:59.999Z") }),
  "apply",
  "A fresh reset must apply to its signed licence, business, and device binding.",
)
assert.throws(
  () => appLockProvisioningDecision({ ...decisionInput, expectedDeviceId: "BZG-OTHER-DEVICE-0002", nowMs: Date.parse("2026-08-26T08:00:00Z") }),
  /another device/,
  "A reset for Device A must fail on Device B.",
)
assert.throws(
  () => appLockProvisioningDecision({ ...decisionInput, nowMs: Date.parse(reset.expires_at) }),
  /expired/,
  "An unapplied reset must fail at its expiry boundary.",
)
const consumedBinding = { ...binding, credential_id: provisioning.credential_id, applied_reset_authorization_id: reset.id }
assert.equal(
  appLockProvisioningDecision({
    ...decisionInput,
    existing: consumedBinding,
    watermark: consumedBinding,
    nowMs: Date.parse("2026-08-26T08:00:00Z"),
  }),
  "ignore",
  "A consumed reset must not overwrite the credential a second time.",
)
assert.equal(
  appLockProvisioningDecision({
    ...decisionInput,
    existing: null,
    watermark: consumedBinding,
    nowMs: Date.parse("2026-08-26T08:00:00Z"),
  }),
  "ignore",
  "The durable non-secret watermark must block replay after keychain loss.",
)
assert.equal(
  appLockProvisioningDecision({
    ...decisionInput,
    existing: null,
    watermark: consumedBinding,
    nowMs: Date.parse("2026-08-26T09:00:00Z"),
  }),
  "ignore",
  "An already-consumed signed reset remains harmless after expiry and restart.",
)

const route = readFileSync("app/api/admin/licenses/route.ts", "utf8")
const client = readFileSync("lib/app-lock/client.ts", "utf8")
const provisioningPolicy = readFileSync("lib/app-lock/provisioning-policy.ts", "utf8")
const safeAudit = licenseAuditSnapshot({
  id: binding.license_id,
  device_id: provisioning.device_id,
  app_password: commonReset.app_password,
  salt: provisioning.salt,
  verifier: provisioning.verifier,
  signed_license_key: "must-not-enter-audit",
})
assert.match(route, /createAppLockResetAuthorization\(crypto\.randomUUID\(\), new Date\(changedAt\)\)/, "The API must derive reset validity from its server timestamp.")
assert.doesNotMatch(route, /Date\.now\(\)\s*\+\s*30\s*\*\s*60_000/, "Reset expiry must not use an unrelated clock read.")
assert.match(client, /appLockProvisioningDecision[\s\S]*decision === "ignore"[\s\S]*return \{ provisioned: false, resetApplied: false \}/, "The desktop import path must enforce the tested reset policy.")
assert.match(provisioningPolicy, /resetWasAlreadyApplied[\s\S]*applied_reset_authorization_id[\s\S]*return "ignore"/, "Consumed reset authorizations must not be replayed from the same signed licence.")
assert.match(provisioningPolicy, /if \(reset && !freshReset\)[\s\S]*authorization has expired/, "An unapplied expired reset must be rejected.")
assert.deepEqual(Object.keys(safeAudit).sort(), ["device_id", "id"], "Audit snapshots must not contain password reset material.")
assert.doesNotMatch(route, /console\.(?:log|warn|error)\([^\n]*app_password/, "The route must not log the plaintext replacement password.")

console.log(`password-reset-authorization-ok timestamps=${acceptedTimestamps.length} ttl_ms=${APP_LOCK_RESET_AUTHORIZATION_TTL_MS} canonical=UTC replay=blocked`)
