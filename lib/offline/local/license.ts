"use client"

import { parseLicenseInput, verifyLicenseSignature, normalizePem, type LicensePayload } from "@/lib/license/codec"
import { evaluateStoredLicense, type LicensePolicyResult, type StoredLicenseRow } from "@/lib/license/policy"
import { setDesktopAuthMarker } from "@/lib/desktop/session"
import { createOfflineId, cacheWorkspaceBootstrap, getCachedWorkspaceBootstrap, getOfflineData, getOfflineMeta, putOfflineData, setOfflineMeta } from "@/lib/offline/db"
import type { WorkspaceBootstrapPayload } from "@/lib/workspaceBootstrapClient"

type DataRow = Record<string, unknown> & { id?: string }

const DEVICE_META_KEY = "bezgrow_device_id"
const DEVICE_STORAGE_KEY = "bezgrow:device-id"
const PUBLIC_KEY = normalizePem(process.env.NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY || "")

type LicenseVerificationResponse = {
  success: boolean
  error?: string
  valid?: boolean
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

function workspaceOrganizationId() {
  const workspace = getCachedWorkspaceBootstrap()
  return workspace?.organization?.id || workspace?.membership?.organization_id || ""
}

function randomDeviceId() {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2)
  return `BZG-${random.replace(/-/g, "").slice(0, 24).toUpperCase()}`
}

export async function getOrCreateDeviceId() {
  const cached = await getOfflineMeta<string>(DEVICE_META_KEY, "", "global").catch(() => "")
  if (cached) return cached

  if (typeof window !== "undefined") {
    const stored = localStorage.getItem(DEVICE_STORAGE_KEY)
    if (stored) {
      await setOfflineMeta(DEVICE_META_KEY, stored, "global").catch(() => undefined)
      return stored
    }
  }

  const next = randomDeviceId()
  if (typeof window !== "undefined") localStorage.setItem(DEVICE_STORAGE_KEY, next)
  await setOfflineMeta(DEVICE_META_KEY, next, "global").catch(() => undefined)
  return next
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
      approved: true,
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

async function createLocalWorkspaceFromLicense(payload: LicensePayload) {
  const workspace = workspaceFromLicense(payload)
  await cacheWorkspaceBootstrap(workspace)
  if (typeof window !== "undefined") {
    sessionStorage.setItem("bezgrow:organization-id", JSON.stringify({ value: payload.business_id, cachedAt: Date.now() }))
  }
  setDesktopAuthMarker()
}

async function verifyLicenseForActivation(input: unknown, parsed: ReturnType<typeof parseLicenseInput>) {
  try {
    return await verifyLicenseSignature(parsed, PUBLIC_KEY)
  } catch (error) {
    if (typeof fetch === "undefined") throw error
    const response = await fetch("/api/license/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license: input }),
    })
    const result = (await response.json().catch(() => null)) as LicenseVerificationResponse | null
    if (!response.ok || !result?.success || !result.valid) {
      throw new Error(result?.error || (error instanceof Error ? error.message : "License signature is invalid."))
    }
    return true
  }
}

export async function activateOfflineLicense(input: unknown) {
  const parsed = parseLicenseInput(input)
  const deviceId = await getOrCreateDeviceId()
  if (parsed.payload.device_id !== deviceId) {
    await logLicenseEvent("global", "LICENSE_WRONG_DEVICE", "Rejected license issued for another device.", parsed.payload.license_id)
    throw new Error("This license was issued for another device.")
  }

  const validSignature = await verifyLicenseForActivation(input, parsed)
  if (!validSignature) {
    await logLicenseEvent("global", "LICENSE_TAMPERED", "Rejected tampered or unsigned license.", parsed.payload.license_id)
    throw new Error("License signature is invalid.")
  }

  if (Date.now() > dateEnd(parsed.payload.expiry_date, parsed.payload.grace_period_days).getTime()) {
    await logLicenseEvent("global", "LICENSE_EXPIRED_IMPORT", "Rejected expired license import.", parsed.payload.license_id)
    throw new Error("This license is already expired.")
  }

  await writeActivatedLicense(parsed.payload, parsed.licenseKey, parsed.signatureText)
  await createLocalWorkspaceFromLicense(parsed.payload)
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
  const rows = await readLicenseRows(organizationId)
  return evaluateStoredLicense(rows, { deviceId })
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
