"use client"

import { detectRuntimeMode, isDesktopRuntime } from "@/lib/desktop/tauri"
import { LOCAL_DB_URL, localMigrations } from "@/lib/offline/local/schema"

export type SqlValue = string | number | null

export type SqlExecutor = {
  execute(query: string, bindValues?: SqlValue[]): Promise<unknown>
  select<T>(query: string, bindValues?: SqlValue[]): Promise<T[]>
}

type SqlModule = {
  default: {
    load(url: string): Promise<SqlExecutor>
  }
}

const POOL_SIZE = 4

export class LocalDatabaseUnavailableError extends Error {
  constructor(message: string, readonly causeMessage?: string) {
    super(message)
    this.name = "LocalDatabaseUnavailableError"
  }
}

function nowIso() {
  return new Date().toISOString()
}

function isOkStatus(value: unknown) {
  return String(value || "").toLowerCase() === "ok"
}

export class LocalDatabaseService {
  private readonly pool: Array<Promise<SqlExecutor | null> | null> = Array.from({ length: POOL_SIZE }, () => null)
  private migrationPromise: Promise<void> | null = null
  private lastInitializationError: string | null = null
  private poolCursor = 0

  async isAvailable() {
    return isDesktopRuntime()
  }

  async diagnostics() {
    return {
      runtimeMode: await detectRuntimeMode().catch(() => "browser" as const),
      databaseUrl: LOCAL_DB_URL,
      migrationVersion: localMigrations[localMigrations.length - 1]?.version || 0,
      lastInitializationError: this.lastInitializationError,
    }
  }

  private unavailableMessage() {
    return [
      "Bezgrow local database could not start.",
      "Restart the desktop app and try again.",
      "If this continues, export diagnostics from the offline recovery screen before making more changes.",
    ].join(" ")
  }

  private unavailableError() {
    return new LocalDatabaseUnavailableError(this.unavailableMessage(), this.lastInitializationError || undefined)
  }

  async connection(mode: "read" | "write" = "read") {
    const desktopRuntime = await this.isAvailable()
    if (!desktopRuntime) return null

    const slot = mode === "write" ? 0 : (this.poolCursor = (this.poolCursor + 1) % POOL_SIZE)
    if (!this.pool[slot]) {
      this.pool[slot] = this.openConnection()
    }

    const db = await this.pool[slot]
    if (!db) {
      this.pool[slot] = null
      throw this.unavailableError()
    }
    await this.ensureReady()
    return db
  }

  async requireConnection(mode: "read" | "write" = "read") {
    const db = await this.connection(mode)
    if (!db) throw this.unavailableError()
    return db
  }

  async execute(query: string, bindValues: SqlValue[] = []) {
    const db = await this.requireConnection("write")
    return db.execute(query, bindValues)
  }

  async select<T>(query: string, bindValues: SqlValue[] = []) {
    const db = await this.requireConnection("read")
    return db.select<T>(query, bindValues)
  }

  async transaction<T>(work: (db: SqlExecutor) => Promise<T>) {
    const db = await this.requireConnection("write")
    await db.execute("BEGIN IMMEDIATE")
    try {
      const result = await work(db)
      await db.execute("COMMIT")
      return result
    } catch (error) {
      await db.execute("ROLLBACK").catch(() => undefined)
      throw error
    }
  }

  async ensureReady() {
    if (!this.migrationPromise) {
      this.migrationPromise = this.runMigrationsAndRepair().catch((error) => {
        this.migrationPromise = null
        throw error
      })
    }
    await this.migrationPromise
  }

  async integrityReport() {
    const db = await this.requireConnection("read")
    const [quick] = await db.select<Record<string, unknown>>("PRAGMA quick_check")
    const foreignKeyRows = await db.select<Record<string, unknown>>("PRAGMA foreign_key_check")
    return {
      quickCheck: Object.values(quick || {})[0] || "unknown",
      foreignKeyViolations: foreignKeyRows.length,
      ok: isOkStatus(Object.values(quick || {})[0]) && foreignKeyRows.length === 0,
    }
  }

  private async openConnection() {
    try {
      const sqlPlugin = (await import("@tauri-apps/plugin-sql")) as SqlModule
      const db = await sqlPlugin.default.load(LOCAL_DB_URL)
      await this.configureConnection(db)
      this.lastInitializationError = null
      return db
    } catch (error) {
      this.lastInitializationError = error instanceof Error ? error.message : String(error)
      console.warn("[offline/local-db] local database plugin unavailable.", error)
      return null
    }
  }

  private async configureConnection(db: SqlExecutor) {
    await db.execute("PRAGMA foreign_keys = ON")
    await db.execute("PRAGMA journal_mode = WAL")
    await db.execute("PRAGMA synchronous = NORMAL")
    await db.execute("PRAGMA temp_store = MEMORY")
    await db.execute("PRAGMA busy_timeout = 5000")
    await db.execute("PRAGMA cache_size = -64000")
  }

  private async runMigrationsAndRepair() {
    if (!this.pool[0]) this.pool[0] = this.openConnection()
    const db = await this.pool[0]
    if (!db) throw this.unavailableError()

    await this.configureConnection(db)
    await db.execute("BEGIN IMMEDIATE")
    try {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)

      const appliedRows = await db.select<{ version: number }>("SELECT version FROM schema_migrations")
      const applied = new Set(appliedRows.map((row) => Number(row.version)))

      for (const migration of localMigrations) {
        if (applied.has(migration.version)) continue
        for (const statement of migration.sql) {
          await this.executeMigrationStatement(db, statement)
        }
        await db.execute("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", [
          migration.version,
          migration.name,
          nowIso(),
        ])
      }

      await db.execute("PRAGMA user_version = " + localMigrations[localMigrations.length - 1].version)
      await db.execute("COMMIT")
    } catch (error) {
      await db.execute("ROLLBACK").catch(() => undefined)
      throw error
    }

    await this.repairAndOptimize(db)
  }

  private async executeMigrationStatement(db: SqlExecutor, statement: string) {
    try {
      await db.execute(statement)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const isDuplicateColumn = /^\s*ALTER\s+TABLE/i.test(statement) && /duplicate column name/i.test(message)
      if (isDuplicateColumn) return
      throw error
    }
  }

  private async repairAndOptimize(db: SqlExecutor) {
    const [quick] = await db.select<Record<string, unknown>>("PRAGMA quick_check")
    const quickStatus = Object.values(quick || {})[0] || "unknown"

    if (!isOkStatus(quickStatus)) {
      await db.execute("REINDEX").catch(() => undefined)
      await db.execute("ANALYZE").catch(() => undefined)
    }

    const foreignKeyRows = await db.select<Record<string, unknown>>("PRAGMA foreign_key_check").catch(() => [])
    await db.execute(
      `INSERT OR REPLACE INTO database_health (id, check_name, status, detail, checked_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        "latest",
        "startup_integrity",
        isOkStatus(quickStatus) && foreignKeyRows.length === 0 ? "ok" : "needs_review",
        `quick_check=${String(quickStatus)}; foreign_key_violations=${foreignKeyRows.length}`,
        nowIso(),
      ]
    ).catch(() => undefined)
    await db.execute("PRAGMA optimize").catch(() => undefined)
  }
}

let localDatabaseService: LocalDatabaseService | null = null

export function getLocalDatabaseService() {
  if (!localDatabaseService) localDatabaseService = new LocalDatabaseService()
  return localDatabaseService
}
