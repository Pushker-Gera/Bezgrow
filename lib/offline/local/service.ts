"use client"

import { detectRuntimeMode, invokeTauri, isDesktopRuntime, type RuntimeMode } from "@/lib/desktop/tauri"
import { LOCAL_DB_URL, localMigrations } from "@/lib/offline/local/schema"

export type SqlValue = string | number | null

export type SqlExecutor = {
  execute(query: string, bindValues?: SqlValue[]): Promise<unknown>
  select<T>(query: string, bindValues?: SqlValue[]): Promise<T[]>
}

type SqlModule = {
  default: {
    get(url: string): SqlExecutor
  }
}

type StartupStageStatus = "pending" | "ok" | "failed" | "skipped"

type StartupStageName =
  | "tauri_runtime_detection"
  | "frontend_bridge_availability"
  | "database_file_path"
  | "parent_directory"
  | "database_open"
  | "connection_creation"
  | "pragma_configuration"
  | "migration_backup"
  | "migration_execution"
  | "schema_version_check"
  | "integrity_check"
  | "repository_initialisation"

type StartupStage = {
  stage: StartupStageName
  status: StartupStageStatus
  startedAt: string
  durationMs?: number
  detail?: string
  errorCode?: string
  errorMessage?: string
}

type DesktopDatabaseDiagnostics = {
  appConfigDir: string
  appDataDir: string
  databasePath: string
  parentExists: boolean
  parentCreated: boolean
  parentWritable: boolean
  databaseExists: boolean
  databaseBytes: number
}

type DesktopDatabaseBackup = {
  backupPath: string
  checksumSha256: string
  bytes: number
  createdAt: string
}

const TEMPORARY_SQLITE_ERROR = /SQLITE_BUSY|busy|database is locked|locked|temporarily unavailable/i
const MIGRATION_TABLE = "schema_migrations"
const STARTUP_RETRY_DELAYS_MS = [120, 320, 700]

export class LocalDatabaseUnavailableError extends Error {
  constructor(message: string, readonly causeMessage?: string, readonly stage?: string, readonly code?: string) {
    super(message)
    this.name = "LocalDatabaseUnavailableError"
  }
}

function nowIso() {
  return new Date().toISOString()
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function isOkStatus(value: unknown) {
  return String(value || "").toLowerCase() === "ok"
}

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/(password|token|secret|key|cookie|authorization)=([^&\s]+)/gi, "$1=[redacted]").slice(0, 500)
}

function safeErrorCode(error: unknown) {
  const message = safeErrorMessage(error)
  if (/permission|denied|readonly/i.test(message)) return "sqlite_permission_denied"
  if (TEMPORARY_SQLITE_ERROR.test(message)) return "sqlite_busy_or_locked"
  if (/migration/i.test(message)) return "sqlite_migration_failed"
  if (/integrity|malformed|corrupt/i.test(message)) return "sqlite_integrity_failed"
  if (/Tauri runtime is not available|not available in the desktop runtime/i.test(message)) return "tauri_runtime_unavailable"
  if (/plugin|load|sql/i.test(message)) return "sqlite_plugin_unavailable"
  return "local_database_startup_failed"
}

function isTemporarySqliteError(error: unknown) {
  return TEMPORARY_SQLITE_ERROR.test(safeErrorMessage(error))
}

export class LocalDatabaseService {
  private primaryConnectionPromise: Promise<SqlExecutor> | null = null
  private startupPromise: Promise<SqlExecutor> | null = null
  private startupFailure: LocalDatabaseUnavailableError | null = null
  private lastInitializationError: string | null = null
  private lastFailedStage: StartupStageName | null = null
  private startupStages: StartupStage[] = []
  private desktopDiagnostics: DesktopDatabaseDiagnostics | null = null
  private migrationBackup: DesktopDatabaseBackup | null = null
  private runtimeMode: RuntimeMode | null = null

  async isAvailable() {
    return isDesktopRuntime()
  }

  async diagnostics() {
    return {
      runtimeMode: this.runtimeMode || (await detectRuntimeMode().catch(() => "browser" as const)),
      databaseUrl: LOCAL_DB_URL,
      migrationVersion: localMigrations[localMigrations.length - 1]?.version || 0,
      startupStatus: this.startupFailure ? "failed" : this.startupPromise ? "ready-or-initialising" : "not-started",
      lastFailedStage: this.lastFailedStage,
      lastInitializationError: this.lastInitializationError,
      desktopDiagnostics: this.desktopDiagnostics,
      migrationBackup: this.migrationBackup,
      startupStages: this.startupStages,
    }
  }

  private unavailableMessage() {
    return [
      "Bezgrow local database could not start.",
      "Restart the desktop app and try again.",
      "If this continues, export diagnostics from the offline recovery screen before making more changes.",
    ].join(" ")
  }

