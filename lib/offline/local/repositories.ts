"use client"

import { getLocalDatabaseService, type SqlExecutor, type SqlValue } from "@/lib/offline/local/service"
import { normalizedTables } from "@/lib/offline/local/schema"
import type { OfflineAction, OfflineActionStatus, OfflineCollection } from "@/lib/offline/db"
import { financialYearIdForDate } from "@/lib/financial-years"

type DataRow = Record<string, unknown>

export type NormalizedListQuery = {
  page: number
  limit: number
  search: string
  sort: string
  direction: "asc" | "desc"
  category?: string
  supplier?: string
  stock?: string
  status?: string
  customerType?: string
  gstStatus?: string
  customerId?: string
  period?: string
  financialYearId?: string
}

export type NormalizedListPage = {
  data: DataRow[]
  total: number
  summary?: Record<string, number>
  facets?: Record<string, string[]>
}

type FieldValue = {
  field_path: string
  value_text: string | null
  value_number: number | null
  value_boolean: number | null
  value_type: string
}

const service = getLocalDatabaseService()

const collectionOrder: Partial<Record<OfflineCollection, string>> = {
  products: "datetime(created_at) DESC",
  inventory_items: "datetime(updated_at) DESC",
  customers: "datetime(created_at) DESC",
  suppliers: "datetime(created_at) DESC",
  warehouses: "datetime(created_at) DESC",
  invoices: "datetime(created_at) DESC",
  invoice_items: "datetime(created_at) ASC",
  purchase_invoices: "datetime(created_at) DESC",
  purchase_items: "datetime(created_at) ASC",
  orders: "datetime(created_at) DESC",
  order_items: "datetime(created_at) ASC",
  quotations: "datetime(created_at) DESC",
  quotation_items: "datetime(created_at) ASC",
  delivery_challans: "datetime(created_at) DESC",
  delivery_challan_items: "datetime(created_at) ASC",
  credit_notes: "datetime(created_at) DESC",
  credit_note_items: "datetime(created_at) ASC",
  debit_notes: "datetime(created_at) DESC",
  debit_note_items: "datetime(created_at) ASC",
  expenses: "datetime(created_at) DESC",
  payments: "datetime(created_at) DESC",
  payment_receipts: "datetime(created_at) DESC",
  ledger_entries: "entry_date DESC",
  chart_of_accounts: "account_code ASC",
  accounting_vouchers: "voucher_date DESC, datetime(created_at) DESC",
  accounting_voucher_entries: "voucher_id ASC, line_no ASC",
  bank_accounts: "datetime(updated_at) DESC",
  print_templates: "datetime(updated_at) DESC",
  license: "datetime(updated_at) DESC",
  device_activations: "datetime(updated_at) DESC",
  audit_logs: "datetime(created_at) DESC",
  backup_manifest: "datetime(created_at) DESC",
  stock_movements: "datetime(created_at) DESC",
  stock_batches: "datetime(updated_at) DESC",
  organization: "datetime(updated_at) DESC",
  settings: "datetime(updated_at) DESC",
  profiles: "datetime(updated_at) DESC",
  organization_members: "datetime(updated_at) DESC",
  financial_years: "start_date DESC",
  financial_year_opening_balances: "created_at DESC",
  financial_year_inventory_openings: "created_at DESC",
  financial_year_invoice_sequences: "updated_at DESC",
  workspace: "datetime(updated_at) DESC",
}

const financialCollectionTables: Partial<Record<OfflineCollection, string>> = {
  financial_years: "financial_years",
  financial_year_opening_balances: "financial_year_opening_balances",
  financial_year_inventory_openings: "financial_year_inventory_openings",
  financial_year_invoice_sequences: "financial_year_invoice_sequences",
}

function nowIso() {
  return new Date().toISOString()
}

function sqlValue(value: unknown): SqlValue {
  if (value === undefined || value === null || value === "") return null
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  return String(value)
}

function text(row: DataRow | null | undefined, keys: string[], fallback: string | null = null) {
  if (!row) return fallback
  for (const key of keys) {
    const value = row[key]
    if (typeof value === "string" && value.trim()) return value
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return fallback
}

function number(row: DataRow | null | undefined, keys: string[], fallback = 0) {
  if (!row) return fallback
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && value !== "") return Number(value || 0)
  }
  return fallback
}

function bool(row: DataRow | null | undefined, keys: string[], fallback = true) {
  if (!row) return fallback ? 1 : 0
  for (const key of keys) {
    const value = row[key]
    if (typeof value === "boolean") return value ? 1 : 0
    if (typeof value === "number") return value ? 1 : 0
  }
  return fallback ? 1 : 0
}

function rowId(prefix: string, organizationId: string, row: DataRow, index = 0) {
  return text(row, ["id", "local_id", "offline_local_id", "server_id"]) || `${prefix}-${organizationId}-${index}`
}

function syncStatus(row: DataRow) {
  const status = text(row, ["sync_status"])
  return status === "pending_sync" ? "pending_update" : status || "synced"
}

function common(row: DataRow, organizationId: string, prefix: string, index = 0) {
  const id = rowId(prefix, organizationId, row, index)
  return {
    id,
    organization_id: text(row, ["organization_id"], organizationId),
    sync_status: syncStatus(row),
    offline_local_id: text(row, ["offline_local_id", "local_id"]) || (id.startsWith("offline-") ? id : null),
    server_id: text(row, ["server_id"]) || (!id.startsWith("offline-") ? id : null),
    last_synced_at: text(row, ["last_synced_at"]),
    created_at: text(row, ["created_at"]) || nowIso(),
    updated_at: text(row, ["updated_at"]) || nowIso(),
    deleted_at: text(row, ["deleted_at"]),
  }
}

function datedFinancialYearId(input: DataRow, organizationId: string, dateKeys: string[]) {
  const explicit = text(input, ["financial_year_id"])
  if (explicit) return explicit
  const value = text(input, dateKeys) || text(input, ["created_at"]) || nowIso().slice(0, 10)
  return financialYearIdForDate(organizationId, value)
}

async function upsert(db: SqlExecutor, table: string, row: DataRow) {
  const entries = Object.entries(row).filter(([, value]) => value !== undefined)
  if (!entries.length) return

  const columns = entries.map(([key]) => key)
  const placeholders = columns.map(() => "?").join(", ")
  const updates = columns
    .filter((column) => column !== "id")
    .map((column) => `${column} = excluded.${column}`)
    .join(", ")
  const values = entries.map(([, value]) => sqlValue(value))

  await db.execute(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updates || "id = excluded.id"}`,
    values
  )
}

async function deleteSynced(db: SqlExecutor, table: string, organizationId: string) {
  await db.execute(`DELETE FROM ${table} WHERE organization_id = ? AND sync_status = 'synced'`, [organizationId])
}

async function listTable<T extends DataRow>(db: SqlExecutor, table: string, organizationId: string, orderBy = "datetime(created_at) DESC") {
  return db.select<T>(
    `SELECT * FROM ${table} WHERE organization_id = ? AND deleted_at IS NULL ORDER BY ${orderBy}`,
    [organizationId]
  )
}

function featureId(organizationId: string, featureKey: string) {
  return `feature:${organizationId}:${featureKey}`
}

function namedId(prefix: string, organizationId: string, name: string) {
  return `${prefix}:${organizationId}:${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
}

async function ensureOrganization(db: SqlExecutor, organizationId: string) {
  if (!organizationId) return
  const now = nowIso()
  await db.execute(
    `INSERT OR IGNORE INTO organizations (id, name, joined_at, created_at, updated_at)
     VALUES (?, 'Business', ?, ?, ?)`,
    [organizationId, now, now, now]
  )
}

async function ensureNamedReference(db: SqlExecutor, table: "categories" | "units" | "warehouses", organizationId: string, name: string | null) {
  if (!name) return null
  const id = namedId(table.slice(0, -1), organizationId, name)
  const payload: DataRow = {
    id,
    organization_id: organizationId,
    name,
    created_at: nowIso(),
    updated_at: nowIso(),
  }
  if (table === "units") payload.symbol = name
  await upsert(db, table, payload)
  return id
}

function productRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "product", index),
    name: text(input, ["name"], "Product"),
    description: text(input, ["description"]),
    manufacturer: text(input, ["manufacturer"]),
    sku: text(input, ["sku"]),
    barcode: text(input, ["barcode"]),
    category_id: text(input, ["category_id"]),
    category: text(input, ["category"]),
    unit_id: text(input, ["unit_id"]),
    unit: text(input, ["unit"], "pcs"),
    supplier_id: text(input, ["supplier_id"]),
    supplier: text(input, ["supplier"]),
    warehouse_id: text(input, ["warehouse_id"]),
    warehouse: text(input, ["warehouse"], "Main Warehouse"),
    hsn_code: text(input, ["hsn_code", "hsn"]),
    price: number(input, ["price", "sale_rate", "mrp"], 0),
    stock: number(input, ["stock", "currentStock", "quantity"], 0),
    min_stock: number(input, ["min_stock"], 5),
    reserved_stock: number(input, ["reserved_stock"], 0),
    batch_no: text(input, ["batch_no"]),
    mrp: sqlValue(input.mrp),
    purchase_rate: sqlValue(input.purchase_rate),
    sale_rate: sqlValue(input.sale_rate ?? input.price),
    gst: sqlValue(input.gst),
    expiry_date: text(input, ["expiry_date"]),
    purchase_date: text(input, ["purchase_date"]),
  }
}

function customerRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "customer", index),
    name: text(input, ["name"], "Customer"),
    email: text(input, ["email"]),
    phone: text(input, ["phone"]),
    gst_number: text(input, ["gst_number", "gstin", "tax_id"]),
    tax_id: text(input, ["tax_id"]),
    address: text(input, ["address"]),
    city: text(input, ["city"]),
    state: text(input, ["state"]),
    state_code: text(input, ["state_code", "gst_state_code"]),
    country: text(input, ["country"]),
    customer_type: text(input, ["customer_type"], "retail"),
    opening_balance: number(input, ["opening_balance"], 0),
    current_balance: number(input, ["current_balance"], 0),
    total_sales: number(input, ["total_sales"], 0),
    last_purchase_at: text(input, ["last_purchase_at"]),
    is_active: bool(input, ["is_active"], true),
  }
}

function supplierRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "supplier", index),
    name: text(input, ["name", "supplier"], "Supplier"),
    email: text(input, ["email"]),
    phone: text(input, ["phone"]),
    gstin: text(input, ["gstin", "gst_number"]),
    gst_number: text(input, ["gst_number", "gstin"]),
    tax_id: text(input, ["tax_id"]),
    address: text(input, ["address"]),
    city: text(input, ["city"]),
    state: text(input, ["state"]),
    country: text(input, ["country"]),
    opening_balance: number(input, ["opening_balance"], 0),
    current_balance: number(input, ["current_balance"], 0),
    is_active: bool(input, ["is_active"], true),
  }
}

function warehouseRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "warehouse", index),
    name: text(input, ["name"], "Main Warehouse"),
    code: text(input, ["code"]),
    address: text(input, ["address"]),
    is_active: bool(input, ["is_active"], true),
  }
}

function invoiceRow(input: DataRow, organizationId: string, index = 0) {
  const amount = number(input, ["grand_total", "total_amount", "total"], 0)
  const created = text(input, ["created_at"]) || nowIso()
  const databaseInvoiceNumber = text(input, ["database_invoice_number", "invoice_number"], `INV-${Date.now()}-${index}`)
  const displayInvoiceNumber = text(input, ["display_invoice_number", "invoice_number"], databaseInvoiceNumber)
  return {
    ...common(input, organizationId, "invoice", index),
    customer_id: text(input, ["customer_id"]),
    customer_name: text(input, ["customer_name"]),
    invoice_number: databaseInvoiceNumber,
    display_invoice_number: displayInvoiceNumber,
    invoice_type: text(input, ["invoice_type"], "standard"),
    invoice_date: text(input, ["invoice_date", "date"]) || created.slice(0, 10),
    date: text(input, ["date"]) || created.slice(0, 10),
    due_date: text(input, ["due_date"]),
    subtotal: number(input, ["subtotal"], amount),
    discount_amount: number(input, ["discount_amount", "discount_total"], 0),
    discount_total: number(input, ["discount_total", "discount_amount"], 0),
    taxable_amount: number(input, ["taxable_amount"], Math.max(0, amount - number(input, ["tax_amount", "tax_total"], 0))),
    tax_amount: number(input, ["tax_amount", "tax_total"], 0),
    tax_total: number(input, ["tax_total", "tax_amount"], 0),
    total_amount: number(input, ["total_amount", "grand_total", "total"], amount),
    grand_total: amount,
    total: number(input, ["total", "grand_total", "total_amount"], amount),
    paid_amount: number(input, ["paid_amount"], 0),
    outstanding_amount: number(input, ["outstanding_amount"], Math.max(0, amount - number(input, ["paid_amount"], 0))),
    payment_status: text(input, ["payment_status", "status"], "unpaid"),
    status: text(input, ["status", "payment_status"], "unpaid"),
    payment_method: text(input, ["payment_method"], "cash"),
    notes: text(input, ["notes"]),
    shipping_code: text(input, ["shipping_code"]),
    courier_name: text(input, ["courier_name"]),
    tracking_number: text(input, ["tracking_number"]),
    offline_client_id: text(input, ["offline_client_id", "offlineClientId"]),
    financial_year_id: datedFinancialYearId(input, organizationId, ["invoice_date", "date"]),
  }
}

function invoiceItemRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "invoice-item", index),
    invoice_id: text(input, ["invoice_id"], ""),
    product_id: text(input, ["product_id"]),
    product_name: text(input, ["product_name"]),
    description: text(input, ["description"]),
    hsn_code: text(input, ["hsn_code", "hsn"]),
    batch_no: text(input, ["batch_no", "batch_number"]),
    expiry_date: text(input, ["expiry_date"]),
    unit: text(input, ["unit"]),
    mrp: sqlValue(input.mrp),
    quantity: number(input, ["quantity"], 0),
    unit_price: number(input, ["unit_price"], 0),
    tax_percent: number(input, ["tax_percent", "gst"], 0),
    discount_percent: number(input, ["discount_percent"], 0),
    line_total: number(input, ["line_total"], 0),
    gst_amount: number(input, ["gst_amount", "tax_amount"], 0),
    cgst_amount: number(input, ["cgst_amount"], 0),
    sgst_amount: number(input, ["sgst_amount"], 0),
    igst_amount: number(input, ["igst_amount"], 0),
  }
}

function orderRow(input: DataRow, organizationId: string, index = 0) {
  const amount = number(input, ["total_amount", "grand_total", "total"], 0)
  return {
    ...common(input, organizationId, "order", index),
    order_number: text(input, ["order_number"], `ORD-${Date.now()}-${index}`),
    customer_id: text(input, ["customer_id"]),
    customer_name: text(input, ["customer_name"]),
    customer_phone: text(input, ["customer_phone"]),
    customer_address: text(input, ["customer_address"]),
    order_status: text(input, ["order_status"]),
    status: text(input, ["status", "order_status"]),
    payment_status: text(input, ["payment_status"]),
    payment_mode: text(input, ["payment_mode"]),
    sales_channel: text(input, ["sales_channel"]),
    courier_name: text(input, ["courier_name", "courier"]),
    courier: text(input, ["courier", "courier_name"]),
    tracking_number: text(input, ["tracking_number"]),
    total_amount: amount,
    grand_total: number(input, ["grand_total", "total_amount", "total"], amount),
    total: number(input, ["total", "grand_total", "total_amount"], amount),
    financial_year_id: datedFinancialYearId(input, organizationId, ["created_at"]),
  }
}

function orderItemRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "order-item", index),
    order_id: text(input, ["order_id"], ""),
    product_id: text(input, ["product_id"]),
    product_name: text(input, ["product_name", "name"]),
    quantity: number(input, ["quantity"], 0),
    unit_price: number(input, ["unit_price"], 0),
    total: number(input, ["total", "line_total"], 0),
  }
}

function purchaseItemRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "purchase-item", index),
    purchase_invoice_id: text(input, ["purchase_invoice_id", "invoice_id"], ""),
    product_id: text(input, ["product_id"]),
    product_name: text(input, ["product_name", "name"]),
    warehouse_id: text(input, ["warehouse_id"]),
    batch_no: text(input, ["batch_no"]),
    expiry_date: text(input, ["expiry_date"]),
    quantity: number(input, ["quantity"], 0),
    unit_cost: number(input, ["unit_cost", "unit_price", "purchase_rate"], 0),
    tax_percent: number(input, ["tax_percent", "gst"], 0),
    tax_amount: number(input, ["tax_amount", "gst_amount"], 0),
    line_total: number(input, ["line_total", "total"], 0),
  }
}

function paymentReceiptRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "payment-receipt", index),
    customer_id: text(input, ["customer_id"]),
    invoice_id: text(input, ["invoice_id"]),
    receipt_number: text(input, ["receipt_number"], `RCPT-${Date.now()}-${index}`),
    receipt_type: text(input, ["receipt_type"], "customer_receipt"),
    amount: number(input, ["amount"], 0),
    payment_method: text(input, ["payment_method"], "cash"),
    reference_no: text(input, ["reference_no"]),
    received_at: text(input, ["received_at", "payment_date"]) || nowIso(),
    notes: text(input, ["notes"]),
    financial_year_id: datedFinancialYearId(input, organizationId, ["received_at", "payment_date"]),
  }
}

function ledgerEntryRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "ledger", index),
    account_type: text(input, ["account_type"], "general"),
    account_id: text(input, ["account_id", "customer_id", "supplier_id"]),
    document_type: text(input, ["document_type"], "manual"),
    document_id: text(input, ["document_id", "invoice_id"]),
    entry_date: text(input, ["entry_date", "date"]) || nowIso().slice(0, 10),
    debit: number(input, ["debit"], 0),
    credit: number(input, ["credit"], 0),
    currency: text(input, ["currency"], "INR"),
    description: text(input, ["description", "notes"]),
    financial_year_id: datedFinancialYearId(input, organizationId, ["entry_date", "date"]),
  }
}

function chartAccountRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "account", index),
    account_code: text(input, ["account_code", "code"], `ACC-${String(index + 1).padStart(4, "0")}`),
    account_name: text(input, ["account_name", "name"], "Account"),
    account_type: text(input, ["account_type", "type"], "asset"),
    account_group: text(input, ["account_group", "group"]),
    parent_id: text(input, ["parent_id"]),
    normal_balance: text(input, ["normal_balance"], "debit"),
    opening_balance: number(input, ["opening_balance"], 0),
    current_balance: number(input, ["current_balance"], 0),
    is_system: bool(input, ["is_system"], false),
    is_cash_account: bool(input, ["is_cash_account"], false),
    is_bank_account: bool(input, ["is_bank_account"], false),
    is_active: bool(input, ["is_active"], true),
    notes: text(input, ["notes"]),
  }
}

function bankAccountRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "bank-account", index),
    account_id: text(input, ["account_id"]),
    bank_name: text(input, ["bank_name", "name"], "Bank"),
    branch_name: text(input, ["branch_name", "branch"]),
    account_number: text(input, ["account_number"]),
    ifsc_code: text(input, ["ifsc_code", "ifsc"]),
    account_holder: text(input, ["account_holder", "holder_name"]),
    opening_balance: number(input, ["opening_balance"], 0),
    current_balance: number(input, ["current_balance"], 0),
    is_active: bool(input, ["is_active"], true),
    notes: text(input, ["notes"]),
  }
}

function accountingVoucherRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "voucher", index),
    voucher_number: text(input, ["voucher_number", "number"], `VCH-${Date.now()}-${index}`),
    voucher_type: text(input, ["voucher_type", "type"], "journal"),
    voucher_date: text(input, ["voucher_date", "date"]) || nowIso().slice(0, 10),
    reference_no: text(input, ["reference_no"]),
    narration: text(input, ["narration", "description", "notes"]),
    total_debit: number(input, ["total_debit"], 0),
    total_credit: number(input, ["total_credit"], 0),
    status: text(input, ["status"], "posted"),
    financial_year_id: datedFinancialYearId(input, organizationId, ["voucher_date", "date"]),
  }
}

function accountingVoucherEntryRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "voucher-entry", index),
    voucher_id: text(input, ["voucher_id"], ""),
    account_id: text(input, ["account_id"]),
    account_type: text(input, ["account_type"], "general"),
    party_type: text(input, ["party_type"]),
    party_id: text(input, ["party_id"]),
    line_no: number(input, ["line_no"], index + 1),
    debit: number(input, ["debit"], 0),
    credit: number(input, ["credit"], 0),
    description: text(input, ["description", "narration"]),
  }
}

function quotationRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "quotation", index),
    customer_id: text(input, ["customer_id"]),
    quote_number: text(input, ["quote_number", "quotation_number"], `QTN-${Date.now()}-${index}`),
    status: text(input, ["status"], "draft"),
    valid_until: text(input, ["valid_until"]),
    subtotal: number(input, ["subtotal"], 0),
    discount_total: number(input, ["discount_total", "discount_amount"], 0),
    tax_total: number(input, ["tax_total", "tax_amount"], 0),
    grand_total: number(input, ["grand_total", "total_amount", "total"], 0),
    notes: text(input, ["notes"]),
    financial_year_id: datedFinancialYearId(input, organizationId, ["created_at"]),
  }
}

function quotationItemRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "quotation-item", index),
    quotation_id: text(input, ["quotation_id", "quote_id"], ""),
    product_id: text(input, ["product_id"]),
    description: text(input, ["description", "product_name"]),
    quantity: number(input, ["quantity"], 0),
    unit_price: number(input, ["unit_price"], 0),
    tax_rate: number(input, ["tax_rate", "tax_percent", "gst"], 0),
    tax_amount: number(input, ["tax_amount", "gst_amount"], 0),
    line_total: number(input, ["line_total", "total"], 0),
  }
}

function deliveryChallanRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "delivery-challan", index),
    customer_id: text(input, ["customer_id"]),
    challan_number: text(input, ["challan_number"], `DC-${Date.now()}-${index}`),
    challan_date: text(input, ["challan_date", "date"]) || nowIso().slice(0, 10),
    status: text(input, ["status"], "draft"),
    notes: text(input, ["notes"]),
    financial_year_id: datedFinancialYearId(input, organizationId, ["challan_date", "date"]),
  }
}

function deliveryChallanItemRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "delivery-challan-item", index),
    challan_id: text(input, ["challan_id", "delivery_challan_id"], ""),
    product_id: text(input, ["product_id"]),
    description: text(input, ["description", "product_name"]),
    quantity: number(input, ["quantity"], 0),
  }
}

function creditNoteRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "credit-note", index),
    invoice_id: text(input, ["invoice_id"]),
    customer_id: text(input, ["customer_id"]),
    note_number: text(input, ["note_number", "credit_note_number"], `CN-${Date.now()}-${index}`),
    note_date: text(input, ["note_date", "date"]) || nowIso().slice(0, 10),
    reason: text(input, ["reason"]),
    subtotal: number(input, ["subtotal"], 0),
    tax_total: number(input, ["tax_total", "tax_amount"], 0),
    grand_total: number(input, ["grand_total", "total_amount", "total"], 0),
    status: text(input, ["status"], "open"),
    financial_year_id: datedFinancialYearId(input, organizationId, ["note_date", "date"]),
  }
}

function creditNoteItemRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "credit-note-item", index),
    credit_note_id: text(input, ["credit_note_id", "note_id"], ""),
    product_id: text(input, ["product_id"]),
    quantity: number(input, ["quantity"], 0),
    unit_price: number(input, ["unit_price"], 0),
    tax_amount: number(input, ["tax_amount", "gst_amount"], 0),
    line_total: number(input, ["line_total", "total"], 0),
  }
}

function debitNoteRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "debit-note", index),
    supplier_id: text(input, ["supplier_id"]),
    note_number: text(input, ["note_number", "debit_note_number"], `DN-${Date.now()}-${index}`),
    note_date: text(input, ["note_date", "date"]) || nowIso().slice(0, 10),
    reason: text(input, ["reason"]),
    subtotal: number(input, ["subtotal"], 0),
    tax_total: number(input, ["tax_total", "tax_amount"], 0),
    grand_total: number(input, ["grand_total", "total_amount", "total"], 0),
    status: text(input, ["status"], "open"),
    financial_year_id: datedFinancialYearId(input, organizationId, ["note_date", "date"]),
  }
}

function debitNoteItemRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "debit-note-item", index),
    debit_note_id: text(input, ["debit_note_id", "note_id"], ""),
    product_id: text(input, ["product_id"]),
    quantity: number(input, ["quantity"], 0),
    unit_price: number(input, ["unit_price"], 0),
    tax_amount: number(input, ["tax_amount", "gst_amount"], 0),
    line_total: number(input, ["line_total", "total"], 0),
  }
}

function printTemplateRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "print-template", index),
    template_key: text(input, ["template_key", "key"], `template-${index}`),
    format: text(input, ["format"], "invoice"),
    name: text(input, ["name"], "Invoice"),
    is_default: bool(input, ["is_default"], false),
    paper_width: text(input, ["paper_width"]),
    font_size: sqlValue(input.font_size),
    show_hsn: sqlValue(input.show_hsn),
    show_tax_breakup: sqlValue(input.show_tax_breakup),
    show_signature: sqlValue(input.show_signature),
    show_qr: sqlValue(input.show_qr),
    show_barcode: sqlValue(input.show_barcode),
    pharma_mode: sqlValue(input.pharma_mode),
  }
}

function deviceActivationRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "device", index),
    license_id: text(input, ["license_id"]),
    device_id: text(input, ["device_id"], `device-${index}`),
    device_name: text(input, ["device_name"]),
    platform: text(input, ["platform"]),
    activated_at: text(input, ["activated_at"]) || nowIso(),
    last_seen_at: text(input, ["last_seen_at"]),
    is_active: bool(input, ["is_active"], true),
  }
}

function backupManifestRow(input: DataRow, organizationId: string, index = 0) {
  return {
    id: text(input, ["id"], `backup:${organizationId}:${Date.now()}:${index}`),
    organization_id: text(input, ["organization_id"], organizationId),
    backup_name: text(input, ["backup_name", "name"], `Backup ${nowIso().slice(0, 10)}`),
    storage_path: text(input, ["storage_path"]),
    checksum: text(input, ["checksum"]),
    size_bytes: sqlValue(input.size_bytes),
    table_count: sqlValue(input.table_count),
    row_count: sqlValue(input.row_count),
    verification_status: text(input, ["verification_status"]),
    verified_at: text(input, ["verified_at"]),
    integrity_report: text(input, ["integrity_report"]),
    created_at: text(input, ["created_at"]) || nowIso(),
    restored_at: text(input, ["restored_at"]),
  }
}

function stockMovementRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "stock-movement", index),
    product_id: text(input, ["product_id"]),
    product_name: text(input, ["product_name"]),
    warehouse_id: text(input, ["warehouse_id"]),
    batch_id: text(input, ["batch_id"]),
    type: text(input, ["type"], "adjustment"),
    quantity: number(input, ["quantity"], 0),
    previous_stock: sqlValue(input.previous_stock),
    new_stock: sqlValue(input.new_stock),
    reason: text(input, ["reason"]),
    reference_no: text(input, ["reference_no"]),
    reference_type: text(input, ["reference_type"]),
    reference_id: text(input, ["reference_id"]),
    movement_date: text(input, ["movement_date"]) || (text(input, ["created_at"]) || nowIso()).slice(0, 10),
    financial_year_id: datedFinancialYearId(input, organizationId, ["movement_date"]),
  }
}

function stockBatchRow(input: DataRow, organizationId: string, index = 0) {
  return {
    ...common(input, organizationId, "stock-batch", index),
    product_id: text(input, ["product_id"], ""),
    warehouse_id: text(input, ["warehouse_id"]),
    batch_no: text(input, ["batch_no"]),
    manufacturing_date: text(input, ["manufacturing_date"]),
    expiry_date: text(input, ["expiry_date"]),
    purchase_date: text(input, ["purchase_date"]),
    quantity: number(input, ["quantity"], 0),
    purchase_rate: sqlValue(input.purchase_rate),
    mrp: sqlValue(input.mrp),
    barcode: text(input, ["barcode"]),
  }
}

function organizationRow(input: DataRow, organizationId: string) {
  return {
    ...common(input, organizationId, "organization"),
    // organizations is the tenant root and is keyed by id; unlike child
    // business tables it intentionally has no organization_id column.
    organization_id: undefined,
    id: text(input, ["id"], organizationId),
    owner_id: text(input, ["owner_id"]),
    name: text(input, ["name", "business_name"], "Business"),
    business_name: text(input, ["business_name", "name"]),
    industry: text(input, ["industry"]),
    business_type: text(input, ["business_type"]),
    business_category: text(input, ["business_category"]),
    gst_number: text(input, ["gst_number", "gstin"]),
    tax_id: text(input, ["tax_id"]),
    phone: text(input, ["phone"]),
    email: text(input, ["email"]),
    website: text(input, ["website"]),
    fssai: text(input, ["fssai"]),
    address: text(input, ["address"]),
    city: text(input, ["city"]),
    state: text(input, ["state"]),
    country: text(input, ["country"]),
    currency: text(input, ["currency"], "INR"),
    timezone: text(input, ["timezone"], "Asia/Kolkata"),
    locale: text(input, ["locale"], "en-IN"),
    branch_name: text(input, ["branch_name"], "Main Branch"),
    invoice_prefix: text(input, ["invoice_prefix"]),
    next_invoice_number: number(input, ["next_invoice_number"], 1),
    financial_year_start: text(input, ["financial_year_start"]),
    joined_at: Object.hasOwn(input, "joined_at") ? text(input, ["joined_at"]) : undefined,
    logo_path: Object.hasOwn(input, "logo_path") ? text(input, ["logo_path"]) : undefined,
    logo_mime_type: Object.hasOwn(input, "logo_mime_type") ? text(input, ["logo_mime_type"]) : undefined,
    logo_width: Object.hasOwn(input, "logo_width") ? sqlValue(input.logo_width) : undefined,
    logo_height: Object.hasOwn(input, "logo_height") ? sqlValue(input.logo_height) : undefined,
    logo_updated_at: Object.hasOwn(input, "logo_updated_at") ? text(input, ["logo_updated_at"]) : undefined,
  }
}

async function replaceRows(
  db: SqlExecutor,
  organizationId: string,
  table: string,
  rows: DataRow[],
  mapper: (row: DataRow, organizationId: string, index: number) => DataRow
) {
  await ensureOrganization(db, organizationId)
  await deleteSynced(db, table, organizationId)
  for (let index = 0; index < rows.length; index += 1) {
    await upsert(db, table, mapper(rows[index], organizationId, index))
  }
}

