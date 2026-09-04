"use client"

import { normalizeLicenseEnvKey, parseLicenseInput, verifyLicenseSignature, type LicensePayload } from "@/lib/license/codec"
import { provisionAppLockFromLicense } from "@/lib/app-lock/client"
import { isAppLockProvisioning } from "@/lib/app-lock/shared"
import { evaluateStoredLicense, type LicensePolicyResult, type StoredLicenseRow } from "@/lib/license/policy"
import { verifyStoredLicenseRows } from "@/lib/license/verification"
import { clearDesktopAuthMarker, markDesktopSessionActive, setDesktopAuthMarker } from "@/lib/desktop/session"
import { desktopArchitecture, invokeTauri, isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import packageJson from "@/package.json"
import {
  createOfflineId,
  cacheWorkspaceBootstrap,
  getCachedWorkspaceBootstrap,
  getOfflineData,
  getOfflineMeta,
  migrateLegacyIndexedDbToSqlite,
  putOfflineData,
  setOfflineMeta,
} from "@/lib/offline/db"
import type { WorkspaceBootstrapPayload } from "@/lib/workspaceBootstrapClient"

type DataRow = Record<string, unknown> & { id?: string }

const DEVICE_META_KEY = "bezgrow_device_id"
const DEVICE_STORAGE_KEY = "bezgrow:device-id"
const DEVICE_SECRET_KEY = "bezgrow-device-id"
const LICENSE_SECRET_KEY = "bezgrow-offline-license-key"
const PUBLIC_KEY = normalizeLicenseEnvKey(process.env.NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY || "")
export const REMOVE_LICENSE_CONFIRMATION = "REMOVE LICENCE"

let deviceIdPromise: Promise<string> | null = null

type DeviceCheckinResponse = {
  success?: boolean
  requestId?: string
  error?: string
  code?: string
  licenseStatus?: string | null
  authoritative?: boolean
  refreshedLicenseKey?: string | null
}

function nowIso() {
  return new Date().toISOString()
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function dateEnd(value: string, graceDays = 0) {
  const date = new Date(`${value.slice(0, 10)}T23:59:59.999`)
  date.setDate(date.getDate() + graceDays)
  return date
}

function normalizedArchitecture(value: unknown) {
  const architecture = String(value || "").toLowerCase()
  return architecture === "x64" || architecture === "x86_64" || architecture === "amd64"
    ? "x86_64"
    : architecture
}

function currentDesktopPlatform() {
  if (typeof navigator === "undefined") return null
  return /windows/i.test(`${navigator.platform} ${navigator.userAgent}`) ? "windows" : "macos"
}

function workspaceOrganizationId() {
  const workspace = getCachedWorkspaceBootstrap()
  return workspace?.organization?.id || workspace?.membership?.organization_id || ""
}

function randomDeviceId() {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2)
  return `BZG-${random.replace(/-/g, "").slice(0, 24).toUpperCase()}`
}

function validDeviceId(value: unknown): value is string {
  return typeof value === "string" && /^BZG-[A-Z0-9-]{8,92}$/i.test(value.trim())
}

async function readDesktopSecret(key: string) {
  if (!(await isTauriRuntimeAsync().catch(() => false))) return null

  try {
    return await invokeTauri<string | null>("read_secret", { key })
  } catch {
    return null
  }
}

async function writeDesktopSecret(key: string, value: string) {
  if (!(await isTauriRuntimeAsync().catch(() => false))) return false

  try {
    await invokeTauri<void>("store_secret", { key, value })
    return true
  } catch {
    return false
  }
}

async function deleteDesktopSecret(key: string) {
  if (!(await isTauriRuntimeAsync().catch(() => false))) return
  await invokeTauri<void>("delete_secret", { key })
}

async function readDeviceIdFromStoredLicense() {
  const licenseKey = await readDesktopSecret(LICENSE_SECRET_KEY)
  if (!licenseKey) return ""

  try {
    return parseLicenseInput(licenseKey).payload.device_id || ""
  } catch {
    return ""
  }
}

async function persistDeviceId(deviceId: string) {
  if (typeof window !== "undefined") localStorage.setItem(DEVICE_STORAGE_KEY, deviceId)
  await writeDesktopSecret(DEVICE_SECRET_KEY, deviceId)
  await setOfflineMeta(DEVICE_META_KEY, deviceId, "global").catch(() => undefined)
}

async function resolveDeviceId() {
  const secureDeviceId = await readDesktopSecret(DEVICE_SECRET_KEY)
  const licensedDeviceId = await readDeviceIdFromStoredLicense()
  const cached = await getOfflineMeta<string>(DEVICE_META_KEY, "", "global").catch(() => "")
  const stored = typeof window !== "undefined" ? localStorage.getItem(DEVICE_STORAGE_KEY) : ""
  // A signed licence is the strongest migration evidence for the Device ID
  // that was actually registered before the native installation file existed.
  const legacyDeviceId = [licensedDeviceId, secureDeviceId, cached, stored]
    .find((value) => validDeviceId(value))
    ?.trim()
  const desktopRuntime = await isTauriRuntimeAsync().catch(() => false)
  const next = desktopRuntime
    ? await invokeTauri<string>("desktop_get_or_create_device_id", { legacyDeviceId: legacyDeviceId || null })
    : legacyDeviceId || randomDeviceId()
  await persistDeviceId(next)
  return next
}

export async function getOrCreateDeviceId() {
  if (!deviceIdPromise) {
    deviceIdPromise = resolveDeviceId().catch((error) => {
      deviceIdPromise = null
      throw error
    })
  }
  return deviceIdPromise
}

async function readLicenseRows(organizationId: string) {
  const [organizationRows, globalRows] = await Promise.all([
    organizationId ? getOfflineData<StoredLicenseRow[]>(organizationId, "license", []) : Promise.resolve([]),
    organizationId === "global" ? Promise.resolve([]) : getOfflineData<StoredLicenseRow[]>("global", "license", []),
  ])
  return [...organizationRows, ...globalRows]
}

function licenseRowFromPayload(payload: LicensePayload, licenseKey: string, signatureText: string, status = "active") {
  const graceUntil = dateEnd(payload.expiry_date, payload.grace_period_days).toISOString()
  return {
    id: payload.license_id,
    organization_id: payload.business_id,
    license_key: licenseKey,
    customer_id: payload.customer_id,
    business_id: payload.business_id,
    business_name: payload.business_name,
    device_id: payload.device_id,
    plan_code: payload.plan_name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
    plan_name: payload.plan_name,
    status,
    expiry_date: payload.expiry_date,
    grace_period_days: payload.grace_period_days,
    allowed_features: JSON.stringify(payload.allowed_features),
    issued_by_admin: payload.issued_by_admin,
    signature_algorithm: payload.signature_algorithm || "rsa-pss-sha256",
    issuer_key_id: payload.issuer_key_id || null,
    issuer_public_key: payload.issuer_public_key || null,
    issued_at: payload.issued_at,
    expires_at: payload.expiry_date,
    grace_until: graceUntil,
    last_verified_at: nowIso(),
    signature: signatureText,
    notes: payload.notes || null,
    sync_status: "synced",
    created_at: nowIso(),
    updated_at: nowIso(),
  }
}

function activationRow(payload: LicensePayload) {
  return {
    id: `activation:${payload.license_id}:${payload.device_id}`,
    organization_id: payload.business_id,
    license_id: payload.license_id,
    device_id: payload.device_id,
    device_name: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 180) : "Desktop Device",
    platform: typeof navigator !== "undefined" ? navigator.platform || "desktop" : "desktop",
    activated_at: nowIso(),
    last_seen_at: nowIso(),
    is_active: true,
    sync_status: "synced",
    created_at: nowIso(),
    updated_at: nowIso(),
  }
}

