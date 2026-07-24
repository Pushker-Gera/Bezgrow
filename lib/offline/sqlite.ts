"use client"

import { isDesktopRuntime } from "@/lib/desktop/tauri"
import { getLocalDatabaseService } from "@/lib/offline/local/service"
import { localFirstRepositoryAdapter } from "@/lib/offline/local/adapters"
import {
  clearNormalizedData,
  getNormalizedMeta,
  importLegacyJsonCollectionsOnce,
  mergeNormalizedOrganization,
  setNormalizedMeta,
  updateNormalizedAction,
  writeNormalizedConflict,
  writeNormalizedSyncLog,
} from "@/lib/offline/local/repositories"
import type { OfflineAction, OfflineActionStatus, OfflineCollection } from "@/lib/offline/db"

const service = getLocalDatabaseService()

let legacyImportPromise: Promise<void> | null = null

async function strictDesktopStorage() {
  return isDesktopRuntime().catch(() => false)
}

async function rethrowInDesktop(error: unknown) {
  if (await strictDesktopStorage()) throw error
}

async function ensureSqliteReady() {
  const desktopRuntime = await isDesktopRuntime().catch(() => false)
  const db = await service.connection("read").catch(async (error) => {
    await service.recordOperationFailure("sqlite_ready", error, "DatabaseManager.ensureReady")
    if (desktopRuntime) throw error
    return null
  })
  if (!db) {
    if (desktopRuntime) throw new Error("Bezgrow local database is not available in the desktop runtime.")
    return null
  }

  if (!legacyImportPromise) {
    legacyImportPromise = importLegacyJsonCollectionsOnce()
      .then(() => undefined)
      .catch(async (error) => {
        await service.recordOperationFailure("legacy_sqlite_import", error, "importLegacyJsonCollectionsOnce")
        console.warn("[offline/sqlite] legacy SQLite import skipped", error)
      })
  }
  await legacyImportPromise
  return db
}

export async function getSqliteDb() {
  return ensureSqliteReady()
}

export async function mergeSqliteOrganizations(sourceOrganizationId: string, targetOrganizationId: string) {
  const db = await ensureSqliteReady()
  if (!db) return false
  await mergeNormalizedOrganization(sourceOrganizationId, targetOrganizationId)
  return true
}

export async function putSqliteCollection<T>(organizationId: string, collection: OfflineCollection, value: T) {
  const db = await ensureSqliteReady()
  if (!db) return false

  try {
    await localFirstRepositoryAdapter.write(organizationId, collection, value)
    return true
  } catch (error) {
    console.warn("[offline/sqlite] normalized collection write failed", error)
    await rethrowInDesktop(error)
    return false
  }
}

export async function getSqliteCollection<T>(organizationId: string, collection: OfflineCollection, fallback: T) {
  const db = await ensureSqliteReady()
  if (!db) return { hit: false, value: fallback }

  try {
    const values = await localFirstRepositoryAdapter.read<unknown[]>(organizationId, collection, [])
    if (values.length === 0) return { hit: false, value: fallback }
    if (Array.isArray(fallback)) return { hit: true, value: values as T }
    return { hit: true, value: (values[0] ?? fallback) as T }
  } catch (error) {
    console.warn("[offline/sqlite] normalized collection read failed", error)
    await rethrowInDesktop(error)
    return { hit: false, value: fallback }
  }
}

export async function queueSqliteAction(action: OfflineAction) {
  const db = await ensureSqliteReady()
  if (!db) return false

  try {
    await localFirstRepositoryAdapter.queue(action)
    return true
  } catch (error) {
    console.warn("[offline/sqlite] normalized queue write failed", error)
    await rethrowInDesktop(error)
    return false
  }
}

export async function listSqliteActions(statuses?: OfflineActionStatus[]) {
  const db = await ensureSqliteReady()
  if (!db) return null

  try {
    return await localFirstRepositoryAdapter.listActions(statuses)
  } catch (error) {
    console.warn("[offline/sqlite] normalized queue read failed", error)
    await rethrowInDesktop(error)
    return null
  }
}

export async function updateSqliteAction(id: string, patch: Partial<OfflineAction>) {
  const db = await ensureSqliteReady()
  if (!db) return null

  try {
    return await updateNormalizedAction(id, patch)
  } catch (error) {
    console.warn("[offline/sqlite] normalized queue update failed", error)
    await rethrowInDesktop(error)
    return null
  }
}

export async function writeSqliteSyncLog(input: {
  id: string
  organizationId?: string | null
  actionId?: string | null
  status: string
  message?: string | null
  payload?: Record<string, unknown> | null
}) {
  const db = await ensureSqliteReady()
  if (!db) return false

  try {
    await writeNormalizedSyncLog(input)
    return true
  } catch (error) {
    console.warn("[offline/sqlite] normalized sync log write failed", error)
    await rethrowInDesktop(error)
    return false
  }
}

export async function writeSqliteConflict(input: {
  id: string
  organizationId: string
  entityType: string
  localId?: string | null
  serverId?: string | null
  localPayload?: Record<string, unknown> | null
  serverPayload?: Record<string, unknown> | null
  message: string
}) {
  const db = await ensureSqliteReady()
  if (!db) return false

  try {
    await writeNormalizedConflict(input)
    return true
  } catch (error) {
    console.warn("[offline/sqlite] normalized conflict write failed", error)
    await rethrowInDesktop(error)
    return false
  }
}

export async function setSqliteMeta(key: string, value: unknown, organizationId = "global") {
  const db = await ensureSqliteReady()
  if (!db) return false

  try {
    await setNormalizedMeta(key, value, organizationId)
    return true
  } catch (error) {
    console.warn("[offline/sqlite] normalized meta write failed", error)
    await rethrowInDesktop(error)
    return false
  }
}

export async function getSqliteMeta<T>(key: string, fallback: T, organizationId = "global") {
  const db = await ensureSqliteReady()
  if (!db) return fallback

  try {
    return await getNormalizedMeta(key, fallback, organizationId)
  } catch (error) {
    console.warn("[offline/sqlite] normalized meta read failed", error)
    await rethrowInDesktop(error)
    return fallback
  }
}

export async function clearSqliteOfflineData() {
  const db = await ensureSqliteReady()
  if (!db) return false

  try {
    await clearNormalizedData()
    return true
  } catch (error) {
    console.warn("[offline/sqlite] normalized clear failed", error)
    await rethrowInDesktop(error)
    return false
  }
}

export async function exportSqliteBackup() {
  const db = await ensureSqliteReady()
  if (!db) return null

  try {
    return await localFirstRepositoryAdapter.exportBackup()
  } catch (error) {
    console.warn("[offline/sqlite] normalized backup export failed", error)
    await rethrowInDesktop(error)
    return null
  }
}
