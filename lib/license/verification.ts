import { parseLicenseInput, verifyLicenseSignature } from "@/lib/license/codec"
import type { StoredLicenseRow } from "@/lib/license/policy"

/**
 * Returns policy rows reconstructed from their signed payloads. Mutable local
 * status fields may make a license more restrictive, but cannot extend its
 * signed expiry, grace period, device, business, or entitlements.
 */
export async function verifyStoredLicenseRows(
  rows: StoredLicenseRow[],
  options: { publicKey: string; deviceId?: string | null; expectedBusinessId?: string | null }
) {
  const verified: StoredLicenseRow[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const licenseKey = typeof row.license_key === "string" ? row.license_key : ""
    if (!licenseKey) continue
    try {
      const parsed = parseLicenseInput(licenseKey)
      if (options.deviceId && parsed.payload.device_id !== options.deviceId) continue
      if (options.expectedBusinessId && parsed.payload.business_id !== options.expectedBusinessId) continue
      if (row.id && row.id !== parsed.payload.license_id) continue
      if (!(await verifyLicenseSignature(parsed, options.publicKey))) continue
      if (seen.has(parsed.payload.license_id)) continue
      seen.add(parsed.payload.license_id)
      verified.push({
        ...row,
        id: parsed.payload.license_id,
        license_key: parsed.licenseKey,
        customer_id: parsed.payload.customer_id,
        business_id: parsed.payload.business_id,
        business_name: parsed.payload.business_name,
        device_id: parsed.payload.device_id,
        plan_name: parsed.payload.plan_name,
        expiry_date: parsed.payload.expiry_date,
        expires_at: parsed.payload.expiry_date,
        grace_period_days: parsed.payload.grace_period_days,
        allowed_features: JSON.stringify(parsed.payload.allowed_features),
        issued_by_admin: parsed.payload.issued_by_admin,
        issued_at: parsed.payload.issued_at,
        signature: parsed.signatureText,
        entitlement_id: parsed.payload.entitlement_id,
        entitlement_source: parsed.payload.entitlement_source,
        entitlement_status: parsed.payload.entitlement_status,
        subscription_id: parsed.payload.subscription_id,
        trial_started_at: parsed.payload.trial_started_at,
        trial_ends_at: parsed.payload.trial_ends_at,
        valid_from: parsed.payload.valid_from,
        valid_until: parsed.payload.valid_until,
        last_verified_at: newestCheckpoint(row.last_verified_at, parsed.payload.server_verified_at, parsed.payload.issued_at),
        server_verified_at: newestCheckpoint(row.server_verified_at, parsed.payload.server_verified_at),
      })
    } catch {
      // Invalid persisted rows are ignored and cannot authorize local writes.
    }
  }

  return verified
}

function newestCheckpoint(...values: unknown[]) {
  return values
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null
}