async function logLicenseEvent(organizationId: string, action: string, description: string, entityId?: string | null) {
  const logs = await getOfflineData<DataRow[]>(organizationId, "audit_logs", []).catch(() => [])
  await putOfflineData(organizationId, "audit_logs", [
    {
      id: createOfflineId("license-audit"),
      organization_id: organizationId,
      action,
      entity_type: "license",
      entity_id: entityId || null,
      description,
      sync_status: "synced",
      created_at: nowIso(),
      updated_at: nowIso(),
    },
    ...logs,
  ]).catch(() => undefined)
}

async function writeActivatedLicense(payload: LicensePayload, licenseKey: string, signatureText: string) {
  const row = licenseRowFromPayload(payload, licenseKey, signatureText)
  const activation = activationRow(payload)
  const targets = [...new Set([payload.business_id, workspaceOrganizationId(), "global"].filter(Boolean))]

  for (const organizationId of targets) {
    const licenseRows = await getOfflineData<DataRow[]>(organizationId, "license", []).catch(() => [])
    const activationRows = await getOfflineData<DataRow[]>(organizationId, "device_activations", []).catch(() => [])
    await putOfflineData(organizationId, "license", [{ ...row, organization_id: organizationId }, ...licenseRows.filter((item) => item.id !== row.id)])
    await putOfflineData(organizationId, "device_activations", [
      { ...activation, organization_id: organizationId },
      ...activationRows.filter((item) => item.id !== activation.id),
    ])
    await logLicenseEvent(organizationId, "LICENSE_ACTIVATED", `License ${payload.license_id} activated for ${payload.business_name}.`, payload.license_id)
  }
}

