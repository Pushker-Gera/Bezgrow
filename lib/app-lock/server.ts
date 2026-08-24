import "server-only"

import { pbkdf2Sync, randomBytes, randomUUID } from "node:crypto"
import {
  APP_LOCK_ALGORITHM,
  APP_LOCK_ITERATIONS,
  APP_LOCK_KEY_BYTES,
  appPasswordPolicyError,
  type AppLockProvisioning,
} from "@/lib/app-lock/shared"

function passwordMaterial(deviceId: string, password: string) {
  return `${deviceId}\u0000${password}`
}

export function createAppLockProvisioning(
  password: string,
  deviceId: string,
  resetAuthorization?: AppLockProvisioning["reset_authorization"]
): AppLockProvisioning {
  const policyError = appPasswordPolicyError(password)
  if (policyError) throw new Error(policyError)
  if (!deviceId.trim()) throw new Error("Device ID is required for app-lock provisioning.")

  const salt = randomBytes(16)
  const verifier = pbkdf2Sync(
    passwordMaterial(deviceId, password),
    salt,
    APP_LOCK_ITERATIONS,
    APP_LOCK_KEY_BYTES,
    "sha256"
  )

  return {
    version: 1,
    algorithm: APP_LOCK_ALGORITHM,
    iterations: APP_LOCK_ITERATIONS,
    salt: salt.toString("base64url"),
    verifier: verifier.toString("base64url"),
    device_id: deviceId,
    credential_id: randomUUID(),
    issued_at: new Date().toISOString(),
    reset_authorization: resetAuthorization || null,
  }
}
