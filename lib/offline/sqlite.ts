"use client"

import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import type { OfflineAction, OfflineActionStatus, OfflineCollection } from "@/lib/offline/db"

type SqlValue = string | number | null

type SqlDatabase = {
  execute(query: string, bindValues?: SqlValue[]): Promise<unknown>
  select<T>(query: string, bindValues?: SqlValue[]): Promise<T[]>
}

type LocalRow = {
  id: string
  organization_id: string | null
  local_id: string | null
  server_id: string | null
  sync_status: string
  payload_json: string
  created_at: string
  updated_at: string
  last_synced_at: string | null
  deleted_at: string | null
}

type QueueRow = {
  id: string
  organization_id: string
  entity_type: string
  operation_type: OfflineAction["type"]
  payload_json: string
  status: OfflineActionStatus
  attempts: number
  error: string | null
  idempotency_key: string | null
  created_at: string
  updated_at: string
  last_synced_at: string | null
}

const DB_URL = "sqlite:bezgrow-offline.db"

const collectionTables: Record<OfflineCollection, string> = {
  workspace: "local_workspace",
  profiles: "local_profiles",
  organization: "local_organizations",
  organization_members: "local_organization_members",
  products: "local_products",
  inventory_items: "local_inventory_items",
  customers: "local_customers",
  invoices: "local_invoices",
  invoice_items: "local_invoice_items",
  orders: "local_orders",
  order_items: "local_order_items",
  settings: "local_settings",
  stock_movements: "local_stock_movements",
}

const metaTable = "local_meta"

let dbPromise: Promise<SqlDatabase | null> | null = null
let migrated = false

function nowIso() {
  return new Date().toISOString()
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null
}

function recordId(collection: OfflineCollection, value: unknown, index: number) {
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>
    return stringField(row.id) || stringField(row.local_id) || stringField(row.server_id) || `${collection}-${index}`
  }

  return `${collection}-${index}`
}

function organizationIdFor(defaultOrganizationId: string, value: unknown) {
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>
    return stringField(row.organization_id) || defaultOrganizationId
  }

  return defaultOrganizationId
}

function syncStatusFor(value: unknown) {
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>
    const status = stringField(row.sync_status)
    if (status === "pending_sync") return "pending_update"
    return status || "synced"
  }

  return "synced"
}

function createdAtFor(value: unknown) {
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>
    return stringField(row.created_at) || nowIso()
  }

  return nowIso()
}

function updatedAtFor(value: unknown) {
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>
    return stringField(row.updated_at) || nowIso()
  }

  return nowIso()
}

function deletedAtFor(value: unknown) {
  if (value && typeof value === "object") {
    return stringField((value as Record<string, unknown>).deleted_at)
  }

  return null
}

async function migrate(db: SqlDatabase) {
  if (migrated) return

  const tableSql = (table: string) => `
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      local_id TEXT,
      server_id TEXT,
      sync_status TEXT NOT NULL DEFAULT 'synced',
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_synced_at TEXT,
      deleted_at TEXT
    )
  `

  for (const table of Object.values(collectionTables)) {
    await db.execute(tableSql(table))
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_${table}_org ON ${table} (organization_id)`)
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_${table}_sync ON ${table} (sync_status)`)
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${metaTable} (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${metaTable}_org_key ON ${metaTable} (organization_id, key)`)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS sync_queue (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_synced_at TEXT
    )
  `)
  await db.execute("CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue (status)")
  await db.execute("CREATE INDEX IF NOT EXISTS idx_sync_queue_org ON sync_queue (organization_id)")

  await db.execute(`
    CREATE TABLE IF NOT EXISTS sync_conflicts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      local_id TEXT,
      server_id TEXT,
      local_payload_json TEXT,
      server_payload_json TEXT,
      message TEXT NOT NULL,
      resolution TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS sync_logs (
      id TEXT PRIMARY KEY,
      organization_id TEXT,
      action_id TEXT,
      status TEXT NOT NULL,
      message TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL
    )
  `)

  migrated = true
}

export async function getSqliteDb() {
  if (!(await isTauriRuntimeAsync())) return null
  if (dbPromise) return dbPromise

  dbPromise = import("@tauri-apps/plugin-sql")
    .then(async (module) => {
      const db = (await module.default.load(DB_URL)) as SqlDatabase
      await migrate(db)
      return db
    })
    .catch((error) => {
      console.warn("[offline/sqlite] falling back to IndexedDB", error)
      return null
    })

  return dbPromise
}

