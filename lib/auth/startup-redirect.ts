"use client"

import { completeDesktopAuthCallback } from "@/lib/desktop/auth-callback"
import { hasCachedDesktopSession, readCachedDesktopSession } from "@/lib/desktop/session"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { getCachedWorkspaceBootstrap } from "@/lib/offline/db"
import { supabase } from "@/lib/supabase"
import type { WorkspaceBootstrapPayload } from "@/lib/workspaceBootstrapClient"

function redirectFromWorkspace(payload: WorkspaceBootstrapPayload | null, fallback = "/dashboard") {
  if (!payload?.success) return ""
  if (payload.permissions?.admin || payload.profile?.role === "admin") return "/admin"
  if (payload.profile?.is_suspended) return "/login?error=account_suspended"
  if (!payload.profile?.approved) return "/pending-approval"

  const hasBusiness = Boolean(payload.profile?.business_created || payload.organization?.id || payload.membership?.organization_id)
  return hasBusiness ? fallback : "/create-business"
}

async function fetchBootstrapWithSession(accessToken?: string) {
  const desktopRuntime = await isTauriRuntimeAsync()
  const bootstrapPath = "/api/workspace/bootstrap"
  const url = desktopRuntime ? `/api/desktop-proxy?path=${encodeURIComponent(bootstrapPath)}` : bootstrapPath

  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
  })

  if (!response.ok) return null
  return (await response.json().catch(() => null)) as WorkspaceBootstrapPayload | null
}

export async function resolveStartupRedirect(fallback = "/dashboard") {
  if (typeof window === "undefined") return ""

  const offline = typeof navigator !== "undefined" && !navigator.onLine
  if (offline) {
    const [hasSession, cachedWorkspace] = await Promise.all([
      hasCachedDesktopSession(),
      Promise.resolve(getCachedWorkspaceBootstrap()),
    ])
    return hasSession ? redirectFromWorkspace(cachedWorkspace, fallback) : ""
  }

  const {
    data: { session },
  } = await supabase.auth.getSession()
  const desktopRuntime = await isTauriRuntimeAsync()

  if (desktopRuntime) {
    const cachedSession = await readCachedDesktopSession()
    const activeSession = cachedSession?.access_token ? cachedSession : session

    if (activeSession?.access_token && activeSession.refresh_token) {
      const { error } = await supabase.auth.setSession({
        access_token: activeSession.access_token,
        refresh_token: activeSession.refresh_token,
      })

      if (!error) {
        return completeDesktopAuthCallback(activeSession.access_token, activeSession.refresh_token, fallback)
      }
    }

    return ""
  }

  const payload = await fetchBootstrapWithSession(session?.access_token)
  const bootstrapRedirect = redirectFromWorkspace(payload, fallback)
  if (bootstrapRedirect) return bootstrapRedirect

  if (session?.access_token && session.refresh_token) {
    return completeDesktopAuthCallback(session.access_token, session.refresh_token, fallback)
  }

  return ""
}
