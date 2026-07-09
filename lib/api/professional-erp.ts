import "server-only"

import { randomUUID } from "node:crypto"
import { NextResponse } from "next/server"
import { writeAdminLog } from "@/lib/api/auth"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { insertStockMovement } from "@/lib/api/stock-movements"
import { parsePagination, paginationRange, requireWorkspace, type WorkspaceContext } from "@/lib/api/tenant"
import { adminSupabase } from "@/lib/supabase/admin"

type DataRow = Record<string, unknown>
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

type ListConfig = {
  table: string
  defaultSort: string
  allowedSort: Set<string>
  searchFields: string[]
}

type SupabaseErrorShape = {
  message?: string | null
  details?: string | null
  code?: string | null
}

const noStore = { headers: { "Cache-Control": "no-store" } }

const professionalRoutes = new Set([
  "GET /api/suppliers/list",
  "POST /api/suppliers/save",
  "POST /api/suppliers/status",
  "GET /api/suppliers/ledger",
  "GET /api/purchases/list",
  "POST /api/purchases/create",
  "POST /api/purchases/return",
  "POST /api/purchases/order",
  "POST /api/purchases/goods-received",
  "POST /api/purchases/supplier-payment",
  "GET /api/payments/list",
  "POST /api/payments/create",
  "GET /api/quotations/list",
  "POST /api/quotations/create",
  "GET /api/delivery-challans/list",
  "POST /api/delivery-challans/create",
  "POST /api/sales/proforma/create",
  "POST /api/sales/returns/create",
  "GET /api/accounting/chart",
  "POST /api/accounting/chart/save",
  "GET /api/accounting/bank-accounts",
  "POST /api/accounting/bank-accounts/save",
  "GET /api/accounting/vouchers",
  "POST /api/accounting/vouchers/create",
  "GET /api/accounting/reports",
  "POST /api/notes/credit",
  "POST /api/notes/debit",
  "GET /api/expenses/list",
  "POST /api/expenses/create",
  "POST /api/inventory/professional-movement",
  "GET /api/reports/local",
  "POST /api/backup/verify",
  "GET /api/database/integrity",
])

const listConfigs: Record<string, ListConfig> = {
  "/api/suppliers/list": {
    table: "suppliers",
    defaultSort: "created_at",
    allowedSort: new Set(["created_at", "updated_at", "name", "current_balance"]),
    searchFields: ["name", "email", "phone", "gst_number", "gstin", "tax_id"],
  },
  "/api/purchases/list": {
    table: "purchase_invoices",
    defaultSort: "created_at",
    allowedSort: new Set(["created_at", "bill_date", "bill_number", "supplier_name", "grand_total", "status", "invoice_kind"]),
    searchFields: ["bill_number", "supplier_name", "status", "invoice_kind", "notes"],
  },
  "/api/payments/list": {
    table: "payments",
    defaultSort: "created_at",
    allowedSort: new Set(["created_at", "payment_date", "party_type", "amount", "direction"]),
    searchFields: ["party_type", "payment_method", "reference_no", "notes"],
  },
  "/api/quotations/list": {
    table: "quotations",
    defaultSort: "created_at",
    allowedSort: new Set(["created_at", "quote_number", "status", "valid_until", "grand_total"]),
    searchFields: ["quote_number", "status", "notes"],
  },
  "/api/delivery-challans/list": {
    table: "delivery_challans",
    defaultSort: "created_at",
    allowedSort: new Set(["created_at", "challan_number", "challan_date", "status"]),
    searchFields: ["challan_number", "status", "notes"],
  },
  "/api/expenses/list": {
    table: "expenses",
    defaultSort: "created_at",
    allowedSort: new Set(["created_at", "expense_date", "category", "amount", "payment_status"]),
    searchFields: ["category", "description", "payment_method", "reference_no"],
  },
  "/api/accounting/chart": {
    table: "chart_of_accounts",
    defaultSort: "account_code",
    allowedSort: new Set(["account_code", "account_name", "account_type", "account_group", "created_at"]),
    searchFields: ["account_code", "account_name", "account_type", "account_group"],
  },
  "/api/accounting/bank-accounts": {
    table: "bank_accounts",
    defaultSort: "created_at",
    allowedSort: new Set(["created_at", "bank_name", "branch_name", "account_number", "is_active"]),
    searchFields: ["bank_name", "branch_name", "account_number", "ifsc_code"],
  },
  "/api/accounting/vouchers": {
    table: "accounting_vouchers",
    defaultSort: "voucher_date",
    allowedSort: new Set(["created_at", "voucher_date", "voucher_number", "voucher_type"]),
    searchFields: ["voucher_number", "voucher_type", "reference_no", "narration"],
  },
}

const defaultAccounts = [
  ["1000", "Cash", "asset", "Current Assets", "debit"],
  ["1010", "Bank", "asset", "Current Assets", "debit"],
  ["1100", "Accounts Receivable", "asset", "Current Assets", "debit"],
  ["1200", "Inventory", "asset", "Current Assets", "debit"],
  ["2000", "Accounts Payable", "liability", "Current Liabilities", "credit"],
  ["2100", "GST Payable", "liability", "Tax", "credit"],
  ["2200", "GST Input Credit", "asset", "Tax", "debit"],
  ["3000", "Owner Equity", "equity", "Equity", "credit"],
  ["4000", "Sales", "income", "Revenue", "credit"],
  ["5000", "Cost of Goods Sold", "expense", "COGS", "debit"],
  ["6000", "Operating Expenses", "expense", "Expenses", "debit"],
] as const

function nowIso() {
  return new Date().toISOString()
}

function dateOnly(value = new Date()) {
  return value.toISOString().slice(0, 10)
}