async function installRefreshedLicenseKey(current: ReturnType<typeof parseLicenseInput>, value: string) {
  const refreshed = parseLicenseInput(value)
  const sameBinding =
    refreshed.payload.license_id === current.payload.license_id &&
    refreshed.payload.device_id === current.payload.device_id &&
    refreshed.payload.business_id === current.payload.business_id &&
    refreshed.payload.customer_id === current.payload.customer_id &&
    refreshed.payload.platform === current.payload.platform
  if (!sameBinding) throw new Error("The control plane returned a licence for another device or business.")
  if (!(await verifyLicenseSignature(refreshed, PUBLIC_KEY))) {
    throw new Error("The refreshed licence signature is invalid.")
  }
  await provisionAppLockFromLicense(
    refreshed.payload.app_lock,
    refreshed.payload.device_id,
    refreshed.payload.license_id,
    refreshed.payload.business_id
  )

  const row = licenseRowFromPayload(refreshed.payload, refreshed.licenseKey, refreshed.signatureText, "active")
  const targets = [...new Set([refreshed.payload.business_id, workspaceOrganizationId(), "global"].filter(Boolean))]
  for (const organizationId of targets) {
    const rows = await getOfflineData<DataRow[]>(organizationId, "license", []).catch(() => [])
    await putOfflineData(
      organizationId,
      "license",
      [{ ...row, organization_id: organizationId }, ...rows.filter((entry) => entry.id !== refreshed.payload.license_id)]
    )
    await logLicenseEvent(
      organizationId,
      "LICENSE_REFRESHED",
      "Installed a newer server-signed licence after authoritative online verification.",
      refreshed.payload.license_id
    )
  }
  await writeDesktopSecret(LICENSE_SECRET_KEY, refreshed.licenseKey)
  await cacheWorkspaceBootstrap(workspaceFromLicense(refreshed.payload))
}

async function restoreLicenseRowsFromDesktopSecret(deviceId: string) {
  const licenseKey = await readDesktopSecret(LICENSE_SECRET_KEY)
  if (!licenseKey) return []

  try {
    const parsed = parseLicenseInput(licenseKey)
    if (parsed.payload.device_id !== deviceId) return []
    if (Date.now() > dateEnd(parsed.payload.expiry_date, parsed.payload.grace_period_days).getTime()) return []
    if (!(await verifyLicenseSignature(parsed, PUBLIC_KEY))) return []

    await provisionAppLockFromLicense(
      parsed.payload.app_lock,
      parsed.payload.device_id,
      parsed.payload.license_id,
      parsed.payload.business_id
    )
    await writeActivatedLicense(parsed.payload, parsed.licenseKey, parsed.signatureText)
    return [licenseRowFromPayload(parsed.payload, parsed.licenseKey, parsed.signatureText) as StoredLicenseRow]
  } catch {
    return []
  }
}

