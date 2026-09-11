"use client"

import { getAppLockStatus } from "@/lib/app-lock/client"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { cacheWorkspaceBootstrap, getCachedWorkspaceBootstrap } from "@/lib/offline/db"
import { getLocalDatabaseService } from "@/lib/offline/local/service"
import { localLicenseSnapshot, restoreLicensedWorkspaceContext } from "@/lib/offline/local/license"
import type { LicensePolicyResult } from "@/lib/license/policy"
import type { WorkspaceBootstrapPayload } from "@/lib/workspaceBootstrapClient"

type DataRow = Record<string, unknown>

export const STARTUP_STATES = {
  databaseInitializing: "DATABASE_INITIALIZING",
  databaseReady: "DATABASE_READY",
  businessOnboardingRequired: "BUSINESS_ONBOARDING_REQUIRED",
  accountRequired: "ACCOUNT_REQUIRED",
  entitlementRequired: "ENTITLEMENT_REQUIRED",
  appLockRequired: "APP_LOCK_REQUIRED",
  appLockLocked: "APP_LOCK_LOCKED",
  ready: "READY",
  readOnlyExpired: "READ_ONLY_EXPIRED",
  recoveryRequired: "RECOVERY_REQUIRED",
  platformAdminAllowed: "PLATFORM_ADMIN_ALLOWED",
  browserLocalOnly: "BROWSER_LOCAL_ONLY",
} as const

export type StartupState = typeof STARTUP_STATES[keyof typeof STARTUP_STATES]
export type StartupResolution = {
  state: StartupState
  organizationId?: string
  workspace?: WorkspaceBootstrapPayload | null
  entitlement?: LicensePolicyResult | null
  redirectTo?: string
  reason?: string
}

const READ_ONLY_ELIGIBLE_STATUSES = new Set<LicensePolicyResult["status"]>([
  "expired",
  "cancelled",
])

export function canContinueReadOnly(status: LicensePolicyResult["status"]) {
  return READ_ONLY_ELIGIBLE_STATUSES.has(status)
}

export function readOnlySessionKey(entitlement: LicensePolicyResult, fallbackId = "global") {
  return `bezgrow:read-only:${String(entitlement.license?.id || fallbackId)}`
}

function text(value: unknown) {
  return typeof value === "string" ? value : ""
}

export async function restoreReadableLocalWorkspace(organizationId?: string) {
  const cached = getCachedWorkspaceBootstrap()
  if (cached?.success && (!organizationId || cached.organization?.id === organizationId)) return cached
  const db = await getLocalDatabaseService().requireConnection("read")
  const organizations = await db.select<DataRow>(
    `SELECT * FROM organizations WHERE deleted_at IS NULL AND id <> 'global' ${organizationId ? "AND id = ?" : ""} ORDER BY datetime(created_at) LIMIT 1`,
    organizationId ? [organizationId] : [],
  )
  const organization = organizations[0]
  if (!organization) return null
  const id = text(organization.id)
  const [user] = await db.select<DataRow>("SELECT * FROM local_users WHERE organization_id = ? ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END LIMIT 1", [id])
  const [member] = await db.select<DataRow>("SELECT * FROM organization_members WHERE organization_id = ? AND is_active = 1 LIMIT 1", [id])
  const featureRows = await db.select<DataRow>("SELECT feature_key FROM feature_flags WHERE organization_id = ? AND is_enabled = 1 ORDER BY feature_key", [id])
  const workspace: WorkspaceBootstrapPayload = {
    success: true,
    user: { id: text(user?.id), email: text(user?.email) || null },
    profile: { id: text(user?.id), role: text(user?.role) || "user", is_suspended: Boolean(user?.is_suspended), business_created: true },
    organization: {
      id, name: text(organization.name) || text(organization.business_name), business_name: text(organization.business_name),
      currency: text(organization.currency) || "INR", timezone: text(organization.timezone) || "Asia/Kolkata",
      locale: text(organization.locale) || "en-IN", business_type: text(organization.business_type) || null,
      business_category: text(organization.business_category) || null, created_at: text(organization.created_at) || null,
      joined_at: text(organization.joined_at) || text(organization.created_at) || null,
    },
    membership: { organization_id: id, role: text(member?.role) || "owner" },
    features: featureRows.map((row) => text(row.feature_key)).filter(Boolean),
    currency: text(organization.currency) || "INR", timezone: text(organization.timezone) || "Asia/Kolkata", locale: text(organization.locale) || "en-IN",
    permissions: { admin: false, canAccessDashboard: true, canManageBilling: true },
  }
  await cacheWorkspaceBootstrap(workspace)
  sessionStorage.setItem("bezgrow:organization-id", JSON.stringify({ value: id, cachedAt: Date.now() }))
  return workspace
}