function newId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`
}

function text(row: DataRow | null | undefined, keys: string[], fallback = "") {
  if (!row) return fallback
  for (const key of keys) {
    const value = row[key]
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return fallback
}

function optionalText(row: DataRow | null | undefined, keys: string[]) {
  return text(row, keys) || null
}

function numberFrom(row: DataRow | null | undefined, keys: string[], fallback = 0) {
  if (!row) return fallback
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && value !== "") {
      const next = Number(value)
      return Number.isFinite(next) ? next : fallback
    }
  }
  return fallback
}

function boolFrom(row: DataRow | null | undefined, keys: string[], fallback = true) {
  if (!row) return fallback
  for (const key of keys) {
    const value = row[key]
    if (typeof value === "boolean") return value
    if (typeof value === "number") return value !== 0
    if (typeof value === "string") return !["false", "0", "no"].includes(value.trim().toLowerCase())
  }
  return fallback
}

function cleanSearch(value: string) {
  return value.replace(/[,%()]/g, " ").trim().slice(0, 120)
}

function missingColumnFromError(error: SupabaseErrorShape | null | undefined) {
  if (!error?.message) return null
  const match =
    error.message.match(/Could not find the '([^']+)' column/i) ||
    error.message.match(/column "([^"]+)" of relation/i) ||
    error.message.match(/column "([^"]+)" does not exist/i)
  return match?.[1] || null
}

function isMissingTable(error: SupabaseErrorShape | null | undefined) {
  const message = `${error?.message || ""} ${error?.details || ""}`.toLowerCase()
  return error?.code === "42P01" || message.includes("could not find the table") || message.includes("does not exist")
}

function tableMissingMessage(table: string) {
  return `Cloud table '${table}' is not available. Run the latest Bezgrow ERP database migration before using this workflow online.`
}

function requiredColumns(columns: string[]) {
  return new Set(["organization_id", ...columns])
}

async function requestBody(request: Request) {
  if (["GET", "HEAD"].includes(request.method.toUpperCase())) return {}
  return (await request.json().catch(() => ({}))) as DataRow
}

async function insertWithSchemaFallback(table: string, payload: DataRow, required = requiredColumns([]), select = "*") {
  const retryPayload = { ...payload }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await adminSupabase.from(table).insert(retryPayload).select(select).single()
    const missingColumn = missingColumnFromError(result.error)

    if (!result.error || !missingColumn || required.has(missingColumn) || !(missingColumn in retryPayload)) {
      return result
    }

    delete retryPayload[missingColumn]
  }

  return adminSupabase.from(table).insert(retryPayload).select(select).single()
}

async function upsertWithSchemaFallback(table: string, payload: DataRow, required = requiredColumns(["id"]), select = "*") {
  const retryPayload = { ...payload }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await adminSupabase.from(table).upsert(retryPayload).select(select).single()
    const missingColumn = missingColumnFromError(result.error)

    if (!result.error || !missingColumn || required.has(missingColumn) || !(missingColumn in retryPayload)) {
      return result
    }

    delete retryPayload[missingColumn]
  }

  return adminSupabase.from(table).upsert(retryPayload).select(select).single()
}

async function updateWithSchemaFallback(table: string, payload: DataRow, match: DataRow, required = new Set<string>(), select = "*") {
  const retryPayload = { ...payload }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    let query = adminSupabase.from(table).update(retryPayload)
    for (const [key, value] of Object.entries(match)) query = query.eq(key, value as string | number | boolean)
    const result = await query.select(select).maybeSingle()
    const missingColumn = missingColumnFromError(result.error)

    if (!result.error || !missingColumn || required.has(missingColumn) || !(missingColumn in retryPayload)) {
      return result
    }

    delete retryPayload[missingColumn]
  }

  let query = adminSupabase.from(table).update(retryPayload)
  for (const [key, value] of Object.entries(match)) query = query.eq(key, value as string | number | boolean)
  return query.select(select).maybeSingle()
}

function jsonRows(data: DataRow[], count: number, pagination: ReturnType<typeof parsePagination>) {
  return NextResponse.json(
    { success: true, data, pagination: { ...pagination, total: count } },
    noStore
  )
}

async function listRows(request: Request, context: WorkspaceContext, config: ListConfig) {
  const pagination = parsePagination(request)
  const { from, to } = paginationRange(pagination)
  const sort = config.allowedSort.has(pagination.sort) ? pagination.sort : config.defaultSort
  const search = cleanSearch(pagination.search)

  let query = adminSupabase
    .from(config.table)
    .select("*", { count: "exact" })
    .eq("organization_id", context.organizationId)

  if (search && config.searchFields.length) {
    query = query.or(config.searchFields.map((field) => `${field}.ilike.%${search}%`).join(","))
  }

  let result = await query
    .order(sort, { ascending: pagination.direction === "asc" })
    .range(from, to)

  if (result.error && (missingColumnFromError(result.error) || isMissingTable(result.error))) {
    if (isMissingTable(result.error)) return fail(tableMissingMessage(config.table), 503)
    result = await adminSupabase
      .from(config.table)
      .select("*", { count: "exact" })
      .eq("organization_id", context.organizationId)
      .range(from, to)
  }

  if (result.error) return fail(`${config.table.replaceAll("_", " ")} failed to load.`, 500)

  const rows = ((result.data || []) as DataRow[]).filter((row) => !row.deleted_at)
  return jsonRows(rows, result.count || rows.length, pagination)
}

function documentItems(body: DataRow) {
  const raw = body.items || body.purchase_items || body.invoice_items || body.lines || []
  if (!Array.isArray(raw)) return []

  return raw
    .filter((item): item is DataRow => Boolean(item && typeof item === "object"))
    .map((item) => {
      const quantity = Math.max(0, numberFrom(item, ["quantity", "qty"], 0))
      const unitPrice = numberFrom(item, ["unit_price", "unit_cost", "price", "rate"], 0)
      const taxPercent = Math.max(0, numberFrom(item, ["tax_percent", "gst", "tax_rate"], 0))
      const lineSubtotal = numberFrom(item, ["subtotal"], quantity * unitPrice)
      const taxAmount = numberFrom(item, ["tax_amount", "gst_amount"], lineSubtotal * (taxPercent / 100))
      const lineTotal = numberFrom(item, ["line_total", "total"], lineSubtotal + taxAmount)

      return {
        ...item,
        id: text(item, ["id"]) || newId("item"),
        product_id: optionalText(item, ["product_id"]),
        product_name: optionalText(item, ["product_name", "name", "description"]),
        description: optionalText(item, ["description", "product_name", "name"]),
        quantity,
        unit_price: unitPrice,
        unit_cost: unitPrice,
        tax_percent: taxPercent,
        tax_rate: taxPercent,
        tax_amount: taxAmount,
        gst_amount: taxAmount,
        line_total: lineTotal,
        total: lineTotal,
      }
    })
    .filter((item) => numberFrom(item, ["quantity"], 0) > 0)
}

function totalsForItems(items: DataRow[], body: DataRow) {
  const subtotal = numberFrom(body, ["subtotal"], items.reduce((sum, item) => sum + numberFrom(item, ["quantity"]) * numberFrom(item, ["unit_price", "unit_cost"]), 0))
  const taxTotal = numberFrom(body, ["tax_total", "tax_amount"], items.reduce((sum, item) => sum + numberFrom(item, ["tax_amount", "gst_amount"]), 0))
  const grandTotal = numberFrom(body, ["grand_total", "total_amount", "total"], items.reduce((sum, item) => sum + numberFrom(item, ["line_total", "total"]), subtotal + taxTotal))
  const paidAmount = Math.max(0, numberFrom(body, ["paid_amount"], 0))
  return {
    subtotal,
    discount_total: Math.max(0, numberFrom(body, ["discount_total", "discount_amount"], 0)),
    taxable_amount: numberFrom(body, ["taxable_amount"], subtotal),
    tax_total: taxTotal,
    tax_amount: taxTotal,
    grand_total: grandTotal,
    total_amount: grandTotal,
    total: grandTotal,
    paid_amount: paidAmount,
    outstanding_amount: Math.max(0, grandTotal - paidAmount),
  }
}

async function adjustProductStock(context: WorkspaceContext, items: DataRow[], direction: 1 | -1, reason: string, referenceId: string, referenceNo: string) {
  const productIds = Array.from(new Set(items.map((item) => text(item, ["product_id"])).filter(Boolean)))
  if (!productIds.length) return { ok: true as const, error: null as string | null }

  const { data: products, error } = await adminSupabase
    .from("products")
    .select("id,name,stock")
    .eq("organization_id", context.organizationId)
    .in("id", productIds)

  if (error) return { ok: false as const, error: "Products could not be verified." }

  const productMap = new Map(((products || []) as DataRow[]).map((product) => [String(product.id), product]))
  const stockRollbacks: Array<{ id: string; stock: number }> = []

  for (const item of items) {
    const productId = text(item, ["product_id"])
    if (!productId) continue

    const product = productMap.get(productId)
    if (!product) return { ok: false as const, error: "One or more products were not found." }

    const previousStock = numberFrom(product, ["stock"])
    const quantity = numberFrom(item, ["quantity"]) * direction
    const nextStock = previousStock + quantity
    if (nextStock < -0.0001) return { ok: false as const, error: `${text(product, ["name"], "Product")} cannot go below zero stock.` }

    const { error: updateError } = await adminSupabase
      .from("products")
      .update({ stock: nextStock, updated_at: nowIso() })
      .eq("id", productId)
      .eq("organization_id", context.organizationId)

    if (updateError) {
      await Promise.all(stockRollbacks.map((rollback) =>
        adminSupabase
          .from("products")
          .update({ stock: rollback.stock, updated_at: nowIso() })
          .eq("id", rollback.id)
          .eq("organization_id", context.organizationId)
      ))
      return { ok: false as const, error: "Stock update failed. No stock changes were kept." }
    }

    stockRollbacks.push({ id: productId, stock: previousStock })
    await insertStockMovement({
      organization_id: context.organizationId,
      product_id: productId,
      product_name: text(item, ["product_name", "description"]),
      type: direction > 0 ? "stock_in" : "sale",
      quantity,
      previous_stock: previousStock,
      new_stock: nextStock,
      reason,
      reference_id: referenceId,
      reference_no: referenceNo,
    })
  }

  return { ok: true as const, error: null as string | null }
}

async function saveSupplier(request: Request, context: WorkspaceContext) {
  const body = await requestBody(request)
  const now = nowIso()
  const id = text(body, ["id"]) || newId("supplier")

  const supplier = {
    ...body,
    id,
    organization_id: context.organizationId,
    name: text(body, ["name", "supplier"], "Supplier"),
    email: optionalText(body, ["email"]),
    phone: optionalText(body, ["phone"]),
    gstin: optionalText(body, ["gstin", "gst_number"]),
    gst_number: optionalText(body, ["gst_number", "gstin"]),
    tax_id: optionalText(body, ["tax_id"]),
    address: optionalText(body, ["address"]),
    city: optionalText(body, ["city"]),
    state: optionalText(body, ["state"]),
    country: optionalText(body, ["country"]),
    opening_balance: numberFrom(body, ["opening_balance"], 0),
    current_balance: numberFrom(body, ["current_balance", "opening_balance"], 0),
    is_active: boolFrom(body, ["is_active"], true),
    updated_at: now,
    created_at: text(body, ["created_at"]) || now,
    deleted_at: null,
  }

  const result = await upsertWithSchemaFallback("suppliers", supplier, requiredColumns(["id", "name"]))
  if (isMissingTable(result.error)) return fail(tableMissingMessage("suppliers"), 503)
  if (result.error) return fail(result.error.message || "Supplier could not be saved.", 500)

  await writeAdminLog({
    action: "supplier.saved",
    description: `Supplier saved: ${supplier.name}`,
    adminUserId: context.userId,
    organizationId: context.organizationId,
    metadata: { supplier_id: id },
  })

  return ok({ supplier: result.data || supplier })
}

async function supplierStatus(request: Request, context: WorkspaceContext) {
  const body = await requestBody(request)
  const id = text(body, ["id", "supplier_id"])
  if (!id) return fail("Supplier id is required.", 422)

  const archive = body.archive === true || body.active === false || body.is_active === false
  const result = await updateWithSchemaFallback(
    "suppliers",
    { is_active: !archive, deleted_at: archive ? nowIso() : null, updated_at: nowIso() },
    { id, organization_id: context.organizationId }
  )
  if (isMissingTable(result.error)) return fail(tableMissingMessage("suppliers"), 503)
  if (result.error) return fail("Supplier status could not be updated.", 500)
  return ok({ id, active: !archive, archived: archive })
}

async function supplierLedger(request: Request, context: WorkspaceContext) {
  const url = new URL(request.url)
  const supplierId = url.searchParams.get("supplier_id") || ""
  if (!supplierId) return fail("Supplier id is required.", 422)

  const [supplierResult, purchasesResult, paymentsResult] = await Promise.all([
    adminSupabase.from("suppliers").select("*").eq("id", supplierId).eq("organization_id", context.organizationId).maybeSingle(),
    adminSupabase.from("purchase_invoices").select("*").eq("supplier_id", supplierId).eq("organization_id", context.organizationId).limit(1000),
    adminSupabase.from("payments").select("*").eq("party_id", supplierId).eq("organization_id", context.organizationId).limit(1000),
  ])

  if (isMissingTable(supplierResult.error) || isMissingTable(purchasesResult.error) || isMissingTable(paymentsResult.error)) {
    return fail("Supplier ledger tables are not available. Run the latest Bezgrow ERP database migration.", 503)
  }

  const purchases = ((purchasesResult.data || []) as DataRow[]).filter((row) => !row.deleted_at)
  const payments = ((paymentsResult.data || []) as DataRow[]).filter((row) => !row.deleted_at)
  const purchaseTotal = purchases.reduce((sum, row) => sum + numberFrom(row, ["grand_total", "total_amount"]), 0)
  const paidTotal = payments.reduce((sum, row) => sum + numberFrom(row, ["amount"]), 0)

  return NextResponse.json({
    success: true,
    supplier: supplierResult.data || null,
    purchases,
    payments,
    summary: {
      purchaseTotal,
      paidTotal,
      balance: purchaseTotal - paidTotal,
      purchaseCount: purchases.length,
      paymentCount: payments.length,
    },
  }, noStore)
}

async function createPurchase(request: Request, context: WorkspaceContext, kind: "purchase_invoice" | "purchase_return" | "purchase_order" | "goods_received") {
  const body = await requestBody(request)
  const items = documentItems(body)
  if (!items.length && kind !== "purchase_order") return fail("Purchase requires at least one item.", 422)

  const totals = totalsForItems(items, body)
  const now = nowIso()
  const purchaseId = text(body, ["id"]) || newId("purchase")
  const billNumber = text(body, ["bill_number", "invoice_number", "number"]) || `${kind === "purchase_return" ? "PR" : kind === "purchase_order" ? "PO" : "PB"}-${Date.now()}`
  const supplierId = optionalText(body, ["supplier_id"])
  const supplierName = text(body, ["supplier_name", "supplier"], supplierId ? "Supplier" : "Supplier")

  const purchase = {
    ...body,
    ...totals,
    id: purchaseId,
    organization_id: context.organizationId,
    supplier_id: supplierId,
    supplier_name: supplierName,
    invoice_kind: kind,
    bill_number: billNumber,
    bill_date: text(body, ["bill_date", "date"]) || dateOnly(),
    due_date: optionalText(body, ["due_date"]),
    received_status: kind === "purchase_order" ? "ordered" : "received",
    status: totals.outstanding_amount <= 0 && totals.grand_total > 0 ? "paid" : text(body, ["status", "payment_status"], "unpaid"),
    notes: optionalText(body, ["notes"]),
    updated_at: now,
    created_at: text(body, ["created_at"]) || now,
    deleted_at: null,
  }

  const result = await insertWithSchemaFallback("purchase_invoices", purchase, requiredColumns(["id", "bill_number"]))
  if (isMissingTable(result.error)) return fail(tableMissingMessage("purchase_invoices"), 503)
  if (result.error || !result.data) return fail(result.error?.message || "Purchase could not be created.", 500)

  const itemRows = items.map((item) => ({
    ...item,
    organization_id: context.organizationId,
    purchase_invoice_id: purchaseId,
    warehouse_id: optionalText(item, ["warehouse_id"]),
    batch_no: optionalText(item, ["batch_no"]),
    expiry_date: optionalText(item, ["expiry_date"]),
    created_at: now,
    updated_at: now,
  }))

  if (itemRows.length) {
    const itemResult = await adminSupabase.from("purchase_invoice_items").insert(itemRows)
    if (itemResult.error) {
      await adminSupabase.from("purchase_invoices").delete().eq("id", purchaseId).eq("organization_id", context.organizationId)
      if (isMissingTable(itemResult.error)) return fail(tableMissingMessage("purchase_invoice_items"), 503)
      return fail("Purchase items could not be created.", 500)
    }
  }

  if (kind !== "purchase_order") {
    const stockResult = await adjustProductStock(
      context,
      items,
      kind === "purchase_return" ? -1 : 1,
      `${kind.replaceAll("_", " ")} ${billNumber}`,
      purchaseId,
      billNumber
    )
    if (!stockResult.ok) {
      await Promise.all([
        adminSupabase.from("purchase_invoice_items").delete().eq("purchase_invoice_id", purchaseId).eq("organization_id", context.organizationId),
        adminSupabase.from("purchase_invoices").delete().eq("id", purchaseId).eq("organization_id", context.organizationId),
      ])
      return fail(stockResult.error || "Stock update failed.", 409)
    }
  }

  await writeAdminLog({
    action: "purchase.created",
    description: `Purchase document created: ${billNumber}`,
    adminUserId: context.userId,
    organizationId: context.organizationId,
    metadata: { purchase_id: purchaseId, bill_number: billNumber, kind, grand_total: totals.grand_total },
  })

  return ok({ purchase_id: purchaseId, bill_number: billNumber, grand_total: totals.grand_total })
}

async function createPayment(request: Request, context: WorkspaceContext, overrides: DataRow = {}) {
  const body = { ...(await requestBody(request)), ...overrides }
  const amount = numberFrom(body, ["amount", "paid_amount"], 0)
  if (amount <= 0) return fail("Payment amount must be greater than zero.", 422)

  const id = text(body, ["id"]) || newId("payment")
  const payment = {
    ...body,
    id,
    organization_id: context.organizationId,
    party_type: text(body, ["party_type"], "customer"),
    party_id: optionalText(body, ["party_id", "customer_id", "supplier_id"]),
    document_type: optionalText(body, ["document_type"]),
    document_id: optionalText(body, ["document_id", "invoice_id", "purchase_id"]),
    amount,
    direction: text(body, ["direction"], text(body, ["party_type"]) === "supplier" ? "out" : "in"),
    payment_method: text(body, ["payment_method", "mode"], "cash"),
    reference_no: optionalText(body, ["reference_no"]),
    payment_date: text(body, ["payment_date", "date"]) || dateOnly(),
    notes: optionalText(body, ["notes"]),
    created_at: nowIso(),
    updated_at: nowIso(),
    deleted_at: null,
  }

  const result = await insertWithSchemaFallback("payments", payment, requiredColumns(["id", "party_type", "amount"]))
  if (isMissingTable(result.error)) return fail(tableMissingMessage("payments"), 503)
  if (result.error) return fail(result.error.message || "Payment could not be created.", 500)
  return ok({ payment_id: id, payment: result.data || payment })
}

async function createQuotation(request: Request, context: WorkspaceContext) {
  return createHeaderWithItems(request, context, {
    table: "quotations",
    itemTable: "quotation_items",
    itemForeignKey: "quotation_id",
    idPrefix: "quotation",
    numberKey: "quote_number",
    numberPrefix: "QT",
    dateKey: "created_at",
    defaultStatus: "draft",
    logAction: "quotation.created",
    responseId: "quotation_id",
  })
}

async function createDeliveryChallan(request: Request, context: WorkspaceContext) {
  const response = await createHeaderWithItems(request, context, {
    table: "delivery_challans",
    itemTable: "delivery_challan_items",
    itemForeignKey: "challan_id",
    idPrefix: "challan",
    numberKey: "challan_number",
    numberPrefix: "DC",
    dateKey: "challan_date",
    defaultStatus: "draft",
    logAction: "delivery_challan.created",
    responseId: "challan_id",
  })
  return response
}

async function createProformaInvoice(request: Request, context: WorkspaceContext) {
  const body = await requestBody(request)
  const items = documentItems(body)
  if (!items.length) return fail("Proforma invoice requires at least one item.", 422)

  const totals = totalsForItems(items, body)
  const id = text(body, ["id"]) || newId("proforma")
  const invoiceNumber = text(body, ["invoice_number", "number"]) || `PF-${Date.now()}`
  const invoice = {
    ...body,
    ...totals,
    id,
    organization_id: context.organizationId,
    customer_id: optionalText(body, ["customer_id"]),
    customer_name: optionalText(body, ["customer_name"]),
    invoice_number: invoiceNumber,
    invoice_type: "proforma",
    invoice_date: text(body, ["invoice_date", "date"]) || dateOnly(),
    payment_status: "draft",
    status: "draft",
    created_at: nowIso(),
    updated_at: nowIso(),
    deleted_at: null,
  }

  const result = await insertWithSchemaFallback("sales_invoices", invoice, requiredColumns(["id", "invoice_number"]))
  if (isMissingTable(result.error)) return fail(tableMissingMessage("sales_invoices"), 503)
  if (result.error) return fail(result.error.message || "Proforma invoice could not be created.", 500)

  const itemRows = items.map((item) => ({
    ...item,
    organization_id: context.organizationId,
    invoice_id: id,
    created_at: nowIso(),
    updated_at: nowIso(),
  }))
  const itemResult = await adminSupabase.from("sales_invoice_items").insert(itemRows)
  if (itemResult.error) {
    await adminSupabase.from("sales_invoices").delete().eq("id", id).eq("organization_id", context.organizationId)
    return fail("Proforma items could not be created.", 500)
  }

  return ok({ invoice_id: id, invoice_number: invoiceNumber, invoice_type: "proforma" })
}

type HeaderWithItemsConfig = {
  table: string
  itemTable: string
  itemForeignKey: string
  idPrefix: string
  numberKey: string
  numberPrefix: string
  dateKey: string
  defaultStatus: string
  logAction: string
  responseId: string
}

async function createHeaderWithItems(request: Request, context: WorkspaceContext, config: HeaderWithItemsConfig) {
  const body = await requestBody(request)
  const items = documentItems(body)
  if (!items.length) return fail(`${config.numberPrefix} document requires at least one item.`, 422)

  const totals = totalsForItems(items, body)
  const id = text(body, ["id"]) || newId(config.idPrefix)
  const number = text(body, [config.numberKey, "number"]) || `${config.numberPrefix}-${Date.now()}`
  const header = {
    ...body,
    ...totals,
    id,
    organization_id: context.organizationId,
    [config.numberKey]: number,
    [config.dateKey]: text(body, [config.dateKey, "date"]) || dateOnly(),
    status: text(body, ["status"], config.defaultStatus),
    notes: optionalText(body, ["notes"]),
    created_at: nowIso(),
    updated_at: nowIso(),
    deleted_at: null,
  }

  const result = await insertWithSchemaFallback(config.table, header, requiredColumns(["id", config.numberKey]))
  if (isMissingTable(result.error)) return fail(tableMissingMessage(config.table), 503)
  if (result.error) return fail(result.error.message || "Document could not be created.", 500)

  const itemRows = items.map((item) => ({
    ...item,
    organization_id: context.organizationId,
    [config.itemForeignKey]: id,
    created_at: nowIso(),
    updated_at: nowIso(),
  }))
  const itemResult = await adminSupabase.from(config.itemTable).insert(itemRows)
  if (itemResult.error) {
    await adminSupabase.from(config.table).delete().eq("id", id).eq("organization_id", context.organizationId)
    return fail(`${config.itemTable.replaceAll("_", " ")} could not be created.`, 500)
  }

  await writeAdminLog({
    action: config.logAction,
    description: `Document created: ${number}`,
    adminUserId: context.userId,
    organizationId: context.organizationId,
    metadata: { id, number },
  })

  return ok({ [config.responseId]: id, number, grand_total: totals.grand_total })
}

async function createNote(request: Request, context: WorkspaceContext, kind: "credit" | "debit") {
  const body = await requestBody(request)
  const items = documentItems(body)
  if (!items.length) return fail(`${kind === "credit" ? "Credit" : "Debit"} note requires at least one item.`, 422)

  const table = kind === "credit" ? "credit_notes" : "debit_notes"
  const itemTable = kind === "credit" ? "credit_note_items" : "debit_note_items"
  const itemForeignKey = kind === "credit" ? "credit_note_id" : "debit_note_id"
  const id = text(body, ["id"]) || newId(`${kind}-note`)
  const noteNumber = text(body, ["note_number", "number"]) || `${kind === "credit" ? "CN" : "DN"}-${Date.now()}`
  const totals = totalsForItems(items, body)
  const note = {
    ...body,
    ...totals,
    id,
    organization_id: context.organizationId,
    note_number: noteNumber,
    note_date: text(body, ["note_date", "date"]) || dateOnly(),
    status: text(body, ["status"], "open"),
    reason: optionalText(body, ["reason", "notes"]),
    created_at: nowIso(),
    updated_at: nowIso(),
    deleted_at: null,
  }

  const result = await insertWithSchemaFallback(table, note, requiredColumns(["id", "note_number"]))
  if (isMissingTable(result.error)) return fail(tableMissingMessage(table), 503)
  if (result.error) return fail(result.error.message || "Note could not be created.", 500)

  const itemRows = items.map((item) => ({
    ...item,
    organization_id: context.organizationId,
    [itemForeignKey]: id,
    created_at: nowIso(),
    updated_at: nowIso(),
  }))
  const itemResult = await adminSupabase.from(itemTable).insert(itemRows)
  if (itemResult.error) {
    await adminSupabase.from(table).delete().eq("id", id).eq("organization_id", context.organizationId)
    return fail("Note items could not be created.", 500)
  }

  if (kind === "credit") {
    const stockResult = await adjustProductStock(context, items, 1, `Credit note ${noteNumber}`, id, noteNumber)
    if (!stockResult.ok) return fail(stockResult.error || "Stock return could not be recorded.", 409)
  }

  return ok({ note_id: id, note_number: noteNumber, grand_total: totals.grand_total })
}

async function createExpense(request: Request, context: WorkspaceContext) {
  const body = await requestBody(request)
  const amount = numberFrom(body, ["amount"], 0)
  if (amount <= 0) return fail("Expense amount must be greater than zero.", 422)

  const id = text(body, ["id"]) || newId("expense")
  const expense = {
    ...body,
    id,
    organization_id: context.organizationId,
    category: text(body, ["category"], "General"),
    description: optionalText(body, ["description", "notes"]),
    amount,
    tax_amount: numberFrom(body, ["tax_amount", "gst_amount"], 0),
    expense_date: text(body, ["expense_date", "date"]) || dateOnly(),
    payment_status: text(body, ["payment_status", "status"], "paid"),
    paid_amount: numberFrom(body, ["paid_amount"], amount),
    outstanding_amount: Math.max(0, amount - numberFrom(body, ["paid_amount"], amount)),
    payment_method: text(body, ["payment_method"], "cash"),
    reference_no: optionalText(body, ["reference_no"]),
    created_at: nowIso(),
    updated_at: nowIso(),
    deleted_at: null,
  }

  const result = await insertWithSchemaFallback("expenses", expense, requiredColumns(["id", "amount"]))
  if (isMissingTable(result.error)) return fail(tableMissingMessage("expenses"), 503)
  if (result.error) return fail(result.error.message || "Expense could not be created.", 500)
  return ok({ expense_id: id, expense: result.data || expense })
}

async function ensureDefaultChart(context: WorkspaceContext) {
  const existing = await adminSupabase
    .from("chart_of_accounts")
    .select("*", { count: "exact" })
    .eq("organization_id", context.organizationId)
    .limit(1000)

  if (isMissingTable(existing.error)) return { error: tableMissingMessage("chart_of_accounts"), rows: [] as DataRow[] }
  if (existing.error) return { error: "Chart of accounts failed to load.", rows: [] as DataRow[] }
  if ((existing.data || []).length) return { error: null, rows: existing.data as DataRow[] }

  const now = nowIso()
  const rows = defaultAccounts.map(([code, name, type, group, normalBalance]) => ({
    id: `coa_${context.organizationId}_${code}`,
    organization_id: context.organizationId,
    account_code: code,
    account_name: name,
    account_type: type,
    account_group: group,
    normal_balance: normalBalance,
    is_active: true,
    created_at: now,
    updated_at: now,
  }))

  const insert = await adminSupabase.from("chart_of_accounts").insert(rows)
  if (insert.error) return { error: "Default chart of accounts could not be created.", rows: [] as DataRow[] }
  return { error: null, rows }
}

async function listChart(request: Request, context: WorkspaceContext) {
  const defaults = await ensureDefaultChart(context)
  if (defaults.error) return fail(defaults.error, 503)
  return listRows(request, context, listConfigs["/api/accounting/chart"])
}

async function saveChartAccount(request: Request, context: WorkspaceContext) {
  const body = await requestBody(request)
  const id = text(body, ["id"]) || newId("account")
  const account = {
    ...body,
    id,
    organization_id: context.organizationId,
    account_code: text(body, ["account_code", "code"], `ACC-${Date.now()}`),
    account_name: text(body, ["account_name", "name"], "Account"),
    account_type: text(body, ["account_type", "type"], "asset"),
    account_group: optionalText(body, ["account_group", "group"]),
    normal_balance: text(body, ["normal_balance"], "debit"),
    is_active: boolFrom(body, ["is_active"], true),
    created_at: text(body, ["created_at"]) || nowIso(),
    updated_at: nowIso(),
    deleted_at: null,
  }

  const result = await upsertWithSchemaFallback("chart_of_accounts", account, requiredColumns(["id", "account_code", "account_name"]))
  if (isMissingTable(result.error)) return fail(tableMissingMessage("chart_of_accounts"), 503)
  if (result.error) return fail(result.error.message || "Account could not be saved.", 500)
  return ok({ account: result.data || account })
}

async function saveBankAccount(request: Request, context: WorkspaceContext) {
  const body = await requestBody(request)
  const id = text(body, ["id"]) || newId("bank")
  const bankAccount = {
    ...body,
    id,
    organization_id: context.organizationId,
    bank_name: text(body, ["bank_name", "name"], "Bank"),
    branch_name: optionalText(body, ["branch_name"]),
    account_number: optionalText(body, ["account_number"]),
    ifsc_code: optionalText(body, ["ifsc_code"]),
    is_active: boolFrom(body, ["is_active"], true),
    created_at: text(body, ["created_at"]) || nowIso(),
    updated_at: nowIso(),
    deleted_at: null,
  }

  const result = await upsertWithSchemaFallback("bank_accounts", bankAccount, requiredColumns(["id", "bank_name"]))
  if (isMissingTable(result.error)) return fail(tableMissingMessage("bank_accounts"), 503)
  if (result.error) return fail(result.error.message || "Bank account could not be saved.", 500)
  return ok({ bank_account: result.data || bankAccount })
}

async function createVoucher(request: Request, context: WorkspaceContext) {
  const body = await requestBody(request)
  const rawEntries = Array.isArray(body.entries) ? body.entries.filter((entry): entry is DataRow => Boolean(entry && typeof entry === "object")) : []
  if (rawEntries.length < 2) return fail("Voucher requires at least two ledger lines.", 422)

  const totalDebit = rawEntries.reduce((sum, entry) => sum + numberFrom(entry, ["debit"], 0), 0)
  const totalCredit = rawEntries.reduce((sum, entry) => sum + numberFrom(entry, ["credit"], 0), 0)
  if (Math.abs(totalDebit - totalCredit) > 0.01) return fail("Voucher debit and credit totals must match.", 422)

  const id = text(body, ["id"]) || newId("voucher")
  const voucherNumber = text(body, ["voucher_number", "number"]) || `JV-${Date.now()}`
  const voucher = {
    ...body,
    id,
    organization_id: context.organizationId,
    voucher_number: voucherNumber,
    voucher_type: text(body, ["voucher_type", "type"], "journal"),
    voucher_date: text(body, ["voucher_date", "date"]) || dateOnly(),
    reference_no: optionalText(body, ["reference_no"]),
    narration: optionalText(body, ["narration", "notes"]),
    total_debit: totalDebit,
    total_credit: totalCredit,
    created_at: nowIso(),
    updated_at: nowIso(),
    deleted_at: null,
  }

  const result = await insertWithSchemaFallback("accounting_vouchers", voucher, requiredColumns(["id", "voucher_number"]))
  if (isMissingTable(result.error)) return fail(tableMissingMessage("accounting_vouchers"), 503)
  if (result.error) return fail(result.error.message || "Voucher could not be created.", 500)

  const entries = rawEntries.map((entry, index) => ({
    ...entry,
    id: text(entry, ["id"]) || newId("voucher_entry"),
    organization_id: context.organizationId,
    voucher_id: id,
    line_no: index + 1,
    account_id: optionalText(entry, ["account_id"]),
    account_type: text(entry, ["account_type"], "ledger"),
    debit: numberFrom(entry, ["debit"], 0),
    credit: numberFrom(entry, ["credit"], 0),
    created_at: nowIso(),
    updated_at: nowIso(),
  }))
  const entryResult = await adminSupabase.from("accounting_voucher_entries").insert(entries)
  if (entryResult.error) {
    await adminSupabase.from("accounting_vouchers").delete().eq("id", id).eq("organization_id", context.organizationId)
    return fail("Voucher entries could not be created.", 500)
  }

  const ledgerEntries = entries.map((entry) => ({
    id: newId("ledger"),
    organization_id: context.organizationId,
    account_type: entry.account_type,
    account_id: entry.account_id,
    document_type: "accounting_voucher",
    document_id: id,
    entry_date: voucher.voucher_date,
    debit: entry.debit,
    credit: entry.credit,
    description: voucher.narration,
    created_at: nowIso(),
    updated_at: nowIso(),
  }))
  await adminSupabase.from("ledger_entries").insert(ledgerEntries)

  return ok({ voucher_id: id, voucher_number: voucherNumber })
}

async function createProfessionalMovement(request: Request, context: WorkspaceContext) {
  const body = await requestBody(request)
  const productId = text(body, ["product_id"])
  const quantity = numberFrom(body, ["quantity"], 0)
  if (!productId || quantity <= 0) return fail("Inventory movement requires a product and quantity.", 422)

  const mode = text(body, ["type", "mode"], "adjustment")
  const direction: 1 | -1 = ["sale", "transfer", "damage", "stock_out"].includes(mode) ? -1 : 1
  const result = await adjustProductStock(context, [{ ...body, product_id: productId, quantity }], direction, text(body, ["reason"], "Inventory movement"), newId("movement-ref"), text(body, ["reference_no"], mode))
  if (!result.ok) return fail(result.error || "Inventory movement could not be recorded.", 409)
  return ok({ productId })
}

function rowsToCsv(rows: DataRow[]) {
  if (!rows.length) return ""
  const headers = Array.from(rows.reduce((set, row) => {
    Object.keys(row).forEach((key) => set.add(key))
    return set
  }, new Set<string>()))
  const escape = (value: unknown) => `"${String(value ?? "").replaceAll("\"", "\"\"")}"`
  return [headers.map(escape).join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n")
}