function workspaceFromLicense(payload: LicensePayload): WorkspaceBootstrapPayload {
  return {
    success: true,
    user: {
      id: payload.customer_id,
      email: payload.customer_email || null,
    },
    profile: {
      id: payload.customer_id,
      role: "user",
      is_suspended: false,
      business_created: true,
    },
    organization: {
      id: payload.business_id,
      name: payload.business_name,
      currency: "INR",
      timezone: "Asia/Kolkata",
      locale: "en-IN",
      business_type: null,
      business_category: null,
    },
    membership: {
      organization_id: payload.business_id,
      role: "owner",
    },
    features: payload.allowed_features,
    currency: "INR",
    timezone: "Asia/Kolkata",
    locale: "en-IN",
    permissions: {
      admin: false,
      canAccessDashboard: true,
      canManageBilling: true,
    },
  }
}

function featuresFromStoredLicense(row: StoredLicenseRow | null | undefined) {
  const raw = row?.allowed_features
  if (!raw) return []
  try {
    const parsed = JSON.parse(String(raw)) as unknown
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean).sort() : []
  } catch {
    return String(raw)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .sort()
  }
}

function workspaceFromStoredLicense(row: StoredLicenseRow): WorkspaceBootstrapPayload {
  const record = row as Record<string, unknown>
  const businessId = stringValue(record.business_id, stringValue(record.organization_id, "global"))
  const businessName = stringValue(record.business_name, "Licensed Business")
  const customerId = stringValue(record.customer_id, "licensed-user")
  const customerEmail = typeof record.customer_email === "string" && record.customer_email.trim() ? record.customer_email.trim() : null

  return {
    success: true,
    user: {
      id: customerId,
      email: customerEmail || null,
    },
    profile: {
      id: customerId,
      role: "user",
      is_suspended: false,
      business_created: true,
    },
    organization: {
      id: businessId,
      name: businessName,
      currency: "INR",
      timezone: "Asia/Kolkata",
      locale: "en-IN",
      business_type: null,
      business_category: null,
    },
    membership: {
      organization_id: businessId,
      role: "owner",
    },
    features: featuresFromStoredLicense(row),
    currency: "INR",
    timezone: "Asia/Kolkata",
    locale: "en-IN",
    permissions: {
      admin: false,
      canAccessDashboard: true,
      canManageBilling: true,
    },
  }
}

async function createLocalWorkspaceFromLicense(payload: LicensePayload) {
  const workspace = workspaceFromLicense(payload)
  await cacheWorkspaceBootstrap(workspace)
  if (typeof window !== "undefined") {
    sessionStorage.setItem("bezgrow:organization-id", JSON.stringify({ value: payload.business_id, cachedAt: Date.now() }))
  }
  markDesktopSessionActive()
  setDesktopAuthMarker()
}

export async function restoreLicensedWorkspaceContext() {
  const migrated = await migrateLegacyIndexedDbToSqlite().catch((error) => {
    console.error("[offline/license] legacy business-data migration failed", error)
    return null
  })
  const status = await getLocalLicenseStatus("global")
  if (!status.allowed || !status.license) return null

  const cachedWorkspace = migrated?.workspace || getCachedWorkspaceBootstrap()
  const workspace = cachedWorkspace?.success ? cachedWorkspace : workspaceFromStoredLicense(status.license)
  await cacheWorkspaceBootstrap(workspace)
  if (typeof window !== "undefined") {
    sessionStorage.setItem("bezgrow:organization-id", JSON.stringify({ value: workspace.organization?.id || "global", cachedAt: Date.now() }))
  }
  setDesktopAuthMarker()
  return workspace
}

async function verifyLicenseForActivation(parsed: ReturnType<typeof parseLicenseInput>) {
  return verifyLicenseSignature(parsed, PUBLIC_KEY)
}

