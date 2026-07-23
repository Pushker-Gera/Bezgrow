"use client"

import type { WorkspaceBootstrapPayload } from "@/lib/workspaceBootstrapClient"
import { invokeTauri, isDesktopRuntime } from "@/lib/desktop/tauri"
import { evaluateStoredLicense, isLicenseRestrictedAction, isLicenseRestrictedCollection, type StoredLicenseRow } from "@/lib/license/policy"
import {
  clearSqliteOfflineData,
  exportSqliteBackup,
  getSqliteCollection,
  getSqliteMeta,
  listSqliteActions,
  mergeSqliteOrganizations,
  putSqliteCollection,
  queueSqliteAction,
  setSqliteMeta,
  updateSqliteAction,
} from "@/lib/offline/sqlite"

export type OfflineCollection =
  | "workspace"
  | "profiles"
  | "organization"
  | "organization_members"
  | "products"
  | "inventory_items"
  | "customers"
  | "suppliers"
  | "warehouses"
  | "invoices"
  | "invoice_items"
  | "purchase_invoices"
  | "purchase_items"
  | "orders"
  | "order_items"
  | "quotations"
  | "quotation_items"
  | "delivery_challans"
  | "delivery_challan_items"
  | "credit_notes"
  | "credit_note_items"
  | "debit_notes"
  | "debit_note_items"
  | "expenses"
  | "payments"
  | "payment_receipts"
  | "ledger_entries"
  | "chart_of_accounts"
  | "accounting_vouchers"
  | "accounting_voucher_entries"
  | "bank_accounts"
  | "print_templates"
  | "license"
  | "device_activations"
  | "audit_logs"
  | "settings"
  | "stock_movements"
  | "stock_batches"
  | "backup_manifest"

export type OfflineActionStatus = "pending" | "syncing" | "synced" | "error" | "conflict"

export type OfflineAction = {
  id: string
  type:
    | "create_invoice"
    | "save_customer"
    | "customer_status"
    | "save_product"
    | "archive_product"
    | "stock_movement"
    | "update_invoice_status"
    | "delete_invoice"
    | "save_settings"
    | "create_order"
    | "save_supplier"
    | "delete_supplier"
    | "create_purchase"
    | "create_purchase_return"
    | "create_purchase_order"
    | "create_goods_received"
    | "create_payment"
    | "create_quotation"
    | "create_delivery_challan"
    | "create_proforma_invoice"
    | "create_credit_note"
    | "create_debit_note"
    | "create_expense"
    | "create_accounting_voucher"
    | "create_backup_manifest"
  organizationId: string
  status: OfflineActionStatus
  createdAt: string
  updatedAt: string
  attempts: number
  payload: Record<string, unknown>
  error?: string
}

type OfflineBackupRecord = {
  organizationId?: string
  organization_id?: string
  collection?: OfflineCollection
  value?: unknown
}

type SqliteBackupRow = {
  organization_id?: string | null
  payload_json?: string | null
}

type OfflineBackupPayload = {
  app?: string
  storage?: string
  data?: OfflineBackupRecord[] | Partial<Record<OfflineCollection, SqliteBackupRow[]>>
  actions?: Array<Partial<OfflineAction>>
}

type OfflineDataRecord<T> = {
  key: string
  organizationId: string
  collection: OfflineCollection
  value: T
  updatedAt: string
}

type LegacyIndexedDbMigrationResult = {
  migrated: boolean
  importedCollections: number
  importedRecords: number
  skippedNonEmptyCollections: number
  workspace: WorkspaceBootstrapPayload | null
}

const DB_NAME = "bezgrow-offline"
const DB_VERSION = 1
const offlineCollections: OfflineCollection[] = [
  "workspace",
  "profiles",
  "organization",
  "organization_members",
  "products",
  "inventory_items",
  "customers",
  "suppliers",
  "warehouses",
  "invoices",
  "invoice_items",
  "purchase_invoices",
  "purchase_items",
  "orders",
  "order_items",
  "quotations",
  "quotation_items",
  "delivery_challans",
  "delivery_challan_items",
  "credit_notes",
  "credit_note_items",
  "debit_notes",
  "debit_note_items",
  "expenses",
  "payments",
  "payment_receipts",
  "ledger_entries",
  "chart_of_accounts",
  "accounting_vouchers",
  "accounting_voucher_entries",
  "bank_accounts",
  "print_templates",
  "license",
  "device_activations",
  "audit_logs",
  "settings",
  "stock_movements",
  "stock_batches",
  "backup_manifest",
]
const singleRecordCollections = new Set<OfflineCollection>(["workspace", "organization", "settings"])
const LEGACY_SQLITE_MIGRATION_MARKER = "legacy_indexeddb_to_sqlite_v7"

