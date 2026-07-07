"use client"

import { getLocalDatabaseService, type SqlExecutor } from "@/lib/offline/local/service"
import {
  exportNormalizedBackup,
  getNormalizedCollection,
  listNormalizedActions,
  putNormalizedCollection,
  queueNormalizedAction,
  repositories,
} from "@/lib/offline/local/repositories"
import type { OfflineAction, OfflineActionStatus, OfflineCollection } from "@/lib/offline/db"

export type DataSourceMode = "sqlite" | "supabase" | "auto"

export type CloudAdapter = {
  mode: "supabase"
  isAvailable(): Promise<boolean>
}

export class LocalFirstRepositoryAdapter {
  constructor(
    private readonly localDb = getLocalDatabaseService(),
    private readonly cloudAdapter: CloudAdapter | null = null
  ) {}

  async mode(): Promise<DataSourceMode> {
    if (await this.localDb.isAvailable()) return "sqlite"
    return this.cloudAdapter && (await this.cloudAdapter.isAvailable()) ? "supabase" : "auto"
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
    if (!(await this.localDb.isAvailable())) return false
    await queueNormalizedAction(action)
    return true
  }

  async listActions(statuses?: OfflineActionStatus[]) {
    if (!(await this.localDb.isAvailable())) return null
    return listNormalizedActions(statuses)
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