export async function reportActivatedDevice(
  parsed: ReturnType<typeof parseLicenseInput>,
  options: {
    updateCheckResult?: "success" | "failed" | "no_update" | "update_available"
    signal?: AbortSignal
  } = {}
) {
  if (typeof navigator === "undefined" || !navigator.onLine) {
    return { reported: false, status: "offline" as const }
  }
  if (!(await isTauriRuntimeAsync().catch(() => false))) {
    return { reported: false, status: "not_desktop" as const }
  }

  const platform = /windows/i.test(`${navigator.platform} ${navigator.userAgent}`)
    ? "windows"
    : "macos"
  const architecture = desktopArchitecture() === "arm64" ? "arm64" : "x86_64"
  const apiPath = `/api/desktop-proxy?path=${encodeURIComponent("/api/devices/checkin")}`
  const timeoutSignal = options.signal || AbortSignal.timeout(8_000)
  const response = await fetch(apiPath, {
    method: "POST",
    cache: "no-store",
    keepalive: true,
    signal: timeoutSignal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      license_key: parsed.licenseKey,
      license_id: parsed.payload.license_id,
      device_id: parsed.payload.device_id,
      business_id: parsed.payload.business_id,
      platform,
      architecture,
      app_version: packageJson.version,
      release_channel: "stable",
      activation_status: "active",
      timestamp: nowIso(),
      update_check_result: options.updateCheckResult,
      diagnostics_available: false,
    }),
  }).catch(() => null)
  if (!response) return { reported: false, status: "network_error" as const }

  const result = (await response.json().catch(() => null)) as DeviceCheckinResponse | null
  if (!response.ok || !result?.success) {
    console.warn("[offline/license] device check-in was not accepted", {
      requestId: result?.requestId || null,
      status: response.status,
    })
    return {
      reported: false,
      status: "rejected" as const,
      requestId: result?.requestId || null,
      authoritativeStatus: result?.authoritative ? normalizeAuthoritativeStatus(result.licenseStatus) : null,
      code: result?.code || null,
    }
  }
  if (result.refreshedLicenseKey) {
    await installRefreshedLicenseKey(parsed, result.refreshedLicenseKey)
  }
  return {
    reported: true,
    status: "reported" as const,
    requestId: result.requestId || null,
    authoritativeStatus: normalizeAuthoritativeStatus(result.licenseStatus),
    code: result.code || null,
  }
}

function normalizeAuthoritativeStatus(value: unknown) {
  const status = stringValue(value).toLowerCase()
  if (["active", "trial", "grace"].includes(status)) return status
  if (status === "expiring") return "active"
  if (status === "grace_period") return "grace"
  if (["cancelled", "canceled", "suspended"].includes(status)) return "cancelled"
  if (["expired", "revoked", "invalid", "replaced", "device_mismatch"].includes(status)) {
    return status
  }
  return null
}

async function persistAuthoritativeLicenseStatus(licenseId: string, status: string, businessId: string) {
  const targets = [...new Set([businessId, workspaceOrganizationId(), "global"].filter(Boolean))]
  const verifiedAt = nowIso()
  for (const organizationId of targets) {
    const rows = await getOfflineData<DataRow[]>(organizationId, "license", []).catch(() => [])
    if (!rows.some((row) => row.id === licenseId)) continue
    await putOfflineData(
      organizationId,
      "license",
      rows.map((row) => row.id === licenseId
        ? { ...row, status, last_verified_at: verifiedAt, last_seen_at: verifiedAt, updated_at: verifiedAt }
        : row)
    )
    await logLicenseEvent(
      organizationId,
      `LICENSE_CONTROL_PLANE_${status.toUpperCase()}`,
      `Control-plane revalidation reported licence status ${status}.`,
      licenseId
    )
  }
}

export async function revalidateLocalLicenseWithControlPlane(
  organizationId = workspaceOrganizationId() || "global"
) {
  const snapshot = await localLicenseSnapshot(organizationId)
  if (!snapshot.license) return { check: { reported: false, status: "not_activated" as const }, snapshot }
  if (typeof navigator === "undefined" || !navigator.onLine) {
    return { check: { reported: false, status: "offline" as const }, snapshot }
  }
  const licenseKey = stringValue(snapshot.license.license_key) || await readDesktopSecret(LICENSE_SECRET_KEY) || ""
  if (!licenseKey) return { check: { reported: false, status: "missing_key" as const }, snapshot }
  const parsed = parseLicenseInput(licenseKey)
  const check = await reportActivatedDevice(parsed)
  if ("authoritativeStatus" in check && check.authoritativeStatus) {
    await persistAuthoritativeLicenseStatus(parsed.payload.license_id, check.authoritativeStatus, parsed.payload.business_id)
  }
  return { check, snapshot: await localLicenseSnapshot(organizationId) }
}

