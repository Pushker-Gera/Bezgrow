"use client"

import { isDesktopRuntime, isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { createOfflineId, getCachedWorkspaceBootstrap, getOfflineData, putOfflineData, type OfflineAction, type OfflineCollection } from "@/lib/offline/db"
import { isLicenseRestrictedEndpoint } from "@/lib/license/policy"
import { localFirstRepositoryAdapter } from "@/lib/offline/local/adapters"
import {
  createAccountingVoucher,
  createCreditNote,
  createDebitNote,
  createExpenseRecord,
  createInventoryMovement,
  createPaymentTransaction,
  createPurchaseDocument,
  deleteSupplierMaster,
  ensureDefaultChartOfAccounts,
  getOfflineReport,
  rowsToCsv,
  runProfessionalIntegrityChecks,
  saveSupplierMaster,
  supplierLedgerSummary,
  verifyLocalBackup,
} from "@/lib/offline/local/erp"
import { assertLocalWriteAllowed, localLicenseSnapshot, restoreLicensedWorkspaceContext } from "@/lib/offline/local/license"
import {
  createNormalizedInvoiceAtomic,
  deleteNormalizedInvoiceAtomic,
  putNormalizedCollectionsInTransaction,
  queryNormalizedAnalyticsReport,
  queryNormalizedBillingSummary,
  queryNormalizedCustomers,
  queryNormalizedDashboardSummary,
  queryNormalizedInvoices,
  queryNormalizedProducts,
  readNormalizedInvoiceCreationContext,
  readNormalizedInvoiceDeletionContext,
  updateNormalizedInvoicePaymentStatus,
  type NormalizedListPage,
  type NormalizedListQuery,
} from "@/lib/offline/local/repositories"
import { getLocalDatabaseService, LocalDatabaseUnavailableError } from "@/lib/offline/local/service"

type DataRow = Record<string, unknown> & { id?: string }

type LocalApiResult = {
  response: Response | null
  handled: boolean
}

const databaseManager = getLocalDatabaseService()

const dailyEndpoints = new Set([
  "/api/workspace/bootstrap",
  "/api/dashboard/summary",
  "/api/dashboard/billing/summary",
  "/api/products/list",
  "/api/products/create",
  "/api/products/update",
  "/api/products/archive",
  "/api/customers/list",
  "/api/customers/save",
  "/api/customers/status",
  "/api/suppliers/list",
  "/api/suppliers/save",
  "/api/suppliers/status",
  "/api/suppliers/ledger",
  "/api/invoices/list",
  "/api/invoices/create",
  "/api/invoices/update-status",
  "/api/invoices/delete-with-stock-restore",
  "/api/purchases/list",
  "/api/purchases/create",
  "/api/purchases/return",
  "/api/purchases/order",
  "/api/purchases/goods-received",
  "/api/purchases/supplier-payment",
  "/api/quotations/list",
  "/api/quotations/create",
  "/api/delivery-challans/list",
  "/api/delivery-challans/create",
  "/api/sales/proforma/create",
  "/api/sales/returns/create",
  "/api/payments/list",
  "/api/payments/create",
  "/api/accounting/chart",
  "/api/accounting/chart/save",
  "/api/accounting/bank-accounts",
  "/api/accounting/bank-accounts/save",
  "/api/accounting/vouchers",
  "/api/accounting/vouchers/create",
  "/api/accounting/reports",
  "/api/notes/credit",
  "/api/notes/debit",
  "/api/expenses/list",
  "/api/expenses/create",
  "/api/inventory/simple-movement",
  "/api/inventory/professional-movement",
  "/api/reports/local",
  "/api/backup/verify",
  "/api/database/integrity",
  "/api/settings/update-organization",
  "/api/settings/toggle-feature",
])

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "X-Bezgrow-Data-Source": "sqlite",
    },
  })
}

function ok(payload: Record<string, unknown> = {}) {
  return jsonResponse({ success: true, ...payload })
}

function fail(message: string, status = 400) {
  return jsonResponse({ success: false, error: message }, status)
}

function isLicenseError(message: string) {
  return /activation required|license|another device|reactivation/i.test(message)
}

function csvResponse(filename: string, rows: DataRow[]) {
  return new Response(rowsToCsv(rows), {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "text/csv; charset=utf-8",
    },
  })
}

function nowIso() {
  return new Date().toISOString()
}

function localNumber(value: unknown, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback
  const next = Number(value)
  return Number.isFinite(next) ? next : fallback
}

function localString(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value : fallback
}

function normalizeUrl(input: RequestInfo | URL) {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  const base = typeof window !== "undefined" ? window.location.origin : "http://localhost"
  return new URL(raw, base)
}

function readCachedOrganizationId() {
  if (typeof window === "undefined") return ""

  try {
    const cached = JSON.parse(sessionStorage.getItem("bezgrow:organization-id") || "null") as { value?: string | null } | null
    if (cached?.value) return cached.value
  } catch {
    sessionStorage.removeItem("bezgrow:organization-id")
  }

  const workspace = getCachedWorkspaceBootstrap()
  return workspace?.organization?.id || workspace?.membership?.organization_id || ""
}

async function organizationIdFor(url: URL, body?: DataRow | null) {
  const cachedId =
    url.searchParams.get("organization_id") ||
    (typeof body?.organization_id === "string" ? body.organization_id : "") ||
    readCachedOrganizationId()
  if (cachedId) return cachedId

  const license = await localLicenseSnapshot().catch(() => null)
  if (!license?.allowed) return ""
  const row = license.license as DataRow | null | undefined
  return localString(row?.business_id || row?.organization_id)
}

async function requestBody(init: RequestInit = {}) {
  if (!init.body || typeof init.body !== "string") return null
  try {
    return JSON.parse(init.body) as DataRow
  } catch {
    return null
  }
}

function sortRows(rows: DataRow[], sort: string, direction: string, allowed: readonly string[] = ["created_at"]) {
  const safeSort = allowed.includes(sort) ? sort : allowed[0]
  const multiplier = direction === "asc" ? 1 : -1
  return [...rows].sort((a, b) => {
    const left = a[safeSort]
    const right = b[safeSort]
    if (typeof left === "number" || typeof right === "number") {
      return (localNumber(left) - localNumber(right)) * multiplier
    }
    return String(left || "").localeCompare(String(right || "")) * multiplier
  })
}

function paginate(url: URL, rows: DataRow[]) {
  const requestedPage = Number.parseInt(url.searchParams.get("page") || "1", 10)
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") || url.searchParams.get("pageSize") || "50", 10)
  const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, requestedLimit)) : 50
  const from = (page - 1) * limit
  return {
    data: rows.slice(from, from + limit),
    pagination: {
      page,
      limit,
      sort: url.searchParams.get("sort") || "created_at",
      direction: url.searchParams.get("direction") === "asc" ? "asc" : "desc",
      search: url.searchParams.get("search") || "",
      total: rows.length,
    },
  }
}

function normalizedListQuery(url: URL): NormalizedListQuery {
  const requestedPage = Number.parseInt(url.searchParams.get("page") || "1", 10)
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") || url.searchParams.get("pageSize") || "50", 10)
  return {
    page: Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1,
    limit: Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, requestedLimit)) : 50,
    search: url.searchParams.get("search") || "",
    sort: url.searchParams.get("sort") || "created_at",
    direction: url.searchParams.get("direction") === "asc" ? "asc" : "desc",
    category: url.searchParams.get("category") || "all",
    supplier: url.searchParams.get("supplier") || "all",
    stock: url.searchParams.get("stock") || "all",
    status: url.searchParams.get("status") || "all",
    customerType: url.searchParams.get("customer_type") || "all",
    gstStatus: url.searchParams.get("gst_status") || "all",
    customerId: url.searchParams.get("customer_id") || "all",
    period: url.searchParams.get("period") || "all",
  }
}

function localListResponse(collection: "products" | "customers" | "invoices", url: URL, organizationId: string, page: NormalizedListPage) {
  const query = normalizedListQuery(url)
  const payload = {
    data: page.data,
    pagination: {
      page: query.page,
      limit: query.limit,
      sort: query.sort,
      direction: query.direction,
      search: query.search,
      total: page.total,
    },
    ...(page.summary ? { summary: page.summary } : {}),
    ...(page.facets ? { facets: page.facets } : {}),
  }
  console.info("[desktop-local-list]", {
    adapter: "sqlite-normalized-repository",
    collection,
    route: url.pathname,
    organizationId,
    request: Object.fromEntries(url.searchParams),
    response: { count: payload.data.length, pagination: payload.pagination },
  })
  return jsonResponse(payload)
}

