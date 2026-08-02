"use client"

import { isDesktopRuntime } from "@/lib/desktop/tauri"
import { getLocalDatabaseService, type SqlExecutor } from "@/lib/offline/local/service"
import {
  exportNormalizedBackup,
  getNormalizedCollection,
  putNormalizedCollection,
  repositories,
} from "@/lib/offline/local/repositories"
import type { OfflineAction, OfflineActionStatus, OfflineCollection } from "@/lib/offline/db"

export type DataSourceMode = "sqlite" | "indexeddb" | "unavailable"

export class LocalFirstRepositoryAdapter {
  constructor(private readonly localDb = getLocalDatabaseService()) {}

  async mode(): Promise<DataSourceMode> {
    const desktopRuntime = await isDesktopRuntime().catch(() => false)
    const db = await this.localDb.connection("read").catch((error) => {
      if (desktopRuntime) throw error
      return null
    })
    if (db) return "sqlite"
    if (desktopRuntime) throw new Error("Bezgrow local database is required in desktop mode.")
    if (typeof window !== "undefined" && "indexedDB" in window) return "indexeddb"
    return "unavailable"
  }

  async read<T>(organizationId: string, collection: OfflineCollection, fallback: T): Promise<T> {
    if (!(await this.localDb.isAvailable())) return fallback
    const rows = await getNormalizedCollection(organizationId, collection)
    return (Array.isArray(fallback) ? rows : rows[0] ?? fallback) as T
  }

  async write(organizationId: string, collection: OfflineCollection, value: unknown) {
    if (!(await this.localDb.isAvailable())) return false
    await putNormalizedCollection(organizationId, collection, value)
    return true
  }

  async queue(action: OfflineAction) {
    // Compatibility no-op: local writes are final and are never queued for upload.
    void action
    return true
  }

  async listActions(statuses?: OfflineActionStatus[]) {
    void statuses
    return []
  }

  async transaction<T>(work: (db: SqlExecutor) => Promise<T>) {
    return this.localDb.transaction(work)
  }

  async integrityReport() {
    return this.localDb.integrityReport()
  }

  async exportBackup() {
    if (!(await this.localDb.isAvailable())) return null
    return exportNormalizedBackup()
  }

  repositories() {
    return repositories
  }
}

export const localFirstRepositoryAdapter = new LocalFirstRepositoryAdapter()
