"use client"

import { supabase } from "@/lib/supabase"
import {
  getOfflineData,
  listOfflineActions,
  putOfflineData,
  setOfflineMeta,
  updateOfflineAction,
  type OfflineAction,
} from "@/lib/offline/db"

type ProductRow = Record<string, unknown> & { id: string; stock?: number | null; name?: string | null }
type CustomerRow = Record<string, unknown> & { id: string; name?: string | null }
type InvoiceRow = Record<string, unknown> & { id: string; invoice_number?: string | null; sync_status?: string | null }
type InvoiceItemRow = Record<string, unknown> & { id: string; invoice_id?: string | null; product_id?: string | null; quantity?: number | null }
type SyncableRow = Record<string, unknown> & { id: string; sync_status?: string | null; offline_local_id?: string | null }
type OrderItemRow = SyncableRow & { order_id?: string | null }

export type SyncProgress = {
  total: number
  completed: number
  current?: string
  message: string
}

function numberFrom(value: unknown) {
  return value === null || value === undefined || value === "" ? 0 : Number(value || 0)
}

async function authHeaders() {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error("Internet required to refresh login.")
  }

  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.access_token}`,
  }
}

async function fetchOnlineProducts(headers: Record<string, string>) {
  const response = await fetch("/api/products/list?limit=100&sort=name&direction=asc", {
    headers,
    cache: "no-store",
  })
  const payload = (await response.json().catch(() => null)) as { data?: ProductRow[]; error?: string } | null
  if (!response.ok) throw new Error(payload?.error || "Products failed to load before sync.")
  return payload?.data || []
}

function actionSortRank(action: OfflineAction) {
  const rank: Record<OfflineAction["type"], number> = {
    save_customer: 1,
    customer_status: 2,
    save_product: 2,
    archive_product: 2,
    stock_movement: 3,
    create_invoice: 4,
    create_order: 6,
    save_settings: 7,
  }

  return rank[action.type] || 99
}

async function postJson<T>(url: string, headers: Record<string, string>, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  const result = (await response.json().catch(() => null)) as T & { error?: string; success?: boolean }

  if (!response.ok) {
    throw new Error(result?.error || `${url} failed.`)
  }

  return result
}

async function syncCustomer(action: OfflineAction, headers: Record<string, string>) {
  const payload = action.payload as {
    localCustomerId: string
    customer: Record<string, unknown>
  }
  const response = await fetch("/api/customers/save", {
    method: "POST",
    headers,
    body: JSON.stringify(payload.customer),
  })
  const result = (await response.json().catch(() => null)) as { id?: string; error?: string } | null
  if (!response.ok || !result?.id) throw new Error(result?.error || "Customer sync failed.")

  const customers = await getOfflineData<CustomerRow[]>(action.organizationId, "customers", [])
  await putOfflineData(
    action.organizationId,
    "customers",
    customers.map((customer) =>
      customer.id === payload.localCustomerId
        ? { ...customer, id: result.id, offline_local_id: payload.localCustomerId, sync_status: "synced", updated_at: new Date().toISOString() }
        : customer
    )
  )
}

async function syncCustomerStatus(action: OfflineAction, headers: Record<string, string>) {
  const payload = action.payload as {
    customerId: string
    status: {
      id?: string
      active?: boolean
      archive?: boolean
    }
  }
  const statusPayload = { ...payload.status }

  if (payload.customerId.startsWith("offline-")) {
    const customers = await getOfflineData<CustomerRow[]>(action.organizationId, "customers", [])
    const syncedCustomer = customers.find((customer) => customer.offline_local_id === payload.customerId)
    if (!syncedCustomer?.id || syncedCustomer.id.startsWith("offline-")) {
      throw new Error("Customer status is waiting for the customer record to sync first.")
    }
    statusPayload.id = syncedCustomer.id
  } else {
    statusPayload.id = payload.customerId
  }

  await postJson<{ success?: boolean }>("/api/customers/status", headers, statusPayload)

  const customers = await getOfflineData<SyncableRow[]>(action.organizationId, "customers", [])
  await putOfflineData(
    action.organizationId,
    "customers",
    customers.map((customer) =>
      customer.id === payload.customerId || customer.id === statusPayload.id
        ? {
            ...customer,
            id: statusPayload.id || customer.id,
            is_active: statusPayload.archive ? false : statusPayload.active ?? customer.is_active,
            deleted_at: statusPayload.archive ? customer.deleted_at || new Date().toISOString() : null,
            sync_status: "synced",
            updated_at: new Date().toISOString(),
          }
        : customer
    )
  )
}

async function syncProduct(action: OfflineAction, headers: Record<string, string>) {
  const payload = action.payload as {
    localProductId: string
    product: Record<string, unknown>
    serverProductId?: string | null
  }
  const serverProductId = payload.serverProductId || (typeof payload.product.id === "string" && !payload.product.id.startsWith("offline-") ? payload.product.id : null)
  const result = await postJson<{ product?: { id?: string }; success?: boolean }>(
    serverProductId ? "/api/products/update" : "/api/products/create",
    headers,
    serverProductId ? { id: serverProductId, ...payload.product } : payload.product
  )
  const serverId = result.product?.id || serverProductId
  if (!serverId) throw new Error("Product sync failed.")

  const products = await getOfflineData<SyncableRow[]>(action.organizationId, "products", [])
  await putOfflineData(
    action.organizationId,
    "products",
    products.map((product) =>
      product.id === payload.localProductId
        ? {
            ...product,
            id: serverId,
            server_id: serverId,
            local_id: payload.localProductId,
            offline_local_id: payload.localProductId,
            sync_status: "synced",
            updated_at: new Date().toISOString(),
          }
        : product
    )
  )
}

async function syncArchiveProduct(action: OfflineAction, headers: Record<string, string>) {
  const payload = action.payload as { productId: string; localProductId?: string }
  const productId = payload.productId
  if (productId.startsWith("offline-")) {
    const products = await getOfflineData<SyncableRow[]>(action.organizationId, "products", [])
    await putOfflineData(
      action.organizationId,
      "products",
      products.filter((product) => product.id !== productId)
    )
    return
  }

  await postJson<{ success?: boolean }>("/api/products/archive", headers, { id: productId })
  const products = await getOfflineData<SyncableRow[]>(action.organizationId, "products", [])
  await putOfflineData(
    action.organizationId,
    "products",
    products.map((product) =>
      product.id === productId ? { ...product, sync_status: "synced", deleted_at: new Date().toISOString() } : product
    )
  )
}

async function syncStockMovement(action: OfflineAction, headers: Record<string, string>) {
  const payload = action.payload as {
    localMovementId: string
    movement: Record<string, unknown> & { product_id?: string; quantity?: number; mode?: string }
  }
  await postJson<{ success?: boolean; warning?: string }>("/api/inventory/simple-movement", headers, payload.movement)

  const movements = await getOfflineData<SyncableRow[]>(action.organizationId, "stock_movements", [])
  await putOfflineData(
    action.organizationId,
    "stock_movements",
    movements.map((movement) =>
      movement.id === payload.localMovementId ? { ...movement, sync_status: "synced", last_synced_at: new Date().toISOString() } : movement
    )
  )
  const refreshedProducts = await fetchOnlineProducts(headers)
  await putOfflineData(action.organizationId, "products", refreshedProducts)
  await putOfflineData(action.organizationId, "inventory_items", refreshedProducts)
}

async function syncSettings(action: OfflineAction, headers: Record<string, string>) {
  const payload = action.payload as {
    kind: "organization" | "feature"
    data: Record<string, unknown>
  }

  if (payload.kind === "feature") {
    await postJson<{ success?: boolean }>("/api/settings/toggle-feature", headers, payload.data)
    return
  }

  await postJson<{ success?: boolean }>("/api/settings/update-organization", headers, payload.data)
}

async function syncOrder(action: OfflineAction, headers: Record<string, string>) {
  const payload = action.payload as {
    localOrderId: string
    order: Record<string, unknown>
    items?: Record<string, unknown>[]
  }

  const result = await postJson<{ order_id?: string; id?: string; order_number?: string; success?: boolean }>(
    "/api/orders/create",
    headers,
    {
      ...payload.order,
      items: payload.items || payload.order.items || [],
    }
  )
  const serverId = result.order_id || result.id
  const orders = await getOfflineData<SyncableRow[]>(action.organizationId, "orders", [])
  await putOfflineData(
    action.organizationId,
    "orders",
    orders.map((order) =>
      order.id === payload.localOrderId
        ? { ...order, id: serverId || order.id, server_id: serverId || null, local_id: payload.localOrderId, sync_status: "synced" }
        : order
    )
  )
  const orderItems = await getOfflineData<OrderItemRow[]>(action.organizationId, "order_items", [])
  await putOfflineData(
    action.organizationId,
    "order_items",
    orderItems.map((item) =>
      item.order_id === payload.localOrderId ? { ...item, order_id: serverId || item.order_id, sync_status: "synced" } : item
    )
  )

  const refreshedProducts = await fetchOnlineProducts(headers)
  await putOfflineData(action.organizationId, "products", refreshedProducts)
  await putOfflineData(action.organizationId, "inventory_items", refreshedProducts)
}

async function syncInvoice(action: OfflineAction, headers: Record<string, string>) {
  const payload = action.payload as {
    offlineClientId: string
    localInvoiceId: string
    invoice: Record<string, unknown>
    items: Array<Record<string, unknown> & { product_id: string; quantity: number; stock_at_queue?: number }>
  }

  const onlineProducts = await fetchOnlineProducts(headers)
  const onlineMap = new Map(onlineProducts.map((product) => [product.id, product]))
  const conflicts: string[] = []

  payload.items.forEach((item) => {
    const onlineProduct = onlineMap.get(item.product_id)
    if (!onlineProduct) {
      conflicts.push(`Product ${item.product_id} no longer exists online.`)
      return
    }

    const queuedStock = numberFrom(item.stock_at_queue)
    const onlineStock = numberFrom(onlineProduct.stock)
    if (queuedStock !== onlineStock) {
      conflicts.push(`${onlineProduct.name || "Product"} stock changed online from ${queuedStock} to ${onlineStock}.`)
    }
  })

  if (conflicts.length > 0) {
    throw new Error(`CONFLICT: ${conflicts.slice(0, 2).join(" ")}`)
  }

  const invoicePayload = { ...payload.invoice }
  if (typeof invoicePayload.customer_id === "string" && invoicePayload.customer_id.startsWith("offline-")) {
    const customers = await getOfflineData<CustomerRow[]>(action.organizationId, "customers", [])
    const syncedCustomer = customers.find((customer) => customer.offline_local_id === invoicePayload.customer_id)
    if (!syncedCustomer?.id || syncedCustomer.id.startsWith("offline-")) {
      throw new Error("Invoice customer is still pending sync. Sync the customer first, then retry.")
    }
    invoicePayload.customer_id = syncedCustomer.id
  }

  const response = await fetch("/api/invoices/create", {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...invoicePayload,
      offline_client_id: payload.offlineClientId,
      items: payload.items.map((item) => {
        const syncItem = { ...item }
        delete syncItem.stock_at_queue
        return syncItem
      }),
    }),
  })
  const result = (await response.json().catch(() => null)) as { invoice_id?: string; invoice_number?: string; error?: string; success?: boolean } | null
  if (!response.ok || !result?.success || !result.invoice_id) {
    throw new Error(result?.error || "Invoice sync failed.")
  }

  const invoices = await getOfflineData<InvoiceRow[]>(action.organizationId, "invoices", [])
  const invoiceItems = await getOfflineData<InvoiceItemRow[]>(action.organizationId, "invoice_items", [])

  await putOfflineData(
    action.organizationId,
    "invoices",
    invoices.map((invoice) =>
      invoice.id === payload.localInvoiceId
        ? {
            ...invoice,
            id: result.invoice_id,
            invoice_number: result.invoice_number || invoice.invoice_number,
            sync_status: "synced",
            offline_client_id: payload.offlineClientId,
          }
        : invoice
    )
  )
  await putOfflineData(
    action.organizationId,
    "invoice_items",
    invoiceItems.map((item) =>
      item.invoice_id === payload.localInvoiceId ? { ...item, invoice_id: result.invoice_id, sync_status: "synced" } : item
    )
  )

  const refreshedProducts = await fetchOnlineProducts(headers)
  await putOfflineData(action.organizationId, "products", refreshedProducts)
  await putOfflineData(action.organizationId, "inventory_items", refreshedProducts)
}

export async function syncOfflineQueue(onProgress?: (progress: SyncProgress) => void) {
  if (!navigator.onLine) throw new Error("You are offline. Sync will run when internet returns.")

  const actions = (await listOfflineActions(["pending", "error", "conflict"])).sort((a, b) => actionSortRank(a) - actionSortRank(b))
  const headers = await authHeaders()
  let completed = 0

  onProgress?.({ total: actions.length, completed, message: actions.length ? "Starting sync..." : "Nothing pending." })

  for (const action of actions) {
    onProgress?.({ total: actions.length, completed, current: action.id, message: `Syncing ${action.type.replace("_", " ")}...` })
    await updateOfflineAction(action.id, { status: "syncing", attempts: action.attempts + 1, error: undefined })

    try {
      if (action.type === "save_customer") await syncCustomer(action, headers)
      if (action.type === "customer_status") await syncCustomerStatus(action, headers)
      if (action.type === "save_product") await syncProduct(action, headers)
      if (action.type === "archive_product") await syncArchiveProduct(action, headers)
      if (action.type === "stock_movement") await syncStockMovement(action, headers)
      if (action.type === "create_invoice") await syncInvoice(action, headers)
      if (action.type === "create_order") await syncOrder(action, headers)
      if (action.type === "save_settings") await syncSettings(action, headers)
      await updateOfflineAction(action.id, { status: "synced", error: undefined })
      completed += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed."
      await updateOfflineAction(action.id, {
        status: message.startsWith("CONFLICT:") ? "conflict" : "error",
        error: message.replace(/^CONFLICT:\s*/, ""),
      })
    }
  }

  const unresolved = await listOfflineActions(["pending", "error", "conflict"])
  if (completed > 0) {
    const organizationId = actions.find((action) => action.organizationId)?.organizationId
    if (organizationId) await setOfflineMeta("last_synced_at", new Date().toISOString(), organizationId)
  }
  onProgress?.({
    total: actions.length,
    completed,
    message: unresolved.length ? `${completed} synced. ${unresolved.length} need attention.` : "All offline changes synced.",
  })

  return { completed, unresolved: unresolved.length }
}
