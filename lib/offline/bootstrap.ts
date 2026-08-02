"use client"

import { cacheWorkspaceBootstrap, putOfflineData } from "@/lib/offline/db"
import type { WorkspaceBootstrapPayload } from "@/lib/workspaceBootstrapClient"

type BootstrapProgress = {
  message: string
  completed: number
  total: number
}

function organizationIdFrom(payload: WorkspaceBootstrapPayload) {
  return payload.organization?.id || payload.membership?.organization_id || null
}

/**
 * Compatibility entry point retained for older UI callers.
 *
 * It deliberately performs no network work. Customer ERP records are never
 * downloaded from, hydrated by, or reconciled with a cloud datastore.
 */
export async function prepareOfflineWorkspace(
  payload: WorkspaceBootstrapPayload,
  options: { force?: boolean; onProgress?: (progress: BootstrapProgress) => void } = {}
) {
  void options.force
  const organizationId = organizationIdFrom(payload)
  if (!payload.success || !organizationId) {
    return { prepared: false, reason: "missing-local-workspace" }
  }

  options.onProgress?.({ message: "Using the local SQLite workspace.", completed: 0, total: 1 })
  await cacheWorkspaceBootstrap(payload)
  await putOfflineData(organizationId, "settings", {
    id: `settings:${organizationId}`,
    organization_id: organizationId,
    organization: payload.organization || null,
    membership: payload.membership || null,
    features: payload.features || [],
    currency: payload.currency,
    timezone: payload.timezone,
    locale: payload.locale,
    updated_at: new Date().toISOString(),
  })
  options.onProgress?.({ message: "Local SQLite workspace ready.", completed: 1, total: 1 })
  return { prepared: true, reason: "local-sqlite-only" }
}