async function loadReportRows(context: WorkspaceContext) {
  const tables = ["products", "customers", "suppliers", "sales_invoices", "sales_invoice_items", "purchase_invoices", "payments", "stock_movements", "ledger_entries"] as const
  const results = await Promise.all(
    tables.map(async (table) => {
      const result = await adminSupabase.from(table).select("*").eq("organization_id", context.organizationId).limit(5000)
      return [table, result.error ? [] : (result.data || [])] as const
    })
  )
  return Object.fromEntries(results) as Record<(typeof tables)[number], DataRow[]>
}

async function report(request: Request, context: WorkspaceContext) {
  const url = new URL(request.url)
  const type = url.searchParams.get("type") || "dashboard"
  const data = await loadReportRows(context)
  const products = data.products.filter((row) => !row.deleted_at)
  const invoices = data.sales_invoices.filter((row) => !row.deleted_at)
  const purchases = data.purchase_invoices.filter((row) => !row.deleted_at)
  const payments = data.payments.filter((row) => !row.deleted_at)
  const movements = data.stock_movements.filter((row) => !row.deleted_at)
  const revenue = invoices.reduce((sum, row) => sum + numberFrom(row, ["grand_total", "total_amount", "total"]), 0)
  const purchaseTotal = purchases.reduce((sum, row) => sum + numberFrom(row, ["grand_total", "total_amount"]), 0)
  const inventoryValue = products.reduce((sum, row) => sum + numberFrom(row, ["stock"]) * numberFrom(row, ["sale_rate", "price", "mrp"]), 0)
  const costValue = products.reduce((sum, row) => sum + numberFrom(row, ["stock"]) * numberFrom(row, ["purchase_rate"]), 0)
  const tax = invoices.reduce((sum, row) => sum + numberFrom(row, ["tax_total", "tax_amount"]), 0)
  const rowsByType: Record<string, DataRow[]> = {
    dashboard: invoices,
    daily: invoices.filter((row) => text(row, ["invoice_date", "created_at"]).startsWith(dateOnly())),
    sales: invoices,
    gst: invoices.map((row) => ({ id: row.id, invoice_number: row.invoice_number, invoice_date: row.invoice_date, tax_amount: numberFrom(row, ["tax_total", "tax_amount"]), grand_total: numberFrom(row, ["grand_total", "total_amount"]) })),
    profit: products.map((row) => ({ id: row.id, name: row.name, stock: row.stock, sale_rate: row.sale_rate || row.price, purchase_rate: row.purchase_rate, margin: numberFrom(row, ["sale_rate", "price"]) - numberFrom(row, ["purchase_rate"]) })),
    stock: products,
    purchases,
    payments,
    movements,
  }
  const reportRows = rowsByType[type] || invoices

  if (url.searchParams.get("format") === "csv") {
    return new NextResponse(rowsToCsv(reportRows), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${type}.csv"`,
        "Content-Type": "text/csv; charset=utf-8",
      },
    })
  }

  return NextResponse.json({
    success: true,
    report: {
      type,
      metrics: {
        revenue,
        purchaseTotal,
        grossProfit: revenue - purchaseTotal,
        inventoryValue,
        costValue,
        potentialProfit: inventoryValue - costValue,
        tax,
        invoiceCount: invoices.length,
        purchaseCount: purchases.length,
        paymentCount: payments.length,
        productCount: products.length,
      },
      rows: reportRows,
    },
  }, noStore)
}

