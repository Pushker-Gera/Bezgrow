import type { AppLockProvisioning } from "@/lib/app-lock/shared"

export type AppLockBindingMarker = {
  license_id: string
  business_id: string
  credential_id: string
  issued_at?: string | null
  applied_reset_authorization_id?: string | null
}

export function appLockProvisioningDecision(input: {
  appLock: AppLockProvisioning
  expectedDeviceId: string
  licenseId: string
  businessId: string
  existing: AppLockBindingMarker | null
  watermark: AppLockBindingMarker | null
  nowMs?: number
}) {
  const { appLock, expectedDeviceId, licenseId, businessId, existing, watermark } = input
  if (appLock.device_id !== expectedDeviceId) {
    throw new Error("The app-access credential was issued for another device.")
  }

  const nowMs = input.nowMs ?? Date.now()
  const sameLicenseBinding = existing?.license_id === licenseId && existing?.business_id === businessId
  const sameWatermarkBinding = watermark?.license_id === licenseId && watermark?.business_id === businessId
  const watermarkRecognizesSignedCredential = sameWatermarkBinding && watermark?.credential_id === appLock.credential_id
  const reset = appLock.reset_authorization
  const freshReset = Boolean(reset && Date.parse(reset.expires_at) > nowMs)
  const resetWasAlreadyApplied = Boolean(
    reset?.id
      && (
        (sameLicenseBinding && existing?.applied_reset_authorization_id === reset.id)
        || (sameWatermarkBinding && watermark?.applied_reset_authorization_id === reset.id)
      )
  )

  if (resetWasAlreadyApplied) return "ignore" as const
  const installedIssuedAt = Math.max(
    sameLicenseBinding ? Date.parse(existing?.issued_at || "") || 0 : 0,
    sameWatermarkBinding ? Date.parse(watermark?.issued_at || "") || 0 : 0,
  )
  if (reset && installedIssuedAt && Date.parse(reset.issued_at) <= installedIssuedAt) {
    // Concurrent/reordered refresh responses must not roll a newer reset or
    // a local password change back to an older, still-unexpired reset.
    return "ignore" as const
  }
  if (reset && !freshReset) {
    throw new Error("This app-password reset authorization has expired. Ask the platform administrator to issue a new reset.")
  }
  if (!existing && sameWatermarkBinding && !watermarkRecognizesSignedCredential && !freshReset) {
    throw new Error("The locally changed app password cannot be recovered from this older signed licence. Ask the platform administrator to authorize an App Password reset.")
  }
  if (sameLicenseBinding && !freshReset) return "ignore" as const
  return "apply" as const
}