export async function putSqliteCollection<T>(organizationId: string, collection: OfflineCollection, value: T) {
  const db = await getSqliteDb()
  const table = collectionTables[collection]
  if (!db || !table) return false

  const rows = Array.isArray(value) ? value : [value]
  const touchedAt = nowIso()

  await db.execute("BEGIN")
  try {
    await db.execute(`DELETE FROM ${table} WHERE organization_id = ? AND sync_status = 'synced'`, [organizationId])

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (row === undefined) continue

      const id = recordId(collection, row, index)
      const rowOrganizationId = organizationIdFor(organizationId, row)
      const syncStatus = syncStatusFor(row)
      const localId = row && typeof row === "object" ? stringField((row as Record<string, unknown>).local_id) || (id.startsWith("offline-") ? id : null) : null
      const serverId = row && typeof row === "object" ? stringField((row as Record<string, unknown>).server_id) || (!id.startsWith("offline-") ? id : null) : null

      await db.execute(
        `INSERT INTO ${table} (
          id, organization_id, local_id, server_id, sync_status, payload_json,
          created_at, updated_at, last_synced_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          organization_id = excluded.organization_id,
          local_id = excluded.local_id,
          server_id = excluded.server_id,
          sync_status = excluded.sync_status,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at,
          last_synced_at = excluded.last_synced_at,
          deleted_at = excluded.deleted_at`,
        [
          id,
          rowOrganizationId,
          localId,
          serverId,
          syncStatus,
          JSON.stringify(row),
          createdAtFor(row),
          updatedAtFor(row),
          syncStatus === "synced" ? touchedAt : null,
          deletedAtFor(row),
        ]
      )
    }

    await db.execute("COMMIT")
    return true
  } catch (error) {
    await db.execute("ROLLBACK").catch(() => undefined)
    console.warn("[offline/sqlite] collection write failed", error)
    return false
  }
}

export async function getSqliteCollection<T>(organizationId: string, collection: OfflineCollection, fallback: T) {
  const db = await getSqliteDb()
  const table = collectionTables[collection]
  if (!db || !table) return { hit: false, value: fallback }

  try {
    const rows = await db.select<LocalRow>(
      `SELECT payload_json FROM ${table}
       WHERE organization_id = ? AND deleted_at IS NULL
       ORDER BY datetime(created_at) DESC`,
      [organizationId]
    )
    const values = rows
      .map((row) => {
        try {
          return JSON.parse(row.payload_json)
        } catch {
          return null
        }
      })
      .filter((value) => value !== null)

    if (Array.isArray(fallback)) return { hit: true, value: values as T }
    return { hit: true, value: (values[0] ?? fallback) as T }
  } catch (error) {
    console.warn("[offline/sqlite] collection read failed", error)
    return { hit: false, value: fallback }
  }
}

export async function queueSqliteAction(action: OfflineAction) {
  const db = await getSqliteDb()
  if (!db) return false

  const entityType = action.type.replace(/^save_/, "").replace(/^create_/, "").replace(/^archive_/, "")

  await db.execute(
    `INSERT INTO sync_queue (
      id, organization_id, entity_type, operation_type, payload_json, status,
      attempts, error, idempotency_key, created_at, updated_at, last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      payload_json = excluded.payload_json,
      status = excluded.status,
      attempts = excluded.attempts,
      error = excluded.error,
      updated_at = excluded.updated_at`,
    [
      action.id,
      action.organizationId,
      entityType,
      action.type,
      JSON.stringify(action.payload),
      action.status,
      action.attempts,
      action.error || null,
      typeof action.payload.idempotency_key === "string" ? action.payload.idempotency_key : action.id,
      action.createdAt,
      action.updatedAt,
      action.status === "synced" ? nowIso() : null,
    ]
  )

  return true
}