let dbPromise: Promise<IDBDatabase> | null = null
let legacyMigrationPromise: Promise<LegacyIndexedDbMigrationResult> | null = null

async function strictDesktopStorage() {
  return isDesktopRuntime().catch(() => false)
}

function desktopSqliteRequiredError(operation: string) {
  return new Error(`SQLite is required in the Bezgrow desktop runtime for ${operation}.`)
}

function isBrowser() {
  return typeof window !== "undefined" && "indexedDB" in window
}

function openDb() {
  if (!isBrowser()) return Promise.reject(new Error("IndexedDB is not available."))
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains("data")) db.createObjectStore("data", { keyPath: "key" })
      if (!db.objectStoreNames.contains("actions")) db.createObjectStore("actions", { keyPath: "id" })
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" })
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error("IndexedDB failed to open."))
  })

  return dbPromise
}

async function storeTransaction(storeName: "data" | "actions" | "meta", mode: IDBTransactionMode) {
  const db = await openDb()
  const transaction = db.transaction(storeName, mode)
  return { store: transaction.objectStore(storeName), transaction }
}

async function getAllFromStore<T>(storeName: "data" | "actions" | "meta") {
  const { store } = await storeTransaction(storeName, "readonly")
  return requestToPromise<T[]>(store.getAll())
}

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."))
  })
}

function waitForTransaction(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."))
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted."))
  })
}

function dataKey(organizationId: string, collection: OfflineCollection) {
  return `${organizationId}:${collection}`
}

function legacyRows(value: unknown) {
  return Array.isArray(value) ? value : value == null ? [] : [value]
}

function workspacePayloadFromLegacyRecord(record: OfflineDataRecord<unknown>) {
  if (record.collection !== "workspace" || !record.value || typeof record.value !== "object") return null
  const value = record.value as { payload?: WorkspaceBootstrapPayload }
  return value.payload?.success ? value.payload : null
}

/**
 * One-time bridge from the WebKit store used by older desktop releases into the
 * authoritative SQLite database. This is deliberately not a read fallback:
 * existing SQLite collections win, the source is retained, and a native SQLite
 * backup is made before the first write.
 */
