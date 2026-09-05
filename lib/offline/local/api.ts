"use client"

import { isDesktopRuntime, isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { createOfflineId, getCachedWorkspaceBootstrap, getOfflineData, putOfflineData, type OfflineAction, type OfflineCollection } from "@/lib/offline/db"
import { isLicenseRestrictedEndpoint } from "@/lib/license/policy"
import { localFirstRepositoryAdapter } from "@/lib/offline/local/adapters"
import {
  createCreditNote,
  createDebitNote,
  createInventoryMovement,
  createPaymentTransaction,
  createPurchaseDocument,
  deleteSupplierMaster,
  getOfflineReport,
  rowsToCsv,
  runProfessionalIntegrityChecks,
  supplierLedgerSummary,
  verifyLocalBackup,
} from "@/lib/offline/local/erp"
import { assertLocalWriteAllowed, localLicenseSnapshot, restoreLicensedWorkspaceContext } from "@/lib/offline/local/license"
import {
  archiveNormalizedProductAtomic,
  createNormalizedInvoiceAtomic,
  deleteNormalizedInvoiceAtomic,
  findNormalizedCustomerById,
  findNormalizedProductById,
  findNormalizedProductBySku,
  putNormalizedCollectionsInTransaction,
  queryNormalizedAnalyticsReport,
  queryNormalizedBillingSummary,
  queryNormalizedCustomers,
  queryNormalizedDashboardSummary,
  queryNormalizedInvoices,
  queryNormalizedProducts,
  readNormalizedInvoiceCreationContext,
  readNormalizedInvoiceDeletionContext,
  saveNormalizedCustomerAtomic,
  saveNormalizedProductAtomic,
  updateNormalizedCustomerStatusAtomic,
  type NormalizedListPage,
  type NormalizedListQuery,
} from "@/lib/offline/local/repositories"
import { getLocalDatabaseService, LocalDatabaseUnavailableError } from "@/lib/offline/local/service"
import { FinancialYearDomainError, isoLocalDate, normalizeLocalDate, type InvoiceNumberingMode } from "@/lib/financial-years"
import { allocateAuthoritativeStock } from "@/lib/inventory-availability"
import { buildReversalJournal, buildSaleJournal, splitOutputGst } from "@/lib/accounting/journal"
import { minorToMoney, moneyToMinor, multiplyMoneyToMinor } from "@/lib/accounting/money"
import { accountingAccounts, accountingIntegrity, accountingReport, accountingStatus, createAccountingExpense, deactivateAccountingAccount, initializeAccounting, loadPostedSourceJournal, postManualJournal, replaceAccountingExpense, reverseAccountingExpense, reverseJournal, saveAccountingAccount, systemAccountMap } from "@/lib/offline/local/accounting"
import {
  applyPartyAdvance,
  createPartyPayment,
  createPurchase as createAccountingPurchase,
  createSalesCreditNote,
  lockAccountingPeriod,
  phaseTwoAccountingReport,
  phaseTwoReferenceData,
  reversePurchase,
  saveBankAccount as saveAccountingBankAccount,
  savePurchaseAttachment,
  saveSupplier as saveAccountingSupplier,
  unlockAccountingPeriod,
  updateBankReconciliation,
} from "@/lib/offline/local/accounting-phase2"
import {
  assertFinancialYearWriteAllowed,
  closeFinancialYear,
  createNextFinancialYear,
  customerFinancialYearLedger,
  financialYearClosingChecks,
  financialYearSummary,
  getFinancialYear,
  listFinancialYears,
  reopenFinancialYear,
  setFinancialYearNumberingMode,
} from "@/lib/offline/local/financial-years"

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
  "/api/purchases/reverse",
  "/api/purchases/attachments/save",
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
  "/api/accounting/chart/deactivate",
  "/api/accounting/status",
  "/api/accounting/initialize",
  "/api/accounting/bank-accounts",
  "/api/accounting/bank-accounts/save",
  "/api/accounting/bank-reconciliation/save",
  "/api/accounting/reference-data",
  "/api/accounting/advances/apply",
  "/api/accounting/period-lock",
  "/api/accounting/period-unlock",
  "/api/accounting/vouchers",
  "/api/accounting/vouchers/create",
  "/api/accounting/vouchers/reverse",
  "/api/accounting/reports",
  "/api/accounting/integrity",
  "/api/notes/credit",
  "/api/notes/debit",
  "/api/expenses/list",
  "/api/expenses/create",
  "/api/expenses/reverse",
  "/api/expenses/replace",
  "/api/inventory/simple-movement",
  "/api/inventory/professional-movement",
  "/api/reports/local",
  "/api/backup/verify",
  "/api/database/integrity",
  "/api/settings/update-organization",
  "/api/settings/toggle-feature",
  "/api/financial-years/list",
  "/api/financial-years/summary",
  "/api/financial-years/closing-checks",
  "/api/financial-years/create-next",
  "/api/financial-years/close",
  "/api/financial-years/reopen",
  "/api/financial-years/numbering",
  "/api/customers/financial-year-ledger",
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

function fail(message: string, status = 400, code?: string) {
  return jsonResponse({ success: false, error: message, ...(code ? { code } : {}) }, status)
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
    financialYearId: url.searchParams.get("financial_year_id") || undefined,
  }
}

const datedMutationKeys: Record<string, string[]> = {
  "/api/invoices/create": ["invoice_date", "date"],
  "/api/purchases/create": ["bill_date"],
  "/api/purchases/return": ["bill_date"],
  "/api/purchases/order": ["bill_date"],
  "/api/purchases/goods-received": ["bill_date"],
  "/api/purchases/supplier-payment": ["payment_date"],
  "/api/purchases/reverse": ["reversal_date"],
  "/api/quotations/create": ["created_at"],
  "/api/delivery-challans/create": ["challan_date"],
  "/api/sales/proforma/create": ["invoice_date", "date"],
  "/api/sales/returns/create": ["note_date"],
  "/api/payments/create": ["payment_date"],
  "/api/accounting/advances/apply": ["allocation_date"],
  "/api/accounting/bank-accounts/save": ["opening_date"],
  "/api/accounting/vouchers/create": ["voucher_date"],
  "/api/accounting/vouchers/reverse": ["reversal_date"],
  "/api/notes/credit": ["note_date"],
  "/api/notes/debit": ["note_date"],
  "/api/expenses/create": ["expense_date"],
  "/api/expenses/reverse": ["reversal_date"],
  "/api/expenses/replace": ["expense_date"],
  "/api/inventory/simple-movement": ["movement_date"],
  "/api/inventory/professional-movement": ["movement_date"],
}

