"use client"

import { getCachedWorkspaceBootstrap } from "@/lib/offline/db"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { localLicenseSnapshot, restoreLicensedWorkspaceContext } from "@/lib/offline/local/license"

export type WorkspaceBootstrapPayload = {
  success: boolean
  error?: string
  user?: { id?: string; email?: string | null }
  profile?: { id?: string; role?: string | null; is_suspended?: boolean; business_created?: boolean }
  organization?: {
    id?: string | null
    name?: string | null
    currency?: string | null
    timezone?: string | null
    locale?: string | null
    business_type?: string | null
    business_category?: string | null
    business_name?: string | null
    created_at?: string | null
    joined_at?: string | null
  } | null
  membership?: { organization_id?: string | null; role?: string | null } | null
  features?: string[]
  currency?: string
  timezone?: string
  locale?: string
  permissions?: { admin?: boolean; canAccessDashboard?: boolean; canManageBilling?: boolean }
}

export function clearWorkspaceBootstrapCache() {
  if (typeof window !== "undefined") {
    sessionStorage.removeItem("bezgrow:workspace-bootstrap")
    sessionStorage.removeItem("bezgrow:organization-id")
  }
}

/** Resolve the ERP workspace exclusively from the desktop's local license and SQLite cache. */
export async function getWorkspaceBootstrap(options: { forceFresh?: boolean } = {}) {
  void options.forceFresh
  if (!(await isTauriRuntimeAsync().catch(() => false))) {
    return {
      success: false,
      error: "Customer ERP records are available only in the Bezgrow desktop application.",
    } satisfies WorkspaceBootstrapPayload
  }

  const cached = getCachedWorkspaceBootstrap()
  if (cached?.success) return cached

  const restored = await restoreLicensedWorkspaceContext().catch(() => null)
  if (restored?.success) return restored

  const license = await localLicenseSnapshot().catch(() => null)
  return {
    success: false,
    error: license?.allowed
      ? "The licensed local workspace could not be restored."
      : license?.reason || "A valid local license is required.",
  } satisfies WorkspaceBootstrapPayload
}
