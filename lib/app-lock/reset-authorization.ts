import { canonicalUtcDateTime } from "@/lib/time/canonical"
import type { AppLockProvisioning } from "@/lib/app-lock/shared"

export const APP_LOCK_RESET_AUTHORIZATION_TTL_MS = 30 * 60_000

export function createAppLockResetAuthorization(id: string, serverNow = new Date()) {
  if (id.trim().length < 8) throw new Error("A valid reset authorization ID is required.")
  const issuedAt = canonicalUtcDateTime(serverNow)
  return {
    id,
    issued_at: issuedAt,
    expires_at: new Date(Date.parse(issuedAt) + APP_LOCK_RESET_AUTHORIZATION_TTL_MS).toISOString(),
  } satisfies NonNullable<AppLockProvisioning["reset_authorization"]>
}