function filterDeleted<T extends DataRow>(rows: T[]) {
  return rows.filter((row) => !row.deleted_at)
}

async function readCollection<T extends DataRow>(organizationId: string, collection: OfflineCollection) {
  return getOfflineData<T[]>(organizationId, collection, [])
}

async function writeCollections(
  organizationId: string,
  updates: Array<{ collection: OfflineCollection; value: unknown }>,
  action?: OfflineAction
) {
  // `action` is a legacy compatibility argument. It is intentionally not
  // persisted: SQLite is authoritative and there is no cloud upload queue.
  void action
  const desktopRuntime = await isDesktopRuntime().catch(() => false)
  const wroteToSqlite = await putNormalizedCollectionsInTransaction(organizationId, updates)
    .then(() => true)
    .catch((error) => {
      console.warn("[offline/local-api] SQLite batch write unavailable.", error)
      if (desktopRuntime) throw error
      return false
    })

  if (!wroteToSqlite) {
    for (const update of updates) {
      await putOfflineData(organizationId, update.collection, update.value)
    }
  }

  if (typeof window !== "undefined") window.dispatchEvent(new Event("bezgrow:offline-data-changed"))
}

function pendingAction(
  id: string,
  type: OfflineAction["type"],
  organizationId: string,
  payload: Record<string, unknown>
): OfflineAction {
  const now = nowIso()
  return { id, type, organizationId, payload, status: "pending", attempts: 0, createdAt: now, updatedAt: now }
}

async function queue(action: Omit<OfflineAction, "status" | "createdAt" | "updatedAt" | "attempts">) {
  // Retained so legacy call sites remain source-compatible. Never enqueue or upload.
  void action
}

function rowMatches(row: DataRow, fields: string[], term: string) {
  if (!term) return true
  const normalized = term.toLowerCase()
  return fields.some((field) => String(row[field] || "").toLowerCase().includes(normalized))
}

async function listProducts(url: URL, organizationId: string) {
  return localListResponse("products", url, organizationId, await queryNormalizedProducts(organizationId, normalizedListQuery(url)))
}

async function saveProduct(url: URL, body: DataRow, isUpdate: boolean, organizationId: string) {
  const now = nowIso()
  const products = await readCollection<DataRow>(organizationId, "products")
  const movements = await readCollection<DataRow>(organizationId, "stock_movements")
  const id = isUpdate ? localString(body.id) : createOfflineId("product")
  if (!id) return fail("Invalid product id.", 422)
  if (!localString(body.name)) return fail("Product name is required.", 422)
  const sku = localString(body.sku).toLowerCase()
  if (sku && products.some((product) => product.id !== id && localString(product.sku).toLowerCase() === sku && !product.deleted_at)) {
    return fail("A product with this SKU already exists.", 409)
  }
  if (body.stock !== undefined) {
    const parsedStock = Number(body.stock)
    if (!Number.isFinite(parsedStock)) return fail("Opening stock must be a valid number.", 422)
    if (parsedStock < 0) return fail("Opening stock cannot be negative.", 422)
  }

  const previous = products.find((product) => product.id === id)
  const stock = localNumber(body.stock, localNumber(previous?.stock))
  const payload: DataRow = {
    ...previous,
    ...body,
    id,
    organization_id: organizationId,
    description: body.description ?? "",
    price: body.price ?? body.sale_rate ?? body.mrp ?? body.purchase_rate ?? 0,
    stock,
    created_at: localString(previous?.created_at) || now,
    updated_at: now,
    deleted_at: null,
    sync_status: isUpdate ? "pending_update" : "pending_create",
    offline_local_id: localString(previous?.offline_local_id) || id,
  }
  const nextProducts = previous ? products.map((product) => (product.id === id ? payload : product)) : [payload, ...products]
  const stockDifference = stock - localNumber(previous?.stock)
  const nextMovements =
    stockDifference === 0
      ? movements
      : [
          {
            id: createOfflineId("stock-movement"),
            organization_id: organizationId,
            product_id: id,
            product_name: payload.name || "",
            type: isUpdate ? "adjustment" : "opening_stock",
            quantity: stockDifference,
            previous_stock: localNumber(previous?.stock),
            new_stock: stock,
            reason: isUpdate ? "Product master stock adjustment" : "Initial product master stock",
            sync_status: "pending_create",
            created_at: now,
            updated_at: now,
          },
          ...movements,
        ]

  await writeCollections(
    organizationId,
    [
      { collection: "products", value: nextProducts },
      { collection: "inventory_items", value: nextProducts },
      { collection: "stock_movements", value: nextMovements },
    ],
    pendingAction(createOfflineId("product-action"), "save_product", organizationId, {
      localProductId: id,
      serverProductId: isUpdate && !id.startsWith("offline-") ? id : null,
      product: { ...body, id: undefined },
    })
  )

  return ok({ product: { id, name: payload.name, sku: payload.sku || null, stock } })
}

async function archiveProduct(body: DataRow, organizationId: string) {
  const id = localString(body.id)
  if (!id) return fail("Invalid product id.", 422)
  const now = nowIso()
  const products = await readCollection<DataRow>(organizationId, "products")
  const nextProducts = products.map((product) =>
    product.id === id ? { ...product, deleted_at: now, sync_status: "pending_delete", updated_at: now } : product
  )
  await writeCollections(
    organizationId,
    [
      { collection: "products", value: nextProducts },
      { collection: "inventory_items", value: nextProducts },
    ],
    pendingAction(createOfflineId("product-archive"), "archive_product", organizationId, { productId: id })
  )
  return ok({ product: { id } })
}

async function listCustomers(url: URL, organizationId: string) {
  return localListResponse("customers", url, organizationId, await queryNormalizedCustomers(organizationId, normalizedListQuery(url)))
}

async function saveCustomer(body: DataRow, organizationId: string) {
  const now = nowIso()
  const customers = await readCollection<DataRow>(organizationId, "customers")
  const id = localString(body.id) || createOfflineId("customer")
  if (!localString(body.name)) return fail("Customer name is required.", 422)
  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(localString(body.email))) return fail("Enter a valid customer email address.", 422)
  const previous = customers.find((customer) => customer.id === id)
  const nextCustomer = {
    ...previous,
    ...body,
    id,
    organization_id: organizationId,
    name: body.name,
    is_active: previous?.is_active ?? true,
    total_sales: previous?.total_sales ?? 0,
    last_purchase_at: previous?.last_purchase_at ?? null,
    deleted_at: null,
    created_at: localString(previous?.created_at) || now,
    updated_at: now,
    sync_status: previous ? "pending_update" : "pending_create",
    offline_local_id: localString(previous?.offline_local_id) || id,
  }
  const nextCustomers = previous ? customers.map((customer) => (customer.id === id ? nextCustomer : customer)) : [nextCustomer, ...customers]
  await writeCollections(
    organizationId,
    [{ collection: "customers", value: nextCustomers }],
    pendingAction(createOfflineId("customer-action"), "save_customer", organizationId, {
      localCustomerId: id,
      customer: previous && !id.startsWith("offline-") ? { id, ...body } : body,
    })
  )
  return ok({ id })
}

async function customerStatus(body: DataRow, organizationId: string) {
  const id = localString(body.id)
  if (!id) return fail("Invalid customer status request.", 422)
  const now = nowIso()
  const archive = body.archive === true
  const active = archive ? false : body.active !== undefined ? Boolean(body.active) : true
  const customers = await readCollection<DataRow>(organizationId, "customers")
  const nextCustomers = customers.map((customer) =>
    customer.id === id
      ? {
          ...customer,
          is_active: active,
          deleted_at: archive ? now : null,
          sync_status: "pending_update",
          updated_at: now,
        }
      : customer
  )
  await writeCollections(
    organizationId,
    [{ collection: "customers", value: nextCustomers }],
    pendingAction(createOfflineId("customer-status"), "customer_status", organizationId, {
      customerId: id,
      status: { id: id.startsWith("offline-") ? undefined : id, active, archive },
    })
  )
  return ok({ id, active, archived: archive })
}

async function queueProfessionalAction(type: OfflineAction["type"], organizationId: string, payload: Record<string, unknown>) {
  await queue({
    id: createOfflineId(`${type}-action`),
    type,
    organizationId,
    payload,
  })
}

async function listSuppliers(url: URL, organizationId: string) {
  const search = url.searchParams.get("search") || ""
  let rows = filterDeleted(await readCollection<DataRow>(organizationId, "suppliers"))
  rows = rows.filter((row) => rowMatches(row, ["name", "email", "phone", "gst_number", "gstin", "tax_id"], search))
  rows = sortRows(rows, url.searchParams.get("sort") || "created_at", url.searchParams.get("direction") || "desc")
  return jsonResponse(paginate(url, rows))
}

