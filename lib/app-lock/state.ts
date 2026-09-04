export const APP_LOCK_STATES = {
  noValidLicence: "NO_VALID_LICENCE",
  provisioningRequired: "PROVISIONING_REQUIRED",
  locked: "LOCKED",
  unlocked: "UNLOCKED",
} as const

export type AppLockState = typeof APP_LOCK_STATES[keyof typeof APP_LOCK_STATES]

export type AppLockEvent =
  | "LICENCE_INVALID"
  | "CREDENTIAL_MISSING"
  | "CREDENTIAL_INSTALLED"
  | "PASSWORD_ACCEPTED"
  | "PASSWORD_REJECTED"
  | "LOCK_REQUESTED"

export function appLockStateFrom(input: {
  licenceValid: boolean
  credentialExists: boolean
  unlocked?: boolean
}): AppLockState {
  if (!input.licenceValid) return APP_LOCK_STATES.noValidLicence
  if (!input.credentialExists) return APP_LOCK_STATES.provisioningRequired
  return input.unlocked ? APP_LOCK_STATES.unlocked : APP_LOCK_STATES.locked
}

export function transitionAppLockState(current: AppLockState, event: AppLockEvent): AppLockState {
  if (event === "LICENCE_INVALID") return APP_LOCK_STATES.noValidLicence
  if (event === "CREDENTIAL_MISSING") {
    return current === APP_LOCK_STATES.noValidLicence
      ? APP_LOCK_STATES.noValidLicence
      : APP_LOCK_STATES.provisioningRequired
  }
  if (event === "CREDENTIAL_INSTALLED") {
    return current === APP_LOCK_STATES.noValidLicence ? current : APP_LOCK_STATES.locked
  }
  if (event === "PASSWORD_ACCEPTED") {
    return current === APP_LOCK_STATES.locked ? APP_LOCK_STATES.unlocked : current
  }
  if (event === "PASSWORD_REJECTED") {
    return current
  }
  if (event === "LOCK_REQUESTED") {
    return current === APP_LOCK_STATES.unlocked ? APP_LOCK_STATES.locked : current
  }
  return current
}