class TableRepository {
  constructor(
    protected readonly table: string,
    private readonly mapper: (row: DataRow, organizationId: string, index: number) => DataRow,
    private readonly orderBy = "datetime(created_at) DESC"
  ) {}

  async replaceSynced(organizationId: string, rows: DataRow[], db?: SqlExecutor) {
    if (db) {
      await replaceRows(db, organizationId, this.table, rows, this.mapper)
      return
    }

    await service.transaction((tx) => replaceRows(tx, organizationId, this.table, rows, this.mapper))
  }

  async list(organizationId: string, db?: SqlExecutor) {
    const tx = db || (await service.requireConnection("read"))
    return listTable(tx, this.table, organizationId, this.orderBy)
  }

  async clear(db: SqlExecutor) {
    await db.execute(`DELETE FROM ${this.table}`)
  }
}

export class ProductRepository extends TableRepository {
  constructor() {
    super("products", productRow)
  }

  async replaceSynced(organizationId: string, rows: DataRow[], db?: SqlExecutor) {
    const work = async (tx: SqlExecutor) => {
      await ensureOrganization(tx, organizationId)
      for (const row of rows) {
        const category = text(row, ["category"])
        const unit = text(row, ["unit"], "pcs")
        const warehouse = text(row, ["warehouse"], "Main Warehouse")
        if (category) row.category_id = row.category_id || (await ensureNamedReference(tx, "categories", organizationId, category))
        if (unit) row.unit_id = row.unit_id || (await ensureNamedReference(tx, "units", organizationId, unit))
        if (warehouse) row.warehouse_id = row.warehouse_id || (await ensureNamedReference(tx, "warehouses", organizationId, warehouse))
      }
      await replaceRows(tx, organizationId, this.table, rows, productRow)
      for (const row of rows) {
        const product = productRow(row, organizationId)
        await upsert(tx, "inventory_items", {
          id: `inventory:${organizationId}:${product.id}:${product.warehouse_id || "main"}:default`,
          organization_id: organizationId,
          product_id: product.id,
          warehouse_id: product.warehouse_id,
          batch_id: null,
          quantity: product.stock,
          reserved_quantity: product.reserved_stock,
          available_quantity: Math.max(0, Number(product.stock || 0) - Number(product.reserved_stock || 0)),
          reorder_level: product.min_stock,
          sync_status: product.sync_status,
          offline_local_id: product.offline_local_id,
          server_id: product.server_id,
          created_at: product.created_at,
          updated_at: product.updated_at,
          deleted_at: product.deleted_at,
        })
      }
    }

    if (db) return work(db)
    await service.transaction(work)
  }
}

export class CustomerRepository extends TableRepository {
  constructor() {
    super("customers", customerRow)
  }
}

export class SupplierRepository extends TableRepository {
  constructor() {
    super("suppliers", supplierRow)
  }
}

export class InventoryRepository extends TableRepository {
  constructor() {
    super("stock_movements", stockMovementRow)
  }

  async listInventoryItems(organizationId: string, db?: SqlExecutor) {
    const tx = db || (await service.requireConnection("read"))
    return listTable(tx, "inventory_items", organizationId, "datetime(updated_at) DESC")
  }
}

export class InvoiceRepository extends TableRepository {
  constructor() {
    super("sales_invoices", invoiceRow)
  }

  async replaceItems(organizationId: string, rows: DataRow[], db?: SqlExecutor) {
    const itemRepo = new TableRepository("sales_invoice_items", invoiceItemRow, "datetime(created_at) ASC")
    await itemRepo.replaceSynced(organizationId, rows, db)
  }

  async listItems(organizationId: string, db?: SqlExecutor) {
    const tx = db || (await service.requireConnection("read"))
    return listTable(tx, "sales_invoice_items", organizationId, "datetime(created_at) ASC")
  }

  async list(organizationId: string, db?: SqlExecutor) {
    const rows = await super.list(organizationId, db)
    return rows.map((row) => ({
      ...row,
      database_invoice_number: row.invoice_number,
      invoice_number: row.display_invoice_number || row.invoice_number,
    }))
  }
}

export class PurchaseRepository extends TableRepository {
  constructor() {
    super("purchase_invoices", (row, organizationId, index) => ({
      ...common(row, organizationId, "purchase-invoice", index),
      supplier_id: text(row, ["supplier_id"]),
      supplier_name: text(row, ["supplier_name"]),
      invoice_kind: text(row, ["invoice_kind", "kind"], "purchase_invoice"),
      purchase_order_id: text(row, ["purchase_order_id"]),
      return_against_id: text(row, ["return_against_id"]),
      goods_received_id: text(row, ["goods_received_id"]),
      bill_number: text(row, ["bill_number"], `PINV-${Date.now()}-${index}`),
      bill_date: text(row, ["bill_date"]) || nowIso().slice(0, 10),
      due_date: text(row, ["due_date"]),
      subtotal: number(row, ["subtotal"], 0),
      discount_total: number(row, ["discount_total"], 0),
      taxable_amount: number(row, ["taxable_amount"], 0),
      tax_total: number(row, ["tax_total"], 0),
      grand_total: number(row, ["grand_total", "total_amount", "total"], 0),
      received_status: text(row, ["received_status"], "received"),
      paid_amount: number(row, ["paid_amount"], 0),
      outstanding_amount: number(row, ["outstanding_amount"], Math.max(0, number(row, ["grand_total", "total_amount", "total"], 0) - number(row, ["paid_amount"], 0))),
      status: text(row, ["status"], "unpaid"),
      notes: text(row, ["notes"]),
      financial_year_id: datedFinancialYearId(row, organizationId, ["bill_date"]),
    }))
  }

  async replaceItems(organizationId: string, rows: DataRow[], db?: SqlExecutor) {
    const itemRepo = new TableRepository("purchase_invoice_items", purchaseItemRow, "datetime(created_at) ASC")
    await itemRepo.replaceSynced(organizationId, rows, db)
  }

  async listItems(organizationId: string, db?: SqlExecutor) {
    const tx = db || (await service.requireConnection("read"))
    return listTable(tx, "purchase_invoice_items", organizationId, "datetime(created_at) ASC")
  }
}

export class OrderRepository extends TableRepository {
  constructor() {
    super("orders", orderRow)
  }

  async replaceItems(organizationId: string, rows: DataRow[], db?: SqlExecutor) {
    const itemRepo = new TableRepository("order_items", orderItemRow, "datetime(created_at) ASC")
    await itemRepo.replaceSynced(organizationId, rows, db)
  }

  async listItems(organizationId: string, db?: SqlExecutor) {
    const tx = db || (await service.requireConnection("read"))
    return listTable(tx, "order_items", organizationId, "datetime(created_at) ASC")
  }
}

export class ExpenseRepository extends TableRepository {
  constructor() {
    super("expenses", (row, organizationId, index) => ({
      ...common(row, organizationId, "expense", index),
      supplier_id: text(row, ["supplier_id"]),
      category: text(row, ["category"]),
      description: text(row, ["description"]),
      amount: number(row, ["amount"], 0),
      tax_amount: number(row, ["tax_amount"], 0),
      expense_date: text(row, ["expense_date"]) || nowIso().slice(0, 10),
      payment_status: text(row, ["payment_status"], "paid"),
      paid_amount: number(row, ["paid_amount"], number(row, ["amount"], 0)),
      outstanding_amount: number(row, ["outstanding_amount"], 0),
      payment_method: text(row, ["payment_method"]),
      reference_no: text(row, ["reference_no"]),
      financial_year_id: datedFinancialYearId(row, organizationId, ["expense_date"]),
    }))
  }
}

export class PaymentRepository extends TableRepository {
  constructor() {
    super("payments", (row, organizationId, index) => ({
      ...common(row, organizationId, "payment", index),
      party_type: text(row, ["party_type"], "customer"),
      party_id: text(row, ["party_id", "customer_id", "supplier_id"]),
      document_type: text(row, ["document_type"]),
      document_id: text(row, ["document_id", "invoice_id"]),
      amount: number(row, ["amount"], 0),
      direction: text(row, ["direction"]),
      payment_method: text(row, ["payment_method"]),
      reference_no: text(row, ["reference_no"]),
      payment_date: text(row, ["payment_date", "received_at"]) || nowIso().slice(0, 10),
      cleared_at: text(row, ["cleared_at"]),
      notes: text(row, ["notes"]),
      financial_year_id: datedFinancialYearId(row, organizationId, ["payment_date", "received_at"]),
    }))
  }

  async replaceReceipts(organizationId: string, rows: DataRow[], db?: SqlExecutor) {
    const receiptRepo = new TableRepository("payment_receipts", paymentReceiptRow)
    await receiptRepo.replaceSynced(organizationId, rows, db)
  }

  async listReceipts(organizationId: string, db?: SqlExecutor) {
    const tx = db || (await service.requireConnection("read"))
    return listTable(tx, "payment_receipts", organizationId)
  }

  async replaceLedgerEntries(organizationId: string, rows: DataRow[], db?: SqlExecutor) {
    const ledgerRepo = new TableRepository("ledger_entries", ledgerEntryRow, "entry_date DESC")
    await ledgerRepo.replaceSynced(organizationId, rows, db)
  }

  async listLedgerEntries(organizationId: string, db?: SqlExecutor) {
    const tx = db || (await service.requireConnection("read"))
    return listTable(tx, "ledger_entries", organizationId, "entry_date DESC")
  }
}

export class AccountingRepository {
  private readonly accounts = new TableRepository("chart_of_accounts", chartAccountRow, "account_code ASC")
  private readonly vouchers = new TableRepository("accounting_vouchers", accountingVoucherRow, "voucher_date DESC, datetime(created_at) DESC")
  private readonly voucherEntries = new TableRepository("accounting_voucher_entries", accountingVoucherEntryRow, "voucher_id ASC, line_no ASC")
  private readonly bankAccounts = new TableRepository("bank_accounts", bankAccountRow, "datetime(updated_at) DESC")

  replaceAccounts(organizationId: string, rows: DataRow[], db?: SqlExecutor) {
    return this.accounts.replaceSynced(organizationId, rows, db)
  }

  listAccounts(organizationId: string, db?: SqlExecutor) {
    return this.accounts.list(organizationId, db)
  }

  replaceVouchers(organizationId: string, rows: DataRow[], db?: SqlExecutor) {
    return this.vouchers.replaceSynced(organizationId, rows, db)
  }

  listVouchers(organizationId: string, db?: SqlExecutor) {
    return this.vouchers.list(organizationId, db)
  }

  replaceVoucherEntries(organizationId: string, rows: DataRow[], db?: SqlExecutor) {
    return this.voucherEntries.replaceSynced(organizationId, rows, db)
  }

  listVoucherEntries(organizationId: string, db?: SqlExecutor) {
    return this.voucherEntries.list(organizationId, db)
  }

  replaceBankAccounts(organizationId: string, rows: DataRow[], db?: SqlExecutor) {
    return this.bankAccounts.replaceSynced(organizationId, rows, db)
  }

  listBankAccounts(organizationId: string, db?: SqlExecutor) {
    return this.bankAccounts.list(organizationId, db)
  }
}

export class SettingsRepository {
  async replaceOrganization(organizationId: string, input: DataRow | null, db?: SqlExecutor) {
    if (!input) return
    const work = async (tx: SqlExecutor) => {
      await upsert(tx, "organizations", organizationRow(input, organizationId))
    }
    if (db) return work(db)
    await service.transaction(work)
  }

  async replaceSettings(organizationId: string, input: DataRow | null, db?: SqlExecutor) {
    const work = async (tx: SqlExecutor) => {
      await ensureOrganization(tx, organizationId)
      const org = input?.organization && typeof input.organization === "object" ? (input.organization as DataRow) : null
      if (org) await upsert(tx, "organizations", organizationRow(org, organizationId))
      const features = Array.isArray(input?.features) ? input?.features : []
      for (const feature of features) {
        if (typeof feature === "string") {
          await upsert(tx, "feature_flags", {
            id: featureId(organizationId, feature),
            organization_id: organizationId,
            feature_key: feature,
            is_enabled: 1,
            updated_at: nowIso(),
          })
        } else if (feature && typeof feature === "object") {
          const row = feature as DataRow
          const featureKey = text(row, ["feature_key"])
          if (featureKey) {
            await upsert(tx, "feature_flags", {
              id: featureId(organizationId, featureKey),
              organization_id: organizationId,
              feature_key: featureKey,
              is_enabled: bool(row, ["is_enabled"], true),
              requires_plan: text(row, ["requires_plan"]),
              updated_at: nowIso(),
            })
          }
        }
      }
      const settings = {
        currency: text(input, ["currency"]),
        timezone: text(input, ["timezone"]),
        locale: text(input, ["locale"]),
      }
      for (const [key, value] of Object.entries(settings)) {
        if (value) {
          await upsert(tx, "business_settings", {
            id: `setting:${organizationId}:${key}`,
            organization_id: organizationId,
            key,
            value_text: value,
            updated_at: nowIso(),
          })
        }
      }
    }
    if (db) return work(db)
    await service.transaction(work)
  }

  async replaceProfiles(organizationId: string, rows: DataRow[], db?: SqlExecutor) {
    const work = async (tx: SqlExecutor) => {
      await ensureOrganization(tx, organizationId)
      await deleteSynced(tx, "local_users", organizationId).catch(() => undefined)
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]
        await upsert(tx, "local_users", {
          ...common(row, organizationId, "user", index),
          id: rowId("user", organizationId, row, index),
          organization_id: organizationId,
          email: text(row, ["email"]),
          full_name: text(row, ["full_name", "name"]),
          role: text(row, ["role"], "user"),
          business_created: bool(row, ["business_created"], true),
          is_suspended: bool(row, ["is_suspended"], false),
          last_login_at: text(row, ["last_login_at"]),
        })
      }
    }
    if (db) return work(db)
    await service.transaction(work)
  }

  async replaceMembers(organizationId: string, rows: DataRow[], db?: SqlExecutor) {
    const work = async (tx: SqlExecutor) => {
      await ensureOrganization(tx, organizationId)
      await deleteSynced(tx, "organization_members", organizationId).catch(() => undefined)
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]
        const userId = text(row, ["user_id", "id"], `local-user-${index}`)
        await upsert(tx, "local_users", {
          id: userId,
          organization_id: organizationId,
          email: text(row, ["email"]),
          role: text(row, ["role"], "user"),
          created_at: text(row, ["created_at"]) || nowIso(),
          updated_at: text(row, ["updated_at"]) || nowIso(),
        })
        await upsert(tx, "organization_members", {
          ...common(row, organizationId, "member", index),
          id: text(row, ["id"], `${userId}:${organizationId}`),
          user_id: userId,
          role: text(row, ["role"], "member"),
          is_active: bool(row, ["is_active"], true),
        })
      }
    }
    if (db) return work(db)
    await service.transaction(work)
  }

  async readOrganization(organizationId: string, db?: SqlExecutor) {
    const tx = db || (await service.requireConnection("read"))
    return tx.select<DataRow>("SELECT * FROM organizations WHERE id = ? AND deleted_at IS NULL LIMIT 1", [organizationId])
  }

  async readSettings(organizationId: string, db?: SqlExecutor) {
    const tx = db || (await service.requireConnection("read"))
    const [organization] = await this.readOrganization(organizationId, tx)
    const features = await tx.select<DataRow>(
      "SELECT organization_id, feature_key, is_enabled, requires_plan FROM feature_flags WHERE organization_id = ? ORDER BY feature_key",
      [organizationId]
    )
    const settingsRows = await tx.select<DataRow>("SELECT key, value_text, value_number, value_boolean FROM business_settings WHERE organization_id = ?", [
      organizationId,
    ])
    const settings = Object.fromEntries(settingsRows.map((row) => [row.key, row.value_text ?? row.value_number ?? row.value_boolean]))
    return [
      {
        id: `settings:${organizationId}`,
        organization_id: organizationId,
        organization: organization || null,
        features,
        currency: settings.currency || organization?.currency || "INR",
        timezone: settings.timezone || organization?.timezone || "Asia/Kolkata",
        locale: settings.locale || organization?.locale || "en-IN",
        updated_at: nowIso(),
      },
    ]
  }

  async readProfiles(organizationId: string, db?: SqlExecutor) {
    const tx = db || (await service.requireConnection("read"))
    return tx.select<DataRow>(
      `SELECT lu.*
       FROM local_users lu
       LEFT JOIN organization_members om ON om.user_id = lu.id
       WHERE om.organization_id = ? OR lu.organization_id = ?
       ORDER BY datetime(lu.updated_at) DESC`,
      [organizationId, organizationId]
    )
  }

  async readMembers(organizationId: string, db?: SqlExecutor) {
    const tx = db || (await service.requireConnection("read"))
    return listTable(tx, "organization_members", organizationId, "datetime(updated_at) DESC")
  }
}