async function saveSupplier(body: DataRow, organizationId: string) {
  const result = await saveSupplierMaster(organizationId, body)
  await queueProfessionalAction("save_supplier", organizationId, { supplier: body, localSupplierId: result.supplier.id })
  return ok(result as Record<string, unknown>)
}

async function supplierStatus(body: DataRow, organizationId: string) {
  const id = localString(body.id || body.supplier_id)
  if (!id) return fail("Invalid supplier status request.", 422)
  const archive = body.archive === true || body.active === false
  if (archive) {
    const result = await deleteSupplierMaster(organizationId, id)
    await queueProfessionalAction("delete_supplier", organizationId, { supplierId: id })
    return ok(result)
  }
  const suppliers = await readCollection<DataRow>(organizationId, "suppliers")
  const now = nowIso()
  const nextSuppliers = suppliers.map((supplier) =>
    supplier.id === id ? { ...supplier, is_active: true, deleted_at: null, sync_status: "pending_update", updated_at: now } : supplier
  )
  await writeCollections(organizationId, [{ collection: "suppliers", value: nextSuppliers }])
  await queueProfessionalAction("save_supplier", organizationId, { supplierId: id, active: true })
  return ok({ id, active: true })
}

async function supplierLedger(url: URL, organizationId: string) {
  const supplierId = url.searchParams.get("supplier_id") || ""
  if (!supplierId) return fail("Supplier id is required.", 422)
  return jsonResponse({ success: true, ...(await supplierLedgerSummary(organizationId, supplierId)) })
}

async function listInvoices(url: URL, organizationId: string) {
  return localListResponse("invoices", url, organizationId, await queryNormalizedInvoices(organizationId, normalizedListQuery(url)))
}

function nextLocalDocumentNumber(prefix: string, rows: DataRow[], key: string) {
  const today = nowIso().slice(0, 10).replace(/-/g, "")
  const count = rows.filter((row) => localString(row[key]).startsWith(`${prefix}-${today}`)).length + 1
  return `${prefix}-${today}-${String(count).padStart(4, "0")}`
}

function nextItemsTax(items: DataRow[]) {
  return items.reduce((sum, item) => sum + localNumber(item.gst_amount, localNumber(item.tax_amount)), 0)
}

type BatchAllocation = {
  productId: string
  batchId: string | null
  warehouseId: string | null
  quantity: number
}

function consumeInvoiceBatches(batches: DataRow[], items: DataRow[], now: string) {
  let nextBatches = [...batches]
  const allocations: BatchAllocation[] = []

  for (const item of items) {
    const productId = localString(item.product_id)
    const requestedBatch = localString(item.batch_no || item.batch_number)
    let remaining = Math.max(0, localNumber(item.quantity))
    if (!productId || remaining <= 0) continue

    const eligibleLots = nextBatches
      .filter((lot) =>
        lot.product_id === productId &&
        !lot.deleted_at &&
        localNumber(lot.quantity) > 0 &&
        (!requestedBatch || localString(lot.batch_no) === requestedBatch)
      )
      .sort((left, right) => {
        const dateOrder = localString(left.purchase_date, localString(left.created_at, "9999")).localeCompare(
          localString(right.purchase_date, localString(right.created_at, "9999"))
        )
        return dateOrder || localString(left.id).localeCompare(localString(right.id))
      })

    for (const lot of eligibleLots) {
      if (remaining <= 0) break
      const quantity = Math.min(remaining, localNumber(lot.quantity))
      remaining -= quantity
      nextBatches = nextBatches.map((candidate) =>
        candidate.id === lot.id
          ? { ...candidate, quantity: Math.max(0, localNumber(candidate.quantity) - quantity), sync_status: "pending_update", updated_at: now }
          : candidate
      )
      allocations.push({
        productId,
        batchId: localString(lot.id) || null,
        warehouseId: localString(lot.warehouse_id) || null,
        quantity,
      })
    }

    if (requestedBatch && remaining > 0.0001) {
      throw new Error(`Batch ${requestedBatch} does not have enough stock.`)
    }
    if (remaining > 0) allocations.push({ productId, batchId: null, warehouseId: null, quantity: remaining })
  }

  return { nextBatches, allocations }
}