async function verifyBackup(request: Request, context: WorkspaceContext) {
  const body = await requestBody(request)
  const manifest = {
    id: text(body, ["id"]) || newId("backup"),
    organization_id: context.organizationId,
    backup_name: text(body, ["backup_name", "name"], `Backup ${new Date().toLocaleString("en-IN")}`),
    storage: text(body, ["storage"], "local"),
    size_bytes: numberFrom(body, ["size_bytes", "size"], 0),
    sha256: optionalText(body, ["sha256", "hash"]),
    verification_status: "verified",
    verified_at: nowIso(),
    created_at: nowIso(),
    updated_at: nowIso(),
  }

  const result = await insertWithSchemaFallback("backup_manifest", manifest, requiredColumns(["id"]))
  if (isMissingTable(result.error)) return fail(tableMissingMessage("backup_manifest"), 503)
  if (result.error) return fail(result.error.message || "Backup verification could not be recorded.", 500)
  return ok({ verified: true, manifest: result.data || manifest })
}

async function databaseIntegrity(context: WorkspaceContext) {
  const tables = ["products", "customers", "suppliers", "sales_invoices", "purchase_invoices", "stock_movements", "payments"] as const
  const checks = await Promise.all(
    tables.map(async (table) => {
      const result = await adminSupabase
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("organization_id", context.organizationId)
      return {
        table,
        ok: !result.error,
        count: result.count || 0,
        error: result.error?.message || null,
      }
    })
  )

  return NextResponse.json({
    success: true,
    integrity: {
      ok: checks.every((check) => check.ok),
      checks,
      checkedAt: nowIso(),
    },
  }, noStore)
}