async function runLegacyIndexedDbToSqliteMigration(): Promise<LegacyIndexedDbMigrationResult> {
  const empty: LegacyIndexedDbMigrationResult = {
    migrated: false,
    importedCollections: 0,
    importedRecords: 0,
    skippedNonEmptyCollections: 0,
    workspace: null,
  }
  if (!isBrowser() || !(await strictDesktopStorage())) return empty

  const marker = await getSqliteMeta(LEGACY_SQLITE_MIGRATION_MARKER, false, "global")
  if (marker) return empty

  const records = await getAllFromStore<OfflineDataRecord<unknown>>("data").catch(() => [])
  const validRecords = records
    .filter(
      (record) =>
        record &&
        typeof record.organizationId === "string" &&
        record.organizationId.length > 0 &&
        offlineCollections.includes(record.collection)
    )
    .sort((left, right) => offlineCollections.indexOf(left.collection) - offlineCollections.indexOf(right.collection))
  if (validRecords.length === 0) {
    await setSqliteMeta(LEGACY_SQLITE_MIGRATION_MARKER, true, "global")
    return empty
  }

  const activityByOrganization = new Map<string, number>()
  for (const record of validRecords) {
    if (["products", "customers", "invoices", "invoice_items", "stock_movements", "warehouses"].includes(record.collection)) {
      activityByOrganization.set(record.organizationId, (activityByOrganization.get(record.organizationId) || 0) + legacyRows(record.value).length)
    }
  }
  const workspace =
    validRecords
      .map((record) => ({ payload: workspacePayloadFromLegacyRecord(record), score: activityByOrganization.get(record.organizationId) || 0 }))
      .filter((candidate): candidate is { payload: WorkspaceBootstrapPayload; score: number } => Boolean(candidate.payload))
      .sort((a, b) => b.score - a.score)[0]?.payload || null
  const selectedOrganizationId = workspace?.organization?.id || workspace?.membership?.organization_id || null
  const selectedBusinessName = workspace?.organization?.name?.trim().toLowerCase() || ""
  const selectedUserEmail = workspace?.user?.email?.trim().toLowerCase() || ""
  const equivalentOrganizations = new Set(
    validRecords
      .map((record) => ({ organizationId: record.organizationId, payload: workspacePayloadFromLegacyRecord(record) }))
      .filter(({ payload }) => {
        if (!payload) return false
        const businessName = payload.organization?.name?.trim().toLowerCase() || ""
        const userEmail = payload.user?.email?.trim().toLowerCase() || ""
        return Boolean(
          (selectedBusinessName && businessName === selectedBusinessName) ||
            (selectedUserEmail && userEmail === selectedUserEmail)
        )
      })
      .map(({ organizationId }) => organizationId)
  )
  if (selectedOrganizationId) equivalentOrganizations.add(selectedOrganizationId)

  // Historical releases could change workspace IDs while retaining records that
  // reference each other. Treat those linked IDs as one business so a product is
  // not left in one workspace while its invoice lives in another.
  const idOwners = new Map<string, string>()
  for (const record of validRecords) {
    for (const row of legacyRows(record.value)) {
      if (!row || typeof row !== "object") continue
      const id = "id" in row ? String((row as { id?: unknown }).id || "") : ""
      if (id) idOwners.set(id, record.organizationId)
    }
  }
  let expanded = true
  while (expanded) {
    expanded = false
    for (const record of validRecords) {
      for (const row of legacyRows(record.value)) {
        if (!row || typeof row !== "object") continue
        for (const [key, value] of Object.entries(row)) {
          if (!key.endsWith("_id") || typeof value !== "string") continue
          const owner = idOwners.get(value)
          if (!owner || owner === record.organizationId) continue
          if (equivalentOrganizations.has(record.organizationId) && !equivalentOrganizations.has(owner)) {
            equivalentOrganizations.add(owner)
            expanded = true
          } else if (equivalentOrganizations.has(owner) && !equivalentOrganizations.has(record.organizationId)) {
            equivalentOrganizations.add(record.organizationId)
            expanded = true
          }
        }
      }
    }
  }

  let backupMade = false
  let importedCollections = 0
  let importedRecords = 0
  let skippedNonEmptyCollections = 0
  const failures: string[] = []

  for (const record of validRecords) {
    const targetOrganizationId =
      selectedOrganizationId && equivalentOrganizations.has(record.organizationId) ? selectedOrganizationId : record.organizationId
    const current = await getSqliteCollection<unknown[]>(targetOrganizationId, record.collection, [])
    const currentRows = legacyRows(current.value)
    let importValue = record.value
    if (current.hit && currentRows.length > 0) {
      const incomingRows = legacyRows(record.value)
      if (singleRecordCollections.has(record.collection)) {
        skippedNonEmptyCollections += 1
        continue
      }
      const existingIds = new Set(
        currentRows
          .map((row) => (row && typeof row === "object" && "id" in row ? String((row as { id?: unknown }).id || "") : ""))
          .filter(Boolean)
      )
      const missingRows = incomingRows.filter((row) => {
        const id = row && typeof row === "object" && "id" in row ? String((row as { id?: unknown }).id || "") : ""
        return !id || !existingIds.has(id)
      })
      if (missingRows.length === 0) {
        skippedNonEmptyCollections += 1
        continue
      }
      importValue = [...currentRows, ...missingRows]
    }
    try {
      if (!backupMade) {
        await invokeTauri("desktop_database_backup", { reason: "pre-legacy-indexeddb-import" })
        backupMade = true
      }
      if (await putSqliteCollection(targetOrganizationId, record.collection, importValue)) {
        importedCollections += 1
        importedRecords += legacyRows(record.value).length
      }
    } catch (error) {
      const message = `${record.organizationId}->${targetOrganizationId}:${record.collection}: ${error instanceof Error ? error.message : String(error)}`
      failures.push(message)
      await invokeTauri("desktop_startup_log", { message: `[offline/migration] failed ${message}` }).catch(() => undefined)
    }
  }

  if (selectedOrganizationId && failures.length === 0) {
    for (const sourceOrganizationId of equivalentOrganizations) {
      if (sourceOrganizationId === selectedOrganizationId || sourceOrganizationId === "global") continue
      try {
        await mergeSqliteOrganizations(sourceOrganizationId, selectedOrganizationId)
      } catch (error) {
        const message = `${sourceOrganizationId}->${selectedOrganizationId}:workspace-merge: ${error instanceof Error ? error.message : String(error)}`
        failures.push(message)
        await invokeTauri("desktop_startup_log", { message: `[offline/migration] failed ${message}` }).catch(() => undefined)
      }
    }
  }

  await setSqliteMeta(LEGACY_SQLITE_MIGRATION_MARKER, failures.length === 0, "global")
  if (workspace) {
    localStorage.setItem(
      "bezgrow:offline-workspace",
      JSON.stringify({
        payload: workspace,
        organizationId: workspace.organization?.id || workspace.membership?.organization_id,
        cachedAt: Date.now(),
      })
    )
  }
  console.info("[offline/migration] legacy IndexedDB import complete", {
    importedCollections,
    importedRecords,
    skippedNonEmptyCollections,
    failures: failures.length,
    selectedOrganizationId: workspace?.organization?.id || null,
  })
  await invokeTauri("desktop_startup_log", {
    message: `[offline/migration] source=${validRecords.length} imported_collections=${importedCollections} imported_records=${importedRecords} skipped_nonempty=${skippedNonEmptyCollections} failures=${failures.length} selected_org=${workspace?.organization?.id || "none"} equivalent_orgs=${[...equivalentOrganizations].join(",") || "none"}`,
  }).catch(() => undefined)
  return { migrated: importedCollections > 0, importedCollections, importedRecords, skippedNonEmptyCollections, workspace }
}