async function createInvoice(body: DataRow, organizationId: string) {
  const now = nowIso()
  const items = Array.isArray(body.items) ? (body.items as DataRow[]) : []
  if (!items.length) return fail("Invalid invoice.", 422)

  const offlineClientId = localString(body.offline_client_id) || createOfflineId("invoice-client")
  const productIds = items.map((item) => localString(item.product_id)).filter(Boolean)
  const context = await readNormalizedInvoiceCreationContext(
    organizationId,
    localString(body.customer_id),
    productIds,
    offlineClientId
  )
  if (context.existing) {
    return ok({
      invoice_id: context.existing.id,
      invoice_number: context.existing.invoice_number,
      idempotent: true,
    })
  }
  const products = context.products
  const batches = context.batches
  const customer = context.customer
  if (!customer) return fail("Customer was not found.", 404)

  const quantityByProduct = new Map<string, number>()
  items.forEach((item) => {
    const productId = localString(item.product_id)
    if (productId) quantityByProduct.set(productId, (quantityByProduct.get(productId) || 0) + localNumber(item.quantity))
  })

  for (const [productId, quantity] of quantityByProduct) {
    const product = products.find((row) => row.id === productId)
    if (!product) return fail("One or more products were not found.", 404)
    if (localNumber(product.stock) < quantity) return fail(`${product.name || "Product"} has only ${localNumber(product.stock)} in stock.`, 409)
  }

  const invoiceId = createOfflineId("invoice")
  const invoiceSequence = context.invoiceSequence
  const invoiceNumber = context.invoiceNumber
  const totalAmount = localNumber(body.total_amount)
  const paidAmount = Math.min(totalAmount, localNumber(body.paid_amount, body.payment_status === "paid" ? totalAmount : 0))
  const outstandingAmount = Math.max(0, totalAmount - paidAmount)
  const paymentStatus = paidAmount >= totalAmount && totalAmount > 0 ? "paid" : paidAmount > 0 ? "partial" : body.payment_status || "unpaid"
  const taxTotal = localNumber(body.tax_total, localNumber(body.tax_amount, nextItemsTax(items)))
  const taxableAmount = localNumber(body.taxable_amount, Math.max(0, totalAmount - taxTotal))
  const invoiceRecord: DataRow = {
    ...body,
    id: invoiceId,
    organization_id: organizationId,
    invoice_number: invoiceNumber,
    customer_name: customer.name || "Customer",
    grand_total: body.total_amount,
    total: body.total_amount,
    tax_total: taxTotal,
    tax_amount: taxTotal,
    taxable_amount: taxableAmount,
    paid_amount: paidAmount,
    outstanding_amount: outstandingAmount,
    payment_status: paymentStatus,
    status: paymentStatus,
    date: now.slice(0, 10),
    invoice_date: now.slice(0, 10),
    offline_client_id: offlineClientId,
    sync_status: "pending_create",
    created_at: now,
    updated_at: now,
  }
  const nextItems: DataRow[] = items.map((item) => {
    const product = products.find((row) => row.id === item.product_id)
    return {
      ...item,
      id: createOfflineId("invoice-item"),
      organization_id: organizationId,
      invoice_id: invoiceId,
      product_name: localString(item.product_name) || localString(product?.name),
      batch_no: localString(item.batch_no || item.batch_number) || localString(product?.batch_no) || null,
      expiry_date: localString(item.expiry_date) || localString(product?.expiry_date) || null,
      hsn_code: localString(item.hsn_code || item.hsn) || localString(product?.hsn_code) || null,
      unit: localString(item.unit) || localString(product?.unit) || null,
      mrp: item.mrp ?? product?.mrp ?? null,
      sync_status: "pending_create",
      created_at: now,
      updated_at: now,
    }
  })
  let consumedBatches: ReturnType<typeof consumeInvoiceBatches>
  try {
    consumedBatches = consumeInvoiceBatches(batches, items, now)
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The selected stock batch is unavailable.", 409)
  }
  const runningStock = new Map(products.map((product) => [String(product.id || ""), localNumber(product.stock)]))
  const nextMovements = consumedBatches.allocations.map(({ productId, batchId, warehouseId, quantity }) => {
      const product = products.find((row) => row.id === productId)
      const previousStock = runningStock.get(productId) ?? localNumber(product?.stock)
      const newStock = previousStock - quantity
      runningStock.set(productId, newStock)
      return {
        id: createOfflineId("stock-movement"),
        organization_id: organizationId,
        product_id: productId,
        product_name: product?.name || "",
        type: "sale",
        quantity: -quantity,
        previous_stock: previousStock,
        new_stock: newStock,
        batch_id: batchId,
        warehouse_id: warehouseId || product?.warehouse_id || null,
        reason: `Invoice ${invoiceNumber}`,
        reference_no: invoiceNumber,
        reference_type: "invoice",
        reference_id: invoiceId,
        sync_status: "pending_create",
        created_at: now,
        updated_at: now,
      }
    })
  const receiptId = paidAmount > 0 ? createOfflineId("receipt") : ""
  const nextLedger = [
    {
      id: createOfflineId("ledger"),
      organization_id: organizationId,
      account_type: "customer",
      account_id: body.customer_id,
      document_type: "sales_invoice",
      document_id: invoiceId,
      entry_date: now.slice(0, 10),
      debit: totalAmount,
      credit: 0,
      description: `Invoice ${invoiceNumber}`,
      sync_status: "pending_create",
      created_at: now,
      updated_at: now,
    },
    {
      id: createOfflineId("ledger"),
      organization_id: organizationId,
      account_type: "sales",
      account_id: null,
      document_type: "sales_invoice",
      document_id: invoiceId,
      entry_date: now.slice(0, 10),
      debit: 0,
      credit: taxableAmount,
      description: `Invoice ${invoiceNumber}`,
      sync_status: "pending_create",
      created_at: now,
      updated_at: now,
    },
    ...(taxTotal > 0
      ? [
          {
            id: createOfflineId("ledger"),
            organization_id: organizationId,
            account_type: "gst_output",
            account_id: null,
            document_type: "sales_invoice",
            document_id: invoiceId,
            entry_date: now.slice(0, 10),
            debit: 0,
            credit: taxTotal,
            description: `GST ${invoiceNumber}`,
            sync_status: "pending_create",
            created_at: now,
            updated_at: now,
          },
        ]
      : []),
    ...(paidAmount > 0
      ? [
          {
            id: createOfflineId("ledger"),
            organization_id: organizationId,
            account_type: ["bank", "bank_transfer"].includes(localString(body.payment_method)) ? "bank" : "cash",
            account_id: null,
            document_type: "payment_receipt",
            document_id: receiptId,
            entry_date: now.slice(0, 10),
            debit: paidAmount,
            credit: 0,
            description: `Receipt ${invoiceNumber}`,
            sync_status: "pending_create",
            created_at: now,
            updated_at: now,
          },
          {
            id: createOfflineId("ledger"),
            organization_id: organizationId,
            account_type: "customer",
            account_id: body.customer_id,
            document_type: "payment_receipt",
            document_id: receiptId,
            entry_date: now.slice(0, 10),
            debit: 0,
            credit: paidAmount,
            description: `Receipt ${invoiceNumber}`,
            sync_status: "pending_create",
            created_at: now,
            updated_at: now,
          },
        ]
      : []),
  ]
  const receipt = paidAmount > 0
    ? {
          id: receiptId,
          organization_id: organizationId,
          customer_id: body.customer_id,
          invoice_id: invoiceId,
          receipt_number: `RCPT-${Date.now()}`,
          receipt_type: "customer_receipt",
          amount: paidAmount,
          payment_method: body.payment_method || "cash",
          received_at: now,
          sync_status: "pending_create",
          created_at: now,
          updated_at: now,
        }
    : null
  const payment =
    paidAmount > 0
      ? {
            id: createOfflineId("payment"),
            organization_id: organizationId,
            party_type: "customer",
            party_id: body.customer_id,
            document_type: "sales_invoice",
            document_id: invoiceId,
            amount: paidAmount,
            direction: "in",
            payment_method: body.payment_method || "cash",
            reference_no: invoiceNumber,
            payment_date: now.slice(0, 10),
            cleared_at: now,
            sync_status: "pending_create",
            created_at: now,
            updated_at: now,
          }
      : null
  const batchDeltas = consumedBatches.nextBatches.flatMap((batch) => {
    const previous = batches.find((candidate) => candidate.id === batch.id)
    const quantity = Math.max(0, localNumber(previous?.quantity) - localNumber(batch.quantity))
    return batch.id && quantity > 0 ? [{ batchId: String(batch.id), quantity, updatedAt: now }] : []
  })

  await createNormalizedInvoiceAtomic({
    organizationId,
    invoice: invoiceRecord,
    items: nextItems,
    productDeltas: Array.from(quantityByProduct.entries()).map(([productId, quantity]) => ({ productId, quantity, updatedAt: now })),
    inventoryDeltas: consumedBatches.allocations.map(({ productId, warehouseId, batchId, quantity }) => ({
      productId,
      warehouseId: warehouseId || localString(products.find((product) => product.id === productId)?.warehouse_id) || null,
      batchId,
      quantity,
      updatedAt: now,
    })),
    batchDeltas,
    movements: nextMovements,
    ledgerEntries: nextLedger,
    receipt,
    payment,
    customerId: localString(body.customer_id),
    customerSalesDelta: totalAmount,
    customerBalanceDelta: outstandingAmount,
    invoiceSequence,
  })

  return ok({ invoice_id: invoiceId, invoice_number: invoiceNumber })
}

async function updateInvoiceStatus(body: DataRow, organizationId: string) {
  const invoiceId = localString(body.invoice_id)
  const paymentStatus = localString(body.payment_status || body.status)
  if (!invoiceId || !paymentStatus) return fail("Invalid invoice status update.", 422)
  const now = nowIso()
  const updated = await updateNormalizedInvoicePaymentStatus(organizationId, invoiceId, paymentStatus, now)
  if (!updated) return fail("Invoice was not found.", 404)
  return ok({ invoiceId, payment_status: paymentStatus })
}

