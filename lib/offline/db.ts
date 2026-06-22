"use client"

import type { WorkspaceBootstrapPayload } from "@/lib/workspaceBootstrapClient"

export type OfflineCollection =
  | "organization"
  | "products"
  | "inventory_items"
  | "customers"
  | "invoices"
  | "invoice_items"
  | "orders"
  | "settings"

export type OfflineActionStatus = "pending" | "syncing" | "synced" | "error" | "conflict"

export type OfflineAction = {
  id: string
  type: "create_invoice" | "save_customer"
  organizationId: string
  status: OfflineActionStatus
  createdAt: string
  updatedAt: string
  attempts: number
  payload: Record<string, unknown>
  error?: string
}

type OfflineDataRecord<T> = {
  key: string
  organizationId: string
  collection: OfflineCollection
  value: T
  updatedAt: string
}

const DB_NAME = "bezgrow-offline"
const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

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

export function createOfflineId(prefix: string) {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2)
  return `offline-${prefix}-${Date.now()}-${random}`
}

export async function putOfflineData<T>(organizationId: string, collection: OfflineCollection, value: T) {
  if (!organizationId || !isBrowser()) return
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
}

export async function getOfflineData<T>(organizationId: string, collection: OfflineCollection, fallback: T): Promise<T> {
  if (!organizationId || !isBrowser()) return fallback
  const { store } = await storeTransaction("data", "readonly")
  const record = await requestToPromise<OfflineDataRecord<T> | undefined>(store.get(dataKey(organizationId, collection)))
  return record?.value ?? fallback
}

export async function cacheWorkspaceBootstrap(payload: WorkspaceBootstrapPayload) {
  const organizationId = payload.organization?.id || payload.membership?.organization_id
  if (!organizationId) return
  await putOfflineData(organizationId, "organization", payload.organization || null)
  await putOfflineData(organizationId, "settings", {
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
  const now = new Date().toISOString()
  const record: OfflineAction = {
    ...action,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    attempts: 0,
  }
  const { store, transaction } = await storeTransaction("actions", "readwrite")
  store.put(record)
  await waitForTransaction(transaction)
  window.dispatchEvent(new Event("bezgrow:offline-actions-changed"))
  return record
}

export async function listOfflineActions(statuses?: OfflineActionStatus[]) {
  if (!isBrowser()) return []
  const { store } = await storeTransaction("actions", "readonly")
  const actions = await requestToPromise<OfflineAction[]>(store.getAll())
  return statuses?.length ? actions.filter((action) => statuses.includes(action.status)) : actions
}

export async function updateOfflineAction(id: string, patch: Partial<OfflineAction>) {
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

export async function exportOfflineBackup() {
  if (!isBrowser()) return null
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