async function applyDatedMutationFinancialYear(pathname: string, body: DataRow, organizationId: string) {
  const keys = datedMutationKeys[pathname]
  if (!keys) return null
  const rawDate = keys.map((key) => localString(body[key])).find(Boolean) || isoLocalDate()
  const date = normalizeLocalDate(rawDate)
  const requested = localString(body.financial_year_id)
  const year = await assertFinancialYearWriteAllowed(organizationId, date, requested || null)
  body.financial_year_id = year.id
  const primaryKey = keys[0]
  if (!body[primaryKey]) body[primaryKey] = date
  return year
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

function filterSelectedFinancialYear<T extends DataRow>(url: URL, rows: T[]) {
  const financialYearIdValue = url.searchParams.get("financial_year_id")
  return financialYearIdValue ? rows.filter((row) => row.financial_year_id === financialYearIdValue) : rows
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
  const id = isUpdate ? localString(body.id) : createOfflineId("product")
  if (!id) return fail("Invalid product id.", 422)
  if (!localString(body.name)) return fail("Product name is required.", 422)
  const sku = localString(body.sku).toLowerCase()
  if (sku && (await findNormalizedProductBySku(organizationId, sku, id))) {
    return fail("A product with this SKU already exists.", 409)
  }
  if (body.stock !== undefined) {
    const parsedStock = Number(body.stock)
    if (!Number.isFinite(parsedStock)) return fail("Opening stock must be a valid number.", 422)
    if (parsedStock < 0) return fail("Opening stock cannot be negative.", 422)
  }

  const previous = isUpdate ? await findNormalizedProductById(organizationId, id) : null
  if (isUpdate && !previous) return fail("Product was not found.", 404)
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
  const stockDifference = stock - localNumber(previous?.stock)
  const stockMovement = stockDifference === 0
    ? null
    : {
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
      }

  const product = await saveNormalizedProductAtomic(organizationId, payload, stockMovement)
  if (typeof window !== "undefined") window.dispatchEvent(new Event("bezgrow:offline-data-changed"))
  return ok({ product })
}

async function archiveProduct(body: DataRow, organizationId: string) {
  const id = localString(body.id)
  if (!id) return fail("Invalid product id.", 422)
  const now = nowIso()
  if (!(await findNormalizedProductById(organizationId, id))) return fail("Product was not found.", 404)
  await archiveNormalizedProductAtomic(organizationId, id, now)
  if (typeof window !== "undefined") window.dispatchEvent(new Event("bezgrow:offline-data-changed"))
  return ok({ product: { id } })
}

async function listCustomers(url: URL, organizationId: string) {
  return localListResponse("customers", url, organizationId, await queryNormalizedCustomers(organizationId, normalizedListQuery(url)))
}

async function saveCustomer(body: DataRow, organizationId: string) {
  const now = nowIso()
  const id = localString(body.id) || createOfflineId("customer")
  if (!localString(body.name)) return fail("Customer name is required.", 422)
  if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(localString(body.email))) return fail("Enter a valid customer email address.", 422)
  const previous = body.id ? await findNormalizedCustomerById(organizationId, id) : null
  if (body.id && !previous) return fail("Customer was not found.", 404)
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
  const customer = await saveNormalizedCustomerAtomic(organizationId, nextCustomer)
  if (typeof window !== "undefined") window.dispatchEvent(new Event("bezgrow:offline-data-changed"))
  return ok({ id, customer })
}