async function deleteInvoice(body: DataRow, organizationId: string) {
  const invoiceId = localString(body.invoice_id)
  if (!invoiceId || body.confirmation !== "DELETE") return fail("Type DELETE to confirm invoice deletion.", 422)
  const now = nowIso()
  const context = await readNormalizedInvoiceDeletionContext(organizationId, invoiceId)
  if (!context) return fail("Invoice was not found.", 404)
  const { invoice, items, movements, products } = context
  const invoiceQuantityByProduct = new Map<string, number>()
  for (const item of items) {
    const productId = localString(item.product_id)
    if (productId) {
      invoiceQuantityByProduct.set(
        productId,
        (invoiceQuantityByProduct.get(productId) || 0) + localNumber(item.quantity)
      )
    }
  }
  const alreadyRestoredByProduct = new Map<string, number>()
  for (const movement of movements) {
    if (localString(movement.reference_type) !== "invoice_delete") continue
    const productId = localString(movement.product_id)
    if (productId) {
      alreadyRestoredByProduct.set(
        productId,
        (alreadyRestoredByProduct.get(productId) || 0) + Math.max(0, localNumber(movement.quantity))
      )
    }
  }
  const restoreQuantityByProduct = new Map(
    Array.from(invoiceQuantityByProduct.entries()).map(([productId, quantity]) => [
      productId,
      Math.max(0, quantity - (alreadyRestoredByProduct.get(productId) || 0)),
    ])
  )
  const restoredByBatch = new Map<string, number>()
  for (const movement of movements) {
    if (localString(movement.reference_type) !== "invoice_delete") continue
    const batchId = localString(movement.batch_id)
    if (batchId) restoredByBatch.set(batchId, (restoredByBatch.get(batchId) || 0) + Math.max(0, localNumber(movement.quantity)))
  }
  const batchRestoreById = new Map<string, number>()
  const restoreAllocations: BatchAllocation[] = []
  for (const [productId, restoreQuantity] of restoreQuantityByProduct.entries()) {
    let remaining = restoreQuantity
    const saleMovements = movements.filter(
      (movement) =>
        localString(movement.reference_type) === "invoice" &&
        localString(movement.product_id) === productId &&
        localNumber(movement.quantity) < 0
    )
    for (const movement of saleMovements) {
      if (remaining <= 0) break
      const batchId = localString(movement.batch_id)
      if (!batchId) continue
      const unrestored = Math.max(0, Math.abs(localNumber(movement.quantity)) - (restoredByBatch.get(batchId) || 0))
      const quantity = Math.min(remaining, unrestored)
      if (quantity <= 0) continue
      remaining -= quantity
      batchRestoreById.set(batchId, (batchRestoreById.get(batchId) || 0) + quantity)
      restoreAllocations.push({ productId, batchId, warehouseId: localString(movement.warehouse_id) || null, quantity })
    }
    if (remaining > 0) restoreAllocations.push({ productId, batchId: null, warehouseId: null, quantity: remaining })
  }
  const runningRestoreStock = new Map(products.map((product) => [String(product.id || ""), localNumber(product.stock)]))
  const restoreMovements = restoreAllocations.map(({ productId, batchId, warehouseId, quantity }) => {
      const product = products.find((row) => row.id === productId)
      const previousStock = runningRestoreStock.get(productId) ?? localNumber(product?.stock)
      const newStock = previousStock + quantity
      runningRestoreStock.set(productId, newStock)
      return {
        id: createOfflineId("stock-movement"),
        organization_id: organizationId,
        product_id: productId,
        product_name: product?.name || "",
        type: "adjustment",
        quantity,
        previous_stock: previousStock,
        new_stock: newStock,
        batch_id: batchId,
        warehouse_id: warehouseId || product?.warehouse_id || null,
        reason: `Invoice ${invoice.invoice_number || invoiceId} deleted and stock restored`,
        reference_no: invoice.invoice_number || invoiceId,
        reference_type: "invoice_delete",
        reference_id: invoiceId,
        sync_status: "pending_create",
        created_at: now,
        updated_at: now,
      }
    })
  const outstandingAmount = localNumber(invoice.outstanding_amount, Math.max(0, localNumber(invoice.grand_total, localNumber(invoice.total_amount, localNumber(invoice.total))) - localNumber(invoice.paid_amount)))
  const invoiceTotal = localNumber(invoice.grand_total, localNumber(invoice.total_amount, localNumber(invoice.total)))

  await deleteNormalizedInvoiceAtomic({
    organizationId,
    invoiceId,
    customerId: localString(invoice.customer_id) || null,
    invoiceTotal,
    outstandingAmount,
    lastPurchaseAt: context.latestCustomerInvoice
      ? localString(
          context.latestCustomerInvoice.invoice_date,
          localString(context.latestCustomerInvoice.date, localString(context.latestCustomerInvoice.created_at))
        ) || null
      : null,
    productDeltas: Array.from(restoreQuantityByProduct.entries()).flatMap(([productId, quantity]) =>
      quantity > 0 ? [{ productId, quantity, updatedAt: now }] : []
    ),
    inventoryDeltas: restoreAllocations.map(({ productId, warehouseId, batchId, quantity }) => ({
      productId,
      warehouseId: warehouseId || localString(products.find((product) => product.id === productId)?.warehouse_id) || null,
      batchId,
      quantity,
      updatedAt: now,
    })),
    batchDeltas: Array.from(batchRestoreById.entries()).map(([batchId, quantity]) => ({ batchId, quantity, updatedAt: now })),
    restoreMovements,
    deletedAt: now,
  })
  return ok({ invoiceId, restoredItems: items.length })
}

function normalizedCommercialItems(items: DataRow[], documentId: string, organizationId: string, ownerKey: string) {
  const now = nowIso()
  return items.map((item) => {
    const quantity = Math.max(0, localNumber(item.quantity))
    const unitPrice = Math.max(0, localNumber(item.unit_price, localNumber(item.price)))
    const base = quantity * unitPrice
    const taxRate = Math.max(0, localNumber(item.tax_rate, localNumber(item.tax_percent, localNumber(item.gst))))
    const taxAmount = localNumber(item.tax_amount, base * (taxRate / 100))
    return {
      ...item,
      id: createOfflineId(`${ownerKey}-item`),
      organization_id: organizationId,
      [ownerKey]: documentId,
      product_id: localString(item.product_id),
      description: localString(item.description, localString(item.product_name, localString(item.name))),
      quantity,
      unit_price: unitPrice,
      tax_rate: taxRate,
      tax_percent: taxRate,
      tax_amount: moneyValue(taxAmount),
      line_total: moneyValue(localNumber(item.line_total, base + taxAmount)),
      sync_status: "pending_create",
      created_at: now,
      updated_at: now,
    }
  })
}

function moneyValue(value: number) {
  return Math.round(value * 100) / 100
}

async function listQuotations(url: URL, organizationId: string) {
  const search = url.searchParams.get("search") || ""
  let rows = filterDeleted(await readCollection<DataRow>(organizationId, "quotations"))
  rows = rows.filter((row) => rowMatches(row, ["quote_number", "status", "notes"], search))
  rows = sortRows(rows, url.searchParams.get("sort") || "created_at", url.searchParams.get("direction") || "desc")
  return jsonResponse(paginate(url, rows))
}

async function createQuotation(body: DataRow, organizationId: string) {
  const now = nowIso()
  const items = Array.isArray(body.items) ? (body.items as DataRow[]) : []
  if (!items.length) return fail("Quotation requires at least one item.", 422)
  const [quotations, quotationItems] = await Promise.all([
    readCollection<DataRow>(organizationId, "quotations"),
    readCollection<DataRow>(organizationId, "quotation_items"),
  ])
  const quotationId = createOfflineId("quotation")
  const nextItems = normalizedCommercialItems(items, quotationId, organizationId, "quotation_id")
  const subtotal = moneyValue(localNumber(body.subtotal, nextItems.reduce((sum, item) => sum + localNumber(item.quantity) * localNumber(item.unit_price), 0)))
  const taxTotal = moneyValue(localNumber(body.tax_total, nextItems.reduce((sum, item) => sum + localNumber(item.tax_amount), 0)))
  const discountTotal = moneyValue(localNumber(body.discount_total, localNumber(body.discount_amount)))
  const grandTotal = moneyValue(localNumber(body.grand_total, subtotal - discountTotal + taxTotal))
  const quotation = {
    ...body,
    id: quotationId,
    organization_id: organizationId,
    quote_number: localString(body.quote_number, nextLocalDocumentNumber("QTN", quotations, "quote_number")),
    status: localString(body.status, "draft"),
    subtotal,
    discount_total: discountTotal,
    tax_total: taxTotal,
    grand_total: grandTotal,
    sync_status: "pending_create",
    created_at: now,
    updated_at: now,
  }
  await writeCollections(organizationId, [
    { collection: "quotations", value: [quotation, ...quotations] },
    { collection: "quotation_items", value: [...nextItems, ...quotationItems] },
  ])
  await queueProfessionalAction("create_quotation", organizationId, { quotation: body, result: { quotation_id: quotationId, quote_number: quotation.quote_number } })
  return ok({ quotation_id: quotationId, quote_number: quotation.quote_number, grand_total: grandTotal })
}

async function listDeliveryChallans(url: URL, organizationId: string) {
  const search = url.searchParams.get("search") || ""
  let rows = filterDeleted(await readCollection<DataRow>(organizationId, "delivery_challans"))
  rows = rows.filter((row) => rowMatches(row, ["challan_number", "status", "notes"], search))
  rows = sortRows(rows, url.searchParams.get("sort") || "created_at", url.searchParams.get("direction") || "desc")
  return jsonResponse(paginate(url, rows))
}