export class LicenseRepository extends TableRepository {
  constructor() {
    super("license_state", (row, organizationId, index) => ({
      ...common(row, organizationId, "license", index),
      id: text(row, ["id"], `license:${organizationId}:${index}`),
      license_key: text(row, ["license_key"]),
      customer_id: text(row, ["customer_id"]),
      business_id: text(row, ["business_id"]),
      business_name: text(row, ["business_name"]),
      device_id: text(row, ["device_id"]),
      plan_code: text(row, ["plan_code"]),
      plan_name: text(row, ["plan_name"]),
      status: text(row, ["status"], "trial"),
      expiry_date: text(row, ["expiry_date", "expires_at"]),
      grace_period_days: sqlValue(row.grace_period_days),
      allowed_features: Array.isArray(row.allowed_features) ? JSON.stringify(row.allowed_features) : text(row, ["allowed_features"]),
      issued_by_admin: text(row, ["issued_by_admin"]),
      notes: text(row, ["notes"]),
      issued_at: text(row, ["issued_at"]),
      expires_at: text(row, ["expires_at"]),
      grace_until: text(row, ["grace_until"]),
      last_verified_at: text(row, ["last_verified_at"]),
      signature: text(row, ["signature"]),
      device_limit: sqlValue(row.device_limit),
    }))
  }
}

export class AuditRepository extends TableRepository {
  constructor() {
    super("local_audit_logs", (row, organizationId, index) => ({
      ...common(row, organizationId, "audit", index),
      id: text(row, ["id"], `audit:${organizationId}:${Date.now()}:${index}`),
      user_id: text(row, ["user_id", "admin_user_id"]),
      action: text(row, ["action"], "unknown"),
      entity_type: text(row, ["entity_type"]),
      entity_id: text(row, ["entity_id"]),
      description: text(row, ["description"]),
      previous_hash: text(row, ["previous_hash"]),
      hash: text(row, ["hash"]),
    }))
  }
}

export const repositories = {
  products: new ProductRepository(),
  customers: new CustomerRepository(),
  suppliers: new SupplierRepository(),
  inventory: new InventoryRepository(),
  invoices: new InvoiceRepository(),
  purchases: new PurchaseRepository(),
  orders: new OrderRepository(),
  expenses: new ExpenseRepository(),
  payments: new PaymentRepository(),
  accounting: new AccountingRepository(),
  settings: new SettingsRepository(),
  license: new LicenseRepository(),
  audit: new AuditRepository(),
}

const documentRepositories: Partial<Record<OfflineCollection, TableRepository>> = {
  warehouses: new TableRepository("warehouses", warehouseRow),
  quotations: new TableRepository("quotations", quotationRow),
  quotation_items: new TableRepository("quotation_items", quotationItemRow, "datetime(created_at) ASC"),
  delivery_challans: new TableRepository("delivery_challans", deliveryChallanRow),
  delivery_challan_items: new TableRepository("delivery_challan_items", deliveryChallanItemRow, "datetime(created_at) ASC"),
  credit_notes: new TableRepository("credit_notes", creditNoteRow),
  credit_note_items: new TableRepository("credit_note_items", creditNoteItemRow, "datetime(created_at) ASC"),
  debit_notes: new TableRepository("debit_notes", debitNoteRow),
  debit_note_items: new TableRepository("debit_note_items", debitNoteItemRow, "datetime(created_at) ASC"),
  print_templates: new TableRepository("print_templates", printTemplateRow, "datetime(updated_at) DESC"),
  device_activations: new TableRepository("device_activations", deviceActivationRow, "datetime(updated_at) DESC"),
  backup_manifest: new TableRepository("backup_manifest", backupManifestRow, "datetime(created_at) DESC"),
  stock_batches: new TableRepository("stock_batches", stockBatchRow, "datetime(updated_at) DESC"),
}

function asRows(value: unknown) {
  if (value === null || value === undefined) return []
  return (Array.isArray(value) ? value : [value]).filter((row): row is DataRow => Boolean(row && typeof row === "object"))
}

export async function putNormalizedCollection(organizationId: string, collection: OfflineCollection, value: unknown) {
  const rows = asRows(value)
  await service.transaction(async (db) => {
    await putNormalizedCollectionWithDb(db, organizationId, collection, rows)
  })
}

async function putNormalizedCollectionWithDb(db: SqlExecutor, organizationId: string, collection: OfflineCollection, rows: DataRow[]) {
  await ensureOrganization(db, organizationId)
  const financialTable = financialCollectionTables[collection]
  if (financialTable) {
    for (const row of rows) await upsert(db, financialTable, { ...row, organization_id: organizationId })
    return
  }
  if (collection === "products") await repositories.products.replaceSynced(organizationId, rows, db)
  // ProductRepository updates inventory_items atomically with products. The
  // compatibility collection must not run the same full replacement twice.
  if (collection === "inventory_items") return
  if (collection === "customers") await repositories.customers.replaceSynced(organizationId, rows, db)
  if (collection === "suppliers") await repositories.suppliers.replaceSynced(organizationId, rows, db)
  if (collection === "invoices") await repositories.invoices.replaceSynced(organizationId, rows, db)
  if (collection === "invoice_items") await repositories.invoices.replaceItems(organizationId, rows, db)
  if (collection === "purchase_invoices") await repositories.purchases.replaceSynced(organizationId, rows, db)
  if (collection === "purchase_items") await repositories.purchases.replaceItems(organizationId, rows, db)
  if (collection === "orders") await repositories.orders.replaceSynced(organizationId, rows, db)
  if (collection === "order_items") await repositories.orders.replaceItems(organizationId, rows, db)
  if (collection === "expenses") await repositories.expenses.replaceSynced(organizationId, rows, db)
  if (collection === "payments") await repositories.payments.replaceSynced(organizationId, rows, db)
  if (collection === "payment_receipts") await repositories.payments.replaceReceipts(organizationId, rows, db)
  if (collection === "ledger_entries") await repositories.payments.replaceLedgerEntries(organizationId, rows, db)
  if (collection === "chart_of_accounts") await repositories.accounting.replaceAccounts(organizationId, rows, db)
  if (collection === "accounting_vouchers") await repositories.accounting.replaceVouchers(organizationId, rows, db)
  if (collection === "accounting_voucher_entries") await repositories.accounting.replaceVoucherEntries(organizationId, rows, db)
  if (collection === "bank_accounts") await repositories.accounting.replaceBankAccounts(organizationId, rows, db)
  if (collection === "license") await repositories.license.replaceSynced(organizationId, rows, db)
  if (collection === "audit_logs") await repositories.audit.replaceSynced(organizationId, rows, db)
  if (documentRepositories[collection]) await documentRepositories[collection]?.replaceSynced(organizationId, rows, db)
  if (collection === "stock_movements") await repositories.inventory.replaceSynced(organizationId, rows, db)
  if (collection === "organization") await repositories.settings.replaceOrganization(organizationId, rows[0] || null, db)
  if (collection === "settings" || collection === "workspace") await repositories.settings.replaceSettings(organizationId, rows[0] || null, db)
  if (collection === "profiles") await repositories.settings.replaceProfiles(organizationId, rows, db)
  if (collection === "organization_members") await repositories.settings.replaceMembers(organizationId, rows, db)
}

export async function putNormalizedCollectionsInTransaction(
  organizationId: string,
  updates: Array<{ collection: OfflineCollection; value: unknown }>,
  action?: OfflineAction
) {
  // `action` is retained only for source compatibility with older callers.
  // There is no cloud ERP queue: a committed SQLite transaction is final.
  void action
  await service.transaction(async (db) => {
    for (const update of updates) {
      await putNormalizedCollectionWithDb(db, organizationId, update.collection, asRows(update.value))
    }
  })
}

