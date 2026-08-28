import { isCanonicalDateTimeInput } from "@/lib/time/canonical"

export const APP_LOCK_ALGORITHM = "pbkdf2-sha256" as const
export const APP_LOCK_ITERATIONS = 600_000
export const APP_LOCK_KEY_BYTES = 32
export const APP_LOCK_MIN_PASSWORD_LENGTH = 6
export const APP_LOCK_MAX_PASSWORD_LENGTH = 64
export const APP_LOCK_PASSWORD_HELP = "Use at least 6 characters. Use either numbers only, or a combination of letters and numbers."

const APP_LOCK_PASSWORD_CHARACTERS = /^[A-Za-z0-9]+$/
const APP_LOCK_PASSWORD_HAS_LETTER = /[A-Za-z]/
const APP_LOCK_PASSWORD_HAS_NUMBER = /[0-9]/
const GENERATED_PASSWORD_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz"
const GENERATED_PASSWORD_NUMBERS = "23456789"
const GENERATED_PASSWORD_CHARACTERS = `${GENERATED_PASSWORD_LETTERS}${GENERATED_PASSWORD_NUMBERS}`
const GENERATED_PASSWORD_LENGTH = 12

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
    return `Password must contain at least ${APP_LOCK_MIN_PASSWORD_LENGTH} characters.`
  }
  if (password.length > APP_LOCK_MAX_PASSWORD_LENGTH) {
    return `Password must contain no more than ${APP_LOCK_MAX_PASSWORD_LENGTH} characters.`
  }
  if (!APP_LOCK_PASSWORD_CHARACTERS.test(password)) {
    return "Password can contain only letters and numbers."
  }
  if (APP_LOCK_PASSWORD_HAS_LETTER.test(password) && !APP_LOCK_PASSWORD_HAS_NUMBER.test(password)) {
    return "Use either numbers only or include at least one number with the letters."
  }
  return null
}

export function isValidAppPassword(password: string) {
  return appPasswordPolicyError(password) === null
}

function secureRandomIndex(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
    throw new Error("Secure password generation received an invalid character set.")
  }
  const bytes = new Uint8Array(1)
  const unbiasedCeiling = Math.floor(256 / limit) * limit
  do {
    globalThis.crypto.getRandomValues(bytes)
  } while (bytes[0] >= unbiasedCeiling)
  return bytes[0] % limit
}

function secureRandomCharacter(alphabet: string) {
  return alphabet[secureRandomIndex(alphabet.length)]
}

export function generateAppPassword() {
  const characters = [
    secureRandomCharacter(GENERATED_PASSWORD_LETTERS),
    secureRandomCharacter(GENERATED_PASSWORD_NUMBERS),
    ...Array.from(
      { length: GENERATED_PASSWORD_LENGTH - 2 },
      () => secureRandomCharacter(GENERATED_PASSWORD_CHARACTERS),
    ),
  ]
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = secureRandomIndex(index + 1)
    const character = characters[index]
    characters[index] = characters[swapIndex]
    characters[swapIndex] = character
  }
  const password = characters.join("")
  if (!isValidAppPassword(password)) throw new Error("Secure password generation failed validation.")
  return password
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