async function createDeliveryChallan(body: DataRow, organizationId: string) {
  const now = nowIso()
  const items = Array.isArray(body.items) ? (body.items as DataRow[]) : []
  if (!items.length) return fail("Delivery challan requires at least one item.", 422)
  const [challans, challanItems, products, movements] = await Promise.all([
    readCollection<DataRow>(organizationId, "delivery_challans"),
    readCollection<DataRow>(organizationId, "delivery_challan_items"),
    readCollection<DataRow>(organizationId, "products"),
    readCollection<DataRow>(organizationId, "stock_movements"),
  ])
  const quantityByProduct = new Map<string, number>()
  items.forEach((item) => {
    const productId = localString(item.product_id)
    if (productId) quantityByProduct.set(productId, (quantityByProduct.get(productId) || 0) + localNumber(item.quantity))
  })
  for (const [productId, quantity] of quantityByProduct) {
    const product = products.find((row) => row.id === productId)
    if (!product) return fail("One or more products were not found.", 404)
    if (localNumber(product.stock) < quantity) return fail(`${product.name || "Product"} has only ${localNumber(product.stock)} in stock.`, 409)
  }
  const challanId = createOfflineId("challan")
  const challanNumber = localString(body.challan_number, nextLocalDocumentNumber("DC", challans, "challan_number"))
  const nextItems: DataRow[] = items.map((item) => ({
    ...item,
    id: createOfflineId("challan-item"),
    organization_id: organizationId,
    challan_id: challanId,
    description: localString(item.description, localString(item.product_name, localString(item.name))),
    quantity: localNumber(item.quantity),
    sync_status: "pending_create",
    created_at: now,
    updated_at: now,
  }))
  const nextProducts = products.map((product) => {
    const quantity = quantityByProduct.get(String(product.id || "")) || 0
    return quantity > 0 ? { ...product, stock: localNumber(product.stock) - quantity, sync_status: "pending_update", updated_at: now } : product
  })
  const nextMovements = [
    ...Array.from(quantityByProduct.entries()).map(([productId, quantity]) => {
      const product = products.find((row) => row.id === productId)
      const previousStock = localNumber(product?.stock)
      return {
        id: createOfflineId("stock-movement"),
        organization_id: organizationId,
        product_id: productId,
        product_name: product?.name || "",
        type: "delivery_challan",
        quantity: -quantity,
        previous_stock: previousStock,
        new_stock: previousStock - quantity,
        reason: `Delivery challan ${challanNumber}`,
        reference_no: challanNumber,
        reference_type: "delivery_challan",
        reference_id: challanId,
        sync_status: "pending_create",
        created_at: now,
        updated_at: now,
      }
    }),
    ...movements,
  ]
  const challan = {
    ...body,
    id: challanId,
    organization_id: organizationId,
    challan_number: challanNumber,
    challan_date: localString(body.challan_date, now.slice(0, 10)),
    status: localString(body.status, "delivered"),
    sync_status: "pending_create",
    created_at: now,
    updated_at: now,
  }
  await writeCollections(organizationId, [
    { collection: "products", value: nextProducts },
    { collection: "inventory_items", value: nextProducts },
    { collection: "stock_movements", value: nextMovements },
    { collection: "delivery_challans", value: [challan, ...challans] },
    { collection: "delivery_challan_items", value: [...nextItems, ...challanItems] },
  ])
  await queueProfessionalAction("create_delivery_challan", organizationId, { challan: body, result: { challan_id: challanId, challan_number: challanNumber } })
  return ok({ challan_id: challanId, challan_number: challanNumber })
}

async function createProformaInvoice(body: DataRow, organizationId: string) {
  const now = nowIso()
  const items = Array.isArray(body.items) ? (body.items as DataRow[]) : []
  if (!items.length) return fail("Proforma invoice requires at least one item.", 422)
  const [invoices, invoiceItems, customers] = await Promise.all([
    readCollection<DataRow>(organizationId, "invoices"),
    readCollection<DataRow>(organizationId, "invoice_items"),
    readCollection<DataRow>(organizationId, "customers"),
  ])
  const invoiceId = createOfflineId("proforma")
  const nextItems: DataRow[] = items.map((item) => ({
    ...item,
    id: createOfflineId("invoice-item"),
    organization_id: organizationId,
    invoice_id: invoiceId,
    sync_status: "pending_create",
    created_at: now,
    updated_at: now,
  }))
  const taxTotal = localNumber(body.tax_total, nextItemsTax(items))
  const totalAmount = localNumber(body.total_amount, localNumber(body.grand_total, nextItems.reduce((sum, item) => sum + localNumber(item.line_total), 0)))
  const customer = customers.find((row) => row.id === body.customer_id)
  const invoiceNumber = localString(body.invoice_number, nextLocalDocumentNumber("PRO", invoices, "invoice_number"))
  const invoice = {
    ...body,
    id: invoiceId,
    organization_id: organizationId,
    customer_name: localString(body.customer_name, localString(customer?.name, "Customer")),
    invoice_number: invoiceNumber,
    invoice_type: "proforma",
    invoice_date: localString(body.invoice_date, now.slice(0, 10)),
    date: localString(body.date, now.slice(0, 10)),
    tax_total: taxTotal,
    tax_amount: taxTotal,
    total_amount: totalAmount,
    grand_total: totalAmount,
    total: totalAmount,
    paid_amount: 0,
    outstanding_amount: 0,
    payment_status: "draft",
    status: "draft",
    sync_status: "pending_create",
    created_at: now,
    updated_at: now,
  }
  await writeCollections(organizationId, [
    { collection: "invoices", value: [invoice, ...invoices] },
    { collection: "invoice_items", value: [...nextItems, ...invoiceItems] },
  ])
  await queueProfessionalAction("create_proforma_invoice", organizationId, { invoice: body, result: { invoice_id: invoiceId, invoice_number: invoiceNumber } })
  return ok({ invoice_id: invoiceId, invoice_number: invoiceNumber, invoice_type: "proforma" })
}

async function stockMovement(body: DataRow, organizationId: string) {
  const productId = localString(body.product_id)
  const quantity = localNumber(body.quantity)
  const mode = body.mode === "transfer" ? "transfer" : "add"
  if (!productId || quantity <= 0) return fail("Invalid stock movement.", 422)
  const result = await createInventoryMovement(organizationId, {
    ...body,
    product_id: productId,
    quantity,
    type: mode === "transfer" ? "stock_transfer" : "stock_in",
    target_warehouse_id: mode === "transfer" ? body.warehouse_id || null : undefined,
    reason: mode === "transfer" ? "Inventory moved to selected warehouse" : "Manual stock addition",
  })
  return ok({
    productId,
    previousStock: result.previous_stock,
    newStock: result.new_stock,
    movementCount: result.movement_count,
  })
}

async function listPurchases(url: URL, organizationId: string) {
  const search = url.searchParams.get("search") || ""
  const kind = url.searchParams.get("kind") || "all"
  let rows = filterDeleted(await readCollection<DataRow>(organizationId, "purchase_invoices"))
  rows = rows.filter((row) => (kind === "all" ? true : row.invoice_kind === kind))
  rows = rows.filter((row) => rowMatches(row, ["bill_number", "supplier_name", "status", "invoice_kind", "notes"], search))
  rows = sortRows(rows, url.searchParams.get("sort") || "created_at", url.searchParams.get("direction") || "desc")
  return jsonResponse(paginate(url, rows))
}

async function purchaseCreate(body: DataRow, organizationId: string, kind: "purchase_invoice" | "purchase_return" | "purchase_order" | "goods_received") {
  const result = await createPurchaseDocument(organizationId, body, kind)
  const actionType =
    kind === "purchase_return"
      ? "create_purchase_return"
      : kind === "purchase_order"
        ? "create_purchase_order"
        : kind === "goods_received"
          ? "create_goods_received"
          : "create_purchase"
  await queueProfessionalAction(actionType, organizationId, { kind, purchase: body, result })
  return ok(result)
}

async function listPayments(url: URL, organizationId: string) {
  const search = url.searchParams.get("search") || ""
  const paymentDirection = url.searchParams.get("payment_direction") || "all"
  let rows = filterDeleted(await readCollection<DataRow>(organizationId, "payments"))
  rows = rows.filter((row) => (paymentDirection === "all" ? true : row.direction === paymentDirection))
  rows = rows.filter((row) => rowMatches(row, ["party_type", "payment_method", "reference_no", "notes"], search))
  rows = sortRows(rows, url.searchParams.get("sort") || "created_at", url.searchParams.get("direction") || "desc")
  return jsonResponse(paginate(url, rows))
}

async function paymentCreate(body: DataRow, organizationId: string) {
  const result = await createPaymentTransaction(
    organizationId,
    body,
    pendingAction(createOfflineId("create_payment-action"), "create_payment", organizationId, { payment: body })
  )
  return ok(result)
}

async function listChartOfAccounts(url: URL, organizationId: string) {
  const search = url.searchParams.get("search") || ""
  let rows = await ensureDefaultChartOfAccounts(organizationId)
  rows = rows.filter((row) => rowMatches(row, ["account_code", "account_name", "account_type", "account_group"], search))
  rows = sortRows(rows, url.searchParams.get("sort") || "account_code", url.searchParams.get("direction") || "asc")
  return jsonResponse(paginate(url, rows))
}

async function saveChartAccount(body: DataRow, organizationId: string) {
  const now = nowIso()
  const accounts = await ensureDefaultChartOfAccounts(organizationId)
  const id = localString(body.id) || createOfflineId("account")
  const account = {
    ...accounts.find((row) => row.id === id),
    ...body,
    id,
    organization_id: organizationId,
    account_code: localString(body.account_code, localString(body.code, `ACC-${Date.now()}`)),
    account_name: localString(body.account_name, localString(body.name, "Account")),
    account_type: localString(body.account_type, localString(body.type, "asset")),
    account_group: localString(body.account_group, localString(body.group)),
    normal_balance: localString(body.normal_balance, "debit"),
    is_active: body.is_active === undefined ? true : Boolean(body.is_active),
    sync_status: "pending_update",
    created_at: localString(body.created_at) || now,
    updated_at: now,
    deleted_at: null,
  }
  await writeCollections(organizationId, [{ collection: "chart_of_accounts", value: [account, ...accounts.filter((row) => row.id !== id)] }])
  return ok({ account })
}

