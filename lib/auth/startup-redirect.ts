"use client"

import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { localLicenseSnapshot, restoreLicensedWorkspaceContext } from "@/lib/offline/local/license"
import { getLocalDatabaseService } from "@/lib/offline/local/service"

export async function resolveStartupRedirect(fallback = "/dashboard") {
  if (typeof window === "undefined") return ""

  const desktopRuntime = await isTauriRuntimeAsync()
  if (desktopRuntime) {
    await getLocalDatabaseService().ensureReady()
    const workspace = await restoreLicensedWorkspaceContext().catch(() => null)
    const organizationId = workspace?.organization?.id || workspace?.membership?.organization_id || undefined
    const license = await localLicenseSnapshot(organizationId).catch(() => null)
    if (license?.allowed) return fallback === "/admin" ? "/dashboard" : fallback
    return `/offline?next=${encodeURIComponent(fallback)}`
  }

  return "/download?erp=desktop_local_only"
}
