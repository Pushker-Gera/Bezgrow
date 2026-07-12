"use client"

import { createOfflineId, getOfflineData, putOfflineData, type OfflineCollection } from "@/lib/offline/db"
import { isDesktopRuntime } from "@/lib/desktop/tauri"
import { exportNormalizedBackup, putNormalizedCollectionsInTransaction } from "@/lib/offline/local/repositories"
import { getLocalDatabaseService } from "@/lib/offline/local/service"

type DataRow = Record<string, unknown> & { id?: string }

type CollectionUpdate = {
  collection: OfflineCollection
  value: unknown
}

type PurchaseKind = "purchase_invoice" | "purchase_return" | "purchase_order" | "goods_received"
type NoteKind = "credit_note" | "debit_note"
type VoucherKind = "journal" | "contra" | "payment" | "receipt"

const service = getLocalDatabaseService()

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

function localDate(value: unknown, fallback = nowIso().slice(0, 10)) {
  return localString(value, fallback).slice(0, 10)
}

function activeRows(rows: DataRow[]) {
  return rows.filter((row) => !row.deleted_at)
}

function statusForPayment(total: number, paid: number) {
  if (paid <= 0) return "unpaid"
  if (paid + 0.0001 >= total) return "paid"
  return "partial"
}

function taxableFrom(total: number, tax: number, discount = 0) {
  return Math.max(0, total - tax - discount)
}

function nextDocumentNumber(prefix: string, rows: DataRow[], key: string) {
  const today = nowIso().slice(0, 10).replace(/-/g, "")
  const count = rows.filter((row) => localString(row[key]).startsWith(`${prefix}-${today}`)).length + 1
  return `${prefix}-${today}-${String(count).padStart(4, "0")}`
}

function upsertRow(rows: DataRow[], next: DataRow) {
  return rows.some((row) => row.id === next.id) ? rows.map((row) => (row.id === next.id ? next : row)) : [next, ...rows]
}

async function readRows(organizationId: string, collection: OfflineCollection) {
  return getOfflineData<DataRow[]>(organizationId, collection, [])
}