export async function readNormalizedInvoiceCreationContext(
  organizationId: string,
  customerId: string,
  productIds: string[],
  offlineClientId: string,
  invoiceDate: string,
  financialYearIdValue: string
) {
  const db = await service.requireConnection("read")
  const uniqueProductIds = [...new Set(productIds.filter(Boolean))]
  const placeholders = uniqueProductIds.map(() => "?").join(", ")
  const [existingRows, organizationRows, customerRows, products, batches, yearRows, sequenceRows] = await Promise.all([
    offlineClientId
      ? db.select<DataRow>(
          "SELECT id, COALESCE(display_invoice_number, invoice_number) AS invoice_number FROM sales_invoices WHERE organization_id = ? AND offline_client_id = ? LIMIT 1",
          [organizationId, offlineClientId]
        )
      : Promise.resolve([]),
    db.select<DataRow>("SELECT id, invoice_prefix, next_invoice_number FROM organizations WHERE id = ? LIMIT 1", [organizationId]),
    db.select<DataRow>("SELECT * FROM customers WHERE organization_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1", [organizationId, customerId]),
    uniqueProductIds.length
      ? db.select<DataRow>(
          `SELECT * FROM products WHERE organization_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
          [organizationId, ...uniqueProductIds]
        )
      : Promise.resolve([]),
    uniqueProductIds.length
      ? db.select<DataRow>(
          `SELECT * FROM stock_batches WHERE organization_id = ? AND deleted_at IS NULL AND product_id IN (${placeholders}) ORDER BY purchase_date ASC, created_at ASC, id ASC`,
          [organizationId, ...uniqueProductIds]
        )
      : Promise.resolve([]),
    db.select<DataRow>(
      "SELECT * FROM financial_years WHERE organization_id = ? AND id = ? AND date(?) BETWEEN date(start_date) AND date(end_date) LIMIT 1",
      [organizationId, financialYearIdValue, invoiceDate]
    ),
    db.select<DataRow>(
      "SELECT * FROM financial_year_invoice_sequences WHERE organization_id = ? AND financial_year_id = ? LIMIT 1",
      [organizationId, financialYearIdValue]
    ),
  ])
  const organization = organizationRows[0] || null
  const financialYear = yearRows[0] || null
  const sequence = sequenceRows[0] || null
  const numberingMode = text(financialYear, ["invoice_numbering_mode"], "CONTINUE") || "CONTINUE"
  const prefix = text(sequence, ["prefix"], text(organization || {}, ["invoice_prefix"], "INV")) || "INV"
  const nextSequence = Math.max(1, Number(organization?.next_invoice_number || 1))
  const financialYearSequence = Math.max(1, Number(sequence?.next_number || 1))
  const invoiceSequence = numberingMode === "RESTART" ? financialYearSequence : nextSequence
  const displayInvoiceNumber = `${prefix}-${String(invoiceSequence).padStart(5, "0")}`
  const databaseInvoiceNumber = numberingMode === "RESTART"
    ? `${String(financialYear?.label || financialYearIdValue).replace(/[^0-9A-Za-z-]/g, "-")}/${displayInvoiceNumber}`
    : displayInvoiceNumber
  return {
    existing: existingRows[0] || null,
    organization,
    customer: customerRows[0] || null,
    products,
    batches,
    financialYear,
    numberingMode,
    invoiceSequence,
    invoiceNumber: displayInvoiceNumber,
    databaseInvoiceNumber,
  }
}

export async function readNormalizedInvoiceDeletionContext(organizationId: string, invoiceId: string) {
  const db = await service.requireConnection("read")
  const [invoice] = await db.select<DataRow>(
    "SELECT * FROM sales_invoices WHERE organization_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1",
    [organizationId, invoiceId]
  )
  if (!invoice) return null

  const [items, movements, products, latestCustomerInvoice] = await Promise.all([
    db.select<DataRow>(
      "SELECT * FROM sales_invoice_items WHERE organization_id = ? AND invoice_id = ? AND deleted_at IS NULL ORDER BY created_at, id",
      [organizationId, invoiceId]
    ),
    db.select<DataRow>(
      `SELECT * FROM stock_movements
       WHERE organization_id = ? AND reference_id = ? AND reference_type IN ('invoice', 'invoice_delete') AND deleted_at IS NULL
       ORDER BY created_at, id`,
      [organizationId, invoiceId]
    ),
    db.select<DataRow>(
      `SELECT * FROM products
       WHERE organization_id = ? AND deleted_at IS NULL
         AND id IN (SELECT product_id FROM sales_invoice_items WHERE organization_id = ? AND invoice_id = ? AND deleted_at IS NULL)`,
      [organizationId, organizationId, invoiceId]
    ),
    invoice.customer_id
      ? db.select<DataRow>(
          `SELECT invoice_date, date, created_at FROM sales_invoices
           WHERE organization_id = ? AND customer_id = ? AND id <> ? AND deleted_at IS NULL
           ORDER BY COALESCE(invoice_date, date, created_at) DESC, id DESC LIMIT 1`,
          [organizationId, invoice.customer_id as SqlValue, invoiceId]
        )
      : Promise.resolve([]),
  ])
  return { invoice, items, movements, products, latestCustomerInvoice: latestCustomerInvoice[0] || null }
}

export type NormalizedInvoiceAtomicInput = {
  organizationId: string
  invoice: DataRow
  items: DataRow[]
  productDeltas: Array<{ productId: string; quantity: number; updatedAt: string }>
  inventoryDeltas: Array<{ productId: string; warehouseId: string | null; batchId: string | null; quantity: number; updatedAt: string }>
  batchDeltas: Array<{ batchId: string; quantity: number; updatedAt: string }>
  movements: DataRow[]
  ledgerEntries: DataRow[]
  receipt?: DataRow | null
  payment?: DataRow | null
  customerId: string
  customerSalesDelta: number
  customerBalanceDelta: number
  invoiceSequence: number
  numberingMode: "CONTINUE" | "RESTART"
  financialYearId: string
}

export type NormalizedInvoiceDeletionInput = {
  organizationId: string
  invoiceId: string
  customerId: string | null
  invoiceTotal: number
  outstandingAmount: number
  lastPurchaseAt: string | null
  productDeltas: Array<{ productId: string; quantity: number; updatedAt: string }>
  inventoryDeltas: Array<{ productId: string; warehouseId: string | null; batchId: string | null; quantity: number; updatedAt: string }>
  batchDeltas: Array<{ batchId: string; quantity: number; updatedAt: string }>
  restoreMovements: DataRow[]
  deletedAt: string
}

export async function createNormalizedInvoiceAtomic(input: NormalizedInvoiceAtomicInput) {
  await service.transaction(async (db) => {
    await ensureOrganization(db, input.organizationId)
    await upsert(db, "sales_invoices", invoiceRow(input.invoice, input.organizationId))
    for (let index = 0; index < input.items.length; index += 1) {
      await upsert(db, "sales_invoice_items", invoiceItemRow(input.items[index], input.organizationId, index))
    }
    for (const delta of input.productDeltas) {
      await db.execute(
        `UPDATE products
         SET stock = stock - ?, sync_status = 'pending_update', updated_at = ?
         WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`,
        [delta.quantity, delta.updatedAt, input.organizationId, delta.productId]
      )
    }
    for (const delta of input.inventoryDeltas) {
      await db.execute(
        `UPDATE inventory_items
         SET quantity = MAX(0, quantity - ?),
             available_quantity = MAX(0, available_quantity - ?),
             sync_status = 'pending_update', updated_at = ?
         WHERE id = (
           SELECT id FROM inventory_items
           WHERE organization_id = ? AND product_id = ? AND deleted_at IS NULL
           ORDER BY CASE
             WHEN ? IS NOT NULL AND batch_id = ? THEN 0
             WHEN ? IS NOT NULL AND warehouse_id = ? THEN 1
             ELSE 2
           END, id
           LIMIT 1
         )`,
        [
          delta.quantity,
          delta.quantity,
          delta.updatedAt,
          input.organizationId,
          delta.productId,
          delta.batchId,
          delta.batchId,
          delta.warehouseId,
          delta.warehouseId,
        ]
      )
    }
    for (const delta of input.batchDeltas) {
      await db.execute(
        `UPDATE stock_batches
         SET quantity = quantity - ?, sync_status = 'pending_update', updated_at = ?
         WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`,
        [delta.quantity, delta.updatedAt, input.organizationId, delta.batchId]
      )
    }
    for (let index = 0; index < input.movements.length; index += 1) {
      await upsert(db, "stock_movements", stockMovementRow(input.movements[index], input.organizationId, index))
    }
    for (let index = 0; index < input.ledgerEntries.length; index += 1) {
      await upsert(db, "ledger_entries", ledgerEntryRow(input.ledgerEntries[index], input.organizationId, index))
    }
    if (input.receipt) await upsert(db, "payment_receipts", paymentReceiptRow(input.receipt, input.organizationId))
    if (input.payment) await upsert(db, "payments", input.payment)
    await db.execute(
      `UPDATE customers
       SET total_sales = COALESCE(total_sales, 0) + ?,
           current_balance = COALESCE(current_balance, 0) + ?,
           last_purchase_at = ?, sync_status = 'pending_update', updated_at = ?
       WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`,
      [
        input.customerSalesDelta,
        input.customerBalanceDelta,
        input.invoice.updated_at as SqlValue,
        input.invoice.updated_at as SqlValue,
        input.organizationId,
        input.customerId,
      ]
    )
    if (input.numberingMode === "RESTART") {
      await db.execute(
        `UPDATE financial_year_invoice_sequences SET next_number = MAX(next_number, ?), updated_at = ?
         WHERE organization_id = ? AND financial_year_id = ?`,
        [input.invoiceSequence + 1, input.invoice.updated_at as SqlValue, input.organizationId, input.financialYearId]
      )
    } else {
      await db.execute(
        `UPDATE organizations
         SET next_invoice_number = MAX(COALESCE(next_invoice_number, 1), ?), updated_at = ?
         WHERE id = ?`,
        [input.invoiceSequence + 1, input.invoice.updated_at as SqlValue, input.organizationId]
      )
      await db.execute(
        `UPDATE financial_year_invoice_sequences SET next_number = MAX(next_number, ?), updated_at = ?
         WHERE organization_id = ? AND financial_year_id = ?`,
        [input.invoiceSequence + 1, input.invoice.updated_at as SqlValue, input.organizationId, input.financialYearId]
      )
    }
  })
}

export async function deleteNormalizedInvoiceAtomic(input: NormalizedInvoiceDeletionInput) {
  await service.transaction(async (db) => {
    for (const delta of input.productDeltas) {
      await db.execute(
        `UPDATE products SET stock = stock + ?, sync_status = 'pending_update', updated_at = ?
         WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`,
        [delta.quantity, delta.updatedAt, input.organizationId, delta.productId]
      )
    }
    for (const delta of input.inventoryDeltas) {
      await db.execute(
        `UPDATE inventory_items
         SET quantity = quantity + ?, available_quantity = available_quantity + ?,
             sync_status = 'pending_update', updated_at = ?
         WHERE id = (
           SELECT id FROM inventory_items
           WHERE organization_id = ? AND product_id = ? AND deleted_at IS NULL
           ORDER BY CASE
             WHEN ? IS NOT NULL AND batch_id = ? THEN 0
             WHEN ? IS NOT NULL AND warehouse_id = ? THEN 1
             ELSE 2
           END, id LIMIT 1
         )`,
        [
          delta.quantity,
          delta.quantity,
          delta.updatedAt,
          input.organizationId,
          delta.productId,
          delta.batchId,
          delta.batchId,
          delta.warehouseId,
          delta.warehouseId,
        ]
      )
    }
    for (const delta of input.batchDeltas) {
      await db.execute(
        `UPDATE stock_batches SET quantity = quantity + ?, sync_status = 'pending_update', updated_at = ?
         WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`,
        [delta.quantity, delta.updatedAt, input.organizationId, delta.batchId]
      )
    }
    for (let index = 0; index < input.restoreMovements.length; index += 1) {
      await upsert(db, "stock_movements", stockMovementRow(input.restoreMovements[index], input.organizationId, index))
    }
    await db.execute(
      `UPDATE sales_invoices SET deleted_at = ?, sync_status = 'pending_delete', updated_at = ?
       WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`,
      [input.deletedAt, input.deletedAt, input.organizationId, input.invoiceId]
    )
    await db.execute(
      `UPDATE sales_invoice_items SET deleted_at = ?, sync_status = 'pending_delete', updated_at = ?
       WHERE organization_id = ? AND invoice_id = ? AND deleted_at IS NULL`,
      [input.deletedAt, input.deletedAt, input.organizationId, input.invoiceId]
    )
    await db.execute(
      `UPDATE ledger_entries SET deleted_at = ?, sync_status = 'pending_delete', updated_at = ?
       WHERE organization_id = ? AND deleted_at IS NULL
         AND (document_id = ? OR document_id IN (
           SELECT id FROM payment_receipts WHERE organization_id = ? AND invoice_id = ?
         ))`,
      [input.deletedAt, input.deletedAt, input.organizationId, input.invoiceId, input.organizationId, input.invoiceId]
    )
    await db.execute(
      `UPDATE payment_receipts SET deleted_at = ?, sync_status = 'pending_delete', updated_at = ?
       WHERE organization_id = ? AND invoice_id = ? AND deleted_at IS NULL`,
      [input.deletedAt, input.deletedAt, input.organizationId, input.invoiceId]
    )
    await db.execute(
      `UPDATE payments SET deleted_at = ?, sync_status = 'pending_delete', updated_at = ?
       WHERE organization_id = ? AND document_id = ? AND deleted_at IS NULL`,
      [input.deletedAt, input.deletedAt, input.organizationId, input.invoiceId]
    )
    if (input.customerId) {
      await db.execute(
        `UPDATE customers
         SET total_sales = MAX(0, COALESCE(total_sales, 0) - ?),
             current_balance = MAX(0, COALESCE(current_balance, 0) - ?),
             last_purchase_at = ?, sync_status = 'pending_update', updated_at = ?
         WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`,
        [
          input.invoiceTotal,
          input.outstandingAmount,
          input.lastPurchaseAt,
          input.deletedAt,
          input.organizationId,
          input.customerId,
        ]
      )
    }
  })
}

export async function updateNormalizedInvoicePaymentStatus(
  organizationId: string,
  invoiceId: string,
  paymentStatus: string,
  updatedAt: string
) {
  const db = await service.requireConnection("read")
  const [invoice] = await db.select<DataRow>(
    `SELECT id, COALESCE(grand_total, total_amount, total, 0) AS invoice_total,
            COALESCE(paid_amount, 0) AS paid_amount
     FROM sales_invoices
     WHERE organization_id = ? AND id = ? AND deleted_at IS NULL
     LIMIT 1`,
    [organizationId, invoiceId]
  )
  if (!invoice) return false

  const invoiceTotal = Number(invoice.invoice_total || 0)
  const paidAmount = paymentStatus === "paid"
    ? invoiceTotal
    : paymentStatus === "unpaid"
      ? 0
      : Math.min(invoiceTotal, Number(invoice.paid_amount || 0))
  const outstandingAmount = Math.max(0, invoiceTotal - paidAmount)
  await service.transaction(async (tx) => {
    await tx.execute(
      `UPDATE sales_invoices
       SET payment_status = ?, status = ?, paid_amount = ?, outstanding_amount = ?,
           sync_status = 'pending_update', updated_at = ?
       WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`,
      [paymentStatus, paymentStatus, paidAmount, outstandingAmount, updatedAt, organizationId, invoiceId]
    )
  })
  return true
}

function listDirection(direction: NormalizedListQuery["direction"]) {
  return direction === "asc" ? "ASC" : "DESC"
}

function likeTerm(value: string) {
  return `%${value.trim()}%`
}

export async function queryNormalizedProducts(organizationId: string, query: NormalizedListQuery): Promise<NormalizedListPage> {
  const db = await service.requireConnection("read")
  const where = ["p.organization_id = ?", "p.deleted_at IS NULL"]
  const values: SqlValue[] = [organizationId]
  const search = query.search.trim()
  if (search) {
    const term = likeTerm(search)
    where.push("(p.name LIKE ? COLLATE NOCASE OR p.batch_no LIKE ? COLLATE NOCASE OR p.hsn_code LIKE ? COLLATE NOCASE OR p.sku LIKE ? COLLATE NOCASE OR p.category LIKE ? COLLATE NOCASE OR p.supplier LIKE ? COLLATE NOCASE OR p.barcode LIKE ? COLLATE NOCASE)")
    values.push(term, term, term, term, term, term, term)
  }
  if (query.category && query.category !== "all") {
    where.push("(p.category = ? OR p.category_id = ?)")
    values.push(query.category, query.category)
  }
  if (query.supplier && query.supplier !== "all") {
    where.push("(p.supplier = ? OR p.supplier_id = ?)")
    values.push(query.supplier, query.supplier)
  }
  if (query.stock === "inStock") where.push("p.stock > 0")
  if (query.stock === "outOfStock") where.push("p.stock <= 0")
  if (query.stock === "low") where.push("p.stock > 0 AND p.stock <= COALESCE(p.min_stock, 5)")

  const sortColumns: Record<string, string> = {
    created_at: "datetime(p.created_at)",
    updated_at: "datetime(p.updated_at)",
    name: "p.name COLLATE NOCASE",
    sku: "p.sku COLLATE NOCASE",
    category: "category_label COLLATE NOCASE",
    supplier: "supplier_label COLLATE NOCASE",
    warehouse: "warehouse_label COLLATE NOCASE",
    stock: "p.stock",
    price: "p.price",
    purchase_rate: "p.purchase_rate",
    sale_rate: "p.sale_rate",
  }
  const orderBy = sortColumns[query.sort] || sortColumns.created_at
  const whereSql = where.join(" AND ")
  const [summaryRow] = await db.select<Record<string, number>>(
    `SELECT
       COUNT(*) AS totalProducts,
       SUM(CASE WHEN COALESCE(p.stock, 0) <= COALESCE(p.min_stock, 5) THEN 1 ELSE 0 END) AS lowStockCount,
       SUM(CASE WHEN COALESCE(p.stock, 0) <= 0 THEN 1 ELSE 0 END) AS outOfStockCount,
       SUM(CASE WHEN p.expiry_date IS NOT NULL AND date(p.expiry_date) < date('now') THEN 1 ELSE 0 END) AS expiredCount,
       SUM(CASE WHEN p.expiry_date IS NOT NULL AND date(p.expiry_date) BETWEEN date('now') AND date('now', '+30 days') THEN 1 ELSE 0 END) AS expiringSoonCount,
       COALESCE(SUM(COALESCE(p.stock, 0) * COALESCE(NULLIF(p.sale_rate, 0), NULLIF(p.price, 0), p.mrp, 0)), 0) AS totalInventoryValue,
       COALESCE(SUM(COALESCE(p.stock, 0) * COALESCE(p.purchase_rate, 0)), 0) AS totalCostValue,
       COUNT(DISTINCT COALESCE(NULLIF(trim(p.category), ''), p.category_id)) AS categoriesCount,
       COUNT(DISTINCT COALESCE(NULLIF(trim(p.supplier), ''), p.supplier_id)) AS suppliersCount,
       COUNT(DISTINCT COALESCE(NULLIF(trim(p.warehouse), ''), p.warehouse_id)) AS warehousesCount
     FROM products p
     WHERE ${whereSql}`,
    values
  )
  const total = Number(summaryRow?.totalProducts || 0)
  const offset = (query.page - 1) * query.limit
  const [data, categories, suppliers] = await Promise.all([
    db.select<DataRow>(
    `SELECT
       p.*,
       COALESCE(c.name, p.category) AS category_label,
       COALESCE(c.name, p.category) AS category,
       COALESCE(s.name, p.supplier) AS supplier_label,
       COALESCE(s.name, p.supplier) AS supplier,
       COALESCE(w.name, p.warehouse, 'Main Warehouse') AS warehouse_label,
       COALESCE(w.name, p.warehouse, 'Main Warehouse') AS warehouse,
       COALESCE(p.stock, 0) * COALESCE(p.sale_rate, p.price, 0) AS inventory_value
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id AND c.organization_id = p.organization_id
     LEFT JOIN suppliers s ON s.id = p.supplier_id AND s.organization_id = p.organization_id
     LEFT JOIN warehouses w ON w.id = p.warehouse_id AND w.organization_id = p.organization_id
     WHERE ${whereSql}
     ORDER BY ${orderBy} ${listDirection(query.direction)}, p.id ${listDirection(query.direction)}
     LIMIT ? OFFSET ?`,
    [...values, query.limit, offset]
    ),
    db.select<{ value: string }>(
      "SELECT DISTINCT category AS value FROM products WHERE organization_id = ? AND deleted_at IS NULL AND category IS NOT NULL AND trim(category) <> '' ORDER BY category COLLATE NOCASE LIMIT 250",
      [organizationId]
    ),
    db.select<{ value: string }>(
      "SELECT DISTINCT supplier AS value FROM products WHERE organization_id = ? AND deleted_at IS NULL AND supplier IS NOT NULL AND trim(supplier) <> '' ORDER BY supplier COLLATE NOCASE LIMIT 250",
      [organizationId]
    ),
  ])
  const totalInventoryValue = Number(summaryRow?.totalInventoryValue || 0)
  const totalCostValue = Number(summaryRow?.totalCostValue || 0)
  return {
    data,
    total,
    summary: {
      ...summaryRow,
      totalProducts: total,
      totalInventoryValue,
      totalCostValue,
      totalPotentialProfit: totalInventoryValue - totalCostValue,
    },
    facets: {
      categories: categories.map((row) => row.value),
      suppliers: suppliers.map((row) => row.value),
    },
  }
}

export async function queryNormalizedCustomers(organizationId: string, query: NormalizedListQuery): Promise<NormalizedListPage> {
  const db = await service.requireConnection("read")
  const invoiceYearClause = query.financialYearId ? " AND financial_year_id = ?" : ""
  const invoiceYearValues: SqlValue[] = query.financialYearId ? [query.financialYearId] : []
  const where = ["c.organization_id = ?", "c.deleted_at IS NULL"]
  const values: SqlValue[] = [organizationId]
  const search = query.search.trim()
  if (search) {
    const term = likeTerm(search)
    where.push("(c.name LIKE ? COLLATE NOCASE OR c.email LIKE ? COLLATE NOCASE OR c.phone LIKE ? COLLATE NOCASE OR c.gst_number LIKE ? COLLATE NOCASE OR c.tax_id LIKE ? COLLATE NOCASE)")
    values.push(term, term, term, term, term)
  }
  if (query.status === "active") where.push("c.is_active = 1")
  if (query.status === "inactive") where.push("c.is_active = 0")
  if (query.customerType && query.customerType !== "all") {
    where.push("COALESCE(c.customer_type, 'retail') = ?")
    values.push(query.customerType)
  }
  if (query.gstStatus === "gst") where.push("COALESCE(NULLIF(trim(c.gst_number), ''), NULLIF(trim(c.tax_id), '')) IS NOT NULL")
  if (query.gstStatus === "nonGst") where.push("COALESCE(NULLIF(trim(c.gst_number), ''), NULLIF(trim(c.tax_id), '')) IS NULL")

  const sortColumns: Record<string, string> = {
    created_at: "datetime(c.created_at)",
    updated_at: "datetime(c.updated_at)",
    name: "c.name COLLATE NOCASE",
    total_sales: "total_sales",
    last_purchase_at: "last_purchase_at",
    invoice_count: "invoice_count",
  }
  const orderBy = sortColumns[query.sort] || sortColumns.created_at
  const whereSql = where.join(" AND ")
  const [summaryRow] = await db.select<Record<string, number>>(
    `SELECT
       COUNT(*) AS totalCustomers,
       COALESCE(SUM(c.total_sales), 0) AS totalRevenue,
       COALESCE(SUM(MAX(c.current_balance, 0)), 0) AS totalOutstanding,
       SUM(CASE WHEN c.is_active = 1 THEN 1 ELSE 0 END) AS activeCount,
       SUM(CASE WHEN c.is_active = 0 THEN 1 ELSE 0 END) AS inactiveCount,
       SUM(CASE WHEN COALESCE(NULLIF(trim(c.gst_number), ''), NULLIF(trim(c.tax_id), '')) IS NOT NULL THEN 1 ELSE 0 END) AS gstCount
     FROM customers c
     WHERE ${whereSql}`,
    values
  )
  if (query.financialYearId && summaryRow) {
    const [financialSummary] = await db.select<Record<string, number>>(
      `WITH filtered_customers AS (
         SELECT c.id FROM customers c WHERE ${whereSql}
       ), invoice_summary AS (
         SELECT COALESCE(SUM(COALESCE(invoice.grand_total, invoice.total_amount, invoice.total, 0)), 0) AS revenue
         FROM sales_invoices invoice
         WHERE invoice.organization_id = ? AND invoice.financial_year_id = ? AND invoice.deleted_at IS NULL
           AND invoice.customer_id IN (SELECT id FROM filtered_customers)
       ), opening AS (
         SELECT party_id, SUM(amount) AS amount FROM financial_year_opening_balances
         WHERE organization_id = ? AND financial_year_id = ? AND party_type = 'customer' AND balance_type = 'RECEIVABLE'
         GROUP BY party_id
       ), activity AS (
         SELECT account_id AS party_id, SUM(COALESCE(debit, 0) - COALESCE(credit, 0)) AS amount FROM ledger_entries
         WHERE organization_id = ? AND financial_year_id = ? AND account_type = 'customer' AND deleted_at IS NULL
         GROUP BY account_id
       )
       SELECT
         (SELECT revenue FROM invoice_summary) AS totalRevenue,
         COALESCE(SUM(MAX(0, COALESCE(opening.amount, 0) + COALESCE(activity.amount, 0))), 0) AS totalOutstanding
       FROM filtered_customers customer
       LEFT JOIN opening ON opening.party_id = customer.id
       LEFT JOIN activity ON activity.party_id = customer.id`,
      [...values, organizationId, query.financialYearId, organizationId, query.financialYearId, organizationId, query.financialYearId]
    )
    summaryRow.totalRevenue = Number(financialSummary?.totalRevenue || 0)
    summaryRow.totalOutstanding = Number(financialSummary?.totalOutstanding || 0)
  }
  const total = Number(summaryRow?.totalCustomers || 0)
  const offset = (query.page - 1) * query.limit
  const metricSort = ["total_sales", "last_purchase_at", "invoice_count"].includes(query.sort)
  const data = metricSort
    ? await db.select<DataRow>(
        `SELECT
           c.*,
           COALESCE(inv.invoice_count, 0) AS invoice_count,
           CASE WHEN COALESCE(inv.invoice_count, 0) > 0 THEN COALESCE(inv.invoice_revenue, 0) ELSE ${query.financialYearId ? "0" : "COALESCE(c.total_sales, 0)"} END AS total_sales,
           COALESCE(inv.last_purchase_at, c.last_purchase_at) AS last_purchase_at
         FROM customers c
         LEFT JOIN (
           SELECT customer_id,
                  COUNT(*) AS invoice_count,
                  SUM(COALESCE(grand_total, total_amount, total, 0)) AS invoice_revenue,
                  MAX(created_at) AS last_purchase_at
           FROM sales_invoices
           WHERE organization_id = ? AND deleted_at IS NULL${invoiceYearClause}
           GROUP BY customer_id
         ) inv ON inv.customer_id = c.id
         WHERE ${whereSql}
         ORDER BY ${orderBy} ${listDirection(query.direction)}, c.id ${listDirection(query.direction)}
         LIMIT ? OFFSET ?`,
        [organizationId, ...invoiceYearValues, ...values, query.limit, offset]
      )
    : await db.select<DataRow>(
        `WITH customer_page AS (
           SELECT c.*
           FROM customers c
           WHERE ${whereSql}
           ORDER BY ${orderBy} ${listDirection(query.direction)}, c.id ${listDirection(query.direction)}
           LIMIT ? OFFSET ?
         ), invoice_metrics AS (
           SELECT invoice.customer_id,
                  COUNT(*) AS invoice_count,
                  SUM(COALESCE(invoice.grand_total, invoice.total_amount, invoice.total, 0)) AS invoice_revenue,
                  MAX(invoice.created_at) AS last_purchase_at
           FROM sales_invoices invoice
           WHERE invoice.organization_id = ? AND invoice.deleted_at IS NULL${query.financialYearId ? " AND invoice.financial_year_id = ?" : ""}
             AND invoice.customer_id IN (SELECT id FROM customer_page)
           GROUP BY invoice.customer_id
         )
         SELECT
           page.*,
           COALESCE(metrics.invoice_count, 0) AS invoice_count,
           CASE WHEN COALESCE(metrics.invoice_count, 0) > 0 THEN COALESCE(metrics.invoice_revenue, 0) ELSE ${query.financialYearId ? "0" : "COALESCE(page.total_sales, 0)"} END AS total_sales,
           COALESCE(metrics.last_purchase_at, page.last_purchase_at) AS last_purchase_at
         FROM customer_page page
         LEFT JOIN invoice_metrics metrics ON metrics.customer_id = page.id
         ORDER BY ${query.sort === "name" ? "page.name COLLATE NOCASE" : query.sort === "updated_at" ? "datetime(page.updated_at)" : "datetime(page.created_at)"} ${listDirection(query.direction)}, page.id ${listDirection(query.direction)}`,
        [...values, query.limit, offset, organizationId, ...invoiceYearValues]
      )
  return { data, total, summary: { ...summaryRow, totalCustomers: total } }
}

export async function queryNormalizedInvoices(organizationId: string, query: NormalizedListQuery): Promise<NormalizedListPage> {
  const db = await service.requireConnection("read")
  const where = ["i.organization_id = ?", "i.deleted_at IS NULL"]
  const values: SqlValue[] = [organizationId]
  if (query.financialYearId) {
    where.push("i.financial_year_id = ?")
    values.push(query.financialYearId)
  }
  const search = query.search.trim()
  if (search) {
    const term = likeTerm(search)
    where.push("(i.invoice_number LIKE ? COLLATE NOCASE OR i.display_invoice_number LIKE ? COLLATE NOCASE OR i.payment_method LIKE ? COLLATE NOCASE OR COALESCE(i.customer_name, c.name) LIKE ? COLLATE NOCASE OR i.notes LIKE ? COLLATE NOCASE)")
    values.push(term, term, term, term, term)
  }
  if (query.status && query.status !== "all") {
    where.push("(i.payment_status = ? OR i.status = ?)")
    values.push(query.status, query.status)
  }
  if (query.customerId && query.customerId !== "all") {
    where.push("i.customer_id = ?")
    values.push(query.customerId)
  }
  if (query.period && query.period !== "all") {
    const now = new Date()
    let cutoff: Date | null = null
    if (query.period === "today") cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    if (query.period === "week") cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    if (query.period === "month") cutoff = new Date(now.getFullYear(), now.getMonth(), 1)
    if (cutoff) {
      where.push("datetime(i.created_at) >= datetime(?)")
      values.push(cutoff.toISOString())
    }
  }

  const sortColumns: Record<string, string> = {
    created_at: "datetime(i.created_at)",
    updated_at: "datetime(i.updated_at)",
    invoice_date: "i.invoice_date",
    date: "i.date",
    invoice_number: "i.invoice_number COLLATE NOCASE",
    customer_name: "COALESCE(i.customer_name, c.name) COLLATE NOCASE",
    total_amount: "i.total_amount",
    grand_total: "i.grand_total",
    paid_amount: "i.paid_amount",
    outstanding_amount: "i.outstanding_amount",
    payment_status: "i.payment_status",
    status: "i.status",
  }
  const orderBy = sortColumns[query.sort] || sortColumns.created_at
  const whereSql = where.join(" AND ")
  const [summaryRow] = await db.select<Record<string, number>>(
    `SELECT
       COUNT(*) AS invoiceCount,
       COALESCE(SUM(COALESCE(i.grand_total, i.total_amount, i.total, 0)), 0) AS revenue,
       COALESCE(SUM(COALESCE(i.tax_amount, i.tax_total, 0)), 0) AS tax,
       COALESCE(SUM(COALESCE(NULLIF(i.paid_amount, 0), CASE WHEN lower(COALESCE(i.payment_status, i.status, '')) IN ('paid', 'completed', 'success') THEN COALESCE(i.grand_total, i.total_amount, i.total, 0) ELSE 0 END)), 0) AS paidRevenue,
       COALESCE(SUM(CASE
         WHEN lower(COALESCE(i.payment_status, i.status, 'unpaid')) IN ('paid', 'completed', 'success') THEN 0
         ELSE COALESCE(NULLIF(i.outstanding_amount, 0), MAX(0, COALESCE(i.grand_total, i.total_amount, i.total, 0) - COALESCE(i.paid_amount, 0)))
       END), 0) AS outstanding,
       SUM(CASE WHEN lower(COALESCE(i.payment_status, i.status, 'unpaid')) IN ('paid', 'completed', 'success') THEN 1 ELSE 0 END) AS paidCount,
       SUM(CASE WHEN lower(COALESCE(i.payment_status, i.status, 'unpaid')) = 'partial' THEN 1 ELSE 0 END) AS partialCount,
       SUM(CASE WHEN lower(COALESCE(i.payment_status, i.status, 'unpaid')) IN ('unpaid', 'pending', 'overdue', '') THEN 1 ELSE 0 END) AS unpaidCount,
       SUM(CASE WHEN date(i.due_date) < date('now') AND lower(COALESCE(i.payment_status, i.status, 'unpaid')) NOT IN ('paid', 'completed', 'success', 'cancelled') THEN 1 ELSE 0 END) AS overdueCount,
       SUM(CASE WHEN date(COALESCE(i.invoice_date, i.date, i.created_at)) = date('now') THEN 1 ELSE 0 END) AS todayCount
     FROM sales_invoices i
     LEFT JOIN customers c ON c.id = i.customer_id AND c.organization_id = i.organization_id
     WHERE ${whereSql}`,
    values
  )
  const total = Number(summaryRow?.invoiceCount || 0)
  const offset = (query.page - 1) * query.limit
  const data = await db.select<DataRow>(
    `WITH invoice_page AS (
       SELECT
         i.*,
         COALESCE(i.customer_name, c.name) AS resolved_customer_name,
         c.phone AS customer_phone,
         c.email AS customer_email
       FROM sales_invoices i
       LEFT JOIN customers c ON c.id = i.customer_id AND c.organization_id = i.organization_id
       WHERE ${whereSql}
       ORDER BY ${orderBy} ${listDirection(query.direction)}, i.id ${listDirection(query.direction)}
       LIMIT ? OFFSET ?
     ), item_metrics AS (
       SELECT item.invoice_id,
              COUNT(*) AS item_count,
              SUM(COALESCE(item.quantity, 0)) AS total_quantity,
              SUM(COALESCE(item.gst_amount, 0)) AS item_tax,
              SUM(COALESCE(item.line_total, 0)) AS item_total
       FROM sales_invoice_items item
       WHERE item.organization_id = ? AND item.deleted_at IS NULL
         AND item.invoice_id IN (SELECT id FROM invoice_page)
       GROUP BY item.invoice_id
     )
     SELECT
       page.*,
       page.resolved_customer_name AS customer_name,
       COALESCE(metrics.item_count, 0) AS item_count,
       COALESCE(metrics.total_quantity, 0) AS total_quantity,
       COALESCE(metrics.item_tax, 0) AS item_tax,
       COALESCE(metrics.item_total, 0) AS item_total
     FROM invoice_page page
     LEFT JOIN item_metrics metrics ON metrics.invoice_id = page.id
     ORDER BY ${query.sort === "invoice_number" ? "page.invoice_number COLLATE NOCASE" : query.sort === "customer_name" ? "page.resolved_customer_name COLLATE NOCASE" : query.sort === "invoice_date" ? "page.invoice_date" : query.sort === "date" ? "page.date" : query.sort === "updated_at" ? "datetime(page.updated_at)" : query.sort === "total_amount" ? "page.total_amount" : query.sort === "grand_total" ? "page.grand_total" : query.sort === "paid_amount" ? "page.paid_amount" : query.sort === "outstanding_amount" ? "page.outstanding_amount" : query.sort === "payment_status" ? "page.payment_status" : query.sort === "status" ? "page.status" : "datetime(page.created_at)"} ${listDirection(query.direction)}, page.id ${listDirection(query.direction)}`,
    [...values, query.limit, offset, organizationId]
  )
  const revenue = Number(summaryRow?.revenue || 0)
  const paidRevenue = Number(summaryRow?.paidRevenue || 0)
  return {
    data: data.map((row) => {
      const output: DataRow = {
        ...row,
        database_invoice_number: row.invoice_number,
        invoice_number: row.display_invoice_number || row.invoice_number,
      }
      delete output.resolved_customer_name
      return output
    }),
    total,
    summary: {
      ...summaryRow,
      invoiceCount: total,
      revenue,
      paidRevenue,
      averageInvoice: total ? revenue / total : 0,
      collectionRate: revenue ? Math.round((paidRevenue / revenue) * 100) : 0,
    },
  }
}

export async function queryNormalizedDashboardSummary(organizationId: string, financialYearId?: string | null) {
  const db = await service.requireConnection("read")
  const financialYearClause = financialYearId ? " AND financial_year_id = ?" : ""
  const aliasedFinancialYearClause = financialYearId ? " AND invoice.financial_year_id = ?" : ""
  const financialYearValues: SqlValue[] = financialYearId ? [organizationId, financialYearId] : [organizationId]
  const [invoiceRows, productRows, customerRows, warehouseRows, weeklyRevenue, recentProducts, lowStockProducts, recentInvoices, recentMovements] = await Promise.all([
    db.select<DataRow>(
      `SELECT
         COUNT(*) AS invoiceCount,
         COALESCE(SUM(COALESCE(grand_total, total_amount, total, 0)), 0) AS totalRevenue,
         COALESCE(SUM(CASE WHEN date(COALESCE(invoice_date, date, created_at)) = date('now', 'localtime') THEN COALESCE(grand_total, total_amount, total, 0) ELSE 0 END), 0) AS todayRevenue,
         COALESCE(SUM(COALESCE(NULLIF(paid_amount, 0), CASE WHEN lower(COALESCE(payment_status, status, '')) IN ('paid', 'completed', 'success') THEN COALESCE(grand_total, total_amount, total, 0) ELSE 0 END)), 0) AS paidRevenue,
         SUM(CASE WHEN lower(COALESCE(payment_status, status, 'unpaid')) IN ('unpaid', 'pending', 'overdue', 'partial', '') THEN 1 ELSE 0 END) AS pendingInvoices
       FROM sales_invoices
       WHERE organization_id = ? AND deleted_at IS NULL${financialYearClause}`,
      financialYearValues
    ),
    db.select<DataRow>(
      `SELECT
         COUNT(*) AS productCount,
         SUM(CASE WHEN COALESCE(stock, 0) <= COALESCE(min_stock, 5) THEN 1 ELSE 0 END) AS lowStockCount,
         SUM(CASE WHEN COALESCE(stock, 0) <= 0 THEN 1 ELSE 0 END) AS outOfStockCount,
         COALESCE(SUM(COALESCE(stock, 0) * COALESCE(NULLIF(sale_rate, 0), NULLIF(price, 0), mrp, purchase_rate, 0)), 0) AS inventoryValue,
         COALESCE(SUM(COALESCE(stock, 0) * COALESCE(purchase_rate, 0)), 0) AS costValue
       FROM products
       WHERE organization_id = ? AND deleted_at IS NULL`,
      [organizationId]
    ),
    db.select<DataRow>("SELECT COUNT(*) AS customerCount FROM customers WHERE organization_id = ? AND deleted_at IS NULL", [organizationId]),
    db.select<DataRow>("SELECT COUNT(*) AS warehouseCount FROM warehouses WHERE organization_id = ? AND deleted_at IS NULL", [organizationId]),
    db.select<DataRow>(
      `SELECT strftime('%w', COALESCE(invoice_date, date, created_at)) AS weekday,
              COALESCE(SUM(COALESCE(grand_total, total_amount, total, 0)), 0) AS value
       FROM sales_invoices
       WHERE organization_id = ? AND deleted_at IS NULL
         ${financialYearClause}
         AND date(COALESCE(invoice_date, date, created_at)) >= date('now', 'localtime', '-6 days')
       GROUP BY weekday`,
      financialYearValues
    ),
    db.select<DataRow>("SELECT * FROM products WHERE organization_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 5", [organizationId]),
    db.select<DataRow>("SELECT * FROM products WHERE organization_id = ? AND deleted_at IS NULL AND COALESCE(stock, 0) <= COALESCE(min_stock, 5) ORDER BY stock ASC, updated_at DESC LIMIT 5", [organizationId]),
    db.select<DataRow>(
      `SELECT invoice.*, COALESCE(invoice.customer_name, customer.name) AS customer_name,
              customer.phone AS customer_phone, customer.email AS customer_email
       FROM sales_invoices invoice
       LEFT JOIN customers customer ON customer.id = invoice.customer_id AND customer.organization_id = invoice.organization_id
       WHERE invoice.organization_id = ? AND invoice.deleted_at IS NULL${aliasedFinancialYearClause}
       ORDER BY invoice.created_at DESC, invoice.id DESC LIMIT 5`,
      financialYearValues
    ),
    db.select<DataRow>(`SELECT * FROM stock_movements WHERE organization_id = ? AND deleted_at IS NULL${financialYearClause} ORDER BY created_at DESC, id DESC LIMIT 12`, financialYearValues),
  ])
  const invoices = invoiceRows[0] || {}
  const products = productRows[0] || {}
  const invoiceCount = Number(invoices.invoiceCount || 0)
  const productCount = Number(products.productCount || 0)
  const totalRevenue = Number(invoices.totalRevenue || 0)
  const paidRevenue = Number(invoices.paidRevenue || 0)
  const lowStockCount = Number(products.lowStockCount || 0)
  const pendingInvoices = Number(invoices.pendingInvoices || 0)
  const inventoryHealth = productCount ? Math.round(((productCount - lowStockCount) / productCount) * 100) : 100
  const collectionRate = totalRevenue ? Math.round((paidRevenue / totalRevenue) * 100) : 0
  const erpHealth = Math.max(0, Math.min(100, Math.round(inventoryHealth * 0.45 + collectionRate * 0.4 + (pendingInvoices === 0 ? 15 : Math.max(0, 15 - pendingInvoices * 2)))))
  const byWeekday = new Map(weeklyRevenue.map((row) => [Number(row.weekday), Number(row.value || 0)]))
  const weekLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

  return {
    metrics: {
      totalRevenue,
      todayRevenue: Number(invoices.todayRevenue || 0),
      paidRevenue,
      pendingInvoices,
      productCount,
      lowStockCount,
      outOfStockCount: Number(products.outOfStockCount || 0),
      inventoryValue: Number(products.inventoryValue || 0),
      costValue: Number(products.costValue || 0),
      potentialProfit: Number(products.inventoryValue || 0) - Number(products.costValue || 0),
      inventoryHealth,
      collectionRate,
      erpHealth,
      customerCount: Number(customerRows[0]?.customerCount || 0),
      warehouseCount: Number(warehouseRows[0]?.warehouseCount || 0),
      invoiceCount,
      weeklyRevenue: weekLabels.map((label, index) => ({ label, value: byWeekday.get(index === 6 ? 0 : index + 1) || 0 })),
    },
    recentProducts,
    lowStockProducts,
    recentInvoices,
    recentMovements,
  }
}

export async function queryNormalizedBillingSummary(organizationId: string, financialYearId?: string | null) {
  const db = await service.requireConnection("read")
  const financialYearClause = financialYearId ? " AND financial_year_id = ?" : ""
  const aliasedFinancialYearClause = financialYearId ? " AND invoice.financial_year_id = ?" : ""
  const financialYearValues: SqlValue[] = financialYearId ? [organizationId, financialYearId] : [organizationId]
  const [invoiceRows, productRows, customerRows, weeklyRevenue, recentInvoices] = await Promise.all([
    db.select<DataRow>(
      `SELECT
         COUNT(*) AS invoiceCount,
         COALESCE(SUM(COALESCE(grand_total, total_amount, total, 0)), 0) AS revenue,
         COALESCE(SUM(CASE WHEN strftime('%Y-%m', COALESCE(invoice_date, date, created_at)) = strftime('%Y-%m', 'now', 'localtime') THEN COALESCE(grand_total, total_amount, total, 0) ELSE 0 END), 0) AS monthlyRevenue,
         COALESCE(SUM(COALESCE(NULLIF(paid_amount, 0), CASE WHEN lower(COALESCE(payment_status, status, '')) IN ('paid', 'completed', 'success') THEN COALESCE(grand_total, total_amount, total, 0) ELSE 0 END)), 0) AS paidRevenue,
         COALESCE(SUM(CASE WHEN lower(COALESCE(payment_status, status, 'unpaid')) NOT IN ('paid', 'completed', 'success', 'cancelled') THEN COALESCE(NULLIF(outstanding_amount, 0), MAX(0, COALESCE(grand_total, total_amount, total, 0) - COALESCE(paid_amount, 0))) ELSE 0 END), 0) AS outstanding,
         COALESCE(SUM(COALESCE(tax_amount, tax_total, 0)), 0) AS tax,
         SUM(CASE WHEN lower(COALESCE(payment_status, status, 'unpaid')) IN ('paid', 'completed', 'success') THEN 1 ELSE 0 END) AS paidCount,
         SUM(CASE WHEN lower(COALESCE(payment_status, status, 'unpaid')) IN ('unpaid', 'pending', 'overdue', '') THEN 1 ELSE 0 END) AS unpaidCount,
         SUM(CASE WHEN lower(COALESCE(payment_status, status, 'unpaid')) = 'partial' THEN 1 ELSE 0 END) AS partialCount,
         SUM(CASE WHEN lower(COALESCE(payment_status, status, 'unpaid')) NOT IN ('paid', 'completed', 'success', 'cancelled') THEN 1 ELSE 0 END) AS openInvoices
       FROM sales_invoices
       WHERE organization_id = ? AND deleted_at IS NULL${financialYearClause}`,
      financialYearValues
    ),
    db.select<DataRow>(
      `SELECT COUNT(*) AS productCount,
              SUM(CASE WHEN COALESCE(stock, 0) <= COALESCE(min_stock, 5) THEN 1 ELSE 0 END) AS lowStockCount,
              COALESCE(SUM(COALESCE(stock, 0) * COALESCE(NULLIF(sale_rate, 0), NULLIF(price, 0), mrp, 0)), 0) AS inventoryValue
       FROM products WHERE organization_id = ? AND deleted_at IS NULL`,
      [organizationId]
    ),
    db.select<DataRow>("SELECT COUNT(*) AS customerCount FROM customers WHERE organization_id = ? AND deleted_at IS NULL", [organizationId]),
    db.select<DataRow>(
      `SELECT date(COALESCE(invoice_date, date, created_at)) AS day,
              COALESCE(SUM(COALESCE(grand_total, total_amount, total, 0)), 0) AS total
       FROM sales_invoices
       WHERE organization_id = ? AND deleted_at IS NULL
         ${financialYearClause}
         AND date(COALESCE(invoice_date, date, created_at)) >= date('now', 'localtime', '-6 days')
       GROUP BY day ORDER BY day ASC`,
      financialYearValues
    ),
    db.select<DataRow>(
      `SELECT invoice.*, COALESCE(invoice.customer_name, customer.name) AS customer_name,
              customer.phone AS customer_phone, customer.email AS customer_email
       FROM sales_invoices invoice
       LEFT JOIN customers customer ON customer.id = invoice.customer_id AND customer.organization_id = invoice.organization_id
       WHERE invoice.organization_id = ? AND invoice.deleted_at IS NULL${aliasedFinancialYearClause}
       ORDER BY invoice.created_at DESC, invoice.id DESC LIMIT 10`,
      financialYearValues
    ),
  ])
  const invoice = invoiceRows[0] || {}
  const product = productRows[0] || {}
  const invoiceCount = Number(invoice.invoiceCount || 0)
  const revenue = Number(invoice.revenue || 0)
  const paidRevenue = Number(invoice.paidRevenue || 0)
  const dayTotals = new Map(weeklyRevenue.map((row) => [String(row.day), Number(row.total || 0)]))
  const week = Array.from({ length: 7 }, (_, index) => {
    const date = new Date()
    date.setHours(12, 0, 0, 0)
    date.setDate(date.getDate() - (6 - index))
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
    return { label: date.toLocaleDateString(undefined, { weekday: "short" }), total: dayTotals.get(key) || 0 }
  })
  return {
    currency: "INR",
    locale: "en-IN",
    timezone: "Asia/Kolkata",
    metrics: {
      invoiceCount,
      revenue,
      monthlyRevenue: Number(invoice.monthlyRevenue || 0),
      paidRevenue,
      outstanding: Number(invoice.outstanding || 0),
      tax: Number(invoice.tax || 0),
      inventoryValue: Number(product.inventoryValue || 0),
      averageInvoice: invoiceCount ? revenue / invoiceCount : 0,
      collectionRate: revenue ? Math.round((paidRevenue / revenue) * 100) : 0,
      openInvoices: Number(invoice.openInvoices || 0),
      paidCount: Number(invoice.paidCount || 0),
      unpaidCount: Number(invoice.unpaidCount || 0),
      partialCount: Number(invoice.partialCount || 0),
      lowStockCount: Number(product.lowStockCount || 0),
      customerCount: Number(customerRows[0]?.customerCount || 0),
      productCount: Number(product.productCount || 0),
    },
    weeklyRevenue: week,
    recentInvoices,
  }
}

export async function queryNormalizedAnalyticsReport(organizationId: string, financialYearId?: string | null) {
  const db = await service.requireConnection("read")
  const financialYearClause = financialYearId ? " AND financial_year_id = ?" : ""
  const financialYearValues: SqlValue[] = financialYearId ? [organizationId, financialYearId] : [organizationId]
  const [invoiceRows, productRows, customerRows, weeklyRevenue, categories, productProfit] = await Promise.all([
    db.select<DataRow>(
      `SELECT COUNT(*) AS invoiceCount,
              COALESCE(SUM(COALESCE(grand_total, total_amount, total, 0)), 0) AS totalRevenue,
              COALESCE(SUM(COALESCE(NULLIF(paid_amount, 0), CASE WHEN lower(COALESCE(payment_status, status, '')) IN ('paid', 'completed', 'success') THEN COALESCE(grand_total, total_amount, total, 0) ELSE 0 END)), 0) AS paidRevenue,
              SUM(CASE WHEN lower(COALESCE(payment_status, status, 'unpaid')) IN ('paid', 'completed', 'success') THEN 1 ELSE 0 END) AS paidCount,
              SUM(CASE WHEN lower(COALESCE(payment_status, status, 'unpaid')) NOT IN ('paid', 'completed', 'success', 'cancelled') THEN 1 ELSE 0 END) AS unpaidCount
       FROM sales_invoices WHERE organization_id = ? AND deleted_at IS NULL${financialYearClause}`,
      financialYearValues
    ),
    db.select<DataRow>(
      `SELECT COUNT(*) AS productCount,
              COALESCE(SUM(COALESCE(stock, 0) * COALESCE(NULLIF(sale_rate, 0), NULLIF(price, 0), purchase_rate, 0)), 0) AS inventoryValue,
              COALESCE(SUM(COALESCE(stock, 0) * COALESCE(purchase_rate, 0)), 0) AS costValue,
              SUM(CASE WHEN COALESCE(stock, 0) <= COALESCE(min_stock, 5) THEN 1 ELSE 0 END) AS lowStockCount,
              SUM(CASE WHEN expiry_date IS NOT NULL AND date(expiry_date) < date('now', 'localtime') THEN 1 ELSE 0 END) AS expiredCount,
              SUM(CASE WHEN expiry_date IS NOT NULL AND date(expiry_date) BETWEEN date('now', 'localtime') AND date('now', 'localtime', '+30 days') THEN 1 ELSE 0 END) AS expiringSoonCount
       FROM products WHERE organization_id = ? AND deleted_at IS NULL`,
      [organizationId]
    ),
    db.select<DataRow>("SELECT COUNT(*) AS customerCount FROM customers WHERE organization_id = ? AND deleted_at IS NULL", [organizationId]),
    db.select<DataRow>(
      `SELECT date(COALESCE(invoice_date, date, created_at)) AS day,
              COALESCE(SUM(COALESCE(grand_total, total_amount, total, 0)), 0) AS revenue
       FROM sales_invoices
       WHERE organization_id = ? AND deleted_at IS NULL
         ${financialYearClause}
         AND date(COALESCE(invoice_date, date, created_at)) >= date('now', 'localtime', '-6 days')
       GROUP BY day ORDER BY day`,
      financialYearValues
    ),
    db.select<DataRow>(
      `SELECT COALESCE(NULLIF(trim(category), ''), 'General') AS name,
              COALESCE(SUM(stock), 0) AS stock,
              COALESCE(SUM(COALESCE(stock, 0) * COALESCE(NULLIF(sale_rate, 0), NULLIF(price, 0), 0)), 0) AS value
       FROM products WHERE organization_id = ? AND deleted_at IS NULL
       GROUP BY name ORDER BY value DESC LIMIT 6`,
      [organizationId]
    ),
    db.select<DataRow>(
      `SELECT COALESCE(NULLIF(trim(name), ''), 'Product') AS name,
              COALESCE(NULLIF(sale_rate, 0), price, 0) - COALESCE(purchase_rate, 0) AS profit,
              COALESCE(stock, 0) AS stock
       FROM products WHERE organization_id = ? AND deleted_at IS NULL
       ORDER BY profit DESC, id LIMIT 8`,
      [organizationId]
    ),
  ])
  const invoice = invoiceRows[0] || {}
  const product = productRows[0] || {}
  const productCount = Number(product.productCount || 0)
  const inventoryValue = Number(product.inventoryValue || 0)
  const costValue = Number(product.costValue || 0)
  const totalRevenue = Number(invoice.totalRevenue || 0)
  const paidRevenue = Number(invoice.paidRevenue || 0)
  const dayTotals = new Map(weeklyRevenue.map((row) => [String(row.day), Number(row.revenue || 0)]))
  const week = Array.from({ length: 7 }, (_, index) => {
    const date = new Date()
    date.setHours(12, 0, 0, 0)
    date.setDate(date.getDate() - (6 - index))
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
    return { label: date.toLocaleDateString(undefined, { weekday: "short" }), revenue: dayTotals.get(key) || 0 }
  })
  return {
    metrics: {
      totalRevenue,
      inventoryValue,
      costValue,
      potentialProfit: inventoryValue - costValue,
      productCount,
      customerCount: Number(customerRows[0]?.customerCount || 0),
      invoiceCount: Number(invoice.invoiceCount || 0),
      paidRevenue,
      paidCount: Number(invoice.paidCount || 0),
      unpaidCount: Number(invoice.unpaidCount || 0),
      lowStockCount: Number(product.lowStockCount || 0),
      expiredCount: Number(product.expiredCount || 0),
      expiringSoonCount: Number(product.expiringSoonCount || 0),
      collectionRate: totalRevenue ? Math.round((paidRevenue / totalRevenue) * 100) : 0,
      stockHealth: productCount ? Math.round(((productCount - Number(product.lowStockCount || 0)) / productCount) * 100) : 0,
    },
    weeklyRevenue: week,
    categories,
    productProfit,
  }
}

export async function getNormalizedCollection(organizationId: string, collection: OfflineCollection) {
  const db = await service.requireConnection("read")
  const financialTable = financialCollectionTables[collection]
  if (financialTable) {
    return db.select<DataRow>(`SELECT * FROM ${financialTable} WHERE organization_id = ? ORDER BY ${collectionOrder[collection] || "created_at DESC"}`, [organizationId])
  }
  if (collection === "products" || collection === "inventory_items") return repositories.products.list(organizationId, db)
  if (collection === "customers") return repositories.customers.list(organizationId, db)
  if (collection === "suppliers") return repositories.suppliers.list(organizationId, db)
  if (collection === "invoices") return repositories.invoices.list(organizationId, db)
  if (collection === "invoice_items") return repositories.invoices.listItems(organizationId, db)
  if (collection === "purchase_invoices") return repositories.purchases.list(organizationId, db)
  if (collection === "purchase_items") return repositories.purchases.listItems(organizationId, db)
  if (collection === "orders") return repositories.orders.list(organizationId, db)
  if (collection === "order_items") return repositories.orders.listItems(organizationId, db)
  if (collection === "expenses") return repositories.expenses.list(organizationId, db)
  if (collection === "payments") return repositories.payments.list(organizationId, db)
  if (collection === "payment_receipts") return repositories.payments.listReceipts(organizationId, db)
  if (collection === "ledger_entries") return repositories.payments.listLedgerEntries(organizationId, db)
  if (collection === "chart_of_accounts") return repositories.accounting.listAccounts(organizationId, db)
  if (collection === "accounting_vouchers") return repositories.accounting.listVouchers(organizationId, db)
  if (collection === "accounting_voucher_entries") return repositories.accounting.listVoucherEntries(organizationId, db)
  if (collection === "bank_accounts") return repositories.accounting.listBankAccounts(organizationId, db)
  if (collection === "license") return repositories.license.list(organizationId, db)
  if (collection === "audit_logs") return repositories.audit.list(organizationId, db)
  if (documentRepositories[collection]) return documentRepositories[collection]?.list(organizationId, db) || []
  if (collection === "stock_movements") return repositories.inventory.list(organizationId, db)
  if (collection === "organization") return repositories.settings.readOrganization(organizationId, db)
  if (collection === "settings" || collection === "workspace") return repositories.settings.readSettings(organizationId, db)
  if (collection === "profiles") return repositories.settings.readProfiles(organizationId, db)
  if (collection === "organization_members") return repositories.settings.readMembers(organizationId, db)
  return []
}

function flatten(value: unknown, path = "", output: FieldValue[] = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, path ? `${path}.${index}` : String(index), output))
    if (value.length === 0 && path) output.push({ field_path: path, value_text: null, value_number: null, value_boolean: null, value_type: "array" })
    return output
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as DataRow)
    if (entries.length === 0 && path) output.push({ field_path: path, value_text: null, value_number: null, value_boolean: null, value_type: "object" })
    entries.forEach(([key, item]) => flatten(item, path ? `${path}.${key}` : key, output))
    return output
  }

  if (!path) return output

  if (value === null || value === undefined) {
    output.push({ field_path: path, value_text: null, value_number: null, value_boolean: null, value_type: "null" })
  } else if (typeof value === "number") {
    output.push({ field_path: path, value_text: null, value_number: Number.isFinite(value) ? value : null, value_boolean: null, value_type: "number" })
  } else if (typeof value === "boolean") {
    output.push({ field_path: path, value_text: null, value_number: null, value_boolean: value ? 1 : 0, value_type: "boolean" })
  } else {
    output.push({ field_path: path, value_text: String(value), value_number: null, value_boolean: null, value_type: "string" })
  }

  return output
}

async function replaceFields(db: SqlExecutor, ownerTable: string, ownerId: string, fields: FieldValue[]) {
  await db.execute(`DELETE FROM ${ownerTable} WHERE ${ownerTable.includes("action") ? "action_id" : ownerTable.includes("conflict") ? "conflict_id" : "log_id"} = ?`, [ownerId])
  const ownerColumn = ownerTable.includes("action") ? "action_id" : ownerTable.includes("conflict") ? "conflict_id" : "log_id"
  for (const field of fields) {
    await db.execute(
      `INSERT INTO ${ownerTable} (${ownerColumn}, field_path, value_text, value_number, value_boolean, value_type)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [ownerId, field.field_path, field.value_text, field.value_number, field.value_boolean, field.value_type]
    )
  }
}

async function queueNormalizedActionWithDb(db: SqlExecutor, action: OfflineAction) {
  void db
  void action
}

export async function queueNormalizedAction(action: OfflineAction) {
  await service.transaction(async (db) => {
    await queueNormalizedActionWithDb(db, action)
  })
}

export async function listNormalizedActions(statuses?: OfflineActionStatus[]) {
  void statuses
  return [] as OfflineAction[]
}

export async function updateNormalizedAction(id: string, patch: Partial<OfflineAction>) {
  void id
  void patch
  return null
}

export async function writeNormalizedSyncLog(input: {
  id: string
  organizationId?: string | null
  actionId?: string | null
  status: string
  message?: string | null
  payload?: Record<string, unknown> | null
}) {
  await service.transaction(async (db) => {
    if (input.organizationId) await ensureOrganization(db, input.organizationId)
    await db.execute(
      `INSERT INTO offline_sync_logs (id, organization_id, action_id, status, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.id, input.organizationId || null, input.actionId || null, input.status, input.message || null, nowIso()]
    )
    await replaceFields(db, "offline_sync_log_fields", input.id, flatten(input.payload || {}))
  })
}

export async function writeNormalizedConflict(input: {
  id: string
  organizationId: string
  entityType: string
  localId?: string | null
  serverId?: string | null
  localPayload?: Record<string, unknown> | null
  serverPayload?: Record<string, unknown> | null
  message: string
}) {
  await service.transaction(async (db) => {
    await ensureOrganization(db, input.organizationId)
    await db.execute(
      `INSERT INTO offline_sync_conflicts (
        id, organization_id, entity_type, local_id, server_id, message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.id, input.organizationId, input.entityType, input.localId || null, input.serverId || null, input.message, nowIso()]
    )
    await replaceFields(db, "offline_sync_conflict_fields", input.id, flatten({ local: input.localPayload || {}, server: input.serverPayload || {} }))
  })
}

export async function setNormalizedMeta(key: string, value: unknown, organizationId = "global") {
  await service.transaction(async (db) => {
    await ensureOrganization(db, organizationId)
    const valueType = typeof value
    await upsert(db, "business_settings", {
      id: `meta:${organizationId}:${key}`,
      organization_id: organizationId,
      key,
      value_text: valueType === "string" ? String(value) : null,
      value_number: valueType === "number" ? (value as number) : null,
      value_boolean: valueType === "boolean" ? ((value as boolean) ? 1 : 0) : null,
      updated_at: nowIso(),
    })
  })
}

export async function getNormalizedMeta<T>(key: string, fallback: T, organizationId = "global") {
  const db = await service.requireConnection("read")
  const rows = await db.select<DataRow>("SELECT value_text, value_number, value_boolean FROM business_settings WHERE organization_id = ? AND key = ? LIMIT 1", [
    organizationId,
    key,
  ])
  const row = rows[0]
  if (!row) return fallback
  const value = row.value_text ?? row.value_number ?? row.value_boolean
  return (typeof fallback === "boolean" && typeof value === "number" ? Boolean(value) : value ?? fallback) as T
}

export async function clearNormalizedData() {
  await service.transaction(async (db) => {
    for (const table of [...normalizedTables].reverse()) {
      await db.execute(`DELETE FROM ${table}`).catch(() => undefined)
    }
  })
}

export async function mergeNormalizedOrganization(sourceOrganizationId: string, targetOrganizationId: string) {
  if (!sourceOrganizationId || !targetOrganizationId || sourceOrganizationId === targetOrganizationId) return
  const businessTables = [
    "financial_years",
    "financial_year_invoice_sequences",
    "products",
    "inventory_items",
    "stock_batches",
    "financial_year_opening_balances",
    "financial_year_inventory_openings",
    "stock_movements",
    "customers",
    "suppliers",
    "sales_invoices",
    "sales_invoice_items",
    "purchase_invoices",
    "purchase_invoice_items",
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
    "accounting_vouchers",
    "accounting_voucher_entries",
    "bank_accounts",
    "print_templates",
    "backup_manifest",
  ]
  await service.transaction(async (db) => {
    await ensureOrganization(db, targetOrganizationId)
    await db.execute("PRAGMA defer_foreign_keys = ON")
    const yearStates = await db.select<{ id: string; status: string }>("SELECT id, status FROM financial_years WHERE organization_id = ?", [sourceOrganizationId])
    await db.execute("UPDATE financial_years SET status = 'OPEN' WHERE organization_id = ?", [sourceOrganizationId])
    for (const table of businessTables) {
      await db.execute(`UPDATE ${table} SET organization_id = ? WHERE organization_id = ?`, [targetOrganizationId, sourceOrganizationId])
    }
    for (const year of yearStates) {
      await db.execute("UPDATE financial_years SET status = ? WHERE organization_id = ? AND id = ?", [year.status, targetOrganizationId, year.id])
    }
  })
}

export async function exportNormalizedBackup() {
  const db = await service.requireConnection("read")
  const data: Partial<Record<OfflineCollection, DataRow[]>> = {}
  const backupCollections = Object.keys(collectionOrder) as OfflineCollection[]
  const organizations = await db.select<{ id: string }>("SELECT id FROM organizations ORDER BY datetime(updated_at) DESC").catch(() => [])

  for (const collection of backupCollections) data[collection] = []
  for (const organization of organizations) {
    for (const collection of backupCollections) {
      const rows = await getNormalizedCollection(organization.id, collection).catch(() => [])
      data[collection]?.push(...rows)
    }
  }

  return {
    exportedAt: nowIso(),
    app: "Bezgrow",
    storage: "sqlite-normalized",
    data,
    actions: await listNormalizedActions(),
    conflicts: await db.select<DataRow>("SELECT * FROM offline_sync_conflicts ORDER BY datetime(created_at) DESC"),
    logs: await db.select<DataRow>("SELECT * FROM offline_sync_logs ORDER BY datetime(created_at) DESC"),
    meta: await db.select<DataRow>("SELECT * FROM business_settings ORDER BY datetime(updated_at) DESC"),
    integrity: await service.integrityReport(),
  }
}

async function tableExists(db: SqlExecutor, table: string) {
  const rows = await db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", [table])
  return Boolean(rows[0])
}

export async function importLegacyJsonCollectionsOnce() {
  const db = await service.requireConnection("write")
  const imported = await getNormalizedMeta("normalized_legacy_import_complete", false, "global").catch(() => false)
  if (imported) return
  const previousImporterCompleted = await getNormalizedMeta("legacy_indexeddb_to_sqlite_v7", false, "global").catch(() => false)
  if (previousImporterCompleted) {
    await setNormalizedMeta("normalized_legacy_import_complete", true, "global")
    return
  }

  const legacyMap: Partial<Record<OfflineCollection, string>> = {
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

  for (const [collection, table] of Object.entries(legacyMap)) {
    if (!table || !(await tableExists(db, table))) continue
    const rows = await db.select<{ organization_id: string | null; payload_json: string }>(
      `SELECT organization_id, payload_json FROM ${table} WHERE payload_json IS NOT NULL`
    ).catch(() => [])
    const byOrg = new Map<string, DataRow[]>()
    for (const row of rows) {
      const orgId = row.organization_id || "global"
      try {
        const parsed = JSON.parse(row.payload_json) as DataRow
        byOrg.set(orgId, [...(byOrg.get(orgId) || []), parsed])
      } catch {
        // Ignore malformed legacy rows; they remain untouched in the legacy table.
      }
    }
    for (const [organizationId, values] of byOrg) {
      await putNormalizedCollection(organizationId, collection as OfflineCollection, values)
    }
  }

  await setNormalizedMeta("normalized_legacy_import_complete", true, "global")
}