export async function migrateLegacyIndexedDbToSqlite(): Promise<LegacyIndexedDbMigrationResult> {
  if (!legacyMigrationPromise) {
    legacyMigrationPromise = runLegacyIndexedDbToSqliteMigration().finally(() => {
      legacyMigrationPromise = null
    })
  }
  return legacyMigrationPromise
}

function deviceIdForGuard() {
  if (typeof window === "undefined") return ""
  return localStorage.getItem("bezgrow:device-id") || ""
}

function valueLooksLikeMutation(value: unknown): boolean {
  const rows = (Array.isArray(value) ? value : [value]).filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
  return rows.some((row) => {
    const status = typeof row.sync_status === "string" ? row.sync_status : ""
    return status.startsWith("pending") || Boolean(row.deleted_at)
  })
}

async function readLicenseRowsForGuard(organizationId: string) {
  const sqliteRows: StoredLicenseRow[] = []
  for (const id of [...new Set([organizationId, "global"].filter(Boolean))]) {
    const result = await getSqliteCollection<StoredLicenseRow[]>(id, "license", []).catch(() => ({ hit: false, value: [] as StoredLicenseRow[] }))
    if (result.hit && Array.isArray(result.value)) sqliteRows.push(...result.value)
  }
  if (sqliteRows.length) return sqliteRows
  if (await strictDesktopStorage()) return sqliteRows

  if (!isBrowser()) return []
  const { store } = await storeTransaction("data", "readonly")
  const rows: StoredLicenseRow[] = []
  for (const id of [...new Set([organizationId, "global"].filter(Boolean))]) {
    const record = await requestToPromise<OfflineDataRecord<StoredLicenseRow[]> | undefined>(store.get(dataKey(id, "license")))
    if (Array.isArray(record?.value)) rows.push(...record.value)
  }
  return rows
}