async function writeCollections(organizationId: string, updates: CollectionUpdate[]) {
  const desktopRuntime = await isDesktopRuntime().catch(() => false)
  const wroteToSqlite = await putNormalizedCollectionsInTransaction(organizationId, updates)
    .then(() => true)
    .catch((error) => {
      console.warn("[offline/local-erp] SQLite batch write unavailable.", error)
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

function money(value: number) {
  return Math.round(value * 100) / 100
}

function normalizePurchaseItems(items: DataRow[], documentId: string, organizationId: string, now: string) {
  return items.map((item) => {
    const quantity = Math.max(0, localNumber(item.quantity))
    const unitCost = Math.max(0, localNumber(item.unit_cost, localNumber(item.unit_price, localNumber(item.purchase_rate))))
    const base = money(quantity * unitCost)
    const taxPercent = Math.max(0, localNumber(item.tax_percent, localNumber(item.gst)))
    const taxAmount = money(localNumber(item.tax_amount, base * (taxPercent / 100)))
    return {
      ...item,
      id: localString(item.id) || createOfflineId("purchase-item"),
      organization_id: organizationId,
      purchase_invoice_id: documentId,
      product_id: localString(item.product_id),
      product_name: localString(item.product_name, localString(item.name)),
      warehouse_id: localString(item.warehouse_id),
      batch_no: localString(item.batch_no),
      expiry_date: localString(item.expiry_date),
      quantity,
      unit_cost: unitCost,
      tax_percent: taxPercent,
      tax_amount: taxAmount,
      line_total: money(localNumber(item.line_total, base + taxAmount)),
      sync_status: "pending_create",
      created_at: now,
      updated_at: now,
    }
  })
}

function ledgerEntry(
  organizationId: string,
  accountType: string,
  documentType: string,
  documentId: string,
  debit: number,
  credit: number,
  description: string,
  accountId?: string | null,
  entryDate = nowIso().slice(0, 10)
) {
  return {
    id: createOfflineId("ledger"),
    organization_id: organizationId,
    account_type: accountType,
    account_id: accountId || null,
    document_type: documentType,
    document_id: documentId,
    entry_date: entryDate,
    debit: money(debit),
    credit: money(credit),
    description,
    sync_status: "pending_create",
    created_at: nowIso(),
    updated_at: nowIso(),
  }
}

function productStockMap(items: DataRow[]) {
  const map = new Map<string, number>()
  for (const item of items) {
    const productId = localString(item.product_id)
    if (!productId) continue
    map.set(productId, (map.get(productId) || 0) + localNumber(item.quantity))
  }
  return map
}

function updateProductsForStock(
  products: DataRow[],
  items: DataRow[],
  stockSign: number,
  now: string,
  reference: string,
  protectNegative = true
) {
  const quantityByProduct = productStockMap(items)
  for (const [productId, quantity] of quantityByProduct) {
    const product = products.find((row) => row.id === productId)
    if (!product) throw new Error("One or more products were not found.")
    const nextStock = localNumber(product.stock) + quantity * stockSign
    if (protectNegative && nextStock < -0.0001) throw new Error(`${product.name || "Product"} cannot go below zero stock.`)
  }

  const movements: DataRow[] = []
  const nextProducts = products.map((product) => {
    const quantity = quantityByProduct.get(String(product.id || "")) || 0
    if (!quantity) return product
    const previousStock = localNumber(product.stock)
    const nextStock = money(previousStock + quantity * stockSign)
    const matchingItem = items.find((item) => item.product_id === product.id)
    movements.push({
      id: createOfflineId("stock-movement"),
      organization_id: product.organization_id,
      product_id: product.id,
      product_name: product.name || "",
      warehouse_id: matchingItem?.warehouse_id || product.warehouse_id || null,
      type: reference,
      quantity: money(quantity * stockSign),
      previous_stock: previousStock,
      new_stock: nextStock,
      reason: reference.replace(/_/g, " "),
      reference_type: reference,
      reference_id: localString(matchingItem?.purchase_invoice_id, localString(matchingItem?.credit_note_id, localString(matchingItem?.debit_note_id))),
      movement_date: now.slice(0, 10),
      sync_status: "pending_create",
      created_at: now,
      updated_at: now,
    })
    return {
      ...product,
      stock: nextStock,
      purchase_rate: stockSign > 0 ? matchingItem?.unit_cost || product.purchase_rate : product.purchase_rate,
      batch_no: stockSign > 0 ? matchingItem?.batch_no || product.batch_no : product.batch_no,
      expiry_date: stockSign > 0 ? matchingItem?.expiry_date || product.expiry_date : product.expiry_date,
      sync_status: "pending_update",
      updated_at: now,
    }
  })

  return { nextProducts, movements }
}

function updateBatchesForStock(batches: DataRow[], items: DataRow[], stockSign: number, organizationId: string, now: string) {
  let nextBatches = [...batches]
  for (const item of items) {
    const productId = localString(item.product_id)
    const batchNo = localString(item.batch_no)
    if (!productId || !batchNo) continue
    const warehouseId = localString(item.warehouse_id, "default")
    const current = nextBatches.find(
      (row) => row.product_id === productId && localString(row.batch_no) === batchNo && localString(row.warehouse_id, "default") === warehouseId
    )
    const previousQuantity = localNumber(current?.quantity)
    const nextQuantity = money(previousQuantity + localNumber(item.quantity) * stockSign)
    if (nextQuantity < -0.0001) throw new Error(`Batch ${batchNo} cannot go below zero stock.`)
    const batch = {
      ...current,
      id: localString(current?.id) || createOfflineId("stock-batch"),
      organization_id: organizationId,
      product_id: productId,
      warehouse_id: localString(item.warehouse_id) || null,
      batch_no: batchNo,
      expiry_date: localString(item.expiry_date),
      purchase_date: now.slice(0, 10),
      quantity: Math.max(0, nextQuantity),
      purchase_rate: item.unit_cost ?? current?.purchase_rate ?? null,
      mrp: item.mrp ?? current?.mrp ?? null,
      barcode: item.barcode ?? current?.barcode ?? null,
      sync_status: current ? "pending_update" : "pending_create",
      created_at: localString(current?.created_at) || now,
      updated_at: now,
    }
    nextBatches = upsertRow(nextBatches, batch)
  }
  return nextBatches
}

export async function saveSupplierMaster(organizationId: string, input: DataRow) {
  const now = nowIso()
  const suppliers = await readRows(organizationId, "suppliers")
  const ledgerEntries = await readRows(organizationId, "ledger_entries")
  const id = localString(input.id) || createOfflineId("supplier")
  const previous = suppliers.find((supplier) => supplier.id === id)
  const openingBalance = localNumber(input.opening_balance, localNumber(previous?.opening_balance))
  const supplier = {
    ...previous,
    ...input,
    id,
    organization_id: organizationId,
    name: localString(input.name, localString(previous?.name, "Supplier")),
    opening_balance: openingBalance,
    current_balance: localNumber(input.current_balance, localNumber(previous?.current_balance, openingBalance)),
    is_active: input.is_active === undefined ? previous?.is_active ?? true : Boolean(input.is_active),
    deleted_at: null,
    sync_status: previous ? "pending_update" : "pending_create",
    offline_local_id: localString(previous?.offline_local_id) || id,
    created_at: localString(previous?.created_at) || now,
    updated_at: now,
  }

  const openingDocumentId = `opening:${id}`
  const nextLedger = ledgerEntries.filter((row) => row.document_id !== openingDocumentId)
  if (openingBalance !== 0) {
    nextLedger.unshift(
      ledgerEntry(
        organizationId,
        "supplier",
        "opening_balance",
        openingDocumentId,
        openingBalance < 0 ? Math.abs(openingBalance) : 0,
        openingBalance > 0 ? openingBalance : 0,
        `Opening balance for ${supplier.name}`,
        id,
        now.slice(0, 10)
      )
    )
  }

  await writeCollections(organizationId, [
    { collection: "suppliers", value: upsertRow(suppliers, supplier) },
    { collection: "ledger_entries", value: nextLedger },
  ])
  return { supplier, balance: await supplierBalance(organizationId, id, nextLedger) }
}

export async function deleteSupplierMaster(organizationId: string, supplierId: string) {
  const now = nowIso()
  const suppliers = await readRows(organizationId, "suppliers")
  const supplier = suppliers.find((row) => row.id === supplierId)
  if (!supplier) throw new Error("Supplier was not found.")
  const nextSuppliers = suppliers.map((row) =>
    row.id === supplierId ? { ...row, is_active: false, deleted_at: now, sync_status: "pending_delete", updated_at: now } : row
  )
  await writeCollections(organizationId, [{ collection: "suppliers", value: nextSuppliers }])
  return { supplier_id: supplierId, archived: true }
}

export async function supplierBalance(organizationId: string, supplierId: string, suppliedLedger?: DataRow[]) {
  const ledgerEntries = suppliedLedger || (await readRows(organizationId, "ledger_entries"))
  const entries = ledgerEntries.filter((row) => row.account_type === "supplier" && row.account_id === supplierId)
  const debit = entries.reduce((sum, row) => sum + localNumber(row.debit), 0)
  const credit = entries.reduce((sum, row) => sum + localNumber(row.credit), 0)
  return money(credit - debit)
}

export async function supplierLedgerSummary(organizationId: string, supplierId: string) {
  const [suppliers, ledgerEntries, purchases, payments] = await Promise.all([
    readRows(organizationId, "suppliers"),
    readRows(organizationId, "ledger_entries"),
    readRows(organizationId, "purchase_invoices"),
    readRows(organizationId, "payments"),
  ])
  const supplier = suppliers.find((row) => row.id === supplierId)
  if (!supplier) throw new Error("Supplier was not found.")
  const entries = ledgerEntries
    .filter((row) => row.account_type === "supplier" && row.account_id === supplierId)
    .sort((a, b) => String(b.entry_date || "").localeCompare(String(a.entry_date || "")))
  return {
    supplier,
    ledger: entries,
    balance: await supplierBalance(organizationId, supplierId, ledgerEntries),
    purchase_history: purchases.filter((row) => row.supplier_id === supplierId && !row.deleted_at),
    payments: payments.filter((row) => row.party_type === "supplier" && row.party_id === supplierId && !row.deleted_at),
  }
}

export async function createPurchaseDocument(organizationId: string, input: DataRow, kind: PurchaseKind = "purchase_invoice") {
  const now = nowIso()
  const items = Array.isArray(input.items) ? (input.items as DataRow[]) : []
  if (!items.length && kind !== "purchase_order") throw new Error("Purchase requires at least one item.")

  const [suppliers, products, purchases, purchaseItems, stockMovements, ledgerEntries, payments, batches] = await Promise.all([
    readRows(organizationId, "suppliers"),
    readRows(organizationId, "products"),
    readRows(organizationId, "purchase_invoices"),
    readRows(organizationId, "purchase_items"),
    readRows(organizationId, "stock_movements"),
    readRows(organizationId, "ledger_entries"),
    readRows(organizationId, "payments"),
    readRows(organizationId, "stock_batches"),
  ])
  const supplierId = localString(input.supplier_id)
  const supplier = activeRows(suppliers).find((row) => row.id === supplierId)
  if (!supplierId || !supplier) throw new Error("Supplier was not found.")

  const documentId = createOfflineId("purchase")
  const normalizedItems = normalizePurchaseItems(items, documentId, organizationId, now)
  const subtotal = money(localNumber(input.subtotal, normalizedItems.reduce((sum, item) => sum + localNumber(item.quantity) * localNumber(item.unit_cost), 0)))
  const taxTotal = money(localNumber(input.tax_total, normalizedItems.reduce((sum, item) => sum + localNumber(item.tax_amount), 0)))
  const discountTotal = money(localNumber(input.discount_total))
  const grandTotal = money(localNumber(input.grand_total, subtotal - discountTotal + taxTotal))
  const paidAmount = kind === "purchase_order" || kind === "goods_received" ? 0 : Math.min(grandTotal, localNumber(input.paid_amount))
  const outstandingAmount = kind === "purchase_return" ? 0 : Math.max(0, grandTotal - paidAmount)
  const prefix = kind === "purchase_return" ? "PRTN" : kind === "purchase_order" ? "PO" : kind === "goods_received" ? "GRN" : "PINV"
  const billNumber = localString(input.bill_number, nextDocumentNumber(prefix, purchases, "bill_number"))

  let nextProducts = products
  let nextMovements = stockMovements
  let nextBatches = batches
  if (kind !== "purchase_order") {
    const sign = kind === "purchase_return" ? -1 : 1
    const stockResult = updateProductsForStock(products, normalizedItems, sign, now, kind, true)
    nextProducts = stockResult.nextProducts
    nextMovements = [...stockResult.movements.map((movement) => ({ ...movement, reference_no: billNumber, reference_id: documentId })), ...stockMovements]
    nextBatches = updateBatchesForStock(batches, normalizedItems, sign, organizationId, now)
  }

  const document = {
    ...input,
    id: documentId,
    organization_id: organizationId,
    supplier_id: supplierId,
    supplier_name: supplier.name || input.supplier_name || "Supplier",
    invoice_kind: kind,
    bill_number: billNumber,
    bill_date: localDate(input.bill_date, now.slice(0, 10)),
    due_date: localString(input.due_date),
    subtotal,
    discount_total: discountTotal,
    taxable_amount: money(localNumber(input.taxable_amount, taxableFrom(grandTotal, taxTotal, discountTotal))),
    tax_total: taxTotal,
    grand_total: grandTotal,
    received_status: kind === "purchase_order" ? "pending" : kind === "goods_received" ? "received_pending_invoice" : "received",
    paid_amount: paidAmount,
    outstanding_amount: outstandingAmount,
    status: kind === "purchase_order" ? "pending" : kind === "goods_received" ? "pending_invoice" : statusForPayment(grandTotal, paidAmount),
    sync_status: "pending_create",
    created_at: now,
    updated_at: now,
  }

  const nextLedger = ledgerEntries.filter((row) => row.document_id !== documentId)
  if (kind === "purchase_invoice") {
    nextLedger.unshift(
      ledgerEntry(organizationId, "supplier", "purchase_invoice", documentId, 0, grandTotal, `Purchase ${billNumber}`, supplierId, document.bill_date),
      ledgerEntry(organizationId, "purchase", "purchase_invoice", documentId, document.taxable_amount, 0, `Purchase ${billNumber}`, null, document.bill_date)
    )
    if (taxTotal > 0) nextLedger.unshift(ledgerEntry(organizationId, "gst_input", "purchase_invoice", documentId, taxTotal, 0, `GST input ${billNumber}`, null, document.bill_date))
  }
  if (kind === "purchase_return") {
    nextLedger.unshift(
      ledgerEntry(organizationId, "supplier", "purchase_return", documentId, grandTotal, 0, `Purchase return ${billNumber}`, supplierId, document.bill_date),
      ledgerEntry(organizationId, "purchase_return", "purchase_return", documentId, 0, document.taxable_amount, `Purchase return ${billNumber}`, null, document.bill_date)
    )
    if (taxTotal > 0) nextLedger.unshift(ledgerEntry(organizationId, "gst_input", "purchase_return", documentId, 0, taxTotal, `GST reversal ${billNumber}`, null, document.bill_date))
  }
  if (paidAmount > 0 && kind === "purchase_invoice") {
    const paymentId = createOfflineId("payment")
    nextLedger.unshift(
      ledgerEntry(organizationId, "supplier", "supplier_payment", paymentId, paidAmount, 0, `Supplier payment ${billNumber}`, supplierId, document.bill_date),
      ledgerEntry(
        organizationId,
        String(input.payment_method || "").includes("bank") ? "bank" : "cash",
        "supplier_payment",
        paymentId,
        0,
        paidAmount,
        `Supplier payment ${billNumber}`,
        null,
        document.bill_date
      )
    )
    payments.unshift({
      id: paymentId,
      organization_id: organizationId,
      party_type: "supplier",
      party_id: supplierId,
      document_type: "purchase_invoice",
      document_id: documentId,
      amount: paidAmount,
      direction: "out",
      payment_method: input.payment_method || "cash",
      reference_no: input.reference_no || billNumber,
      payment_date: document.bill_date,
      cleared_at: now,
      notes: input.payment_notes || null,
      sync_status: "pending_create",
      created_at: now,
      updated_at: now,
    })
  }

  const balanceDelta = kind === "purchase_invoice" ? outstandingAmount : kind === "purchase_return" ? -grandTotal : 0
  const nextSuppliers = suppliers.map((row) =>
    row.id === supplierId ? { ...row, current_balance: money(localNumber(row.current_balance) + balanceDelta), sync_status: "pending_update", updated_at: now } : row
  )

  await writeCollections(organizationId, [
    { collection: "suppliers", value: nextSuppliers },
    { collection: "products", value: nextProducts },
    { collection: "inventory_items", value: nextProducts },
    { collection: "stock_batches", value: nextBatches },
    { collection: "purchase_invoices", value: [document, ...purchases] },
    { collection: "purchase_items", value: [...normalizedItems, ...purchaseItems] },
    { collection: "stock_movements", value: nextMovements },
    { collection: "ledger_entries", value: nextLedger },
    { collection: "payments", value: payments },
  ])

  return { purchase_id: documentId, bill_number: billNumber, status: document.status, outstanding_amount: outstandingAmount }
}

export async function createPaymentTransaction(organizationId: string, input: DataRow) {
  const now = nowIso()
  const amount = money(localNumber(input.amount))
  if (amount <= 0) throw new Error("Payment amount must be greater than zero.")
  const paymentMethod = localString(input.payment_method, "cash")
  const accountType = paymentMethod.toLowerCase().includes("bank") ? "bank" : "cash"
  const receiptLike = ["receipt", "cash_receipt", "bank_receipt", "customer_receipt"].includes(localString(input.payment_type, localString(input.type)))
  const direction = localString(input.direction, receiptLike ? "in" : "out")
  const partyType = localString(input.party_type, direction === "in" ? "customer" : "supplier")
  const partyId = localString(input.party_id, localString(input.customer_id, localString(input.supplier_id)))
  const documentType = localString(input.document_type, partyType === "customer" ? "sales_invoice" : "purchase_invoice")
  const documentId = localString(input.document_id, localString(input.invoice_id, localString(input.purchase_invoice_id)))
  const paymentId = createOfflineId("payment")
  const paymentDate = localDate(input.payment_date, now.slice(0, 10))

  const [payments, receipts, invoices, purchases, expenses, customers, suppliers, ledgerEntries] = await Promise.all([
    readRows(organizationId, "payments"),
    readRows(organizationId, "payment_receipts"),
    readRows(organizationId, "invoices"),
    readRows(organizationId, "purchase_invoices"),
    readRows(organizationId, "expenses"),
    readRows(organizationId, "customers"),
    readRows(organizationId, "suppliers"),
    readRows(organizationId, "ledger_entries"),
  ])

  let nextInvoices = invoices
  let nextPurchases = purchases
  let nextExpenses = expenses
  if (documentId && documentType === "sales_invoice") {
    nextInvoices = invoices.map((invoice) => {
      if (invoice.id !== documentId) return invoice
      const paidAmount = money(localNumber(invoice.paid_amount) + amount)
      const total = localNumber(invoice.grand_total, localNumber(invoice.total_amount, localNumber(invoice.total)))
      const outstanding = Math.max(0, total - paidAmount)
      return { ...invoice, paid_amount: paidAmount, outstanding_amount: outstanding, payment_status: statusForPayment(total, paidAmount), status: statusForPayment(total, paidAmount), sync_status: "pending_update", updated_at: now }
    })
  }
  if (documentId && documentType === "purchase_invoice") {
    nextPurchases = purchases.map((purchase) => {
      if (purchase.id !== documentId) return purchase
      const paidAmount = money(localNumber(purchase.paid_amount) + amount)
      const total = localNumber(purchase.grand_total)
      const outstanding = Math.max(0, total - paidAmount)
      return { ...purchase, paid_amount: paidAmount, outstanding_amount: outstanding, status: statusForPayment(total, paidAmount), sync_status: "pending_update", updated_at: now }
    })
  }
  if (documentId && documentType === "expense") {
    nextExpenses = expenses.map((expense) => {
      if (expense.id !== documentId) return expense
      const paidAmount = money(localNumber(expense.paid_amount) + amount)
      const total = localNumber(expense.amount)
      const outstanding = Math.max(0, total - paidAmount)
      return { ...expense, paid_amount: paidAmount, outstanding_amount: outstanding, payment_status: statusForPayment(total, paidAmount), sync_status: "pending_update", updated_at: now }
    })
  }

  const payment = {
    id: paymentId,
    organization_id: organizationId,
    party_type: partyType,
    party_id: partyId || null,
    document_type: documentType,
    document_id: documentId || null,
    amount,
    direction,
    payment_method: paymentMethod,
    reference_no: input.reference_no || null,
    payment_date: paymentDate,
    cleared_at: direction === "in" || input.cleared ? now : null,
    notes: input.notes || null,
    sync_status: "pending_create",
    created_at: now,
    updated_at: now,
  }

  const nextReceipts =
    direction === "in" && partyType === "customer"
      ? [
          {
            id: createOfflineId("receipt"),
            organization_id: organizationId,
            customer_id: partyId || null,
            invoice_id: documentType === "sales_invoice" ? documentId || null : null,
            receipt_number: localString(input.receipt_number, nextDocumentNumber("RCPT", receipts, "receipt_number")),
            receipt_type: localString(input.receipt_type, "customer_receipt"),
            amount,
            payment_method: paymentMethod,
            reference_no: input.reference_no || null,
            received_at: now,
            notes: input.notes || null,
            sync_status: "pending_create",
            created_at: now,
            updated_at: now,
          },
          ...receipts,
        ]
      : receipts

  const partyDebit = direction === "out" ? amount : 0
  const partyCredit = direction === "in" ? amount : 0
  const cashDebit = direction === "in" ? amount : 0
  const cashCredit = direction === "out" ? amount : 0
  const description = direction === "in" ? "Receipt" : "Payment"
  const nextLedger = [
    ledgerEntry(organizationId, partyType, documentType, paymentId, partyDebit, partyCredit, description, partyId || null, paymentDate),
    ledgerEntry(organizationId, accountType, documentType, paymentId, cashDebit, cashCredit, description, null, paymentDate),
    ...ledgerEntries,
  ]

  const nextCustomers = customers.map((customer) =>
    direction === "in" && customer.id === partyId ? { ...customer, current_balance: money(localNumber(customer.current_balance) - amount), sync_status: "pending_update", updated_at: now } : customer
  )
  const nextSuppliers = suppliers.map((supplier) =>
    direction === "out" && supplier.id === partyId ? { ...supplier, current_balance: money(localNumber(supplier.current_balance) - amount), sync_status: "pending_update", updated_at: now } : supplier
  )

  await writeCollections(organizationId, [
    { collection: "payments", value: [payment, ...payments] },
    { collection: "payment_receipts", value: nextReceipts },
    { collection: "ledger_entries", value: nextLedger },
    { collection: "invoices", value: nextInvoices },
    { collection: "purchase_invoices", value: nextPurchases },
    { collection: "expenses", value: nextExpenses },
    { collection: "customers", value: nextCustomers },
    { collection: "suppliers", value: nextSuppliers },
  ])

  return { payment_id: paymentId, amount, direction, document_id: documentId || null }
}

function normalizeNoteItems(items: DataRow[], noteId: string, organizationId: string, now: string, noteKind: NoteKind) {
  const noteColumn = noteKind === "credit_note" ? "credit_note_id" : "debit_note_id"
  return items.map((item) => {
    const quantity = Math.max(0, localNumber(item.quantity))
    const unitPrice = Math.max(0, localNumber(item.unit_price, localNumber(item.unit_cost)))
    const base = money(quantity * unitPrice)
    const taxAmount = money(localNumber(item.tax_amount, base * (localNumber(item.tax_percent, localNumber(item.gst)) / 100)))
    return {
      ...item,
      id: localString(item.id) || createOfflineId(`${noteKind}-item`),
      organization_id: organizationId,
      [noteColumn]: noteId,
      product_id: localString(item.product_id),
      quantity,
      unit_price: unitPrice,
      tax_amount: taxAmount,
      line_total: money(localNumber(item.line_total, base + taxAmount)),
      sync_status: "pending_create",
      created_at: now,
      updated_at: now,
    }
  })
}

export async function createCreditNote(organizationId: string, input: DataRow) {
  const now = nowIso()
  const items = Array.isArray(input.items) ? (input.items as DataRow[]) : []
  if (!items.length) throw new Error("Credit note requires at least one item.")
  const [notes, noteItems, products, movements, ledgerEntries, invoices, customers] = await Promise.all([
    readRows(organizationId, "credit_notes"),
    readRows(organizationId, "credit_note_items"),
    readRows(organizationId, "products"),
    readRows(organizationId, "stock_movements"),
    readRows(organizationId, "ledger_entries"),
    readRows(organizationId, "invoices"),
    readRows(organizationId, "customers"),
  ])
  const noteId = createOfflineId("credit-note")
  const normalizedItems = normalizeNoteItems(items, noteId, organizationId, now, "credit_note")
  const taxTotal = money(localNumber(input.tax_total, normalizedItems.reduce((sum, item) => sum + localNumber(item.tax_amount), 0)))
  const grandTotal = money(localNumber(input.grand_total, normalizedItems.reduce((sum, item) => sum + localNumber(item.line_total), 0)))
  const subtotal = money(localNumber(input.subtotal, grandTotal - taxTotal))
  const noteNumber = localString(input.note_number, nextDocumentNumber("CN", notes, "note_number"))
  const customerId = localString(input.customer_id, localString(invoices.find((invoice) => invoice.id === input.invoice_id)?.customer_id))
  const stockResult = updateProductsForStock(products, normalizedItems, 1, now, "sales_return", false)
  const note = {
    ...input,
    id: noteId,
    organization_id: organizationId,
    invoice_id: localString(input.invoice_id) || null,
    customer_id: customerId || null,
    note_number: noteNumber,
    note_date: localDate(input.note_date, now.slice(0, 10)),
    subtotal,
    tax_total: taxTotal,
    grand_total: grandTotal,
    status: localString(input.status, "open"),
    sync_status: "pending_create",
    created_at: now,
    updated_at: now,
  }
  const nextInvoices = invoices.map((invoice) => {
    if (!input.invoice_id || invoice.id !== input.invoice_id) return invoice
    const outstanding = Math.max(0, localNumber(invoice.outstanding_amount, localNumber(invoice.grand_total) - localNumber(invoice.paid_amount)) - grandTotal)
    return { ...invoice, outstanding_amount: outstanding, payment_status: outstanding <= 0 ? "paid" : invoice.payment_status, status: outstanding <= 0 ? "paid" : invoice.status, sync_status: "pending_update", updated_at: now }
  })
  const nextCustomers = customers.map((customer) =>
    customer.id === customerId ? { ...customer, current_balance: money(localNumber(customer.current_balance) - grandTotal), sync_status: "pending_update", updated_at: now } : customer
  )
  const nextLedger = [
    ledgerEntry(organizationId, "customer", "credit_note", noteId, 0, grandTotal, `Credit note ${noteNumber}`, customerId || null, note.note_date),
    ledgerEntry(organizationId, "sales_return", "credit_note", noteId, subtotal, 0, `Credit note ${noteNumber}`, null, note.note_date),
    ...(taxTotal > 0 ? [ledgerEntry(organizationId, "gst_output", "credit_note", noteId, taxTotal, 0, `GST credit note ${noteNumber}`, null, note.note_date)] : []),
    ...ledgerEntries,
  ]

  await writeCollections(organizationId, [
    { collection: "credit_notes", value: [note, ...notes] },
    { collection: "credit_note_items", value: [...normalizedItems, ...noteItems] },
    { collection: "products", value: stockResult.nextProducts },
    { collection: "inventory_items", value: stockResult.nextProducts },
    { collection: "stock_movements", value: [...stockResult.movements.map((movement) => ({ ...movement, reference_no: noteNumber, reference_id: noteId })), ...movements] },
    { collection: "ledger_entries", value: nextLedger },
    { collection: "invoices", value: nextInvoices },
    { collection: "customers", value: nextCustomers },
  ])
  return { credit_note_id: noteId, note_number: noteNumber, grand_total: grandTotal }
}

export async function createDebitNote(organizationId: string, input: DataRow) {
  const now = nowIso()
  const items = Array.isArray(input.items) ? (input.items as DataRow[]) : []
  if (!items.length) throw new Error("Debit note requires at least one item.")
  const [notes, noteItems, products, movements, ledgerEntries, purchases, suppliers] = await Promise.all([
    readRows(organizationId, "debit_notes"),
    readRows(organizationId, "debit_note_items"),
    readRows(organizationId, "products"),
    readRows(organizationId, "stock_movements"),
    readRows(organizationId, "ledger_entries"),
    readRows(organizationId, "purchase_invoices"),
    readRows(organizationId, "suppliers"),
  ])
  const noteId = createOfflineId("debit-note")
  const normalizedItems = normalizeNoteItems(items, noteId, organizationId, now, "debit_note")
  const taxTotal = money(localNumber(input.tax_total, normalizedItems.reduce((sum, item) => sum + localNumber(item.tax_amount), 0)))
  const grandTotal = money(localNumber(input.grand_total, normalizedItems.reduce((sum, item) => sum + localNumber(item.line_total), 0)))
  const subtotal = money(localNumber(input.subtotal, grandTotal - taxTotal))
  const noteNumber = localString(input.note_number, nextDocumentNumber("DN", notes, "note_number"))
  const supplierId = localString(input.supplier_id, localString(purchases.find((purchase) => purchase.id === input.purchase_invoice_id)?.supplier_id))
  const stockResult = updateProductsForStock(products, normalizedItems, -1, now, "supplier_return", true)
  const note = {
    ...input,
    id: noteId,
    organization_id: organizationId,
    supplier_id: supplierId || null,
    note_number: noteNumber,
    note_date: localDate(input.note_date, now.slice(0, 10)),
    subtotal,
    tax_total: taxTotal,
    grand_total: grandTotal,
    status: localString(input.status, "open"),
    sync_status: "pending_create",
    created_at: now,
    updated_at: now,
  }
  const nextPurchases = purchases.map((purchase) => {
    if (!input.purchase_invoice_id || purchase.id !== input.purchase_invoice_id) return purchase
    const outstanding = Math.max(0, localNumber(purchase.outstanding_amount, localNumber(purchase.grand_total) - localNumber(purchase.paid_amount)) - grandTotal)
    return { ...purchase, outstanding_amount: outstanding, status: outstanding <= 0 ? "paid" : purchase.status, sync_status: "pending_update", updated_at: now }
  })
  const nextSuppliers = suppliers.map((supplier) =>
    supplier.id === supplierId ? { ...supplier, current_balance: money(localNumber(supplier.current_balance) - grandTotal), sync_status: "pending_update", updated_at: now } : supplier
  )
  const nextLedger = [
    ledgerEntry(organizationId, "supplier", "debit_note", noteId, grandTotal, 0, `Debit note ${noteNumber}`, supplierId || null, note.note_date),
    ledgerEntry(organizationId, "purchase_return", "debit_note", noteId, 0, subtotal, `Debit note ${noteNumber}`, null, note.note_date),
    ...(taxTotal > 0 ? [ledgerEntry(organizationId, "gst_input", "debit_note", noteId, 0, taxTotal, `GST debit note ${noteNumber}`, null, note.note_date)] : []),
    ...ledgerEntries,
  ]

  await writeCollections(organizationId, [
    { collection: "debit_notes", value: [note, ...notes] },
    { collection: "debit_note_items", value: [...normalizedItems, ...noteItems] },
    { collection: "products", value: stockResult.nextProducts },
    { collection: "inventory_items", value: stockResult.nextProducts },
    { collection: "stock_movements", value: [...stockResult.movements.map((movement) => ({ ...movement, reference_no: noteNumber, reference_id: noteId })), ...movements] },
    { collection: "ledger_entries", value: nextLedger },
    { collection: "purchase_invoices", value: nextPurchases },
    { collection: "suppliers", value: nextSuppliers },
  ])
  return { debit_note_id: noteId, note_number: noteNumber, grand_total: grandTotal }
}

export async function createExpenseRecord(organizationId: string, input: DataRow) {
  const now = nowIso()
  const amount = money(localNumber(input.amount))
  if (amount <= 0) throw new Error("Expense amount must be greater than zero.")
  const taxAmount = money(localNumber(input.tax_amount))
  const paidAmount = money(localNumber(input.paid_amount, input.payment_status === "unpaid" ? 0 : amount))
  const expenseId = createOfflineId("expense")
  const [expenses, payments, ledgerEntries, suppliers] = await Promise.all([
    readRows(organizationId, "expenses"),
    readRows(organizationId, "payments"),
    readRows(organizationId, "ledger_entries"),
    readRows(organizationId, "suppliers"),
  ])
  const expenseDate = localDate(input.expense_date, now.slice(0, 10))
  const expense = {
    ...input,
    id: expenseId,
    organization_id: organizationId,
    category: localString(input.category, "Misc expense"),
    description: localString(input.description),
    amount,
    tax_amount: taxAmount,
    expense_date: expenseDate,
    payment_status: statusForPayment(amount, paidAmount),
    paid_amount: paidAmount,
    outstanding_amount: Math.max(0, amount - paidAmount),
    payment_method: localString(input.payment_method, "cash"),
    sync_status: "pending_create",
    created_at: now,
    updated_at: now,
  }
  const accountType = String(expense.payment_method).toLowerCase().includes("bank") ? "bank" : "cash"
  const nextLedger = [
    ledgerEntry(organizationId, "expense", "expense", expenseId, amount - taxAmount, 0, `${expense.category}`, null, expenseDate),
    ...(taxAmount > 0 ? [ledgerEntry(organizationId, "gst_input", "expense", expenseId, taxAmount, 0, `Expense GST ${expense.category}`, null, expenseDate)] : []),
    ...(paidAmount > 0 ? [ledgerEntry(organizationId, accountType, "expense", expenseId, 0, paidAmount, `Expense payment ${expense.category}`, null, expenseDate)] : []),
    ...(amount - paidAmount > 0 ? [ledgerEntry(organizationId, "accounts_payable", "expense", expenseId, 0, amount - paidAmount, `Unpaid expense ${expense.category}`, localString(input.supplier_id) || null, expenseDate)] : []),
    ...ledgerEntries,
  ]
  const nextPayments =
    paidAmount > 0
      ? [
          {
            id: createOfflineId("payment"),
            organization_id: organizationId,
            party_type: "expense",
            party_id: expenseId,
            document_type: "expense",
            document_id: expenseId,
            amount: paidAmount,
            direction: "out",
            payment_method: expense.payment_method,
            reference_no: input.reference_no || null,
            payment_date: expenseDate,
            cleared_at: now,
            notes: input.notes || null,
            sync_status: "pending_create",
            created_at: now,
            updated_at: now,
          },
          ...payments,
        ]
      : payments
  const nextSuppliers = suppliers.map((supplier) =>
    supplier.id === input.supplier_id && expense.outstanding_amount > 0
      ? { ...supplier, current_balance: money(localNumber(supplier.current_balance) + expense.outstanding_amount), sync_status: "pending_update", updated_at: now }
      : supplier
  )

  await writeCollections(organizationId, [
    { collection: "expenses", value: [expense, ...expenses] },
    { collection: "payments", value: nextPayments },
    { collection: "ledger_entries", value: nextLedger },
    { collection: "suppliers", value: nextSuppliers },
  ])
  return { expense_id: expenseId, amount, payment_status: expense.payment_status }
}

export async function createInventoryMovement(organizationId: string, input: DataRow) {
  const now = nowIso()
  const productId = localString(input.product_id)
  const quantity = Math.abs(localNumber(input.quantity))
  if (!productId || quantity <= 0) throw new Error("Inventory movement requires a product and quantity.")
  const type = localString(input.type, localString(input.mode, "adjustment"))
  const [products, movements, batches] = await Promise.all([
    readRows(organizationId, "products"),
    readRows(organizationId, "stock_movements"),
    readRows(organizationId, "stock_batches"),
  ])
  const product = products.find((row) => row.id === productId)
  if (!product) throw new Error("Product was not found.")
  const previousStock = localNumber(product.stock)
  const explicitDelta = input.delta !== undefined ? localNumber(input.delta) : null
  const delta =
    explicitDelta !== null
      ? explicitDelta
      : ["damage", "stock_out", "sale", "transfer_out"].includes(type)
        ? -quantity
        : type === "transfer" || type === "stock_transfer"
          ? 0
          : quantity
  if ((delta < 0 || type === "transfer" || type === "stock_transfer") && previousStock < quantity) {
    throw new Error("Movement quantity cannot be greater than available stock.")
  }
  const nextStock = money(previousStock + delta)
  if (nextStock < -0.0001) throw new Error("Stock cannot go below zero.")
  const nextProducts = products.map((row) =>
    row.id === productId
      ? {
          ...row,
          stock: nextStock,
          warehouse_id: input.target_warehouse_id || input.warehouse_id || row.warehouse_id || null,
          batch_no: input.batch_no || row.batch_no || null,
          expiry_date: input.expiry_date || row.expiry_date || null,
          sync_status: "pending_update",
          updated_at: now,
        }
      : row
  )
  const movementRows: DataRow[] = [
    {
      id: createOfflineId("stock-movement"),
      organization_id: organizationId,
      product_id: productId,
      product_name: product.name || "",
      warehouse_id: input.warehouse_id || input.target_warehouse_id || null,
      type,
      quantity: delta,
      previous_stock: previousStock,
      new_stock: nextStock,
      reason: input.reason || type.replace(/_/g, " "),
      reference_no: input.reference_no || null,
      reference_type: type,
      reference_id: input.reference_id || null,
      movement_date: localDate(input.movement_date, now.slice(0, 10)),
      sync_status: "pending_create",
      created_at: now,
      updated_at: now,
    },
  ]
  if (type === "transfer" || type === "stock_transfer") {
    movementRows[0].quantity = -quantity
    movementRows[0].new_stock = previousStock
    movementRows.push({ ...movementRows[0], id: createOfflineId("stock-movement"), warehouse_id: input.target_warehouse_id || null, quantity, reason: "Stock transfer received" })
  }

  const batchInput = {
    product_id: productId,
    warehouse_id: input.warehouse_id || input.target_warehouse_id || null,
    batch_no: input.batch_no || null,
    expiry_date: input.expiry_date || null,
    quantity,
    unit_cost: input.purchase_rate || product.purchase_rate || null,
    mrp: input.mrp || product.mrp || null,
    barcode: input.barcode || product.barcode || null,
  }
  const nextBatches = input.batch_no && delta !== 0 ? updateBatchesForStock(batches, [batchInput], delta > 0 ? 1 : -1, organizationId, now) : batches

  await writeCollections(organizationId, [
    { collection: "products", value: nextProducts },
    { collection: "inventory_items", value: nextProducts },
    { collection: "stock_batches", value: nextBatches },
    { collection: "stock_movements", value: [...movementRows, ...movements] },
  ])
  return { product_id: productId, previous_stock: previousStock, new_stock: nextStock, movement_count: movementRows.length }
}

function inDateRange(row: DataRow, dateKeys: string[], start?: string | null, end?: string | null) {
  const date = dateKeys.map((key) => localString(row[key])).find(Boolean)
  if (!date) return true
  if (start && date < start) return false
  if (end && date > end) return false
  return true
}

function groupSum(rows: DataRow[], key: string, amountKey: string) {
  const grouped = new Map<string, number>()
  for (const row of rows) grouped.set(localString(row[key], "Uncategorized"), money((grouped.get(localString(row[key], "Uncategorized")) || 0) + localNumber(row[amountKey])))
  return Array.from(grouped.entries()).map(([name, amount]) => ({ name, amount }))
}

function groupBy<T>(rows: T[], keyFor: (row: T) => string, amountFor: (row: T) => number) {
  const grouped = new Map<string, number>()
  for (const row of rows) {
    const key = keyFor(row) || "Uncategorized"
    grouped.set(key, money((grouped.get(key) || 0) + amountFor(row)))
  }
  return Array.from(grouped.entries()).map(([name, amount]) => ({ name, amount }))
}

function accountId(organizationId: string, code: string) {
  return `account:${organizationId}:${code.toLowerCase()}`
}

const defaultChartSeeds = [
  ["1000", "Cash", "asset", "cash", "debit", 1, 0],
  ["1010", "Bank", "asset", "bank", "debit", 0, 1],
  ["1100", "Accounts Receivable", "asset", "customer", "debit", 0, 0],
  ["1200", "Stock In Hand", "asset", "inventory", "debit", 0, 0],
  ["2000", "Accounts Payable", "liability", "supplier", "credit", 0, 0],
  ["2100", "GST Output", "liability", "gst_output", "credit", 0, 0],
  ["2200", "GST Input", "asset", "gst_input", "debit", 0, 0],
  ["3000", "Owner Capital", "equity", "capital", "credit", 0, 0],
  ["4000", "Sales", "income", "sales", "credit", 0, 0],
  ["4100", "Sales Return", "income", "sales_return", "debit", 0, 0],
  ["5000", "Purchase", "expense", "purchase", "debit", 0, 0],
  ["5100", "Purchase Return", "expense", "purchase_return", "credit", 0, 0],
  ["6000", "Expenses", "expense", "expense", "debit", 0, 0],
  ["9999", "Suspense", "asset", "general", "debit", 0, 0],
] as const

function defaultAccountRows(organizationId: string, now = nowIso()) {
  return defaultChartSeeds.map(([code, name, accountType, group, normalBalance, isCash, isBank]) => ({
    id: accountId(organizationId, code),
    organization_id: organizationId,
    account_code: code,
    account_name: name,
    account_type: accountType,
    account_group: group,
    normal_balance: normalBalance,
    opening_balance: 0,
    current_balance: 0,
    is_system: true,
    is_cash_account: Boolean(isCash),
    is_bank_account: Boolean(isBank),
    is_active: true,
    sync_status: "synced",
    created_at: now,
    updated_at: now,
  }))
}

export async function ensureDefaultChartOfAccounts(organizationId: string) {
  const now = nowIso()
  const accounts = await readRows(organizationId, "chart_of_accounts")
  const existingCodes = new Set(accounts.map((row) => localString(row.account_code)))
  const missing = defaultAccountRows(organizationId, now).filter((row) => !existingCodes.has(localString(row.account_code)))
  if (!missing.length) return activeRows(accounts)
  const nextAccounts = [...accounts, ...missing]
  await writeCollections(organizationId, [{ collection: "chart_of_accounts", value: nextAccounts }])
  return activeRows(nextAccounts)
}

function accountLookup(accounts: DataRow[]) {
  const map = new Map<string, DataRow>()
  for (const account of accounts) {
    for (const key of [account.id, account.account_code, account.account_name, account.account_group]) {
      const value = localString(key)
      if (value) map.set(value.toLowerCase(), account)
    }
  }
  return map
}

function accountForEntry(entry: DataRow, lookup: Map<string, DataRow>) {
  const keys = [entry.account_id, entry.account_code, entry.account_name, entry.account_type]
  for (const key of keys) {
    const account = lookup.get(localString(key).toLowerCase())
    if (account) return account
  }
  return null
}

function voucherPrefix(kind: VoucherKind) {
  if (kind === "contra") return "CV"
  if (kind === "payment") return "PV"
  if (kind === "receipt") return "RV"
  return "JV"
}

function normalizeVoucherEntries(input: DataRow) {
  const explicit = Array.isArray(input.entries) ? (input.entries as DataRow[]) : []
  if (explicit.length) return explicit

  const amount = money(localNumber(input.amount))
  const from = localString(input.from_account_type, localString(input.from_account))
  const to = localString(input.to_account_type, localString(input.to_account))
  if (amount <= 0 || !from || !to) return []
  const kind = localString(input.voucher_type, localString(input.type, "journal")) as VoucherKind
  if (kind === "receipt") return [{ account_type: to, debit: amount }, { account_type: from, credit: amount }]
  if (kind === "payment") return [{ account_type: to, debit: amount }, { account_type: from, credit: amount }]
  return [{ account_type: to, debit: amount }, { account_type: from, credit: amount }]
}

export async function createAccountingVoucher(organizationId: string, input: DataRow, forcedKind?: VoucherKind) {
  const now = nowIso()
  const kind = (forcedKind || localString(input.voucher_type, localString(input.type, "journal"))) as VoucherKind
  if (!["journal", "contra", "payment", "receipt"].includes(kind)) throw new Error("Voucher type is invalid.")

  const [accounts, vouchers, voucherEntries, ledgerEntries, auditLogs] = await Promise.all([
    ensureDefaultChartOfAccounts(organizationId),
    readRows(organizationId, "accounting_vouchers"),
    readRows(organizationId, "accounting_voucher_entries"),
    readRows(organizationId, "ledger_entries"),
    readRows(organizationId, "audit_logs"),
  ])
  const lookup = accountLookup(accounts)
  const rawEntries = normalizeVoucherEntries({ ...input, voucher_type: kind })
  if (rawEntries.length < 2) throw new Error("Voucher requires at least two ledger lines.")

  const voucherId = createOfflineId("voucher")
  const voucherDate = localDate(input.voucher_date || input.date, now.slice(0, 10))
  const normalizedEntries = rawEntries.map((entry, index) => {
    const account = accountForEntry(entry, lookup)
    const debit = money(localNumber(entry.debit))
    const credit = money(localNumber(entry.credit))
    if (!account && !localString(entry.account_type)) throw new Error("Every voucher line needs an account.")
    if (debit > 0 && credit > 0) throw new Error("A voucher line cannot have both debit and credit.")
    if (debit <= 0 && credit <= 0) throw new Error("Every voucher line needs debit or credit amount.")
    return {
      ...entry,
      id: createOfflineId("voucher-entry"),
      organization_id: organizationId,
      voucher_id: voucherId,
      account_id: localString(account?.id) || localString(entry.account_id) || null,
      account_type: localString(account?.account_group, localString(entry.account_type, "general")),
      party_type: localString(entry.party_type),
      party_id: localString(entry.party_id),
      line_no: index + 1,
      debit,
      credit,
      description: localString(entry.description, localString(input.narration)),
      sync_status: "pending_create",
      created_at: now,
      updated_at: now,
    }
  })

  const totalDebit = money(normalizedEntries.reduce((sum, entry) => sum + localNumber(entry.debit), 0))
  const totalCredit = money(normalizedEntries.reduce((sum, entry) => sum + localNumber(entry.credit), 0))
  if (Math.abs(totalDebit - totalCredit) > 0.01) throw new Error("Voucher debit and credit totals must match.")

  const voucherNumber = localString(input.voucher_number, nextDocumentNumber(voucherPrefix(kind), vouchers, "voucher_number"))
  const voucher = {
    id: voucherId,
    organization_id: organizationId,
    voucher_number: voucherNumber,
    voucher_type: kind,
    voucher_date: voucherDate,
    reference_no: localString(input.reference_no),
    narration: localString(input.narration, localString(input.notes)),
    total_debit: totalDebit,
    total_credit: totalCredit,
    status: localString(input.status, "posted"),
    sync_status: "pending_create",
    created_at: now,
    updated_at: now,
  }

  const accountBalances = new Map(accounts.map((account) => [String(account.id), { ...account }]))
  for (const entry of normalizedEntries) {
    const account = entry.account_id ? accountBalances.get(String(entry.account_id)) : null
    if (!account) continue
    const normal = localString(account.normal_balance, "debit")
    const delta = normal === "credit" ? localNumber(entry.credit) - localNumber(entry.debit) : localNumber(entry.debit) - localNumber(entry.credit)
    account.current_balance = money(localNumber(account.current_balance) + delta)
    account.sync_status = "pending_update"
    account.updated_at = now
  }
  const nextAccounts = accounts.map((account) => accountBalances.get(String(account.id)) || account)
  const nextLedger = [
    ...normalizedEntries.map((entry) =>
      ledgerEntry(
        organizationId,
        localString(entry.account_type, "general"),
        `${kind}_voucher`,
        voucherId,
        localNumber(entry.debit),
        localNumber(entry.credit),
        localString(entry.description, `${kind} voucher ${voucherNumber}`),
        localString(entry.party_id, localString(entry.account_id)) || null,
        voucherDate
      )
    ),
    ...ledgerEntries,
  ]
  const nextAudit = [
    {
      id: createOfflineId("audit"),
      organization_id: organizationId,
      action: "ACCOUNTING_VOUCHER_CREATED",
      entity_type: "accounting_voucher",
      entity_id: voucherId,
      description: `${kind} voucher ${voucherNumber} posted`,
      sync_status: "pending_create",
      created_at: now,
      updated_at: now,
    },
    ...auditLogs,
  ]

  await writeCollections(organizationId, [
    { collection: "chart_of_accounts", value: nextAccounts },
    { collection: "accounting_vouchers", value: [voucher, ...vouchers] },
    { collection: "accounting_voucher_entries", value: [...normalizedEntries, ...voucherEntries] },
    { collection: "ledger_entries", value: nextLedger },
    { collection: "audit_logs", value: nextAudit },
  ])

  return { voucher_id: voucherId, voucher_number: voucherNumber, voucher_type: kind, total_debit: totalDebit, total_credit: totalCredit }
}

function accountTypeForBalance(accountType: string) {
  if (["sales", "income"].includes(accountType)) return "income"
  if (["purchase", "purchase_return", "expense", "sales_return"].includes(accountType)) return "expense"
  if (["supplier", "accounts_payable", "gst_output"].includes(accountType)) return "liability"
  if (["customer", "cash", "bank", "inventory", "gst_input"].includes(accountType)) return "asset"
  return "asset"
}

function trialBalanceRows(ledger: DataRow[], accounts: DataRow[]) {
  const accountNames = new Map(accounts.map((account) => [localString(account.account_group, localString(account.account_type)), localString(account.account_name)]))
  const grouped = new Map<string, { account_type: string; account_name: string; debit: number; credit: number }>()
  for (const row of ledger) {
    const accountType = localString(row.account_type, "general")
    const current = grouped.get(accountType) || {
      account_type: accountType,
      account_name: accountNames.get(accountType) || accountType.replace(/_/g, " "),
      debit: 0,
      credit: 0,
    }
    current.debit += localNumber(row.debit)
    current.credit += localNumber(row.credit)
    grouped.set(accountType, current)
  }
  return Array.from(grouped.values()).map((row) => ({
    ...row,
    debit: money(row.debit),
    credit: money(row.credit),
    balance: money(row.debit - row.credit),
  }))
}

function csvEscape(value: unknown) {
  const text = String(value ?? "")
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function rowsToCsv(rows: DataRow[]) {
  const columns = Array.from(rows.reduce((set, row) => {
    Object.keys(row).forEach((key) => set.add(key))
    return set
  }, new Set<string>()))
  if (!columns.length) return ""
  return [columns.join(","), ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","))].join("\n")
}

export async function getOfflineReport(
  organizationId: string,
  type: string,
  options: { start?: string | null; end?: string | null; account_type?: string | null; account_id?: string | null } = {}
) {
  const [invoices, invoiceItems, purchases, purchaseItems, products, customers, suppliers, expenses, ledgerEntries, stockMovements, accounts] = await Promise.all([
    readRows(organizationId, "invoices"),
    readRows(organizationId, "invoice_items"),
    readRows(organizationId, "purchase_invoices"),
    readRows(organizationId, "purchase_items"),
    readRows(organizationId, "products"),
    readRows(organizationId, "customers"),
    readRows(organizationId, "suppliers"),
    readRows(organizationId, "expenses"),
    readRows(organizationId, "ledger_entries"),
    readRows(organizationId, "stock_movements"),
    readRows(organizationId, "chart_of_accounts"),
  ])
  const sales = activeRows(invoices).filter((row) => row.invoice_type !== "proforma" && inDateRange(row, ["invoice_date", "date", "created_at"], options.start, options.end))
  const purchaseDocs = activeRows(purchases).filter((row) => inDateRange(row, ["bill_date", "created_at"], options.start, options.end))
  const expenseRows = activeRows(expenses).filter((row) => inDateRange(row, ["expense_date", "created_at"], options.start, options.end))
  const ledger = activeRows(ledgerEntries).filter((row) => inDateRange(row, ["entry_date", "created_at"], options.start, options.end))
  const saleIds = new Set(sales.map((row) => String(row.id || "")))
  const purchaseIds = new Set(purchaseDocs.map((row) => String(row.id || "")))
  const salesItems = activeRows(invoiceItems).filter((row) => saleIds.has(String(row.invoice_id || "")))
  const purchaseLineItems = activeRows(purchaseItems).filter((row) => purchaseIds.has(String(row.purchase_invoice_id || "")))
  const productById = new Map(products.map((row) => [String(row.id || ""), row]))
  const customerById = new Map(customers.map((row) => [String(row.id || ""), row]))

  const salesTotal = money(sales.reduce((sum, row) => sum + localNumber(row.grand_total, localNumber(row.total_amount, localNumber(row.total))), 0))
  const purchaseTotal = money(purchaseDocs.filter((row) => row.invoice_kind !== "purchase_order" && row.invoice_kind !== "goods_received").reduce((sum, row) => sum + localNumber(row.grand_total), 0))
  const expenseTotal = money(expenseRows.reduce((sum, row) => sum + localNumber(row.amount), 0))
  const trialRows = trialBalanceRows(ledger, accounts)

  if (type === "sales") return { type, total: salesTotal, count: sales.length, invoices: sales }
  if (type === "daily_sales") return { type, rows: groupBy(sales, (row) => localString(row.invoice_date, localString(row.date, localString(row.created_at).slice(0, 10))), (row) => localNumber(row.grand_total, localNumber(row.total_amount, localNumber(row.total)))) }
  if (type === "monthly_sales") return { type, rows: groupBy(sales, (row) => localString(row.invoice_date, localString(row.date, localString(row.created_at))).slice(0, 7), (row) => localNumber(row.grand_total, localNumber(row.total_amount, localNumber(row.total)))) }
  if (type === "product_wise_sales") {
    const grouped = new Map<string, { product_id: string; product_name: string; quantity: number; amount: number; tax: number }>()
    for (const item of salesItems) {
      const product = productById.get(String(item.product_id || ""))
      const productId = localString(item.product_id, "unknown")
      const current = grouped.get(productId) || { product_id: productId, product_name: localString(item.product_name, localString(product?.name, "Product")), quantity: 0, amount: 0, tax: 0 }
      current.quantity += localNumber(item.quantity)
      current.amount += localNumber(item.line_total)
      current.tax += localNumber(item.gst_amount, localNumber(item.tax_amount))
      grouped.set(productId, current)
    }
    return { type, rows: Array.from(grouped.values()).map((row) => ({ ...row, quantity: money(row.quantity), amount: money(row.amount), tax: money(row.tax) })) }
  }
  if (type === "customer_wise_sales") {
    return {
      type,
      rows: groupBy(
        sales,
        (row) => localString(row.customer_name, localString(customerById.get(String(row.customer_id || ""))?.name, "Walk-in Customer")),
        (row) => localNumber(row.grand_total, localNumber(row.total_amount, localNumber(row.total)))
      ),
    }
  }
  if (type === "purchase") return { type, total: purchaseTotal, count: purchaseDocs.length, purchases: purchaseDocs }
  if (type === "supplier_wise_purchase") {
    return { type, rows: groupBy(purchaseDocs, (row) => localString(row.supplier_name, localString(row.supplier_id, "Supplier")), (row) => localNumber(row.grand_total)) }
  }
  if (type === "profit_loss") return { type, sales: salesTotal, purchases: purchaseTotal, expenses: expenseTotal, gross_profit: money(salesTotal - purchaseTotal), net_profit: money(salesTotal - purchaseTotal - expenseTotal) }
  if (type === "profit_report") return { type, sales: salesTotal, purchases: purchaseTotal, expenses: expenseTotal, gross_profit: money(salesTotal - purchaseTotal), net_profit: money(salesTotal - purchaseTotal - expenseTotal) }
  if (type === "day_book") return { type, entries: ledger, debit: money(ledger.reduce((sum, row) => sum + localNumber(row.debit), 0)), credit: money(ledger.reduce((sum, row) => sum + localNumber(row.credit), 0)) }
  if (type === "cash_book") {
    const rows = ledger.filter((row) => row.account_type === "cash")
    return { type, entries: rows, balance: money(rows.reduce((sum, row) => sum + localNumber(row.debit) - localNumber(row.credit), 0)) }
  }
  if (type === "bank_book") {
    const rows = ledger.filter((row) => row.account_type === "bank")
    return { type, entries: rows, balance: money(rows.reduce((sum, row) => sum + localNumber(row.debit) - localNumber(row.credit), 0)) }
  }
  if (type === "ledger" || type === "ledger_reports") {
    const accountType = localString(options.account_type)
    const accountId = localString(options.account_id)
    const rows = ledger.filter((row) => (!accountType || row.account_type === accountType) && (!accountId || row.account_id === accountId))
    let running = 0
    return {
      type,
      entries: [...rows].reverse().map((row) => {
        running = money(running + localNumber(row.debit) - localNumber(row.credit))
        return { ...row, running_balance: running }
      }).reverse(),
      debit: money(rows.reduce((sum, row) => sum + localNumber(row.debit), 0)),
      credit: money(rows.reduce((sum, row) => sum + localNumber(row.credit), 0)),
    }
  }
  if (type === "trial_balance") {
    return {
      type,
      rows: trialRows,
      total_debit: money(trialRows.reduce((sum, row) => sum + Math.max(0, localNumber(row.balance)), 0)),
      total_credit: money(trialRows.reduce((sum, row) => sum + Math.max(0, -localNumber(row.balance)), 0)),
    }
  }
  if (type === "balance_sheet") {
    const buckets = trialRows.reduce<Record<string, number>>((output, row) => {
      const balanceType = accountTypeForBalance(localString(row.account_type))
      output[balanceType] = money((output[balanceType] || 0) + localNumber(row.balance))
      return output
    }, {})
    return {
      type,
      assets: money(buckets.asset || 0),
      liabilities: money(Math.abs(buckets.liability || 0)),
      equity: money(Math.abs(buckets.equity || 0)),
      retained_profit: money(salesTotal - purchaseTotal - expenseTotal),
      rows: trialRows,
    }
  }
  if (type === "stock" || type === "stock_valuation") return { type, items: activeRows(products), stock_value: money(activeRows(products).reduce((sum, row) => sum + localNumber(row.stock) * localNumber(row.purchase_rate, localNumber(row.price)), 0)) }
  if (type === "stock_ledger") return { type, entries: activeRows(stockMovements).filter((row) => inDateRange(row, ["movement_date", "created_at"], options.start, options.end)) }
  if (type === "low_stock") return { type, items: activeRows(products).filter((row) => localNumber(row.stock) <= localNumber(row.min_stock, 0)) }
  if (type === "outstanding_customers") {
    return { type, customers: activeRows(customers).filter((row) => localNumber(row.current_balance) > 0), total: money(activeRows(customers).reduce((sum, row) => sum + Math.max(0, localNumber(row.current_balance)), 0)) }
  }
  if (type === "outstanding_suppliers") {
    return { type, suppliers: activeRows(suppliers).filter((row) => localNumber(row.current_balance) > 0), total: money(activeRows(suppliers).reduce((sum, row) => sum + Math.max(0, localNumber(row.current_balance)), 0)) }
  }
  if (type === "expense") return { type, total: expenseTotal, categories: groupSum(expenseRows, "category", "amount"), expenses: expenseRows }
  if (type === "expense_report") return { type, total: expenseTotal, categories: groupSum(expenseRows, "category", "amount"), expenses: expenseRows }
  if (type === "outstanding_report") {
    const customerTotal = money(activeRows(customers).reduce((sum, row) => sum + Math.max(0, localNumber(row.current_balance)), 0))
    const supplierTotal = money(activeRows(suppliers).reduce((sum, row) => sum + Math.max(0, localNumber(row.current_balance)), 0))
    return { type, customer_total: customerTotal, supplier_total: supplierTotal, customers: activeRows(customers), suppliers: activeRows(suppliers) }
  }
  if (type === "gst_summary") {
    return {
      type,
      output_gst: money(sales.reduce((sum, row) => sum + localNumber(row.tax_total, localNumber(row.tax_amount)), 0)),
      input_gst: money(purchaseDocs.reduce((sum, row) => sum + localNumber(row.tax_total), 0) + expenseRows.reduce((sum, row) => sum + localNumber(row.tax_amount), 0)),
    }
  }
  if (type === "tax_wise_sales") {
    return {
      type,
      rows: groupBy(
        salesItems,
        (row) => `${localNumber(row.tax_percent, localNumber(row.gst))}%`,
        (row) => localNumber(row.gst_amount, localNumber(row.tax_amount))
      ),
    }
  }
  if (type === "tax_wise_purchase") {
    return {
      type,
      rows: groupBy(
        purchaseLineItems,
        (row) => `${localNumber(row.tax_percent, localNumber(row.gst))}%`,
        (row) => localNumber(row.tax_amount)
      ),
    }
  }
  if (type === "hsn_summary") {
    const grouped = new Map<string, { hsn_code: string; quantity: number; taxable_amount: number; tax_amount: number }>()
    for (const item of salesItems) {
      const product = productById.get(String(item.product_id || ""))
      const hsn = localString(item.hsn_code, localString(product?.hsn_code, "NA"))
      const current = grouped.get(hsn) || { hsn_code: hsn, quantity: 0, taxable_amount: 0, tax_amount: 0 }
      const tax = localNumber(item.gst_amount, localNumber(item.tax_amount))
      current.quantity += localNumber(item.quantity)
      current.taxable_amount += Math.max(0, localNumber(item.line_total) - tax)
      current.tax_amount += tax
      grouped.set(hsn, current)
    }
    return { type, rows: Array.from(grouped.values()).map((row) => ({ ...row, quantity: money(row.quantity), taxable_amount: money(row.taxable_amount), tax_amount: money(row.tax_amount) })) }
  }
  if (type === "chart_of_accounts") return { type, accounts: accounts.length ? activeRows(accounts) : defaultAccountRows(organizationId) }
  return {
    type: "dashboard",
    sales: salesTotal,
    purchases: purchaseTotal,
    expenses: expenseTotal,
    products: activeRows(products).length,
    customers: activeRows(customers).length,
    suppliers: activeRows(suppliers).length,
  }
}

async function checksum(value: unknown) {
  const text = JSON.stringify(value)
  if (typeof crypto !== "undefined" && crypto.subtle && typeof TextEncoder !== "undefined") {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    return Array.from(new Uint8Array(hash))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) hash = (hash * 33) ^ text.charCodeAt(index)
  return `djb2-${(hash >>> 0).toString(16)}`
}

export async function verifyLocalBackup(organizationId: string, input: DataRow = {}) {
  const now = nowIso()
  const backup = input.backup || (await exportNormalizedBackup())
  const integrity = await service.integrityReport()
  const data = backup && typeof backup === "object" ? (backup as { data?: Partial<Record<string, DataRow[]>> }).data || {} : {}
  const tableNames = Object.keys(data)
  const rowCount = tableNames.reduce((sum, key) => sum + (Array.isArray(data[key]) ? data[key].length : 0), 0)
  const manifest = {
    id: createOfflineId("backup"),
    organization_id: organizationId,
    backup_name: localString(input.backup_name, `Backup ${now.slice(0, 10)}`),
    storage_path: localString(input.storage_path),
    checksum: await checksum(backup),
    size_bytes: JSON.stringify(backup).length,
    table_count: tableNames.length,
    row_count: rowCount,
    verification_status: integrity.ok ? "verified" : "needs_review",
    verified_at: now,
    integrity_report: JSON.stringify(integrity),
    created_at: now,
  }
  const manifests = await readRows(organizationId, "backup_manifest")
  await writeCollections(organizationId, [{ collection: "backup_manifest", value: [manifest, ...manifests] }])
  return { manifest, integrity }
}

function duplicates(rows: DataRow[], keys: string[]) {
  const seen = new Map<string, number>()
  for (const row of rows) {
    const key = keys.map((item) => localString(row[item])).join("::")
    if (!key.replace(/:/g, "")) continue
    seen.set(key, (seen.get(key) || 0) + 1)
  }
  return Array.from(seen.entries())
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count }))
}

