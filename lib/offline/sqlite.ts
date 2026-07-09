"use client"

import { getLocalDatabaseService, type SqlExecutor } from "@/lib/offline/local/service"
import { localFirstRepositoryAdapter } from "@/lib/offline/local/adapters"
import {
  clearNormalizedData,
  getNormalizedMeta,
  importLegacyJsonCollectionsOnce,
  setNormalizedMeta,
  updateNormalizedAction,
  writeNormalizedConflict,
  writeNormalizedSyncLog,
} from "@/lib/offline/local/repositories"
import type { OfflineAction, OfflineActionStatus, OfflineCollection } from "@/lib/offline/db"

const service = getLocalDatabaseService()

let dbPromise: Promise<SqlExecutor | null> | null = null

async function ensureSqliteReady() {
  if (dbPromise) {
    const db = await dbPromise
    if (db) return db
    dbPromise = null
  }

  dbPromise = service
    .connection("read")
    .then(async (db) => {
      if (!db) return null
      await importLegacyJsonCollectionsOnce().catch((error) => {
        console.warn("[offline/sqlite] legacy SQLite import skipped", error)
      })
      return db
    })
    .catch((error) => {
      console.warn("[offline/sqlite] falling back to IndexedDB", error)
      return null
    })

  const db = await dbPromise
  if (!db) dbPromise = null
  return db
}

export async function getSqliteDb() {
  return ensureSqliteReady()
}

export async function putSqliteCollection<T>(organizationId: string, collection: OfflineCollection, value: T) {
  const db = await ensureSqliteReady()
  if (!db) return false

  try {
    await localFirstRepositoryAdapter.write(organizationId, collection, value)
    return true
  } catch (error) {
    console.warn("[offline/sqlite] normalized collection write failed", error)
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
    return null
  }
}
