"use client"

import { supabase } from "@/lib/supabase"
import {
  getOfflineData,
  listOfflineActions,
  putOfflineData,
  updateOfflineAction,
  type OfflineAction,
} from "@/lib/offline/db"

type ProductRow = Record<string, unknown> & { id: string; stock?: number | null; name?: string | null }
type CustomerRow = Record<string, unknown> & { id: string; name?: string | null }
type InvoiceRow = Record<string, unknown> & { id: string; invoice_number?: string | null; sync_status?: string | null }
type InvoiceItemRow = Record<string, unknown> & { id: string; invoice_id?: string | null; product_id?: string | null; quantity?: number | null }

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

  const actions = await listOfflineActions(["pending", "error", "conflict"])
  const headers = await authHeaders()
  let completed = 0

  onProgress?.({ total: actions.length, completed, message: actions.length ? "Starting sync..." : "Nothing pending." })

  for (const action of actions) {
    onProgress?.({ total: actions.length, completed, current: action.id, message: `Syncing ${action.type.replace("_", " ")}...` })
    await updateOfflineAction(action.id, { status: "syncing", attempts: action.attempts + 1, error: undefined })

    try {
      if (action.type === "save_customer") await syncCustomer(action, headers)
      if (action.type === "create_invoice") await syncInvoice(action, headers)
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
  onProgress?.({
    total: actions.length,
    completed,
    message: unresolved.length ? `${completed} synced. ${unresolved.length} need attention.` : "All offline changes synced.",
  })

  return { completed, unresolved: unresolved.length }
}