export async function runProfessionalIntegrityChecks(organizationId: string) {
  const [
    dbIntegrity,
    invoices,
    invoiceItems,
    purchases,
    purchaseItems,
    ledgerEntries,
    products,
    stockMovements,
    customers,
    suppliers,
    expenses,
    creditNotes,
    debitNotes,
    vouchers,
    voucherEntries,
    accounts,
  ] = await Promise.all([
    service.integrityReport(),
    readRows(organizationId, "invoices"),
    readRows(organizationId, "invoice_items"),
    readRows(organizationId, "purchase_invoices"),
    readRows(organizationId, "purchase_items"),
    readRows(organizationId, "ledger_entries"),
    readRows(organizationId, "products"),
    readRows(organizationId, "stock_movements"),
    readRows(organizationId, "customers"),
    readRows(organizationId, "suppliers"),
    readRows(organizationId, "expenses"),
    readRows(organizationId, "credit_notes"),
    readRows(organizationId, "debit_notes"),
    readRows(organizationId, "accounting_vouchers"),
    readRows(organizationId, "accounting_voucher_entries"),
    readRows(organizationId, "chart_of_accounts"),
  ])
  const invoiceIds = new Set(invoices.map((row) => row.id))
  const purchaseIds = new Set(purchases.map((row) => row.id))
  const voucherIds = new Set(vouchers.map((row) => row.id))
  const accountIds = new Set(accounts.map((row) => row.id))
  const ledgerSignatures = duplicates(ledgerEntries, ["account_type", "account_id", "document_type", "document_id", "debit", "credit"])
  const ledgerByDocument = new Map<string, { debit: number; credit: number }>()
  for (const row of ledgerEntries) {
    const key = `${localString(row.document_type)}:${localString(row.document_id)}`
    const current = ledgerByDocument.get(key) || { debit: 0, credit: 0 }
    current.debit += localNumber(row.debit)
    current.credit += localNumber(row.credit)
    ledgerByDocument.set(key, current)
  }
  const unbalancedDocuments = Array.from(ledgerByDocument.entries())
    .filter(([, value]) => Math.abs(value.debit - value.credit) > 0.01)
    .map(([key, value]) => ({ key, debit: money(value.debit), credit: money(value.credit) }))
  const voucherTotals = new Map<string, { debit: number; credit: number }>()
  for (const row of voucherEntries) {
    const key = localString(row.voucher_id)
    if (!key) continue
    const current = voucherTotals.get(key) || { debit: 0, credit: 0 }
    current.debit += localNumber(row.debit)
    current.credit += localNumber(row.credit)
    voucherTotals.set(key, current)
  }
  const unbalancedVouchers = Array.from(voucherTotals.entries())
    .filter(([, value]) => Math.abs(value.debit - value.credit) > 0.01)
    .map(([key, value]) => ({ key, debit: money(value.debit), credit: money(value.credit) }))
  const activeProducts = activeRows(products)
  const activeLedger = activeRows(ledgerEntries)
  const stockMovementRows = activeRows(stockMovements)
  const stockBalanceMismatches = activeProducts.flatMap((product) => {
    const latestMovement = stockMovementRows
      .filter((row) => row.product_id === product.id)
      .sort((a, b) => localString(b.created_at).localeCompare(localString(a.created_at)))[0]
    if (!latestMovement) return []
    const expected = money(localNumber(latestMovement.new_stock))
    const actual = money(localNumber(product.stock))
    return Math.abs(expected - actual) > 0.01 ? [{ product_id: product.id, product_name: product.name, expected, actual }] : []
  })
  const ledgerBalance = (accountType: string, accountId?: string | null) => {
    const rows = activeLedger.filter((row) => row.account_type === accountType && (accountId ? row.account_id === accountId : true))
    return {
      debit: money(rows.reduce((sum, row) => sum + localNumber(row.debit), 0)),
      credit: money(rows.reduce((sum, row) => sum + localNumber(row.credit), 0)),
    }
  }
  const customerLedgerMismatches = activeRows(customers).flatMap((customer) => {
    const balance = ledgerBalance("customer", localString(customer.id))
    const expected = money(localNumber(customer.opening_balance) + balance.debit - balance.credit)
    const actual = money(localNumber(customer.current_balance))
    return Math.abs(expected - actual) > 0.01 ? [{ customer_id: customer.id, customer_name: customer.name, expected, actual }] : []
  })
  const supplierLedgerMismatches = activeRows(suppliers).flatMap((supplier) => {
    const balance = ledgerBalance("supplier", localString(supplier.id))
    const expected = money(localNumber(supplier.opening_balance) + balance.credit - balance.debit)
    const actual = money(localNumber(supplier.current_balance))
    return Math.abs(expected - actual) > 0.01 ? [{ supplier_id: supplier.id, supplier_name: supplier.name, expected, actual }] : []
  })
  const cashBalance = ledgerBalance("cash")
  const bankBalance = ledgerBalance("bank")
  const gstOutputLedger = ledgerBalance("gst_output")
  const gstInputLedger = ledgerBalance("gst_input")
  const expectedOutputGst = money(
    activeRows(invoices)
      .filter((row) => row.invoice_type !== "proforma")
      .reduce((sum, row) => sum + localNumber(row.tax_total, localNumber(row.tax_amount)), 0) -
      activeRows(creditNotes).reduce((sum, row) => sum + localNumber(row.tax_total, localNumber(row.tax_amount)), 0)
  )
  const expectedInputGst = money(
    activeRows(purchases).reduce((sum, row) => sum + localNumber(row.tax_total, localNumber(row.tax_amount)), 0) +
      activeRows(expenses).reduce((sum, row) => sum + localNumber(row.tax_amount), 0) -
      activeRows(debitNotes).reduce((sum, row) => sum + localNumber(row.tax_total, localNumber(row.tax_amount)), 0)
  )
  const actualOutputGst = money(gstOutputLedger.credit - gstOutputLedger.debit)
  const actualInputGst = money(gstInputLedger.debit - gstInputLedger.credit)
  const gstMismatches = [
    ...(Math.abs(expectedOutputGst - actualOutputGst) > 0.01 ? [{ account: "gst_output", expected: expectedOutputGst, actual: actualOutputGst }] : []),
    ...(Math.abs(expectedInputGst - actualInputGst) > 0.01 ? [{ account: "gst_input", expected: expectedInputGst, actual: actualInputGst }] : []),
  ]

  return {
    ok:
      dbIntegrity.ok &&
      duplicates(invoices, ["organization_id", "invoice_number"]).length === 0 &&
      duplicates(purchases, ["organization_id", "bill_number"]).length === 0 &&
      duplicates(vouchers, ["organization_id", "voucher_number"]).length === 0 &&
      invoiceItems.every((row) => invoiceIds.has(String(row.invoice_id || ""))) &&
      purchaseItems.every((row) => purchaseIds.has(String(row.purchase_invoice_id || ""))) &&
      voucherEntries.every((row) => voucherIds.has(String(row.voucher_id || ""))) &&
      voucherEntries.every((row) => !row.account_id || accountIds.has(String(row.account_id || ""))) &&
      ledgerSignatures.length === 0 &&
      unbalancedDocuments.length === 0 &&
      unbalancedVouchers.length === 0 &&
      products.every((row) => localNumber(row.stock) >= 0) &&
      stockBalanceMismatches.length === 0 &&
      customerLedgerMismatches.length === 0 &&
      supplierLedgerMismatches.length === 0 &&
      gstMismatches.length === 0,
    dbIntegrity,
    duplicate_invoice_numbers: duplicates(invoices, ["organization_id", "invoice_number"]),
    duplicate_purchase_numbers: duplicates(purchases, ["organization_id", "bill_number"]),
    duplicate_voucher_numbers: duplicates(vouchers, ["organization_id", "voucher_number"]),
    orphan_invoice_items: invoiceItems.filter((row) => !invoiceIds.has(String(row.invoice_id || ""))).length,
    orphan_purchase_items: purchaseItems.filter((row) => !purchaseIds.has(String(row.purchase_invoice_id || ""))).length,
    orphan_voucher_entries: voucherEntries.filter((row) => !voucherIds.has(String(row.voucher_id || ""))).length,
    orphan_voucher_accounts: voucherEntries.filter((row) => row.account_id && !accountIds.has(String(row.account_id || ""))).length,
    negative_stock_products: products.filter((row) => localNumber(row.stock) < 0),
    stock_balance_mismatches: stockBalanceMismatches,
    customer_ledger_mismatches: customerLedgerMismatches,
    supplier_ledger_mismatches: supplierLedgerMismatches,
    cash_bank_ledger: {
      cash: { ...cashBalance, balance: money(cashBalance.debit - cashBalance.credit) },
      bank: { ...bankBalance, balance: money(bankBalance.debit - bankBalance.credit) },
    },
    gst_summary_check: {
      output_gst: { expected: expectedOutputGst, actual: actualOutputGst },
      input_gst: { expected: expectedInputGst, actual: actualInputGst },
      mismatches: gstMismatches,
    },
    duplicate_ledger_entries: ledgerSignatures,
    unbalanced_documents: unbalancedDocuments,
    unbalanced_vouchers: unbalancedVouchers,
  }
}