export async function activateOfflineLicense(input: unknown) {
  const parsed = parseLicenseInput(input)
  const deviceId = await getOrCreateDeviceId()
  if (parsed.payload.device_id !== deviceId) {
    await logLicenseEvent("global", "LICENSE_WRONG_DEVICE", "Rejected license issued for another device.", parsed.payload.license_id)
    throw new Error("This license was issued for another device.")
  }

  if (await isTauriRuntimeAsync().catch(() => false)) {
    const platform = currentDesktopPlatform()
    if (parsed.payload.platform && platform && parsed.payload.platform !== platform) {
      await logLicenseEvent("global", "LICENSE_WRONG_PLATFORM", "Rejected license issued for another operating system.", parsed.payload.license_id)
      throw new Error(`This license was issued for ${parsed.payload.platform === "windows" ? "Windows" : "macOS"}.`)
    }
    const currentArchitecture = normalizedArchitecture(desktopArchitecture())
    const licensedArchitecture = normalizedArchitecture(parsed.payload.architecture)
    if (licensedArchitecture && licensedArchitecture !== currentArchitecture) {
      await logLicenseEvent("global", "LICENSE_WRONG_ARCHITECTURE", "Rejected license issued for another processor architecture.", parsed.payload.license_id)
      throw new Error(`This license was issued for ${parsed.payload.architecture}.`)
    }
  }

  const validSignature = await verifyLicenseForActivation(parsed)
  if (!validSignature) {
    await logLicenseEvent("global", "LICENSE_TAMPERED", "Rejected tampered or unsigned license.", parsed.payload.license_id)
    throw new Error("License signature is invalid.")
  }

  if (Date.now() > dateEnd(parsed.payload.expiry_date, parsed.payload.grace_period_days).getTime()) {
    await logLicenseEvent("global", "LICENSE_EXPIRED_IMPORT", "Rejected expired license import.", parsed.payload.license_id)
    throw new Error("This license is already expired.")
  }

  await provisionAppLockFromLicense(
    parsed.payload.app_lock,
    parsed.payload.device_id,
    parsed.payload.license_id,
    parsed.payload.business_id
  )
  await writeActivatedLicense(parsed.payload, parsed.licenseKey, parsed.signatureText)
  await writeDesktopSecret(LICENSE_SECRET_KEY, parsed.licenseKey)
  await createLocalWorkspaceFromLicense(parsed.payload)
  // Online reporting is deliberately best-effort and runs only after the
  // signed license has been accepted and persisted locally. A network or
  // control-plane failure can never roll back or block offline ERP access.
  const activationCheck = await reportActivatedDevice(parsed).catch((error) => {
    console.warn("[offline/license] device check-in failed after local activation", {
      message: error instanceof Error ? error.message : "unknown",
    })
    return null
  })
  if (activationCheck && "authoritativeStatus" in activationCheck && activationCheck.authoritativeStatus) {
    await persistAuthoritativeLicenseStatus(
      parsed.payload.license_id,
      activationCheck.authoritativeStatus,
      parsed.payload.business_id
    )
    const revalidated = await getLocalLicenseStatus(parsed.payload.business_id)
    if (!revalidated.allowed) throw new Error(revalidated.reason)
  }
  return {
    license: parsed.payload,
    status: "active",
    expires_at: parsed.payload.expiry_date,
    grace_until: dateEnd(parsed.payload.expiry_date, parsed.payload.grace_period_days).toISOString(),
  }
}

