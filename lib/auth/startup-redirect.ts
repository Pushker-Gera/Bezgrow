"use client"

import { completeDesktopAuthCallback } from "@/lib/desktop/auth-callback"
import { hasCachedDesktopSession } from "@/lib/desktop/session"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { getCachedWorkspaceBootstrap } from "@/lib/offline/db"
import { localLicenseSnapshot, restoreLicensedWorkspaceContext } from "@/lib/offline/local/license"
import { getLocalDatabaseService } from "@/lib/offline/local/service"
import { supabase } from "@/lib/supabase"
import type { WorkspaceBootstrapPayload } from "@/lib/workspaceBootstrapClient"

function redirectFromWorkspace(payload: WorkspaceBootstrapPayload | null, fallback = "/dashboard") {
  if (!payload?.success) return ""
  if (payload.permissions?.admin || payload.profile?.role === "admin") return "/admin"
  if (payload.profile?.is_suspended) return "/login?error=account_suspended"

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

  const desktopRuntime = await isTauriRuntimeAsync()
  if (desktopRuntime) {
    await getLocalDatabaseService().integrityReport()
    const workspace = await restoreLicensedWorkspaceContext().catch(() => null)
    const organizationId = workspace?.organization?.id || workspace?.membership?.organization_id || undefined
    const license = await localLicenseSnapshot(organizationId).catch(() => null)
    if (license?.allowed) return fallback === "/admin" ? "/dashboard" : fallback
    return `/offline?next=${encodeURIComponent(fallback)}`
  }

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
  const payload = await fetchBootstrapWithSession(session?.access_token)
  const bootstrapRedirect = redirectFromWorkspace(payload, fallback)
  if (bootstrapRedirect) return bootstrapRedirect

  if (session?.access_token && session.refresh_token) {
    return completeDesktopAuthCallback(session.access_token, session.refresh_token, fallback)
  }

  return ""
}