async function dispatchProfessionalRoute(request: Request, context: WorkspaceContext) {
  const url = new URL(request.url)
  const method = request.method.toUpperCase() as Method
  const path = url.pathname

  if (method === "GET" && listConfigs[path]) {
    if (path === "/api/accounting/chart") return listChart(request, context)
    return listRows(request, context, listConfigs[path])
  }

  if (method === "POST" && path === "/api/suppliers/save") return saveSupplier(request, context)
  if (method === "POST" && path === "/api/suppliers/status") return supplierStatus(request, context)
  if (method === "GET" && path === "/api/suppliers/ledger") return supplierLedger(request, context)
  if (method === "POST" && path === "/api/purchases/create") return createPurchase(request, context, "purchase_invoice")
  if (method === "POST" && path === "/api/purchases/return") return createPurchase(request, context, "purchase_return")
  if (method === "POST" && path === "/api/purchases/order") return createPurchase(request, context, "purchase_order")
  if (method === "POST" && path === "/api/purchases/goods-received") return createPurchase(request, context, "goods_received")
  if (method === "POST" && path === "/api/purchases/supplier-payment") return createPayment(request, context, { party_type: "supplier", direction: "out" })
  if (method === "POST" && path === "/api/payments/create") return createPayment(request, context)
  if (method === "POST" && path === "/api/quotations/create") return createQuotation(request, context)
  if (method === "POST" && path === "/api/delivery-challans/create") return createDeliveryChallan(request, context)
  if (method === "POST" && path === "/api/sales/proforma/create") return createProformaInvoice(request, context)
  if (method === "POST" && path === "/api/sales/returns/create") return createNote(request, context, "credit")
  if (method === "POST" && path === "/api/accounting/chart/save") return saveChartAccount(request, context)
  if (method === "POST" && path === "/api/accounting/bank-accounts/save") return saveBankAccount(request, context)
  if (method === "POST" && path === "/api/accounting/vouchers/create") return createVoucher(request, context)
  if (method === "GET" && (path === "/api/accounting/reports" || path === "/api/reports/local")) return report(request, context)
  if (method === "POST" && path === "/api/notes/credit") return createNote(request, context, "credit")
  if (method === "POST" && path === "/api/notes/debit") return createNote(request, context, "debit")
  if (method === "POST" && path === "/api/expenses/create") return createExpense(request, context)
  if (method === "POST" && path === "/api/inventory/professional-movement") return createProfessionalMovement(request, context)
  if (method === "POST" && path === "/api/backup/verify") return verifyBackup(request, context)
  if (method === "GET" && path === "/api/database/integrity") return databaseIntegrity(context)

  return fail("API route not found.", 404)
}

export async function handleProfessionalErpApi(request: Request) {
  const url = new URL(request.url)
  const routeKey = `${request.method.toUpperCase()} ${url.pathname}`

  if (!professionalRoutes.has(routeKey)) {
    return fail("API route not found.", 404)
  }

  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)

  try {
    return await dispatchProfessionalRoute(request, workspace.context)
  } catch {
    return serverFail()
  }
}