export async function resolveDesktopStartupState(fallback = "/dashboard"): Promise<StartupResolution> {
  if (!(await isTauriRuntimeAsync().catch(() => false))) {
    return { state: STARTUP_STATES.browserLocalOnly, redirectTo: "/download?erp=desktop_local_only" }
  }
  try {
    await getLocalDatabaseService().ensureReady()
  } catch (error) {
    return { state: STARTUP_STATES.recoveryRequired, reason: error instanceof Error ? error.message : "Local database startup failed." }
  }

  const db = await getLocalDatabaseService().requireConnection("read")
  const [organization] = await db.select<DataRow>("SELECT id FROM organizations WHERE deleted_at IS NULL AND id <> 'global' ORDER BY datetime(created_at) LIMIT 1")
  const organizationId = text(organization?.id)
  if (!organizationId) {
    const legacyWorkspace = await restoreLicensedWorkspaceContext().catch(() => null)
    if (!legacyWorkspace?.success) {
      return { state: STARTUP_STATES.businessOnboardingRequired, redirectTo: "/create-business" }
    }
    const legacyId = legacyWorkspace.organization?.id || legacyWorkspace.membership?.organization_id || "global"
    const legacyEntitlement = await localLicenseSnapshot(legacyId).catch(() => null)
    if (!legacyEntitlement?.license) {
      return { state: STARTUP_STATES.recoveryRequired, organizationId: legacyId, workspace: legacyWorkspace, entitlement: legacyEntitlement }
    }
    if (!legacyEntitlement.allowed) {
      const readOnlyEligible = canContinueReadOnly(legacyEntitlement.status)
      const readOnlyAccepted = readOnlyEligible
        && sessionStorage.getItem(readOnlySessionKey(legacyEntitlement, legacyId)) === "1"
      return {
        state: readOnlyEligible ? STARTUP_STATES.readOnlyExpired : STARTUP_STATES.recoveryRequired,
        organizationId: legacyId,
        workspace: legacyWorkspace,
        entitlement: legacyEntitlement,
        redirectTo: readOnlyAccepted
          ? undefined
          : `/subscription?reason=${encodeURIComponent(legacyEntitlement.status)}&next=${encodeURIComponent(fallback)}`,
        reason: legacyEntitlement.reason,
      }
    }
    const legacyAppLock = await getAppLockStatus().catch(() => null)
    if (!legacyAppLock?.enabled) return { state: STARTUP_STATES.appLockRequired, organizationId: legacyId, workspace: legacyWorkspace, entitlement: legacyEntitlement }
    return { state: STARTUP_STATES.appLockLocked, organizationId: legacyId, workspace: legacyWorkspace, entitlement: legacyEntitlement }
  }

  const [attempt] = await db.select<DataRow>("SELECT stage FROM onboarding_attempts WHERE organization_id = ? ORDER BY datetime(updated_at) DESC LIMIT 1", [organizationId])
  const attemptStage = text(attempt?.stage)
  if (attemptStage && ["LOCAL_READY", "ACCOUNT_READY", "ENTITLEMENT_READY"].includes(attemptStage)) {
    return { state: attemptStage === "LOCAL_READY" ? STARTUP_STATES.accountRequired : STARTUP_STATES.entitlementRequired, organizationId, redirectTo: "/create-business?resume=1" }
  }

  const workspace = await restoreReadableLocalWorkspace(organizationId)
  const entitlement = await localLicenseSnapshot(organizationId).catch(() => null)
  if (!entitlement?.license) {
    return { state: STARTUP_STATES.entitlementRequired, organizationId, workspace, entitlement, redirectTo: `/offline?mode=legacy&next=${encodeURIComponent(fallback)}` }
  }
  if (!entitlement.allowed) {
    if (!canContinueReadOnly(entitlement.status)) {
      return {
        state: STARTUP_STATES.recoveryRequired,
        organizationId,
        workspace,
        entitlement,
        redirectTo: `/subscription?reason=${encodeURIComponent(entitlement.status)}&next=${encodeURIComponent(fallback)}`,
        reason: entitlement.reason,
      }
    }
    const readOnlyAccepted = sessionStorage.getItem(readOnlySessionKey(entitlement, organizationId)) === "1"
    return {
      state: STARTUP_STATES.readOnlyExpired, organizationId, workspace, entitlement,
      redirectTo: readOnlyAccepted ? undefined : `/subscription?expired=1&next=${encodeURIComponent(fallback)}`,
      reason: entitlement.reason,
    }
  }
  const appLock = await getAppLockStatus().catch(() => null)
  if (!appLock?.enabled) return { state: STARTUP_STATES.appLockRequired, organizationId, workspace, entitlement }
  return { state: STARTUP_STATES.appLockLocked, organizationId, workspace, entitlement }
}
