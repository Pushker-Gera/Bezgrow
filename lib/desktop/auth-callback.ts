"use client"

import { readCachedDesktopSession } from "@/lib/desktop/session"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"

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

export async function completeDesktopAuthCallback(accessToken: string, refreshToken: string, nextPath = "/dashboard") {
  const desktopRuntime = await isTauriRuntimeAsync()
  if (desktopRuntime) {
    // Desktop ERP access is license-based. A cloud login never hydrates or
    // authorizes a local business workspace.
    void accessToken
    void refreshToken
    return "/offline"
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
    throw new Error(payload.error || "Unable to complete login.")
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
