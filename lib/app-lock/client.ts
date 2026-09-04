"use client"

import { invokeTauri, isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import {
  APP_LOCK_ALGORITHM,
  APP_LOCK_ITERATIONS,
  appPasswordPolicyError,
  isAppLockProvisioning,
  type AppLockProvisioning,
} from "@/lib/app-lock/shared"
import {
  appLockBytesToBase64Url,
  deriveAppLockVerifier,
  verifyAppLockPassword,
} from "@/lib/app-lock/verification"
import { appLockProvisioningDecision } from "@/lib/app-lock/provisioning-policy"
import { getOfflineMeta, setOfflineMeta } from "@/lib/offline/db"

const APP_LOCK_SECRET_KEY = "bezgrow-app-lock-v1"
const APP_LOCK_WATERMARK_KEY = "bezgrow_app_lock_watermark_v1"
const AUTO_LOCK_KEY = "bezgrow:app-lock-delay-ms"
export const APP_LOCK_EVENT = "bezgrow:app-lock"
export const APP_LOCK_CREDENTIAL_CHANGED_EVENT = "bezgrow:app-lock-credential-changed"
export const APP_LOCK_PROVISIONING_STATUS_EVENT = "bezgrow:app-lock-provisioning-status"
export const DEFAULT_AUTO_LOCK_DELAY_MS = 30_000

export type AppLockProvisioningStatus = "credential-received" | "installing" | "ready"

export type AppLockCredential = AppLockProvisioning & {
  license_id: string
  business_id: string
  installed_at?: string | null
  locally_changed_at?: string | null
  applied_reset_authorization_id?: string | null
}

type AppLockWatermark = Pick<AppLockCredential, "license_id" | "business_id" | "credential_id"> & {
  issued_at?: string | null
  installed_at?: string | null
  locally_changed_at?: string | null
  applied_reset_authorization_id?: string | null
}

let credentialMutation: Promise<unknown> = Promise.resolve()

function serializeCredentialMutation<T>(operation: () => Promise<T>): Promise<T> {
  const pending = credentialMutation.then(operation, operation)
  credentialMutation = pending.catch(() => undefined)
  return pending
}

async function requireDesktopRuntime() {
  if (!(await isTauriRuntimeAsync().catch(() => false))) {
    throw new Error("App Lock is available only in the Bezgrow desktop app.")
  }
}

async function readCredential() {
  await requireDesktopRuntime()
  const stored = await invokeTauri<string | null>("read_secret", { key: APP_LOCK_SECRET_KEY })
  if (!stored) return null
  try {
    const parsed = JSON.parse(stored) as AppLockCredential
    return isAppLockProvisioning(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function writeCredential(credential: AppLockCredential) {
  await requireDesktopRuntime()
  await invokeTauri<void>("store_secret", {
    key: APP_LOCK_SECRET_KEY,
    value: JSON.stringify(credential),
  })
  const persisted = await readCredential()
  if (!persisted || JSON.stringify(persisted) !== JSON.stringify(credential)) {
    throw new Error("The secure app-access credential could not be saved. Retry App Lock or contact support.")
  }
}

async function readWatermark() {
  const stored = await getOfflineMeta<unknown>(APP_LOCK_WATERMARK_KEY, null, "global").catch(() => null)
  try {
    const parsed = typeof stored === "string" ? JSON.parse(stored) as AppLockWatermark : stored as AppLockWatermark | null
    if (
      !parsed
      || typeof parsed.license_id !== "string"
      || typeof parsed.business_id !== "string"
      || typeof parsed.credential_id !== "string"
    ) return null
    return parsed
  } catch {
    return null
  }
}

async function writeWatermark(credential: AppLockCredential) {
  const watermark: AppLockWatermark = {
    license_id: credential.license_id,
    business_id: credential.business_id,
    credential_id: credential.credential_id,
    issued_at: credential.issued_at,
    installed_at: credential.installed_at || null,
    locally_changed_at: credential.locally_changed_at || null,
    applied_reset_authorization_id: credential.applied_reset_authorization_id || null,
  }
  // Normalized SQLite metadata has scalar columns, so object metadata must be
  // serialized explicitly. Persisting the object directly created a row with
  // three NULL value columns and silently discarded the replay watermark.
  await setOfflineMeta(APP_LOCK_WATERMARK_KEY, JSON.stringify(watermark), "global")
}

function dispatchProvisioningStatus(status: AppLockProvisioningStatus) {
  window.dispatchEvent(new CustomEvent(APP_LOCK_PROVISIONING_STATUS_EVENT, { detail: status }))
}

function secureStorageBackend() {
  if (typeof navigator === "undefined") return "OS credential store"
  return /windows/i.test(`${navigator.platform} ${navigator.userAgent}`)
    ? "Windows Credential Manager"
    : "macOS Keychain"
}

export async function getAppLockStatus() {
  const credential = await readCredential()
  return {
    enabled: Boolean(credential),
    credentialId: credential?.credential_id || null,
    locallyChangedAt: credential?.locally_changed_at || null,
  }
}

export async function getAppLockDiagnostics(options: { unlocked?: boolean } = {}) {
  const [credential, watermark] = await Promise.all([readCredential(), readWatermark()])
  const reset = credential?.reset_authorization
  return {
    state: credential ? (options.unlocked ? "UNLOCKED" : "LOCKED") : "PROVISIONING_REQUIRED",
    localCredentialExists: Boolean(credential),
    lastCredentialInstallAt: credential?.installed_at || watermark?.installed_at || null,
    resetAuthorizationPresent: Boolean(reset),
    resetAuthorizationExpiryStatus: !reset
      ? "not-present"
      : Date.parse(reset.expires_at) > Date.now()
        ? "valid"
        : "expired-or-consumed",
    secureStorageBackend: secureStorageBackend(),
  }
}

export function provisionAppLockFromLicense(
  appLock: unknown,
  expectedDeviceId: string,
  licenseId: string,
  businessId: string
) {
  return serializeCredentialMutation(() => installAppLockCredential(appLock, expectedDeviceId, licenseId, businessId))
}

async function installAppLockCredential(appLock: unknown, expectedDeviceId: string, licenseId: string, businessId: string) {
  // A valid legacy licence remains valid, but cannot unlock an unprovisioned
  // device. Never synthesize app_lock:null in the signed payload itself.
  if (appLock === undefined || appLock === null) return { provisioned: false, resetApplied: false }
  if (!isAppLockProvisioning(appLock)) {
    throw new Error("This licence does not contain an app-access password. Ask the platform administrator to reset the App Password for this device.")
  }
  const existing = await readCredential()
  const watermark = await readWatermark()
  const decision = appLockProvisioningDecision({
    appLock,
    expectedDeviceId,
    licenseId,
    businessId,
    existing,
    watermark,
  })
  if (decision === "ignore") {
    // Repair old NULL metadata and interrupted watermark writes without
    // replacing an already-installed (possibly locally changed) password.
    if (existing) await writeWatermark(existing)
    return { provisioned: false, resetApplied: false }
  }

  dispatchProvisioningStatus("credential-received")
  const credential: AppLockCredential = {
    ...appLock,
    license_id: licenseId,
    business_id: businessId,
    installed_at: new Date().toISOString(),
    applied_reset_authorization_id: appLock.reset_authorization?.id || null,
  }
  dispatchProvisioningStatus("installing")
  await writeCredential(credential)
  // The secure credential is authoritative. Lock immediately after read-back,
  // even if a later non-secret metadata write fails and needs a retry.
  window.dispatchEvent(new Event(APP_LOCK_CREDENTIAL_CHANGED_EVENT))
  await writeWatermark(credential)
  dispatchProvisioningStatus("ready")
  return { provisioned: true, resetApplied: Boolean(appLock.reset_authorization) }
}

export async function verifyAppPassword(password: string) {
  const credential = await readCredential()
  if (!credential) return false
  if (!(await verifyAppLockPassword(password, credential))) return false
  // A reset can arrive while PBKDF2 is running. Never accept the previous
  // password after the canonical secure credential has been replaced.
  const current = await readCredential()
  return current?.credential_id === credential.credential_id
    && current.verifier === credential.verifier
}

export function changeAppPassword(currentPassword: string, newPassword: string) {
  return serializeCredentialMutation(() => replaceAppPassword(currentPassword, newPassword))
}

async function replaceAppPassword(currentPassword: string, newPassword: string) {
  const policyError = appPasswordPolicyError(newPassword)
  if (policyError) throw new Error(policyError)
  const credential = await readCredential()
  if (!credential) throw new Error("App Lock is not provisioned for this device.")
  if (!(await verifyAppPassword(currentPassword))) throw new Error("Current password is incorrect.")

  const salt = crypto.getRandomValues(new Uint8Array(16))
  const next: AppLockCredential = {
    ...credential,
    algorithm: APP_LOCK_ALGORITHM,
    iterations: APP_LOCK_ITERATIONS,
    salt: appLockBytesToBase64Url(salt),
    verifier: "",
    credential_id: crypto.randomUUID(),
    issued_at: new Date().toISOString(),
    locally_changed_at: new Date().toISOString(),
    reset_authorization: null,
  }
  next.verifier = await deriveAppLockVerifier(newPassword, next)
  await writeCredential(next)
  window.dispatchEvent(new Event(APP_LOCK_CREDENTIAL_CHANGED_EVENT))
  await writeWatermark(next)
}

export function requestAppLock() {
  window.dispatchEvent(new Event(APP_LOCK_EVENT))
}

export function readAutoLockDelay() {
  if (typeof window === "undefined") return DEFAULT_AUTO_LOCK_DELAY_MS
  const value = Number(localStorage.getItem(AUTO_LOCK_KEY))
  return [0, 30_000, 60_000, 300_000, 900_000].includes(value) ? value : DEFAULT_AUTO_LOCK_DELAY_MS
}

export function saveAutoLockDelay(value: number) {
  if (![0, 30_000, 60_000, 300_000, 900_000].includes(value)) {
    throw new Error("Select a supported auto-lock interval.")
  }
  localStorage.setItem(AUTO_LOCK_KEY, String(value))
}