async function touchLicense(organizationId: string, result: LicensePolicyResult) {
  if (!result.allowed || !result.license?.id) return
  const rows = await getOfflineData<DataRow[]>(organizationId, "license", []).catch(() => [])
  if (!rows.length) return
  await putOfflineData(
    organizationId,
    "license",
    rows.map((row) => (row.id === result.license?.id ? { ...row, last_verified_at: nowIso(), last_seen_at: nowIso(), updated_at: nowIso() } : row))
  ).catch(() => undefined)
}

export async function getLocalLicenseStatus(organizationId = workspaceOrganizationId() || "global") {
  const deviceId = await getOrCreateDeviceId()
  const storedRows = await readLicenseRows(organizationId)
  let rows = await verifyStoredLicenseRows(storedRows, { publicKey: PUBLIC_KEY, deviceId })
  const connectivity = typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "unknown"
  let status = evaluateStoredLicense(rows, { deviceId, connectivity })
  const authoritativeLocalStatus = stringValue(status.license?.status).toLowerCase()
  const canRestoreFromSecret = !["revoked", "cancelled", "canceled", "replaced", "invalid"].includes(authoritativeLocalStatus)
  if (!status.allowed && canRestoreFromSecret) {
    const restoredRows = await restoreLicenseRowsFromDesktopSecret(deviceId)
    if (restoredRows.length) {
      rows = await verifyStoredLicenseRows([...restoredRows, ...rows], { publicKey: PUBLIC_KEY, deviceId })
      status = evaluateStoredLicense(rows, { deviceId, connectivity })
    }
  }
  return status
}

export async function assertLocalWriteAllowed(organizationId: string, actionName: string) {
  const status = await getLocalLicenseStatus(organizationId)
  if (!status.allowed) {
    await logLicenseEvent(organizationId || "global", `LICENSE_${status.status.toUpperCase()}`, `${actionName} blocked: ${status.reason}`, stringValue(status.license?.id))
    throw new Error(status.reason)
  }
  await touchLicense(organizationId, status)
  return status
}

export async function localLicenseSnapshot(organizationId = workspaceOrganizationId() || "global") {
  const [deviceId, status] = await Promise.all([getOrCreateDeviceId(), getLocalLicenseStatus(organizationId)])
  return { device_id: deviceId, ...status }
}

export async function reconcileLocalAppLockCredential(
  organizationId = workspaceOrganizationId() || "global",
) {
  const snapshot = await localLicenseSnapshot(organizationId)
  if (!snapshot.allowed || !snapshot.license) {
    return { reconciled: false, reason: "no-valid-licence" as const, snapshot }
  }

  const licenseKey = stringValue(snapshot.license.license_key)
    || await readDesktopSecret(LICENSE_SECRET_KEY)
    || ""
  if (!licenseKey) {
    return { reconciled: false, reason: "signed-key-unavailable" as const, snapshot }
  }

  const parsed = parseLicenseInput(licenseKey)
  if (parsed.payload.device_id !== snapshot.device_id) {
    throw new Error("The stored licence does not match this Device ID.")
  }
  if (!(await verifyLicenseSignature(parsed, PUBLIC_KEY))) {
    throw new Error("The stored licence signature is invalid.")
  }
  if (!isAppLockProvisioning(parsed.payload.app_lock)) {
    return { reconciled: false, reason: "signed-credential-missing" as const, snapshot }
  }

  const result = await provisionAppLockFromLicense(
    parsed.payload.app_lock,
    snapshot.device_id,
    parsed.payload.license_id,
    parsed.payload.business_id,
  )
  return {
    reconciled: result.provisioned,
    reason: result.provisioned ? "installed" as const : "already-reconciled" as const,
    snapshot,
  }
}