  private unavailableError(cause?: unknown, stage?: StartupStageName) {
    const causeMessage = cause ? safeErrorMessage(cause) : this.lastInitializationError || undefined
    const code = cause ? safeErrorCode(cause) : undefined
    const error = new LocalDatabaseUnavailableError(this.unavailableMessage(), causeMessage, stage, code)
    this.lastInitializationError = causeMessage || this.lastInitializationError
    this.lastFailedStage = stage || this.lastFailedStage
    this.startupFailure = error
    return error
  }

  async connection(mode: "read" | "write" = "read") {
    void mode
    const desktopRuntime = await this.isAvailable()
    if (!desktopRuntime) return null
    return this.ensureReady()
  }

  async requireConnection(mode: "read" | "write" = "read") {
    const db = await this.connection(mode)
    if (!db) throw this.unavailableError()
    return db
  }

  async execute(query: string, bindValues: SqlValue[] = []) {
    const db = await this.requireConnection("write")
    return this.withTemporaryLockRetry(() => db.execute(query, bindValues))
  }

  async select<T>(query: string, bindValues: SqlValue[] = []) {
    const db = await this.requireConnection("read")
    return this.withTemporaryLockRetry(() => db.select<T>(query, bindValues))
  }

  async transaction<T>(work: (db: SqlExecutor) => Promise<T>) {
    const db = await this.requireConnection("write")
    await this.withTemporaryLockRetry(() => db.execute("BEGIN IMMEDIATE"))
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
    if (this.startupFailure) throw this.startupFailure
    if (!this.startupPromise) {
      this.startupPromise = this.bootstrap().catch((error) => {
        const unavailable = error instanceof LocalDatabaseUnavailableError ? error : this.unavailableError(error, this.lastFailedStage || undefined)
        this.startupPromise = null
        throw unavailable
      })
    }
    return this.startupPromise
  }

  async integrityReport() {
    const db = await this.ensureReady()
    const [quick] = await db.select<Record<string, unknown>>("PRAGMA quick_check")
    const foreignKeyRows = await db.select<Record<string, unknown>>("PRAGMA foreign_key_check")
    return {
      quickCheck: Object.values(quick || {})[0] || "unknown",
      foreignKeyViolations: foreignKeyRows.length,
      ok: isOkStatus(Object.values(quick || {})[0]) && foreignKeyRows.length === 0,
    }
  }

  private async bootstrap() {
    this.startupStages = []
    this.startupFailure = null
    this.lastFailedStage = null
    this.migrationBackup = null

    await this.recordStage("tauri_runtime_detection", async () => {
      this.runtimeMode = await detectRuntimeMode()
      if (this.runtimeMode !== "tauri-dev" && this.runtimeMode !== "tauri-packaged") {
        throw new Error(`Local SQLite is only available inside the packaged desktop runtime. mode=${this.runtimeMode}`)
      }
      return `mode=${this.runtimeMode}`
    })

    await this.recordStage("frontend_bridge_availability", async () => {
      await invokeTauri("desktop_database_diagnostics")
      return "tauri invoke available"
    })

    this.desktopDiagnostics = await this.recordStage("database_file_path", async () => {
      return invokeTauri<DesktopDatabaseDiagnostics>("desktop_database_diagnostics")
    })

    await this.recordStage("parent_directory", async () => {
      if (!this.desktopDiagnostics?.parentExists) throw new Error("Desktop database parent directory was not created.")
      if (!this.desktopDiagnostics.parentWritable) throw new Error("Desktop database parent directory is not writable.")
      return this.desktopDiagnostics.parentCreated ? "created" : "ready"
    })

    const db = await this.recordStage("database_open", async () => this.openPrimaryConnection())
    await this.recordStage("connection_creation", async () => {
      await db.select("SELECT 1 AS ok")
      return "connection verified"
    })
    await this.recordStage("pragma_configuration", async () => this.configureConnection(db))
    await this.recordStage("migration_execution", async () => this.runMigrations(db))
    await this.recordStage("schema_version_check", async () => this.verifySchemaVersion(db))
    await this.recordStage("integrity_check", async () => this.verifyIntegrity(db))
    await this.recordStage("repository_initialisation", async () => this.verifyRepositoryTables(db))

    this.lastInitializationError = null
    return db
  }

  private async recordStage<T>(stage: StartupStageName, work: () => Promise<T>) {
    const started = Date.now()
    const entry: StartupStage = { stage, status: "pending", startedAt: nowIso() }
    this.startupStages.push(entry)

    try {
      const result = await work()
      entry.status = "ok"
      entry.durationMs = Date.now() - started
      if (typeof result === "string") entry.detail = result
      await this.logStartupStage(entry)
      return result
    } catch (error) {
      entry.status = "failed"
      entry.durationMs = Date.now() - started
      entry.errorCode = safeErrorCode(error)
      entry.errorMessage = safeErrorMessage(error)
      this.lastFailedStage = stage
      this.lastInitializationError = entry.errorMessage
      await this.logStartupStage(entry)
      throw this.unavailableError(error, stage)
    }
  }

  private async logStartupStage(entry: StartupStage) {
    const detail = entry.errorMessage || entry.detail || ""
    await invokeTauri("desktop_startup_log", {
      message: `SQLite startup stage=${entry.stage} status=${entry.status} duration_ms=${entry.durationMs || 0}${detail ? ` detail=${detail}` : ""}`,
    }).catch(() => undefined)
  }