async function assertOfflineMutationAllowed(organizationId: string, collection: OfflineCollection, value: unknown) {
  if (!organizationId || !isLicenseRestrictedCollection(collection) || !valueLooksLikeMutation(value)) return
  const status = evaluateStoredLicense(await readLicenseRowsForGuard(organizationId), { deviceId: deviceIdForGuard() })
  if (!status.allowed) throw new Error(status.reason)
}

async function assertOfflineActionAllowed(action: Omit<OfflineAction, "status" | "createdAt" | "updatedAt" | "attempts">) {
  if (!isLicenseRestrictedAction(action.type)) return
  const status = evaluateStoredLicense(await readLicenseRowsForGuard(action.organizationId), { deviceId: deviceIdForGuard() })
  if (!status.allowed) throw new Error(status.reason)
}

export function createOfflineId(prefix: string) {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2)
  return `offline-${prefix}-${Date.now()}-${random}`
}

export async function putOfflineData<T>(organizationId: string, collection: OfflineCollection, value: T) {
  if (!organizationId || !isBrowser()) return
  await assertOfflineMutationAllowed(organizationId, collection, value)
  const sqliteHandled = await putSqliteCollection(organizationId, collection, value)
  if (sqliteHandled) {
    window.dispatchEvent(new Event("bezgrow:offline-data-changed"))
    return
  }
  if (await strictDesktopStorage()) throw desktopSqliteRequiredError(`writing ${collection}`)

  const { store, transaction } = await storeTransaction("data", "readwrite")
  const record: OfflineDataRecord<T> = {
    key: dataKey(organizationId, collection),
    organizationId,
    collection,
    value,
    updatedAt: new Date().toISOString(),
  }
  store.put(record)
  await waitForTransaction(transaction)
  window.dispatchEvent(new Event("bezgrow:offline-data-changed"))
}

export async function getOfflineData<T>(organizationId: string, collection: OfflineCollection, fallback: T): Promise<T> {
  if (!organizationId || !isBrowser()) return fallback
  const sqliteResult = await getSqliteCollection(organizationId, collection, fallback)
  if (sqliteResult.hit) return sqliteResult.value
  if (await strictDesktopStorage()) return fallback

  const { store } = await storeTransaction("data", "readonly")
  const record = await requestToPromise<OfflineDataRecord<T> | undefined>(store.get(dataKey(organizationId, collection)))
  return record?.value ?? fallback
}

export async function cacheWorkspaceBootstrap(payload: WorkspaceBootstrapPayload) {
  const organizationId = payload.organization?.id || payload.membership?.organization_id
  if (!organizationId) return
  const now = new Date().toISOString()

  await putOfflineData(organizationId, "workspace", {
    id: `workspace:${organizationId}`,
    organization_id: organizationId,
    payload,
    updated_at: now,
  })
  await putOfflineData(organizationId, "profiles", payload.profile ? [{ ...payload.profile, id: payload.profile.id || payload.user?.id, organization_id: organizationId }] : [])
  await putOfflineData(organizationId, "organization", payload.organization || null)
  await putOfflineData(
    organizationId,
    "organization_members",
    payload.membership
      ? [
          {
            id: `${payload.user?.id || "user"}:${organizationId}`,
            user_id: payload.user?.id || null,
            organization_id: organizationId,
            role: payload.membership.role || null,
            updated_at: now,
          },
        ]
      : []
  )
  await putOfflineData(organizationId, "settings", {
    id: `settings:${organizationId}`,
    organization_id: organizationId,
    features: payload.features || [],
    currency: payload.currency,
    timezone: payload.timezone,
    locale: payload.locale,
  })

  if (isBrowser()) {
    localStorage.setItem("bezgrow:offline-workspace", JSON.stringify({ payload, organizationId, cachedAt: Date.now() }))
  }
}

export function getCachedWorkspaceBootstrap(): WorkspaceBootstrapPayload | null {
  if (!isBrowser()) return null
  try {
    const cached = JSON.parse(localStorage.getItem("bezgrow:offline-workspace") || "null") as { payload?: WorkspaceBootstrapPayload } | null
    return cached?.payload?.success ? cached.payload : null
  } catch {
    localStorage.removeItem("bezgrow:offline-workspace")
    return null
  }
}