async function listBankAccounts(url: URL, organizationId: string) {
  const search = url.searchParams.get("search") || ""
  let rows = filterDeleted(await readCollection<DataRow>(organizationId, "bank_accounts"))
  rows = rows.filter((row) => rowMatches(row, ["bank_name", "branch_name", "account_number", "ifsc_code"], search))
  rows = sortRows(rows, url.searchParams.get("sort") || "created_at", url.searchParams.get("direction") || "desc")
  return jsonResponse(paginate(url, rows))
}

async function saveBankAccount(body: DataRow, organizationId: string) {
  const now = nowIso()
  const rows = await readCollection<DataRow>(organizationId, "bank_accounts")
  const id = localString(body.id) || createOfflineId("bank-account")
  const account = {
    ...rows.find((row) => row.id === id),
    ...body,
    id,
    organization_id: organizationId,
    bank_name: localString(body.bank_name, localString(body.name, "Bank")),
    is_active: body.is_active === undefined ? true : Boolean(body.is_active),
    sync_status: "pending_update",
    created_at: localString(body.created_at) || now,
    updated_at: now,
    deleted_at: null,
  }
  await writeCollections(organizationId, [{ collection: "bank_accounts", value: [account, ...rows.filter((row) => row.id !== id)] }])
  return ok({ bank_account: account })
}

async function listAccountingVouchers(url: URL, organizationId: string) {
  const search = url.searchParams.get("search") || ""
  const kind = url.searchParams.get("type") || "all"
  let rows = filterDeleted(await readCollection<DataRow>(organizationId, "accounting_vouchers"))
  rows = rows.filter((row) => (kind === "all" ? true : row.voucher_type === kind))
  rows = rows.filter((row) => rowMatches(row, ["voucher_number", "voucher_type", "reference_no", "narration"], search))
  rows = sortRows(rows, url.searchParams.get("sort") || "voucher_date", url.searchParams.get("direction") || "desc")
  return jsonResponse(paginate(url, rows))
}

async function createVoucher(body: DataRow, organizationId: string) {
  const result = await createAccountingVoucher(organizationId, body)
  await queueProfessionalAction("create_accounting_voucher", organizationId, { voucher: body, result })
  return ok(result)
}

async function noteCreate(body: DataRow, organizationId: string, kind: "credit" | "debit") {
  const result = kind === "credit" ? await createCreditNote(organizationId, body) : await createDebitNote(organizationId, body)
  await queueProfessionalAction(kind === "credit" ? "create_credit_note" : "create_debit_note", organizationId, { note: body, result })
  return ok(result)
}

async function listExpenses(url: URL, organizationId: string) {
  const search = url.searchParams.get("search") || ""
  const category = url.searchParams.get("category") || "all"
  let rows = filterDeleted(await readCollection<DataRow>(organizationId, "expenses"))
  rows = rows.filter((row) => (category === "all" ? true : row.category === category))
  rows = rows.filter((row) => rowMatches(row, ["category", "description", "payment_method", "reference_no"], search))
  rows = sortRows(rows, url.searchParams.get("sort") || "created_at", url.searchParams.get("direction") || "desc")
  return jsonResponse(paginate(url, rows))
}

async function expenseCreate(body: DataRow, organizationId: string) {
  const result = await createExpenseRecord(organizationId, body)
  await queueProfessionalAction("create_expense", organizationId, { expense: body, result })
  return ok(result)
}

async function professionalInventoryMovement(body: DataRow, organizationId: string) {
  const result = await createInventoryMovement(
    organizationId,
    body,
    pendingAction(createOfflineId("stock_movement-action"), "stock_movement", organizationId, { movement: body })
  )
  return ok(result)
}

async function localReport(url: URL, organizationId: string) {
  if (url.searchParams.get("type") === "analytics-dashboard") {
    return jsonResponse({ success: true, report: await queryNormalizedAnalyticsReport(organizationId) })
  }
  const report = await getOfflineReport(organizationId, url.searchParams.get("type") || "dashboard", {
    start: url.searchParams.get("start"),
    end: url.searchParams.get("end"),
    account_type: url.searchParams.get("account_type"),
    account_id: url.searchParams.get("account_id"),
  })
  if (url.searchParams.get("format") === "csv") {
    const candidate = report as DataRow
    const rows = (Array.isArray(candidate.rows)
      ? candidate.rows
      : Array.isArray(candidate.entries)
        ? candidate.entries
        : Array.isArray(candidate.invoices)
          ? candidate.invoices
          : Array.isArray(candidate.purchases)
            ? candidate.purchases
            : Array.isArray(candidate.items)
              ? candidate.items
              : []) as DataRow[]
    return csvResponse(`${url.searchParams.get("type") || "report"}.csv`, rows)
  }
  return jsonResponse({ success: true, report })
}

async function verifyBackup(body: DataRow, organizationId: string) {
  const result = await verifyLocalBackup(organizationId, body)
  await queueProfessionalAction("create_backup_manifest", organizationId, { backup_name: body.backup_name, manifest: result.manifest })
  return ok(result as Record<string, unknown>)
}

async function databaseIntegrity(organizationId: string) {
  return jsonResponse({ success: true, integrity: await runProfessionalIntegrityChecks(organizationId) })
}

async function localWorkspaceBootstrap() {
  const workspace = getCachedWorkspaceBootstrap() || (await restoreLicensedWorkspaceContext().catch(() => null))
  if (!workspace?.success) return fail("Activation required. Enter a valid Bezgrow license to use desktop mode.", 403)
  return ok(workspace as unknown as Record<string, unknown>)
}

async function dashboardSummary(organizationId: string) {
  const workspace = getCachedWorkspaceBootstrap()
  const summary = await queryNormalizedDashboardSummary(organizationId)
  return jsonResponse({
    workspace: {
      organizationId,
      organizationName: workspace?.organization?.name || workspace?.organization?.id || "Business",
      currency: workspace?.currency || workspace?.organization?.currency || "INR",
      timezone: workspace?.timezone || workspace?.organization?.timezone || "Asia/Kolkata",
      locale: workspace?.locale || workspace?.organization?.locale || "en-IN",
      features: workspace?.features || [],
    },
    ...summary,
    warnings: [],
  })
}

async function billingSummary(organizationId: string) {
  return jsonResponse(await queryNormalizedBillingSummary(organizationId))
}

async function updateOrganization(body: DataRow, organizationId: string) {
  const currentSettings = await getOfflineData<DataRow>(organizationId, "settings", {})
  const currentOrganization = (currentSettings.organization && typeof currentSettings.organization === "object" ? currentSettings.organization : {}) as DataRow
  const normalizedBody = {
    ...body,
    ...(localString(body.name) ? { business_name: localString(body.name) } : {}),
  }
  const organization = {
    ...currentOrganization,
    ...normalizedBody,
    id: organizationId,
    organization_id: organizationId,
    updated_at: nowIso(),
  }
  await writeCollections(
    organizationId,
    [
      { collection: "organization", value: organization },
      { collection: "settings", value: { ...currentSettings, organization_id: organizationId, organization, updated_at: nowIso() } },
    ],
    pendingAction(createOfflineId("settings-action"), "save_settings", organizationId, { kind: "organization", data: normalizedBody })
  )
  return ok({ organizationId })
}

async function toggleFeature(body: DataRow, organizationId: string) {
  const currentSettings = await getOfflineData<DataRow>(organizationId, "settings", {})
  const auditLogs = await readCollection<DataRow>(organizationId, "audit_logs")
  const features = Array.isArray(currentSettings.features) ? ([...currentSettings.features] as DataRow[]) : []
  const featureKey = localString(body.feature_key)
  if (!featureKey) return fail("Invalid feature toggle.", 422)
  const existing = features.find((feature) => feature.feature_key === featureKey)
  const nextFeatures = existing
    ? features.map((feature) => (feature.feature_key === featureKey ? { ...feature, is_enabled: body.is_enabled === true } : feature))
    : [...features, { organization_id: organizationId, feature_key: featureKey, is_enabled: body.is_enabled === true }]
  const changedAt = nowIso()
  await writeCollections(
    organizationId,
    [
      { collection: "settings", value: { ...currentSettings, organization_id: organizationId, features: nextFeatures, updated_at: changedAt } },
      {
        collection: "audit_logs",
        value: [
          {
            id: createOfflineId("audit"),
            organization_id: organizationId,
            action: "settings.feature_toggled",
            entity_type: "feature_flag",
            entity_id: featureKey,
            description: `${featureKey} ${body.is_enabled === true ? "enabled" : "disabled"} on this device`,
            sync_status: "pending_create",
            created_at: changedAt,
            updated_at: changedAt,
          },
          ...auditLogs,
        ],
      },
    ],
    pendingAction(createOfflineId("feature-action"), "save_settings", organizationId, {
      kind: "feature",
      data: { feature_key: featureKey, is_enabled: body.is_enabled === true },
    })
  )
  return ok({ feature_key: featureKey, is_enabled: body.is_enabled === true })
}

