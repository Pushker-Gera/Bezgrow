"use client"

import { getLocalDatabaseService, type SqlExecutor, type SqlValue } from "@/lib/offline/local/service"
import { normalizedTables } from "@/lib/offline/local/schema"
import type { OfflineAction, OfflineActionStatus, OfflineCollection } from "@/lib/offline/db"

type DataRow = Record<string, unknown>

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
  workspace: "datetime(updated_at) DESC",
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
  await upsert(db, "organizations", {
    id: organizationId,
    name: "Business",
    created_at: nowIso(),
    updated_at: nowIso(),
  })
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
  return {
    ...common(input, organizationId, "invoice", index),
    customer_id: text(input, ["customer_id"]),
    customer_name: text(input, ["customer_name"]),
    invoice_number: text(input, ["invoice_number"], `INV-${Date.now()}-${index}`),
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
          approved: bool(row, ["approved"], true),
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
  if (collection === "products" || collection === "inventory_items") await repositories.products.replaceSynced(organizationId, rows, db)
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
  updates: Array<{ collection: OfflineCollection; value: unknown }>
) {
  await service.transaction(async (db) => {
    for (const update of updates) {
      await putNormalizedCollectionWithDb(db, organizationId, update.collection, asRows(update.value))
    }
  })
}

export async function getNormalizedCollection(organizationId: string, collection: OfflineCollection) {
  const db = await service.requireConnection("read")
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

function valueFromField(field: FieldValue) {
  if (field.value_type === "null") return null
  if (field.value_type === "number") return field.value_number
  if (field.value_type === "boolean") return Boolean(field.value_boolean)
  if (field.value_type === "array") return []
  if (field.value_type === "object") return {}
  return field.value_text
}

function setPath(target: DataRow, path: string, value: unknown) {
  const parts = path.split(".")
  let current: Record<string, unknown> | unknown[] = target
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    const isLast = index === parts.length - 1
    const nextIsArray = /^\d+$/.test(parts[index + 1] || "")
    const key: string | number = /^\d+$/.test(part) ? Number(part) : part

    if (isLast) {
      ;(current as Record<string, unknown>)[key] = value
      return
    }

    if ((current as Record<string, unknown>)[key] === undefined) {
      ;(current as Record<string, unknown>)[key] = nextIsArray ? [] : {}
    }
    current = (current as Record<string, unknown>)[key] as Record<string, unknown> | unknown[]
  }
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

async function readFields(db: SqlExecutor, table: string, ownerColumn: string, ownerId: string) {
  const rows = await db.select<FieldValue>(`SELECT field_path, value_text, value_number, value_boolean, value_type FROM ${table} WHERE ${ownerColumn} = ?`, [
    ownerId,
  ])
  const value: DataRow = {}
  rows.forEach((field) => setPath(value, field.field_path, valueFromField(field)))
  return value
}

export async function queueNormalizedAction(action: OfflineAction) {
  await service.transaction(async (db) => {
    await ensureOrganization(db, action.organizationId)
    const entityType = action.type.replace(/^save_/, "").replace(/^create_/, "").replace(/^archive_/, "")
    await db.execute(
      `INSERT INTO offline_sync_queue (
        id, organization_id, entity_type, operation_type, status, attempts, error,
        idempotency_key, created_at, updated_at, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        attempts = excluded.attempts,
        error = excluded.error,
        updated_at = excluded.updated_at,
        last_synced_at = excluded.last_synced_at`,
      [
        action.id,
        action.organizationId,
        entityType,
        action.type,
        action.status,
        action.attempts,
        action.error || null,
        typeof action.payload.idempotency_key === "string" ? action.payload.idempotency_key : action.id,
        action.createdAt,
        action.updatedAt,
        action.status === "synced" ? nowIso() : null,
      ]
    )
    await replaceFields(db, "offline_sync_action_fields", action.id, flatten(action.payload))
  })
}

export async function listNormalizedActions(statuses?: OfflineActionStatus[]) {
  const db = await service.requireConnection("read")
  const statusSql = statuses?.length ? `AND status IN (${statuses.map(() => "?").join(",")})` : ""
  const rows = await db.select<DataRow>(
    `SELECT * FROM offline_sync_queue WHERE 1 = 1 ${statusSql} ORDER BY datetime(created_at) ASC`,
    statuses || []
  )

  const actions: OfflineAction[] = []
  for (const row of rows) {
    actions.push({
      id: String(row.id),
      type: row.operation_type as OfflineAction["type"],
      organizationId: String(row.organization_id),
      status: row.status as OfflineActionStatus,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      attempts: Number(row.attempts || 0),
      payload: await readFields(db, "offline_sync_action_fields", "action_id", String(row.id)),
      error: text(row, ["error"]) || undefined,
    })
  }
  return actions
}

export async function updateNormalizedAction(id: string, patch: Partial<OfflineAction>) {
  const current = (await listNormalizedActions()).find((action) => action.id === id)
  if (!current) return null
  const next: OfflineAction = { ...current, ...patch, updatedAt: nowIso(), payload: patch.payload || current.payload }
  await queueNormalizedAction(next)
  return next
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

  if (await tableExists(db, "sync_queue")) {
    const actions = await db.select<DataRow>("SELECT * FROM sync_queue ORDER BY datetime(created_at) ASC").catch(() => [])
    for (const row of actions) {
      try {
        await queueNormalizedAction({
          id: String(row.id),
          type: row.operation_type as OfflineAction["type"],
          organizationId: String(row.organization_id),
          status: (row.status as OfflineActionStatus) || "pending",
          createdAt: String(row.created_at || nowIso()),
          updatedAt: String(row.updated_at || nowIso()),
          attempts: Number(row.attempts || 0),
          payload: typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : {},
          error: text(row, ["error"]) || undefined,
        })
      } catch {
        // Legacy queue rows remain in place if they cannot be normalized.
      }
    }
  }

  await setNormalizedMeta("normalized_legacy_import_complete", true, "global")
}