export async function listSqliteActions(statuses?: OfflineActionStatus[]) {
  const db = await getSqliteDb()
  if (!db) return null

  const statusSql = statuses?.length ? `WHERE status IN (${statuses.map(() => "?").join(",")})` : ""
  const rows = await db.select<QueueRow>(
    `SELECT * FROM sync_queue ${statusSql} ORDER BY datetime(created_at) ASC`,
    statuses || []
  )

  return rows.map<OfflineAction>((row) => ({
    id: row.id,
    type: row.operation_type,
    organizationId: row.organization_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attempts: Number(row.attempts || 0),
    payload: JSON.parse(row.payload_json || "{}") as Record<string, unknown>,
    error: row.error || undefined,
  }))
}

export async function updateSqliteAction(id: string, patch: Partial<OfflineAction>) {
  const db = await getSqliteDb()
  if (!db) return null

  const rows = await listSqliteActions()
  const current = rows?.find((row) => row.id === id)
  if (!current) return null

  const next: OfflineAction = { ...current, ...patch, updatedAt: nowIso() }
  await queueSqliteAction(next)
  return next
}

export async function writeSqliteSyncLog(input: {
  id: string
  organizationId?: string | null
  actionId?: string | null
  status: string
  message?: string | null
  payload?: Record<string, unknown> | null
}) {
  const db = await getSqliteDb()
  if (!db) return false

  await db.execute(
    `INSERT INTO sync_logs (id, organization_id, action_id, status, message, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.organizationId || null,
      input.actionId || null,
      input.status,
      input.message || null,
      input.payload ? JSON.stringify(input.payload) : null,
      nowIso(),
    ]
  )
  return true
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
  const db = await getSqliteDb()
  if (!db) return false

  await db.execute(
    `INSERT INTO sync_conflicts (
      id, organization_id, entity_type, local_id, server_id,
      local_payload_json, server_payload_json, message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.organizationId,
      input.entityType,
      input.localId || null,
      input.serverId || null,
      input.localPayload ? JSON.stringify(input.localPayload) : null,
      input.serverPayload ? JSON.stringify(input.serverPayload) : null,
      input.message,
      nowIso(),
    ]
  )
  return true
}

export async function setSqliteMeta(key: string, value: unknown, organizationId = "global") {
  const db = await getSqliteDb()
  if (!db) return false

  await db.execute(
    `INSERT INTO ${metaTable} (id, organization_id, key, value_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(organization_id, key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
    [`${organizationId}:${key}`, organizationId, key, JSON.stringify(value), nowIso()]
  )
  return true
}

export async function getSqliteMeta<T>(key: string, fallback: T, organizationId = "global") {
  const db = await getSqliteDb()
  if (!db) return fallback

  const rows = await db.select<{ value_json: string }>(
    `SELECT value_json FROM ${metaTable} WHERE organization_id = ? AND key = ? LIMIT 1`,
    [organizationId, key]
  )
  if (!rows[0]) return fallback

  try {
    return JSON.parse(rows[0].value_json) as T
  } catch {
    return fallback
  }
}

export async function clearSqliteOfflineData() {
  const db = await getSqliteDb()
  if (!db) return false

  for (const table of Object.values(collectionTables)) {
    await db.execute(`DELETE FROM ${table}`)
  }
  await db.execute(`DELETE FROM ${metaTable}`)
  await db.execute("DELETE FROM sync_queue")
  await db.execute("DELETE FROM sync_conflicts")
  await db.execute("DELETE FROM sync_logs")
  return true
}

export async function exportSqliteBackup() {
  const db = await getSqliteDb()
  if (!db) return null

  const data: Record<string, LocalRow[]> = {}
  for (const [collection, table] of Object.entries(collectionTables)) {
    data[collection] = await db.select<LocalRow>(`SELECT * FROM ${table} ORDER BY datetime(updated_at) DESC`)
  }

  return {
    exportedAt: new Date().toISOString(),
    app: "Bezgrow",
    storage: "sqlite",
    data,
    actions: await db.select<QueueRow>("SELECT * FROM sync_queue ORDER BY datetime(created_at) ASC"),
    conflicts: await db.select<Record<string, unknown>>("SELECT * FROM sync_conflicts ORDER BY datetime(created_at) DESC"),
    logs: await db.select<Record<string, unknown>>("SELECT * FROM sync_logs ORDER BY datetime(created_at) DESC"),
    meta: await db.select<Record<string, unknown>>(`SELECT * FROM ${metaTable} ORDER BY datetime(updated_at) DESC`),
  }
}