async function shouldHandleLocalApi() {
  const mode = await localFirstRepositoryAdapter.mode()
  if (mode === "sqlite") return true
  if (await isTauriRuntimeAsync().catch(() => false)) return true
  if (typeof window === "undefined") return false

  try {
    const localDesktopHost = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)
    const hasDesktopAuthMarker = document.cookie
      .split(";")
      .map((cookie) => cookie.trim())
      .includes("bezgrow_desktop_auth=1")
    if (!localDesktopHost || !hasDesktopAuthMarker) return false
    if (!localStorage.getItem("bezgrow:device-id") && !localStorage.getItem("bezgrow:offline-workspace")) return false
  } catch {
    return false
  }

  const license = await localLicenseSnapshot().catch(() => null)
  return Boolean(license?.allowed)
}

function userSafeLocalError(error: unknown) {
  if (error instanceof LocalDatabaseUnavailableError) {
    return "Bezgrow local database could not start. Restart the desktop app and try again. If this continues, export diagnostics before making more changes."
  }
  const message = error instanceof Error ? error.message : "Local database request failed."
  if (/unique constraint.*products.*sku/i.test(message)) return "A product with this SKU already exists."
  if (/constraint|sqlite|sql plugin|database is locked|transaction/i.test(message)) {
    return "The local database could not save this change. Nothing was changed; please try again."
  }
  return message
}

export async function localApiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<LocalApiResult> {
  const url = normalizeUrl(input)
  if (!dailyEndpoints.has(url.pathname)) return { handled: false, response: null }

  try {
    if (!(await shouldHandleLocalApi())) return { handled: false, response: null }

    const method = (init.method || "GET").toUpperCase()
    const body = await requestBody(init)

    if (method === "GET" && url.pathname === "/api/workspace/bootstrap") return { handled: true, response: await localWorkspaceBootstrap() }

    const organizationId = await organizationIdFor(url, body)
    if (!organizationId) return { handled: false, response: null }
    if (isLicenseRestrictedEndpoint(url.pathname, method)) {
      await assertLocalWriteAllowed(organizationId, url.pathname)
    }

    if (method === "GET" && url.pathname === "/api/dashboard/summary") return { handled: true, response: await dashboardSummary(organizationId) }
    if (method === "GET" && url.pathname === "/api/dashboard/billing/summary") return { handled: true, response: await billingSummary(organizationId) }
    if (method === "GET" && url.pathname === "/api/products/list") return { handled: true, response: await listProducts(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/products/create") return { handled: true, response: await saveProduct(url, body || {}, false, organizationId) }
    if (method === "POST" && url.pathname === "/api/products/update") return { handled: true, response: await saveProduct(url, body || {}, true, organizationId) }
    if (method === "POST" && url.pathname === "/api/products/archive") return { handled: true, response: await archiveProduct(body || {}, organizationId) }
    if (method === "GET" && url.pathname === "/api/customers/list") return { handled: true, response: await listCustomers(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/customers/save") return { handled: true, response: await saveCustomer(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/customers/status") return { handled: true, response: await customerStatus(body || {}, organizationId) }
    if (method === "GET" && url.pathname === "/api/suppliers/list") return { handled: true, response: await listSuppliers(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/suppliers/save") return { handled: true, response: await saveSupplier(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/suppliers/status") return { handled: true, response: await supplierStatus(body || {}, organizationId) }
    if (method === "GET" && url.pathname === "/api/suppliers/ledger") return { handled: true, response: await supplierLedger(url, organizationId) }
    if (method === "GET" && url.pathname === "/api/invoices/list") return { handled: true, response: await listInvoices(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/invoices/create") return { handled: true, response: await createInvoice(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/invoices/update-status") return { handled: true, response: await updateInvoiceStatus(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/invoices/delete-with-stock-restore") return { handled: true, response: await deleteInvoice(body || {}, organizationId) }
    if (method === "GET" && url.pathname === "/api/purchases/list") return { handled: true, response: await listPurchases(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/purchases/create") return { handled: true, response: await purchaseCreate(body || {}, organizationId, "purchase_invoice") }
    if (method === "POST" && url.pathname === "/api/purchases/return") return { handled: true, response: await purchaseCreate(body || {}, organizationId, "purchase_return") }
    if (method === "POST" && url.pathname === "/api/purchases/order") return { handled: true, response: await purchaseCreate(body || {}, organizationId, "purchase_order") }
    if (method === "POST" && url.pathname === "/api/purchases/goods-received") return { handled: true, response: await purchaseCreate(body || {}, organizationId, "goods_received") }
    if (method === "POST" && url.pathname === "/api/purchases/supplier-payment") return { handled: true, response: await paymentCreate({ ...(body || {}), party_type: "supplier", payment_type: "cash_payment", direction: "out" }, organizationId) }
    if (method === "GET" && url.pathname === "/api/quotations/list") return { handled: true, response: await listQuotations(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/quotations/create") return { handled: true, response: await createQuotation(body || {}, organizationId) }
    if (method === "GET" && url.pathname === "/api/delivery-challans/list") return { handled: true, response: await listDeliveryChallans(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/delivery-challans/create") return { handled: true, response: await createDeliveryChallan(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/sales/proforma/create") return { handled: true, response: await createProformaInvoice(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/sales/returns/create") return { handled: true, response: await noteCreate(body || {}, organizationId, "credit") }
    if (method === "GET" && url.pathname === "/api/payments/list") return { handled: true, response: await listPayments(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/payments/create") return { handled: true, response: await paymentCreate(body || {}, organizationId) }
    if (method === "GET" && url.pathname === "/api/accounting/chart") return { handled: true, response: await listChartOfAccounts(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/accounting/chart/save") return { handled: true, response: await saveChartAccount(body || {}, organizationId) }
    if (method === "GET" && url.pathname === "/api/accounting/bank-accounts") return { handled: true, response: await listBankAccounts(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/accounting/bank-accounts/save") return { handled: true, response: await saveBankAccount(body || {}, organizationId) }
    if (method === "GET" && url.pathname === "/api/accounting/vouchers") return { handled: true, response: await listAccountingVouchers(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/accounting/vouchers/create") return { handled: true, response: await createVoucher(body || {}, organizationId) }
    if (method === "GET" && url.pathname === "/api/accounting/reports") return { handled: true, response: await localReport(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/notes/credit") return { handled: true, response: await noteCreate(body || {}, organizationId, "credit") }
    if (method === "POST" && url.pathname === "/api/notes/debit") return { handled: true, response: await noteCreate(body || {}, organizationId, "debit") }
    if (method === "GET" && url.pathname === "/api/expenses/list") return { handled: true, response: await listExpenses(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/expenses/create") return { handled: true, response: await expenseCreate(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/inventory/simple-movement") return { handled: true, response: await stockMovement(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/inventory/professional-movement") return { handled: true, response: await professionalInventoryMovement(body || {}, organizationId) }
    if (method === "GET" && url.pathname === "/api/reports/local") return { handled: true, response: await localReport(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/backup/verify") return { handled: true, response: await verifyBackup(body || {}, organizationId) }
    if (method === "GET" && url.pathname === "/api/database/integrity") return { handled: true, response: await databaseIntegrity(organizationId) }
    if (method === "POST" && url.pathname === "/api/settings/update-organization") return { handled: true, response: await updateOrganization(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/settings/toggle-feature") return { handled: true, response: await toggleFeature(body || {}, organizationId) }
  } catch (error) {
    await databaseManager.recordOperationFailure(
      `local_api:${(init.method || "GET").toUpperCase()}:${url.pathname}`,
      error,
      `${(init.method || "GET").toUpperCase()} ${url.pathname}`
    )
    const message = userSafeLocalError(error)
    return { handled: true, response: fail(message, isLicenseError(message) ? 403 : 500) }
  }

  return { handled: false, response: null }
}