export async function queueOfflineAction(action: Omit<OfflineAction, "status" | "createdAt" | "updatedAt" | "attempts">) {
  await assertOfflineActionAllowed(action)
  const now = new Date().toISOString()
  const record: OfflineAction = {
    ...action,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  }
  const sqliteHandled = await queueSqliteAction(record)
  if (sqliteHandled) {
    window.dispatchEvent(new Event("bezgrow:offline-actions-changed"))
    return record
  }
  if (await strictDesktopStorage()) throw desktopSqliteRequiredError(`queuing ${action.type}`)

  const { store, transaction } = await storeTransaction("actions", "readwrite")
  store.put(record)
  await waitForTransaction(transaction)
  window.dispatchEvent(new Event("bezgrow:offline-actions-changed"))
  return record
}

export async function listOfflineActions(statuses?: OfflineActionStatus[]) {
  if (!isBrowser()) return []
  const sqliteActions = await listSqliteActions(statuses)
  if (sqliteActions) return sqliteActions
  if (await strictDesktopStorage()) throw desktopSqliteRequiredError("listing pending actions")

  const { store } = await storeTransaction("actions", "readonly")
  const actions = await requestToPromise<OfflineAction[]>(store.getAll())
  return statuses?.length ? actions.filter((action) => statuses.includes(action.status)) : actions
}

export async function updateOfflineAction(id: string, patch: Partial<OfflineAction>) {
  const sqliteAction = await updateSqliteAction(id, patch)
  if (sqliteAction) {
    window.dispatchEvent(new Event("bezgrow:offline-actions-changed"))
    return sqliteAction
  }
  if (await strictDesktopStorage()) return null

  const { store: readStore } = await storeTransaction("actions", "readonly")
  const current = await requestToPromise<OfflineAction | undefined>(readStore.get(id))
  if (!current) return null
  const next: OfflineAction = { ...current, ...patch, updatedAt: new Date().toISOString() }
  const { store, transaction } = await storeTransaction("actions", "readwrite")
  store.put(next)
  await waitForTransaction(transaction)
  window.dispatchEvent(new Event("bezgrow:offline-actions-changed"))
  return next
}

export async function pendingOfflineCount() {
  const actions = await listOfflineActions(["pending", "syncing", "error", "conflict"])
  return actions.length
}

export async function setOfflineMeta(key: string, value: unknown, organizationId?: string) {
  const sqliteHandled = await setSqliteMeta(key, value, organizationId)
  if (sqliteHandled) return
  if (await strictDesktopStorage()) throw desktopSqliteRequiredError(`writing metadata ${key}`)
  if (!isBrowser()) return

  const { store, transaction } = await storeTransaction("meta", "readwrite")
  store.put({ key: organizationId ? `${organizationId}:${key}` : key, value, updatedAt: new Date().toISOString() })
  await waitForTransaction(transaction)
}

export async function getOfflineMeta<T>(key: string, fallback: T, organizationId?: string) {
  const sqliteValue = await getSqliteMeta(key, fallback, organizationId)
  if (sqliteValue !== fallback) return sqliteValue
  if (await strictDesktopStorage()) return fallback
  if (!isBrowser()) return fallback

  const { store } = await storeTransaction("meta", "readonly")
  const record = await requestToPromise<{ value?: T } | undefined>(store.get(organizationId ? `${organizationId}:${key}` : key))
  return record?.value ?? fallback
}

export async function clearOfflineData() {
  if (!isBrowser()) return
  const sqliteHandled = await clearSqliteOfflineData()
  if (await strictDesktopStorage()) {
    if (!sqliteHandled) throw desktopSqliteRequiredError("clearing local data")
    localStorage.removeItem("bezgrow:offline-workspace")
    sessionStorage.removeItem("bezgrow:workspace-bootstrap")
    sessionStorage.removeItem("bezgrow:organization-id")
    window.dispatchEvent(new Event("bezgrow:offline-actions-changed"))
    window.dispatchEvent(new Event("bezgrow:offline-data-changed"))
    return
  }

  const db = await openDb()
  const transaction = db.transaction(["data", "actions", "meta"], "readwrite")
  transaction.objectStore("data").clear()
  transaction.objectStore("actions").clear()
  transaction.objectStore("meta").clear()
  await waitForTransaction(transaction)

  localStorage.removeItem("bezgrow:offline-workspace")
  sessionStorage.removeItem("bezgrow:workspace-bootstrap")
  sessionStorage.removeItem("bezgrow:organization-id")
  window.dispatchEvent(new Event("bezgrow:offline-actions-changed"))
  window.dispatchEvent(new Event("bezgrow:offline-data-changed"))
}