  private async withTemporaryLockRetry<T>(work: () => Promise<T>) {
    let lastError: unknown
    for (let attempt = 0; attempt <= STARTUP_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await work()
      } catch (error) {
        lastError = error
        if (!isTemporarySqliteError(error) || attempt >= STARTUP_RETRY_DELAYS_MS.length) throw error
        await wait(STARTUP_RETRY_DELAYS_MS[attempt])
      }
    }
    throw lastError
  }

  private async openPrimaryConnection() {
    if (this.primaryConnectionPromise) return this.primaryConnectionPromise

    this.primaryConnectionPromise = this.withTemporaryLockRetry(async () => {
      const sqlPlugin = (await import("@tauri-apps/plugin-sql")) as SqlModule
      return sqlPlugin.default.get(LOCAL_DB_URL)
    }).catch((error) => {
      this.primaryConnectionPromise = null
      throw error
    })

    return this.primaryConnectionPromise
  }

  private async configureConnection(db: SqlExecutor) {
    await db.execute("PRAGMA foreign_keys = ON")
    await db.execute("PRAGMA journal_mode = WAL")
    await db.execute("PRAGMA synchronous = NORMAL")
    await db.execute("PRAGMA temp_store = MEMORY")
    await db.execute("PRAGMA busy_timeout = 5000")
    await db.execute("PRAGMA cache_size = -64000")
  }

  private async runMigrations(db: SqlExecutor) {
    const tableRows = await db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [MIGRATION_TABLE])
    const migrationTableExists = tableRows.length > 0

    if (!migrationTableExists) {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
    }

    const appliedRows = await db.select<{ version: number }>("SELECT version FROM schema_migrations")
    const applied = new Set(appliedRows.map((row) => Number(row.version)))
    const pending = localMigrations.filter((migration) => !applied.has(migration.version))

    if (pending.length === 0) {
      await this.recordSkippedStage("migration_backup", "no pending migrations")
      await this.repairAndOptimize(db)
      return
    }

    await this.recordStage("migration_backup", async () => {
      await db.execute("PRAGMA wal_checkpoint(FULL)").catch(() => undefined)
      const reason = `pre-migration-v${pending[pending.length - 1]?.version || "unknown"}`
      const backup = await invokeTauri<DesktopDatabaseBackup | null>("desktop_database_backup", { reason })
      if (backup) {
        this.migrationBackup = backup
        return `backup=${backup.backupPath}; bytes=${backup.bytes}; sha256=${backup.checksumSha256}`
      }
      return "database did not exist before migration"
    })

    await db.execute("BEGIN IMMEDIATE")
    try {
      for (const migration of pending) {
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

  private async recordSkippedStage(stage: StartupStageName, detail: string) {
    this.startupStages.push({
      stage,
      status: "skipped",
      startedAt: nowIso(),
      durationMs: 0,
      detail,
    })
  }

  private async verifySchemaVersion(db: SqlExecutor) {
    const [versionRow] = await db.select<Record<string, unknown>>("PRAGMA user_version")
    const userVersion = Number(Object.values(versionRow || {})[0] || 0)
    const expectedVersion = localMigrations[localMigrations.length - 1]?.version || 0
    if (userVersion < expectedVersion) {
      throw new Error(`Desktop database schema version ${userVersion} is older than expected ${expectedVersion}.`)
    }
    return `user_version=${userVersion}`
  }

  private async verifyIntegrity(db: SqlExecutor) {
    const [quick] = await db.select<Record<string, unknown>>("PRAGMA quick_check")
    const quickStatus = Object.values(quick || {})[0] || "unknown"
    const foreignKeyRows = await db.select<Record<string, unknown>>("PRAGMA foreign_key_check")
    if (!isOkStatus(quickStatus) || foreignKeyRows.length > 0) {
      throw new Error(`Desktop database integrity check failed. quick_check=${String(quickStatus)}; foreign_key_violations=${foreignKeyRows.length}`)
    }
    return `quick_check=${String(quickStatus)}; foreign_key_violations=0`
  }

  private async verifyRepositoryTables(db: SqlExecutor) {
    const requiredTables = [
      "products",
      "customers",
      "sales_invoices",
      "sales_invoice_items",
      "ledger_entries",
      "offline_sync_queue",
      "database_health",
    ]
    const placeholders = requiredTables.map(() => "?").join(", ")
    const rows = await db.select<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
      requiredTables
    )
    const found = new Set(rows.map((row) => row.name))
    const missing = requiredTables.filter((table) => !found.has(table))
    if (missing.length > 0) {
      throw new Error(`Desktop database repository tables are missing: ${missing.join(", ")}`)
    }
    return `tables=${requiredTables.length}`
  }

  private async executeMigrationStatement(db: SqlExecutor, statement: string) {
    try {
      await db.execute(statement)
    } catch (error) {
      const message = safeErrorMessage(error)
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
