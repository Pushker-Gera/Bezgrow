"use client"

import { cacheWorkspaceBootstrap, getOfflineMeta, putOfflineData, setOfflineMeta } from "@/lib/offline/db"
import { supabase } from "@/lib/supabase"
import type { WorkspaceBootstrapPayload } from "@/lib/workspaceBootstrapClient"

type BootstrapProgress = {
  message: string
  completed: number
  total: number
}

type ListResponse<T> = {
  data?: T[]
  error?: string
}

const PREPARE_INTERVAL_MS = 30 * 60 * 1000

function organizationIdFrom(payload: WorkspaceBootstrapPayload) {
  return payload.organization?.id || payload.membership?.organization_id || null
}

async function authHeaders() {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined
}

async function fetchList<T>(url: string, headers?: HeadersInit) {
  const response = await fetch(url, { headers, cache: "no-store" })
  const payload = (await response.json().catch(() => null)) as ListResponse<T> | null
  if (!response.ok) throw new Error(payload?.error || `${url} failed to load.`)
  return payload?.data || []
}

async function readSupabaseTable<T>(table: string, organizationId: string, columns = "*", limit = 5000) {
  const { data, error } = await supabase
    .from(table)
    .select(columns)
    .eq("organization_id", organizationId)
    .limit(limit)

  if (error) return []
  return (data || []) as T[]
}

export async function prepareOfflineWorkspace(
  payload: WorkspaceBootstrapPayload,
  options: { force?: boolean; onProgress?: (progress: BootstrapProgress) => void } = {}
) {
  const organizationId = organizationIdFrom(payload)
  if (!payload.success || !organizationId || typeof navigator === "undefined" || !navigator.onLine) {
    return { prepared: false, reason: "offline-or-missing-workspace" }
  }

  const lastPreparedAt = await getOfflineMeta<number>("offline_workspace_prepared_at", 0, organizationId)
  if (!options.force && lastPreparedAt && Date.now() - lastPreparedAt < PREPARE_INTERVAL_MS) {
    return { prepared: false, reason: "recently-prepared" }
  }

  const steps = [
    "workspace",
    "products",
    "customers",
    "invoices",
    "invoice items",
    "orders",
    "settings",
    "stock movements",
  ]
  let completed = 0

  const progress = (message: string) => {
    options.onProgress?.({ message, completed, total: steps.length })
  }

  progress("Preparing offline workspace...")
  await cacheWorkspaceBootstrap(payload)
  completed += 1

  const headers = await authHeaders()

  progress("Downloading products and inventory...")
  const products = await fetchList<Record<string, unknown>>("/api/products/list?limit=1000&sort=name&direction=asc", headers)
  await putOfflineData(organizationId, "products", products)
  await putOfflineData(organizationId, "inventory_items", products)
  completed += 1

  progress("Downloading customers...")
  const customers = await fetchList<Record<string, unknown>>("/api/customers/list?limit=1000", headers)
  await putOfflineData(organizationId, "customers", customers)
  completed += 1

  progress("Downloading invoices...")
  const invoices = await fetchList<Record<string, unknown>>("/api/invoices/list?limit=1000", headers)
  await putOfflineData(organizationId, "invoices", invoices)
  completed += 1

  progress("Downloading invoice items...")
  const invoiceItems = await readSupabaseTable<Record<string, unknown>>("invoice_items", organizationId)
  await putOfflineData(organizationId, "invoice_items", invoiceItems)
  completed += 1

  progress("Downloading orders...")
  try {
    const orders = await fetchList<Record<string, unknown>>("/api/orders/list?limit=500", headers)
    await putOfflineData(organizationId, "orders", orders)
  } catch {
    await putOfflineData(organizationId, "orders", await readSupabaseTable<Record<string, unknown>>("orders", organizationId))
  }
  await putOfflineData(organizationId, "order_items", await readSupabaseTable<Record<string, unknown>>("order_items", organizationId))
  completed += 1

  progress("Saving settings...")
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
  completed += 1

  progress("Downloading stock movements...")
  const stockMovements = await readSupabaseTable<Record<string, unknown>>("stock_movements", organizationId)
  await putOfflineData(organizationId, "stock_movements", stockMovements)
  completed += 1

  const syncedAt = new Date().toISOString()
  await setOfflineMeta("offline_workspace_prepared_at", Date.now(), organizationId)
  await setOfflineMeta("last_synced_at", syncedAt, organizationId)

  options.onProgress?.({
    message: "Bezgrow is ready for offline use.",
    completed,
    total: steps.length,
  })

  window.dispatchEvent(new Event("bezgrow:offline-workspace-ready"))
  return { prepared: true, lastSyncedAt: syncedAt }
}