export async function exportOfflineBackup() {
  if (!isBrowser()) return null
  const sqliteBackup = await exportSqliteBackup()
  if (sqliteBackup) return sqliteBackup
  if (await strictDesktopStorage()) throw desktopSqliteRequiredError("exporting backup")

  const [data, actions] = await Promise.all([
    getAllFromStore<OfflineDataRecord<unknown>>("data"),
    getAllFromStore<OfflineAction>("actions"),
  ])
  return {
    exportedAt: new Date().toISOString(),
    app: "Bezgrow",
    data,
    actions,
  }
}

function isOfflineCollection(value: unknown): value is OfflineCollection {
  return typeof value === "string" && offlineCollections.includes(value as OfflineCollection)
}

function parseSqlitePayload(row: SqliteBackupRow) {
  if (!row.payload_json) return row

  try {
    return JSON.parse(row.payload_json) as unknown
  } catch {
    return null
  }
}

function maybeCacheWorkspaceFromValue(value: unknown, organizationId: string) {
  if (!isBrowser() || !value || typeof value !== "object") return

  const payload = (value as { payload?: WorkspaceBootstrapPayload }).payload
  if (payload?.success) {
    localStorage.setItem("bezgrow:offline-workspace", JSON.stringify({ payload, organizationId, cachedAt: Date.now() }))
  }
}

async function restoreCollection(organizationId: string, collection: OfflineCollection, values: unknown[]) {
  if (!organizationId || values.length === 0) return 0

  const value = singleRecordCollections.has(collection) ? values[0] : values
  await putOfflineData(organizationId, collection, value)

  if (collection === "workspace") maybeCacheWorkspaceFromValue(value, organizationId)
  return values.length
}

export async function restoreOfflineBackup(input: unknown) {
  if (!isBrowser()) throw new Error("Backup restore is available only inside Bezgrow.")

  const backup = input as OfflineBackupPayload | null
  if (!backup || backup.app !== "Bezgrow" || !backup.data) {
    throw new Error("This does not look like a Bezgrow backup file.")
  }

  let restoredRecords = 0
  let restoredActions = 0

  if (Array.isArray(backup.data)) {
    for (const record of backup.data) {
      if (!isOfflineCollection(record.collection)) continue
      const organizationId = record.organizationId || record.organization_id
      if (!organizationId) continue

      restoredRecords += await restoreCollection(organizationId, record.collection, [record.value])
    }
  } else {
    for (const collection of offlineCollections) {
      const rows = backup.data[collection]
      if (!Array.isArray(rows)) continue

      const rowsByOrganization = new Map<string, unknown[]>()
      rows.forEach((row) => {
        const organizationId = row.organization_id || "global"
        const value = parseSqlitePayload(row)
        if (!value) return

        rowsByOrganization.set(organizationId, [...(rowsByOrganization.get(organizationId) || []), value])
      })

      for (const [organizationId, values] of rowsByOrganization) {
        restoredRecords += await restoreCollection(organizationId, collection, values)
      }
    }
  }

  if (Array.isArray(backup.actions)) {
    for (const action of backup.actions) {
      if (!action.id || !action.type || !action.organizationId || !action.payload) continue
      if (action.status === "synced") continue

      await queueOfflineAction({
        id: action.id,
        type: action.type,
        organizationId: action.organizationId,
        payload: action.payload,
      })
      restoredActions += 1
    }
  }

  window.dispatchEvent(new Event("bezgrow:offline-data-changed"))
  window.dispatchEvent(new Event("bezgrow:offline-actions-changed"))

  return { restoredRecords, restoredActions }
}
