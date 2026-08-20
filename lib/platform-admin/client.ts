"use client"

import { invokeTauri, isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { supabase } from "@/lib/supabase"

type DeviceProof = {
  deviceId: string
  publicKey: string
  signature: string
  timestamp: string
  nonce: string
}

const DEVICE_DENIED = "This device is not authorized for Bezgrow Platform Administration."
const DEVICE_AUTHORIZE_PATH = "/api/platform-admin/device/authorize"
const DEVICE_STATUS_PATH = "/api/platform-admin/device/status"
let cachedAccessToken: { value: string; expiresAt: number } | null = null
let sessionRequest: Promise<string | null> | null = null
let authListenerReady = false

function ensureAuthListener() {
  if (authListenerReady || typeof window === "undefined") return
  authListenerReady = true
  supabase.auth.onAuthStateChange((_event, session) => {
    cachedAccessToken = session?.access_token
      ? { value: session.access_token, expiresAt: (session.expires_at || 0) * 1000 }
      : null
  })
}

async function platformAdminAccessToken() {
  ensureAuthListener()
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) return cachedAccessToken.value
  if (sessionRequest) return sessionRequest
  sessionRequest = supabase.auth.getSession().then(({ data, error }) => {
    const session = data.session
    if (error || !session?.access_token) return null
    cachedAccessToken = { value: session.access_token, expiresAt: (session.expires_at || 0) * 1000 }
    return session.access_token
  }).finally(() => {
    sessionRequest = null
  })
  return sessionRequest
}

function bytesForBody(body: BodyInit | null | undefined) {
  if (body === undefined || body === null) return new Uint8Array()
  if (typeof body === "string") return new TextEncoder().encode(body)
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  throw new Error("Platform Admin requests support only deterministic text or byte bodies.")
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function nativeProof(method: string, pathAndQuery: string, body: BodyInit | null | undefined) {
  if (!(await isTauriRuntimeAsync().catch(() => false))) throw new Error(DEVICE_DENIED)
  return invokeTauri<DeviceProof>("desktop_platform_admin_proof", {
    method,
    pathAndQuery,
    bodySha256: await sha256Hex(bytesForBody(body)),
  })
}

function proofHeaders(proof: DeviceProof) {
  return {
    "x-bezgrow-desktop-admin": "1",
    "x-bezgrow-device-id": proof.deviceId,
    "x-bezgrow-device-public-key": proof.publicKey,
    "x-bezgrow-device-signature": proof.signature,
    "x-bezgrow-device-timestamp": proof.timestamp,
    "x-bezgrow-device-nonce": proof.nonce,
  }
}

async function desktopControlPlaneFetch(
  pathAndQuery: string,
  init: RequestInit,
  accessToken?: string,
) {
  const method = (init.method || "GET").toUpperCase()
  const proof = await nativeProof(method, pathAndQuery, init.body)
  const headers = new Headers(init.headers)
  Object.entries(proofHeaders(proof)).forEach(([name, value]) => headers.set(name, value))
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`)
  const target = `/api/desktop-proxy?path=${encodeURIComponent(pathAndQuery)}`
  return fetch(target, {
    ...init,
    method,
    headers,
    cache: "no-store",
    credentials: "same-origin",
  })
}

export async function authorizeThisPlatformAdminDevice(input: {
  licenseKey: string
  deviceId: string
}) {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new Error("Platform Administration requires an internet connection.")
  }
  const body = JSON.stringify({ license_key: input.licenseKey, device_id: input.deviceId })
  const response = await desktopControlPlaneFetch(DEVICE_AUTHORIZE_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(12_000),
  })
  const payload = await response.json().catch(() => null) as {
    success?: boolean
    authorized?: boolean
    error?: string
  } | null
  if (!response.ok || !payload?.success || !payload.authorized) {
    throw new Error(payload?.error || DEVICE_DENIED)
  }
  return true
}

export async function secureAdminFetch(pathAndQuery: string, init: RequestInit = {}) {
  if (!pathAndQuery.startsWith("/api/admin/")) throw new Error("Invalid Platform Admin API path.")
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new Error("Platform Administration requires an internet connection.")
  }
  const accessToken = await platformAdminAccessToken()
  if (!accessToken) throw new Error("Platform Admin authentication required.")
  return desktopControlPlaneFetch(pathAndQuery, init, accessToken)
}

export async function verifyThisPlatformAdminDevice() {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new Error("Platform Administration requires an internet connection.")
  }
  const response = await desktopControlPlaneFetch(DEVICE_STATUS_PATH, {
    method: "GET",
    signal: AbortSignal.timeout(12_000),
  })
  const payload = await response.json().catch(() => null) as {
    success?: boolean
    authorized?: boolean
    error?: string
  } | null
  if (!response.ok || !payload?.success || !payload.authorized) {
    throw new Error(payload?.error || DEVICE_DENIED)
  }
  return true
}

export async function downloadAdminFile(pathAndQuery: string) {
  const response = await secureAdminFetch(pathAndQuery)
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null
    throw new Error(payload?.error || "The admin export could not be downloaded.")
  }
  const blob = await response.blob()
  const disposition = response.headers.get("content-disposition") || ""
  const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] || "bezgrow-admin-export.csv"
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export { DEVICE_DENIED as PLATFORM_ADMIN_DEVICE_DENIED }