export async function localLicenseAppLockDiagnostics(
  organizationId = workspaceOrganizationId() || "global",
) {
  const snapshot = await localLicenseSnapshot(organizationId)
  if (!snapshot.license) {
    return {
      provisioningStatus: "not-activated",
      resetAuthorizationPresent: false,
      resetAuthorizationExpiryStatus: "not-present",
    }
  }

  const licenseKey = stringValue(snapshot.license.license_key)
    || await readDesktopSecret(LICENSE_SECRET_KEY)
    || ""
  if (!licenseKey) {
    return {
      provisioningStatus: "signed-key-unavailable",
      resetAuthorizationPresent: false,
      resetAuthorizationExpiryStatus: "unknown",
    }
  }

  try {
    const parsed = parseLicenseInput(licenseKey)
    const appLock = parsed.payload.app_lock
    if (!isAppLockProvisioning(appLock)) {
      return {
        provisioningStatus: "not-provisioned",
        resetAuthorizationPresent: false,
        resetAuthorizationExpiryStatus: "not-present",
      }
    }
    const reset = appLock.reset_authorization
    return {
      provisioningStatus: "signed-credential-present",
      resetAuthorizationPresent: Boolean(reset),
      resetAuthorizationExpiryStatus: !reset
        ? "not-present"
        : Date.parse(reset.expires_at) > Date.now()
          ? "valid"
          : "expired-or-consumed",
    }
  } catch {
    return {
      provisioningStatus: "invalid-signed-key",
      resetAuthorizationPresent: false,
      resetAuthorizationExpiryStatus: "unknown",
    }
  }
}

export async function getExplicitControlPlaneActionAuth(
  organizationId = workspaceOrganizationId() || "global",
) {
  const [deviceId, status] = await Promise.all([
    getOrCreateDeviceId(),
    getLocalLicenseStatus(organizationId),
  ])
  if (!status.allowed || !status.license) {
    throw new Error(status.reason || "A valid local licence is required for this online action.")
  }

  const license = status.license as StoredLicenseRow & Record<string, unknown>
  const licenseKey = stringValue(license.license_key) || await readDesktopSecret(LICENSE_SECRET_KEY) || ""
  if (!licenseKey) throw new Error("The signed local licence key is unavailable.")
  const parsed = parseLicenseInput(licenseKey)
  if (parsed.payload.device_id !== deviceId) {
    throw new Error("The signed licence does not match this device.")
  }
  if (organizationId !== "global" && parsed.payload.business_id !== organizationId) {
    throw new Error("The signed licence does not match this business.")
  }
  return {
    licenseKey,
    deviceId,
    businessId: parsed.payload.business_id,
  }
}

export async function removeLocalLicenseFromDevice(confirmation: string) {
  if (confirmation.trim().toUpperCase() !== REMOVE_LICENSE_CONFIRMATION) {
    throw new Error(`Type ${REMOVE_LICENSE_CONFIRMATION} to confirm licence removal.`)
  }

  const deviceId = await getOrCreateDeviceId()
  const storedKey = await readDesktopSecret(LICENSE_SECRET_KEY)
  let storedBusinessId = ""
  let storedLicenseId = ""
  if (storedKey) {
    try {
      const parsed = parseLicenseInput(storedKey)
      storedBusinessId = parsed.payload.business_id
      storedLicenseId = parsed.payload.license_id
    } catch {
      // An invalid stored key is still removed only by this explicit action.
    }
  }

  const targets = [...new Set(["global", workspaceOrganizationId(), storedBusinessId].filter(Boolean))]
  for (const organizationId of targets) {
    const [licenses, activations] = await Promise.all([
      getOfflineData<DataRow[]>(organizationId, "license", []).catch(() => []),
      getOfflineData<DataRow[]>(organizationId, "device_activations", []).catch(() => []),
    ])
    const remainingLicenses = licenses.filter((row) => {
      if (storedLicenseId && String(row.id || "") === storedLicenseId) return false
      return String(row.device_id || "") !== deviceId
    })
    const remainingActivations = activations.filter((row) => String(row.device_id || "") !== deviceId)
    await Promise.all([
      putOfflineData(organizationId, "license", remainingLicenses),
      putOfflineData(organizationId, "device_activations", remainingActivations),
    ])
    await logLicenseEvent(
      organizationId,
      "LICENSE_REMOVED_FROM_DEVICE",
      "The signed local licence was removed after explicit Settings confirmation. ERP records and the installation Device ID were preserved.",
      storedLicenseId || null
    )
  }

  await deleteDesktopSecret(LICENSE_SECRET_KEY)
  clearDesktopAuthMarker()
  return { device_id: deviceId, removed: true }
}