async function customerStatus(body: DataRow, organizationId: string) {
  const id = localString(body.id)
  if (!id) return fail("Invalid customer status request.", 422)
  const now = nowIso()
  const archive = body.archive === true
  const active = archive ? false : body.active !== undefined ? Boolean(body.active) : true
  if (!(await findNormalizedCustomerById(organizationId, id))) return fail("Customer was not found.", 404)
  await updateNormalizedCustomerStatusAtomic(organizationId, id, active, archive, now)
  if (typeof window !== "undefined") window.dispatchEvent(new Event("bezgrow:offline-data-changed"))
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
  return ok(await saveAccountingSupplier(organizationId, body))
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

async function createInvoice(body: DataRow, organizationId: string) {
  const now = nowIso()
  const invoiceDate = normalizeLocalDate(localString(body.invoice_date || body.date, isoLocalDate()))
  const financialYear = await assertFinancialYearWriteAllowed(organizationId, invoiceDate, localString(body.financial_year_id) || null)
  await initializeAccounting(organizationId, invoiceDate)
  const items = Array.isArray(body.items) ? (body.items as DataRow[]) : []
  if (!items.length) return fail("Invalid invoice.", 422)

  const offlineClientId = localString(body.offline_client_id) || createOfflineId("invoice-client")
  const productIds = items.map((item) => localString(item.product_id)).filter(Boolean)
  const context = await readNormalizedInvoiceCreationContext(
    organizationId,
    localString(body.customer_id),
    productIds,
    offlineClientId,
    invoiceDate,
    financialYear.id
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
  const databaseInvoiceNumber = context.databaseInvoiceNumber
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
    invoice_number: databaseInvoiceNumber,
    display_invoice_number: invoiceNumber,
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
    date: invoiceDate,
    invoice_date: invoiceDate,
    financial_year_id: financialYear.id,
    offline_client_id: offlineClientId,
    sync_status: "pending_create",
    created_at: now,
    updated_at: now,
  }
  let nextItems: DataRow[] = items.map((item) => {
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
  let consumedBatches: ReturnType<typeof allocateAuthoritativeStock>
  try {
    consumedBatches = allocateAuthoritativeStock(products, batches, items, now)
  } catch (error) {
    return fail(error instanceof Error ? error.message : "The selected stock batch is unavailable.", 409)
  }
  const costByAllocation = consumedBatches.allocations.map((allocation) => {
    const product = products.find((row) => row.id === allocation.productId)
    const batch = allocation.batchId ? batches.find((row) => row.id === allocation.batchId) : null
    const recordedRate = batch?.purchase_rate !== null && batch?.purchase_rate !== undefined && String(batch.purchase_rate) !== ""
      ? batch.purchase_rate
      : product?.purchase_rate !== null && product?.purchase_rate !== undefined && String(product.purchase_rate) !== ""
        ? product.purchase_rate
        : null
    return {
      ...allocation,
      unitCostMinor: recordedRate === null ? null : moneyToMinor(recordedRate, `Recorded cost for ${localString(product?.name, allocation.productId)}`),
      totalCostMinor: recordedRate === null ? null : multiplyMoneyToMinor(allocation.quantity, recordedRate, `Recorded cost for ${localString(product?.name, allocation.productId)}`),
    }
  })
  const productCost = new Map<string, { knownMinor: number; quantity: number; missing: boolean }>()
  for (const allocation of costByAllocation) {
    const current = productCost.get(allocation.productId) || { knownMinor: 0, quantity: 0, missing: false }
    current.quantity += allocation.quantity
    current.knownMinor += allocation.totalCostMinor || 0
    current.missing ||= allocation.totalCostMinor === null
    productCost.set(allocation.productId, current)
  }
  const assignedCost = new Map<string, number>()
  const itemCountByProduct = new Map<string, number>()
  const itemIndexByProduct = new Map<string, number>()
  for (const item of nextItems) itemCountByProduct.set(localString(item.product_id), (itemCountByProduct.get(localString(item.product_id)) || 0) + 1)
  const intraState = !(localString(context.organization?.state) && localString(customer.state) && localString(context.organization?.state).toUpperCase() !== localString(customer.state).toUpperCase())
  nextItems = nextItems.map((item) => {
    const productId = localString(item.product_id)
    const cost = productCost.get(productId) || { knownMinor: 0, quantity: 0, missing: true }
    const currentIndex = (itemIndexByProduct.get(productId) || 0) + 1
    itemIndexByProduct.set(productId, currentIndex)
    const alreadyAssigned = assignedCost.get(productId) || 0
    const isLast = currentIndex === (itemCountByProduct.get(productId) || 1)
    const costAmountMinor = isLast
      ? cost.knownMinor - alreadyAssigned
      : Math.round(cost.knownMinor * (Math.max(0, localNumber(item.quantity)) / Math.max(cost.quantity, 0.000001)))
    assignedCost.set(productId, alreadyAssigned + costAmountMinor)
    const itemTax = moneyToMinor(localNumber(item.gst_amount, localNumber(item.tax_amount)), "Invoice line GST")
    const hasExplicitItemGst = ["cgst_amount", "sgst_amount", "igst_amount"].some((key) => Object.prototype.hasOwnProperty.call(item, key))
    const explicitItemGst = {
      cgstMinor: moneyToMinor(item.cgst_amount || 0, "Invoice line CGST"),
      sgstMinor: moneyToMinor(item.sgst_amount || 0, "Invoice line SGST"),
      igstMinor: moneyToMinor(item.igst_amount || 0, "Invoice line IGST"),
    }
    const gst = hasExplicitItemGst && explicitItemGst.cgstMinor + explicitItemGst.sgstMinor + explicitItemGst.igstMinor === itemTax
      ? { ...explicitItemGst, mode: explicitItemGst.igstMinor ? "INTER_STATE" as const : "INTRA_STATE" as const }
      : splitOutputGst(itemTax, intraState ? "SAME" : "ORIGIN", intraState ? "SAME" : "DESTINATION")
    const cessMinor = moneyToMinor(item.cess_amount || 0, "Invoice line cess")
    const lineTotalMinor = moneyToMinor(item.line_total ?? 0, "Invoice line total")
    return {
      ...item,
      cost_rate_minor: cost.quantity > 0 ? Math.round(cost.knownMinor / cost.quantity) : null,
      cost_amount_minor: costAmountMinor,
      cost_status: cost.missing ? (cost.knownMinor > 0 ? "PARTIAL" : "MISSING") : "RECORDED",
      cgst_amount: minorToMoney(gst.cgstMinor),
      sgst_amount: minorToMoney(gst.sgstMinor),
      igst_amount: minorToMoney(gst.igstMinor),
      taxable_minor: Math.max(0, lineTotalMinor - gst.cgstMinor - gst.sgstMinor - gst.igstMinor - cessMinor),
      cgst_minor: gst.cgstMinor,
      sgst_minor: gst.sgstMinor,
      igst_minor: gst.igstMinor,
      cess_minor: cessMinor,
      gst_rate_basis_points: moneyToMinor(item.tax_percent ?? item.gst ?? 0, "Invoice line GST rate"),
    }
  })
  const cogsMinor = Array.from(productCost.values()).reduce((sum, cost) => sum + cost.knownMinor, 0)
  const accountingWarnings = Array.from(productCost.entries()).flatMap(([productId, cost]) => cost.missing
    ? [{
        id: `accounting-warning:${organizationId}:invoice-cost:${invoiceId}:${productId}`,
        productId,
        message: `${localString(products.find((row) => row.id === productId)?.name, "Product")} had sold quantity without a recorded purchase cost on ${invoiceNumber}. COGS includes only genuine recorded cost.`,
      }]
    : [])
  const accounts = await systemAccountMap(organizationId)
  const discountMinor = moneyToMinor(localNumber(body.discount_total, localNumber(body.discount_amount)), "Invoice discount")
  const taxableMinor = moneyToMinor(taxableAmount, "Invoice taxable amount")
  const explicitGst = {
    cgstMinor: moneyToMinor(body.cgst_amount ?? nextItems.reduce((sum, item) => sum + localNumber(item.cgst_amount), 0), "Invoice CGST"),
    sgstMinor: moneyToMinor(body.sgst_amount ?? nextItems.reduce((sum, item) => sum + localNumber(item.sgst_amount), 0), "Invoice SGST"),
    igstMinor: moneyToMinor(body.igst_amount ?? nextItems.reduce((sum, item) => sum + localNumber(item.igst_amount), 0), "Invoice IGST"),
  }
  const taxMinor = moneyToMinor(taxTotal, "Invoice GST")
  const hasExplicitGst = explicitGst.cgstMinor + explicitGst.sgstMinor + explicitGst.igstMinor === taxMinor
  Object.assign(invoiceRecord, {
    taxable_minor: taxableMinor,
    cgst_minor: explicitGst.cgstMinor,
    sgst_minor: explicitGst.sgstMinor,
    igst_minor: explicitGst.igstMinor,
    cess_minor: moneyToMinor(body.cess_amount || 0, "Invoice cess"),
    grand_total_minor: moneyToMinor(totalAmount, "Invoice total"),
    paid_minor: moneyToMinor(paidAmount, "Invoice paid amount"),
    outstanding_minor: moneyToMinor(outstandingAmount, "Invoice outstanding amount"),
    place_of_supply: localString(body.place_of_supply, localString(customer.state)) || null,
    customer_gstin: localString(body.customer_gstin, localString(customer.gst_number)) || null,
    supply_type: intraState ? "INTRA_STATE" : "INTER_STATE",
    transaction_type: localString(body.customer_gstin, localString(customer.gst_number)) ? "B2B" : "B2C",
    tax_category: localString(body.tax_category, "TAXABLE"),
  })
  const journal = buildSaleJournal({
    id: createOfflineId("sale-voucher"), organizationId, financialYearId: financialYear.id,
    voucherNumber: `SALE-${invoiceNumber}`, voucherType: "sale", voucherDate: invoiceDate,
    sourceType: "SALES_INVOICE", sourceId: invoiceId, referenceNo: invoiceNumber,
    narration: `Sales invoice ${invoiceNumber}`, systemGenerated: true, accounts,
    customerId: localString(body.customer_id),
    paymentAccountRole: ["bank", "bank_transfer"].includes(localString(body.payment_method).toLowerCase()) ? "BANK" : "CASH",
    subtotalMinor: taxableMinor + discountMinor,
    discountMinor,
    taxableMinor,
    taxMinor,
    totalMinor: moneyToMinor(totalAmount, "Invoice total"),
    paidMinor: moneyToMinor(paidAmount, "Invoice paid amount"),
    organizationState: localString(context.organization?.state) || null,
    customerState: localString(customer.state) || null,
    cogsMinor,
    gstSplit: hasExplicitGst ? explicitGst : undefined,
  }).journal
  const runningStock = new Map(products.map((product) => [String(product.id || ""), localNumber(product.stock)]))
  const nextMovements = costByAllocation.map(({ productId, batchId, warehouseId, quantity, unitCostMinor, totalCostMinor }) => {
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
        movement_date: invoiceDate,
        financial_year_id: financialYear.id,
        unit_cost_minor: unitCostMinor,
        total_cost_minor: totalCostMinor,
        cost_status: totalCostMinor === null ? "MISSING" : "RECORDED",
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
        entry_date: invoiceDate,
        financial_year_id: financialYear.id,
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
        entry_date: invoiceDate,
        financial_year_id: financialYear.id,
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
            entry_date: invoiceDate,
            financial_year_id: financialYear.id,
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
            entry_date: invoiceDate,
            financial_year_id: financialYear.id,
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
            entry_date: invoiceDate,
            financial_year_id: financialYear.id,
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
          received_at: `${invoiceDate}T12:00:00`,
          financial_year_id: financialYear.id,
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
            payment_date: invoiceDate,
            financial_year_id: financialYear.id,
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
    numberingMode: context.numberingMode as "CONTINUE" | "RESTART",
    financialYearId: financialYear.id,
    journal,
    accountingWarnings,
  })

  return ok({ invoice_id: invoiceId, invoice_number: invoiceNumber })
}

async function updateInvoiceStatus(body: DataRow, organizationId: string) {
  const invoiceId = localString(body.invoice_id)
  const paymentStatus = localString(body.payment_status || body.status)
  if (!invoiceId || !paymentStatus) return fail("Invalid invoice status update.", 422)
  const [invoice] = await databaseManager.select<DataRow>(
    `SELECT financial_year_id, customer_id, COALESCE(outstanding_amount, 0) outstanding_amount
     FROM sales_invoices WHERE organization_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1`,
    [organizationId, invoiceId]
  )
  if (!invoice) return fail("Invoice was not found.", 404)
  if (invoice?.financial_year_id) {
    const year = await getFinancialYear(organizationId, String(invoice.financial_year_id))
    if (year?.status !== "OPEN") return fail(`${year?.label || "This financial year"} is closed. Invoice status cannot be edited.`, 409)
  }
  if (paymentStatus !== "paid") {
    return fail("Payment status is derived from posted receipts. Record a receipt to settle an invoice; reverse the receipt to undo it.", 409)
  }
  const amount = localNumber(invoice.outstanding_amount)
  if (amount <= 0) return ok({ invoiceId, payment_status: "paid", idempotent: true })
  const paymentDate = isoLocalDate()
  const financialYear = await assertFinancialYearWriteAllowed(organizationId, paymentDate)
  const result = await createPaymentTransaction(organizationId, {
    amount,
    direction: "in",
    payment_type: "customer_receipt",
    payment_method: body.payment_method || "cash",
    party_type: "customer",
    party_id: invoice.customer_id,
    document_type: "sales_invoice",
    document_id: invoiceId,
    payment_date: paymentDate,
    financial_year_id: financialYear.id,
    reference_no: body.reference_no || null,
    notes: "Invoice marked paid through an auditable receipt.",
    idempotency_key: `invoice-status-paid:${invoiceId}`,
  })
  return ok({ invoiceId, payment_status: "paid", ...result })
}

async function deleteInvoice(body: DataRow, organizationId: string) {
  const invoiceId = localString(body.invoice_id)
  if (!invoiceId || body.confirmation !== "DELETE") return fail("Type DELETE to confirm invoice deletion.", 422)
  const now = nowIso()
  const context = await readNormalizedInvoiceDeletionContext(organizationId, invoiceId)
  if (!context) return fail("Invoice was not found.", 404)
  const { invoice, items, movements, products } = context
  if (invoice.financial_year_id) {
    const year = await getFinancialYear(organizationId, String(invoice.financial_year_id))
    if (year?.status !== "OPEN") return fail(`${year?.label || "This financial year"} is closed. Historical invoices cannot be deleted.`, 409)
  }
  const originalJournal = await loadPostedSourceJournal(organizationId, "SALES_INVOICE", invoiceId)
  if (!originalJournal) {
    return fail("This invoice predates the controlled accounting opening and cannot be deleted automatically. Preserve it as history and post a reviewed adjustment if needed.", 409)
  }
  const reversalDate = normalizeLocalDate(isoLocalDate())
  const reversalYear = await assertFinancialYearWriteAllowed(organizationId, reversalDate)
  const reversalJournal = buildReversalJournal(originalJournal, {
    id: createOfflineId("sale-reversal"),
    voucherNumber: `REV-${originalJournal.voucherNumber}`,
    voucherDate: reversalDate,
    financialYearId: reversalYear.id,
    sourceType: "SALES_INVOICE_REVERSAL",
    sourceId: invoiceId,
    narration: `Invoice ${localString(invoice.display_invoice_number, localString(invoice.invoice_number, invoiceId))} cancelled with stock restoration.`,
    createdBy: null,
  })
  const invoicePayments = await databaseManager.select<DataRow>(
    "SELECT id FROM payments WHERE organization_id = ? AND document_type = 'sales_invoice' AND document_id = ? AND deleted_at IS NULL",
    [organizationId, invoiceId]
  )
  const receiptOriginals = (await Promise.all(invoicePayments.map((payment) => loadPostedSourceJournal(organizationId, "PAYMENT", localString(payment.id))))).filter((journal): journal is NonNullable<typeof journal> => Boolean(journal))
  const receiptReversals = receiptOriginals.map((journal) => buildReversalJournal(journal, {
    id: createOfflineId("receipt-reversal"), voucherNumber: `REV-${journal.voucherNumber}`, voucherDate: reversalDate,
    financialYearId: reversalYear.id, sourceType: "PAYMENT_REVERSAL", sourceId: journal.sourceId,
    narration: `Receipt reversed because invoice ${localString(invoice.display_invoice_number, localString(invoice.invoice_number, invoiceId))} was cancelled.`,
    createdBy: null,
  }))
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
  const restoreAllocations: Array<{ productId: string; batchId: string | null; warehouseId: string | null; quantity: number }> = []
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
    reversalJournals: [reversalJournal, ...receiptReversals],
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
  let rows = filterSelectedFinancialYear(url, filterDeleted(await readCollection<DataRow>(organizationId, "quotations")))
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
  let rows = filterSelectedFinancialYear(url, filterDeleted(await readCollection<DataRow>(organizationId, "delivery_challans")))
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
  let rows = filterSelectedFinancialYear(url, filterDeleted(await readCollection<DataRow>(organizationId, "purchase_invoices")))
  rows = rows.filter((row) => (kind === "all" ? true : row.invoice_kind === kind))
  rows = rows.filter((row) => rowMatches(row, ["bill_number", "supplier_name", "status", "invoice_kind", "notes"], search))
  rows = sortRows(rows, url.searchParams.get("sort") || "created_at", url.searchParams.get("direction") || "desc")
  return jsonResponse(paginate(url, rows))
}

async function purchaseCreate(body: DataRow, organizationId: string, kind: "purchase_invoice" | "purchase_return" | "purchase_order" | "goods_received") {
  if (kind === "purchase_invoice" || kind === "purchase_return") {
    return ok(await createAccountingPurchase(organizationId, body, kind))
  }
  const result = await createPurchaseDocument(organizationId, body, kind)
  const actionType =
    kind === "purchase_order"
      ? "create_purchase_order"
      : "create_goods_received"
  await queueProfessionalAction(actionType, organizationId, { kind, purchase: body, result })
  return ok(result)
}

async function listPayments(url: URL, organizationId: string) {
  const search = url.searchParams.get("search") || ""
  const paymentDirection = url.searchParams.get("payment_direction") || "all"
  let rows = filterSelectedFinancialYear(url, filterDeleted(await readCollection<DataRow>(organizationId, "payments")))
  rows = rows.filter((row) => (paymentDirection === "all" ? true : row.direction === paymentDirection))
  rows = rows.filter((row) => rowMatches(row, ["party_type", "payment_method", "reference_no", "notes"], search))
  rows = sortRows(rows, url.searchParams.get("sort") || "created_at", url.searchParams.get("direction") || "desc")
  return jsonResponse(paginate(url, rows))
}

async function paymentCreate(body: DataRow, organizationId: string) {
  const partyType = localString(body.party_type)
  if (partyType === "supplier" || partyType === "customer") {
    return ok(await createPartyPayment(organizationId, body, partyType))
  }
  const result = await createPaymentTransaction(
    organizationId,
    body,
    pendingAction(createOfflineId("create_payment-action"), "create_payment", organizationId, { payment: body })
  )
  return ok(result)
}

async function listChartOfAccounts(url: URL, organizationId: string) {
  const search = url.searchParams.get("search") || ""
  let rows = await accountingAccounts(organizationId, url.searchParams.get("include_inactive") === "true")
  rows = rows.filter((row) => rowMatches(row, ["account_code", "account_name", "account_type", "account_group"], search))
  rows = sortRows(rows, url.searchParams.get("sort") || "account_code", url.searchParams.get("direction") || "asc")
  return jsonResponse(paginate(url, rows))
}

async function saveChartAccount(body: DataRow, organizationId: string) {
  const id = await saveAccountingAccount({
    organizationId,
    id: localString(body.id) || undefined,
    accountCode: localString(body.account_code, localString(body.code)),
    accountName: localString(body.account_name, localString(body.name)),
    accountType: localString(body.account_type, localString(body.type, "EXPENSE")).toUpperCase() as "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE",
    accountGroup: localString(body.account_group, localString(body.group)),
    normalBalance: localString(body.normal_balance, "debit").toLowerCase() as "debit" | "credit",
    notes: localString(body.notes),
  })
  return ok({ account_id: id })
}

async function deactivateChartAccount(body: DataRow, organizationId: string) {
  const id = localString(body.id || body.account_id)
  if (!id) return fail("Account id is required.", 422)
  return ok({ account_id: id, ...(await deactivateAccountingAccount(organizationId, id)) })
}

async function listBankAccounts(url: URL, organizationId: string) {
  const search = url.searchParams.get("search") || ""
  let rows = filterDeleted(await readCollection<DataRow>(organizationId, "bank_accounts"))
  rows = rows.filter((row) => rowMatches(row, ["bank_name", "branch_name", "account_number", "ifsc_code"], search))
  rows = sortRows(rows, url.searchParams.get("sort") || "created_at", url.searchParams.get("direction") || "desc")
  return jsonResponse(paginate(url, rows.map((row) => ({
    ...row,
    account_number: undefined,
    masked_identifier: row.masked_identifier || (localString(row.account_number) ? `•••• ${localString(row.account_number).slice(-4)}` : "Not provided"),
  }))))
}

async function saveBankAccount(body: DataRow, organizationId: string) {
  return ok(await saveAccountingBankAccount(organizationId, body))
}

async function listAccountingVouchers(url: URL, organizationId: string) {
  const search = url.searchParams.get("search") || ""
  const kind = url.searchParams.get("type") || "all"
  let rows = filterSelectedFinancialYear(url, filterDeleted(await readCollection<DataRow>(organizationId, "accounting_vouchers")))
  rows = rows.filter((row) => (kind === "all" ? true : row.voucher_type === kind))
  rows = rows.filter((row) => rowMatches(row, ["voucher_number", "voucher_type", "reference_no", "narration"], search))
  rows = sortRows(rows, url.searchParams.get("sort") || "voucher_date", url.searchParams.get("direction") || "desc")
  return jsonResponse(paginate(url, rows))
}

async function createVoucher(body: DataRow, organizationId: string) {
  const entries = Array.isArray(body.entries) ? body.entries as DataRow[] : []
  const result = await postManualJournal({
    organizationId,
    financialYearId: localString(body.financial_year_id),
    voucherDate: normalizeLocalDate(localString(body.voucher_date || body.date, isoLocalDate())),
    voucherType: localString(body.voucher_type, "journal").toLowerCase() as "journal" | "receipt" | "payment" | "contra" | "opening",
    referenceNo: localString(body.reference_no),
    narration: localString(body.narration, "Manual journal"),
    createdBy: localString(body.created_by),
    lines: entries.map((entry) => ({ accountId: localString(entry.account_id), debit: entry.debit ?? 0, credit: entry.credit ?? 0, description: localString(entry.description) })),
  })
  return ok({ voucher: result })
}

async function noteCreate(body: DataRow, organizationId: string, kind: "credit" | "debit") {
  const result = kind === "credit" ? await createCreditNote(organizationId, body) : await createDebitNote(organizationId, body)
  await queueProfessionalAction(kind === "credit" ? "create_credit_note" : "create_debit_note", organizationId, { note: body, result })
  return ok(result)
}

async function listExpenses(url: URL, organizationId: string) {
  const search = url.searchParams.get("search") || ""
  const category = url.searchParams.get("category") || "all"
  let rows = filterSelectedFinancialYear(url, filterDeleted(await readCollection<DataRow>(organizationId, "expenses")))
  rows = rows.filter((row) => (category === "all" ? true : row.category === category))
  rows = rows.filter((row) => rowMatches(row, ["category", "description", "payment_method", "reference_no"], search))
  rows = sortRows(rows, url.searchParams.get("sort") || "created_at", url.searchParams.get("direction") || "desc")
  return jsonResponse(paginate(url, rows))
}

async function expenseCreate(body: DataRow, organizationId: string) {
  const result = await createAccountingExpense({
    organizationId,
    expenseDate: normalizeLocalDate(localString(body.expense_date || body.date, isoLocalDate())),
    description: localString(body.description, "Expense"),
    vendorName: localString(body.vendor_name), category: localString(body.category),
    expenseAccountId: localString(body.expense_account_id), paymentAccountId: localString(body.payment_account_id),
    amount: body.amount, cgst: body.cgst ?? body.cgst_amount ?? 0, sgst: body.sgst ?? body.sgst_amount ?? 0, igst: body.igst ?? body.igst_amount ?? 0,
    cess: body.cess ?? body.cess_amount ?? 0, taxableValue: body.taxable_value, gstRate: body.gst_rate,
    partyGstin: localString(body.party_gstin, localString(body.gstin)), supplierInvoiceNumber: localString(body.supplier_invoice_number), hsnCode: localString(body.hsn_code),
    placeOfSupply: localString(body.place_of_supply), supplyType: localString(body.supply_type, "INTRA_STATE") as "INTRA_STATE" | "INTER_STATE",
    taxCategory: localString(body.tax_category, "TAXABLE") as "TAXABLE" | "EXEMPT" | "NIL_RATED" | "NON_GST",
    reverseCharge: body.reverse_charge === true || body.reverse_charge === "true", itcStatus: localString(body.itc_status, "REVIEW_REQUIRED") as "ELIGIBLE" | "INELIGIBLE" | "REVIEW_REQUIRED",
    paymentMethod: localString(body.payment_method, "cash"), referenceNo: localString(body.reference_no),
  })
  return ok(result)
}

function accountingExpenseInput(body: DataRow, organizationId: string) {
  return {
    organizationId,
    expenseDate: normalizeLocalDate(localString(body.expense_date || body.date, isoLocalDate())),
    description: localString(body.description, "Expense"), vendorName: localString(body.vendor_name), category: localString(body.category),
    expenseAccountId: localString(body.expense_account_id), paymentAccountId: localString(body.payment_account_id),
    amount: body.amount, cgst: body.cgst ?? body.cgst_amount ?? 0, sgst: body.sgst ?? body.sgst_amount ?? 0, igst: body.igst ?? body.igst_amount ?? 0,
    paymentMethod: localString(body.payment_method, "cash"), referenceNo: localString(body.reference_no),
  }
}

async function expenseReverse(body: DataRow, organizationId: string) {
  const id = localString(body.expense_id || body.id)
  if (!id) return fail("Expense id is required.", 422)
  const voucher = await reverseAccountingExpense(organizationId, id, normalizeLocalDate(localString(body.reversal_date, isoLocalDate())), localString(body.reason))
  return ok({ expense_id: id, reversal_voucher_id: voucher?.id })
}

async function expenseReplace(body: DataRow, organizationId: string) {
  const id = localString(body.expense_id || body.id)
  if (!id) return fail("Expense id is required.", 422)
  return ok(await replaceAccountingExpense(id, accountingExpenseInput(body, organizationId), localString(body.reason)) as DataRow)
}

async function phaseOneAccountingReport(url: URL, organizationId: string) {
  const financialYearId = url.searchParams.get("financial_year_id") || ""
  if (!financialYearId) return fail("Financial year is required.", 422)
  const requested = (url.searchParams.get("report") || url.searchParams.get("type") || "overview").replace("dashboard", "overview")
  const allowed = new Set(["overview", "journals", "general-ledger", "trial-balance", "profit-loss", "balance-sheet", "cash-flow", "expenses", "warnings"])
  if (!allowed.has(requested)) {
    return jsonResponse({ success: true, ...(await phaseTwoAccountingReport({
      organizationId,
      financialYearId,
      report: requested,
      from: url.searchParams.get("from") || undefined,
      to: url.searchParams.get("to") || undefined,
      page: Number(url.searchParams.get("page") || 1),
      limit: Number(url.searchParams.get("limit") || 100),
      search: url.searchParams.get("search") || undefined,
      accountId: url.searchParams.get("account_id") || undefined,
      partyId: url.searchParams.get("party_id") || url.searchParams.get("bank_account_id") || undefined,
      status: url.searchParams.get("status") || undefined,
    })) })
  }
  return jsonResponse({ success: true, ...(await accountingReport({
    organizationId, financialYearId, report: requested as Parameters<typeof accountingReport>[0]["report"],
    from: url.searchParams.get("from") || undefined, to: url.searchParams.get("to") || undefined,
    accountId: url.searchParams.get("account_id") || undefined, page: Number(url.searchParams.get("page") || 1), limit: Number(url.searchParams.get("limit") || 100),
    transactionType: url.searchParams.get("transaction_type") || undefined,
    direction: url.searchParams.get("direction") === "desc" ? "desc" : "asc",
    search: url.searchParams.get("search") || undefined,
  })) })
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
    return jsonResponse({ success: true, report: await queryNormalizedAnalyticsReport(organizationId, url.searchParams.get("financial_year_id")) })
  }
  const report = await getOfflineReport(organizationId, url.searchParams.get("type") || "dashboard", {
    start: url.searchParams.get("start"),
    end: url.searchParams.get("end"),
    account_type: url.searchParams.get("account_type"),
    account_id: url.searchParams.get("account_id"),
    financial_year_id: url.searchParams.get("financial_year_id"),
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

async function financialYearsList(organizationId: string) {
  const years = await listFinancialYears(organizationId)
  return ok({ years, active: years.find((year) => year.is_active) || null })
}

async function financialYearSummaryResponse(url: URL, organizationId: string) {
  const financialYearIdValue = url.searchParams.get("financial_year_id") || ""
  if (!financialYearIdValue) return fail("Financial year is required.", 422)
  const year = await getFinancialYear(organizationId, financialYearIdValue)
  if (!year) return fail("Financial year was not found.", 404)
  return ok({ year, summary: await financialYearSummary(organizationId, financialYearIdValue) })
}

async function financialYearClosingChecksResponse(url: URL, organizationId: string) {
  const financialYearIdValue = url.searchParams.get("financial_year_id") || ""
  if (!financialYearIdValue) return fail("Financial year is required.", 422)
  return ok({ checks: await financialYearClosingChecks(organizationId, financialYearIdValue) })
}

async function financialYearCreateNext(body: DataRow, organizationId: string) {
  const sourceId = localString(body.source_financial_year_id || body.financial_year_id)
  if (!sourceId) return fail("Source financial year is required.", 422)
  return ok(await createNextFinancialYear(organizationId, sourceId) as unknown as Record<string, unknown>)
}

async function financialYearClose(body: DataRow, organizationId: string) {
  const financialYearIdValue = localString(body.financial_year_id)
  if (!financialYearIdValue) return fail("Financial year is required.", 422)
  return ok(await closeFinancialYear(organizationId, financialYearIdValue, localString(body.confirmation)) as unknown as Record<string, unknown>)
}

async function financialYearReopen(body: DataRow, organizationId: string) {
  const financialYearIdValue = localString(body.financial_year_id)
  if (!financialYearIdValue) return fail("Financial year is required.", 422)
  return ok(await reopenFinancialYear(organizationId, financialYearIdValue, localString(body.confirmation), localString(body.reason)) as unknown as Record<string, unknown>)
}

async function financialYearNumbering(body: DataRow, organizationId: string) {
  const financialYearIdValue = localString(body.financial_year_id)
  if (!financialYearIdValue) return fail("Financial year is required.", 422)
  return ok(await setFinancialYearNumberingMode(organizationId, financialYearIdValue, localString(body.mode) as InvoiceNumberingMode) as unknown as Record<string, unknown>)
}

async function customerLedgerByFinancialYear(url: URL, organizationId: string) {
  const customerId = url.searchParams.get("customer_id") || ""
  if (!customerId) return fail("Customer is required.", 422)
  const requestedYear = url.searchParams.get("financial_year_id")
  return ok({ ledger: await customerFinancialYearLedger(organizationId, customerId, requestedYear === "all" ? null : requestedYear) })
}

async function localWorkspaceBootstrap() {
  const workspace = getCachedWorkspaceBootstrap() || (await restoreLicensedWorkspaceContext().catch(() => null))
  if (!workspace?.success) return fail("Activation required. Enter a valid Bezgrow license to use desktop mode.", 403)
  return ok(workspace as unknown as Record<string, unknown>)
}

async function dashboardSummary(url: URL, organizationId: string) {
  const workspace = getCachedWorkspaceBootstrap()
  const summary = await queryNormalizedDashboardSummary(organizationId, url.searchParams.get("financial_year_id"))
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

async function billingSummary(url: URL, organizationId: string) {
  return jsonResponse(await queryNormalizedBillingSummary(organizationId, url.searchParams.get("financial_year_id")))
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

function userSafeLocalError(error: unknown, pathname: string) {
  if (error instanceof LocalDatabaseUnavailableError) {
    return "Bezgrow local database could not start. Restart the desktop app and try again. If this continues, export diagnostics before making more changes."
  }
  const message = error instanceof Error ? error.message : "Local database request failed."
  if (/unique constraint.*products.*sku/i.test(message)) return "A product with this SKU already exists."
  if (isLicenseError(message) || error instanceof FinancialYearDomainError) return message
  if (/\/api\/products\/(?:create|update)/.test(pathname)) {
    return "Bezgrow could not save this product. The local database is temporarily unavailable. Nothing was changed; please retry."
  }
  if (pathname === "/api/customers/save") {
    return "Bezgrow could not save this customer. The local database is temporarily unavailable. Nothing was changed; please retry."
  }
  if ((pathname.startsWith("/api/accounting/") || pathname.startsWith("/api/expenses/")) && !/constraint|sqlite|database is locked|transaction/i.test(message)) {
    return message
  }
  if (/constraint|sqlite|sql plugin|database is locked|transaction/i.test(message)) {
    return "The local database could not save this change. Nothing was changed; please try again."
  }
  return "Bezgrow could not complete this local operation. Nothing was changed; please try again."
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
    if (method === "POST" && body) await applyDatedMutationFinancialYear(url.pathname, body, organizationId)

    if (method === "GET" && url.pathname === "/api/financial-years/list") return { handled: true, response: await financialYearsList(organizationId) }
    if (method === "GET" && url.pathname === "/api/financial-years/summary") return { handled: true, response: await financialYearSummaryResponse(url, organizationId) }
    if (method === "GET" && url.pathname === "/api/financial-years/closing-checks") return { handled: true, response: await financialYearClosingChecksResponse(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/financial-years/create-next") return { handled: true, response: await financialYearCreateNext(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/financial-years/close") return { handled: true, response: await financialYearClose(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/financial-years/reopen") return { handled: true, response: await financialYearReopen(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/financial-years/numbering") return { handled: true, response: await financialYearNumbering(body || {}, organizationId) }
    if (method === "GET" && url.pathname === "/api/customers/financial-year-ledger") return { handled: true, response: await customerLedgerByFinancialYear(url, organizationId) }
    if (method === "GET" && url.pathname === "/api/dashboard/summary") return { handled: true, response: await dashboardSummary(url, organizationId) }
    if (method === "GET" && url.pathname === "/api/dashboard/billing/summary") return { handled: true, response: await billingSummary(url, organizationId) }
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
    if (method === "POST" && url.pathname === "/api/purchases/reverse") return { handled: true, response: ok(await reversePurchase(organizationId, body || {})) }
    if (method === "POST" && url.pathname === "/api/purchases/attachments/save") return { handled: true, response: ok(await savePurchaseAttachment(organizationId, body || {})) }
    if (method === "GET" && url.pathname === "/api/quotations/list") return { handled: true, response: await listQuotations(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/quotations/create") return { handled: true, response: await createQuotation(body || {}, organizationId) }
    if (method === "GET" && url.pathname === "/api/delivery-challans/list") return { handled: true, response: await listDeliveryChallans(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/delivery-challans/create") return { handled: true, response: await createDeliveryChallan(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/sales/proforma/create") return { handled: true, response: await createProformaInvoice(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/sales/returns/create") return { handled: true, response: ok(await createSalesCreditNote(organizationId, body || {})) }
    if (method === "GET" && url.pathname === "/api/payments/list") return { handled: true, response: await listPayments(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/payments/create") return { handled: true, response: await paymentCreate(body || {}, organizationId) }
    if (method === "GET" && url.pathname === "/api/accounting/chart") return { handled: true, response: await listChartOfAccounts(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/accounting/chart/save") return { handled: true, response: await saveChartAccount(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/accounting/chart/deactivate") return { handled: true, response: await deactivateChartAccount(body || {}, organizationId) }
    if (method === "GET" && url.pathname === "/api/accounting/status") return { handled: true, response: ok({ status: await accountingStatus(organizationId) }) }
    if (method === "POST" && url.pathname === "/api/accounting/initialize") return { handled: true, response: ok({ status: await initializeAccounting(organizationId, normalizeLocalDate(localString(body?.opening_date, isoLocalDate()))) }) }
    if (method === "GET" && url.pathname === "/api/accounting/bank-accounts") return { handled: true, response: await listBankAccounts(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/accounting/bank-accounts/save") return { handled: true, response: await saveBankAccount(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/accounting/bank-reconciliation/save") return { handled: true, response: ok(await updateBankReconciliation(organizationId, body || {})) }
    if (method === "GET" && url.pathname === "/api/accounting/reference-data") {
      const financialYearId = url.searchParams.get("financial_year_id") || ""
      if (!financialYearId) return { handled: true, response: fail("Financial year is required.", 422) }
      return { handled: true, response: ok(await phaseTwoReferenceData(organizationId, financialYearId)) }
    }
    if (method === "POST" && url.pathname === "/api/accounting/advances/apply") {
      const partyType = localString(body?.party_type) === "customer" ? "customer" : "supplier"
      return { handled: true, response: ok(await applyPartyAdvance(organizationId, body || {}, partyType)) }
    }
    if (method === "POST" && url.pathname === "/api/accounting/period-lock") return { handled: true, response: ok(await lockAccountingPeriod(organizationId, body || {})) }
    if (method === "POST" && url.pathname === "/api/accounting/period-unlock") return { handled: true, response: ok(await unlockAccountingPeriod(organizationId, body || {})) }
    if (method === "GET" && url.pathname === "/api/accounting/vouchers") return { handled: true, response: await listAccountingVouchers(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/accounting/vouchers/create") return { handled: true, response: await createVoucher(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/accounting/vouchers/reverse") return { handled: true, response: ok({ voucher: await reverseJournal({ organizationId, voucherId: localString(body?.voucher_id), reversalDate: normalizeLocalDate(localString(body?.reversal_date, isoLocalDate())), reason: localString(body?.reason) }) }) }
    if (method === "GET" && url.pathname === "/api/accounting/reports") return { handled: true, response: await phaseOneAccountingReport(url, organizationId) }
    if (method === "GET" && url.pathname === "/api/accounting/integrity") return { handled: true, response: ok({ integrity: await accountingIntegrity(organizationId, url.searchParams.get("financial_year_id")) }) }
    if (method === "POST" && url.pathname === "/api/notes/credit") return { handled: true, response: body?.invoice_id ? ok(await createSalesCreditNote(organizationId, body || {})) : await noteCreate(body || {}, organizationId, "credit") }
    if (method === "POST" && url.pathname === "/api/notes/debit") return { handled: true, response: await noteCreate(body || {}, organizationId, "debit") }
    if (method === "GET" && url.pathname === "/api/expenses/list") return { handled: true, response: await listExpenses(url, organizationId) }
    if (method === "POST" && url.pathname === "/api/expenses/create") return { handled: true, response: await expenseCreate(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/expenses/reverse") return { handled: true, response: await expenseReverse(body || {}, organizationId) }
    if (method === "POST" && url.pathname === "/api/expenses/replace") return { handled: true, response: await expenseReplace(body || {}, organizationId) }
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
    const message = userSafeLocalError(error, url.pathname)
    return {
      handled: true,
      response: fail(
        message,
        isLicenseError(message) ? 403 : error instanceof FinancialYearDomainError ? 409 : 500,
        error instanceof FinancialYearDomainError ? error.code : undefined
      ),
    }
  }

  return { handled: false, response: null }
}
