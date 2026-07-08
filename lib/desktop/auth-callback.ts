"use client"

import { readCachedDesktopSession, setDesktopAuthMarker } from "@/lib/desktop/session"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import type { WorkspaceBootstrapPayload } from "@/lib/workspaceBootstrapClient"

type DesktopCallbackResponse = {
  redirectTo?: string
  error?: string
}

function toLocalPath(value: string | undefined, fallback: string) {
  if (!value) return fallback

  try {
    const parsed = new URL(value, window.location.origin)
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return fallback
  }
}

function desktopRedirectFromWorkspace(payload: WorkspaceBootstrapPayload | null, fallback: string) {
  if (!payload?.success) return "/login"
  if (payload.permissions?.admin || payload.profile?.role === "admin") return "/admin"
  if (payload.profile?.is_suspended) return "/login?error=account_suspended"

  const hasBusiness = Boolean(payload.profile?.business_created || payload.organization?.id || payload.membership?.organization_id)
  if (!hasBusiness) return "/create-business"
  if (fallback === "/admin") return "/dashboard"
  return fallback
}

async function completeDesktopAuthViaCloud(accessToken: string, nextPath: string) {
  const proxyPath = `/api/desktop-proxy?path=${encodeURIComponent("/api/workspace/bootstrap")}`
  const response = await fetch(proxyPath, {
    credentials: "include",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
  const payload = (await response.json().catch(() => null)) as WorkspaceBootstrapPayload | null

  if (!response.ok || !payload?.success) {
    throw new Error(payload?.error || "Unable to validate desktop login.")
  }

  const redirectPath = desktopRedirectFromWorkspace(payload, nextPath)

  await fetch("/auth/callback", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      access_token: accessToken,
      refresh_token: "desktop-session-cookie-sync",
      next: redirectPath,
      desktop: true,
    }),
  }).catch(() => undefined)
  setDesktopAuthMarker()

  return redirectPath
}

export async function completeDesktopAuthCallback(accessToken: string, refreshToken: string, nextPath = "/dashboard") {
  if (await isTauriRuntimeAsync()) {
    return completeDesktopAuthViaCloud(accessToken, nextPath)
  }

  const response = await fetch("/auth/callback", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      next: nextPath,
    }),
  })

  const payload = (await response.json().catch(() => ({}))) as DesktopCallbackResponse

  if (!response.ok) {
    throw new Error(payload.error || "Unable to complete desktop login.")
  }

  return toLocalPath(payload.redirectTo, nextPath)
}

export async function syncCachedDesktopSessionWithServer(nextPath = "/dashboard") {
  if (!(await isTauriRuntimeAsync())) return null
  if (typeof navigator !== "undefined" && !navigator.onLine) return null

  const cached = await readCachedDesktopSession()
  if (!cached?.access_token || !cached.refresh_token) return null

  try {
    return await completeDesktopAuthCallback(cached.access_token, cached.refresh_token, nextPath)
  } catch {
    return null
  }
}
