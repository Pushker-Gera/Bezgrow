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
export const DEFAULT_AUTO_LOCK_DELAY_MS = 30_000

export type AppLockCredential = AppLockProvisioning & {
  license_id: string
  business_id: string
  locally_changed_at?: string | null
  applied_reset_authorization_id?: string | null
}

type AppLockWatermark = Pick<AppLockCredential, "license_id" | "business_id" | "credential_id"> & {
  locally_changed_at?: string | null
  applied_reset_authorization_id?: string | null
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
}

async function readWatermark() {
  return getOfflineMeta<AppLockWatermark | null>(APP_LOCK_WATERMARK_KEY, null, "global").catch(() => null)
}

async function writeWatermark(credential: AppLockCredential) {
  const watermark: AppLockWatermark = {
    license_id: credential.license_id,
    business_id: credential.business_id,
    credential_id: credential.credential_id,
    locally_changed_at: credential.locally_changed_at || null,
    applied_reset_authorization_id: credential.applied_reset_authorization_id || null,
  }
  await setOfflineMeta(APP_LOCK_WATERMARK_KEY, watermark, "global")
}

export async function getAppLockStatus() {
  const credential = await readCredential()
  return {
    enabled: Boolean(credential),
    credentialId: credential?.credential_id || null,
    locallyChangedAt: credential?.locally_changed_at || null,
  }
}

export async function provisionAppLockFromLicense(
  appLock: unknown,
  expectedDeviceId: string,
  licenseId: string,
  businessId: string
) {
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
    return { provisioned: false, resetApplied: false }
  }

  const credential: AppLockCredential = {
    ...appLock,
    license_id: licenseId,
    business_id: businessId,
    applied_reset_authorization_id: appLock.reset_authorization?.id || null,
  }
  await writeCredential(credential)
  await writeWatermark(credential)
  window.dispatchEvent(new Event(APP_LOCK_CREDENTIAL_CHANGED_EVENT))
  return { provisioned: true, resetApplied: Boolean(appLock.reset_authorization) }
}

export async function verifyAppPassword(password: string) {
  const credential = await readCredential()
  if (!credential) return false
  return verifyAppLockPassword(password, credential)
}

export async function changeAppPassword(currentPassword: string, newPassword: string) {
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
  await writeWatermark(next)
  window.dispatchEvent(new Event(APP_LOCK_CREDENTIAL_CHANGED_EVENT))
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
