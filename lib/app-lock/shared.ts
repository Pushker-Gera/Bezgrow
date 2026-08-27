import { isCanonicalDateTimeInput } from "@/lib/time/canonical"

export const APP_LOCK_ALGORITHM = "pbkdf2-sha256" as const
export const APP_LOCK_ITERATIONS = 600_000
export const APP_LOCK_KEY_BYTES = 32
export const APP_LOCK_MIN_PASSWORD_LENGTH = 6

export type AppLockProvisioning = {
  version: 1
  algorithm: typeof APP_LOCK_ALGORITHM
  iterations: number
  salt: string
  verifier: string
  device_id: string
  credential_id: string
  issued_at: string
  reset_authorization?: {
    id: string
    issued_at: string
    expires_at: string
  } | null
}

export function appPasswordPolicyError(password: string) {
  if (password.length < APP_LOCK_MIN_PASSWORD_LENGTH) {
    return `Use at least ${APP_LOCK_MIN_PASSWORD_LENGTH} characters.`
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return "Use at least one uppercase letter, one lowercase letter, and one number."
  }
  return null
}

export function isAppLockProvisioning(value: unknown): value is AppLockProvisioning {
  if (!value || typeof value !== "object") return false
  const row = value as Partial<AppLockProvisioning>
  const reset = row.reset_authorization
  const validReset = reset === undefined || reset === null || (
    typeof reset === "object"
    && typeof reset.id === "string"
    && reset.id.length >= 8
    && isCanonicalDateTimeInput(reset.issued_at)
    && isCanonicalDateTimeInput(reset.expires_at)
    && Date.parse(reset.expires_at) > Date.parse(reset.issued_at)
  )
  return row.version === 1
    && row.algorithm === APP_LOCK_ALGORITHM
    && Number.isInteger(row.iterations)
    && Number(row.iterations) >= 100_000
    && typeof row.salt === "string"
    && row.salt.length >= 16
    && typeof row.verifier === "string"
    && row.verifier.length >= 32
    && typeof row.device_id === "string"
    && row.device_id.length >= 8
    && typeof row.credential_id === "string"
    && row.credential_id.length >= 8
    && isCanonicalDateTimeInput(row.issued_at)
    && validReset
}
