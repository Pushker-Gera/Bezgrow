/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { copyFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { buildCsvBytes } from "../lib/desktop-file-export"
import { createInvoicePdf } from "../lib/pdf-invoice"
import { defaultPrintSettings } from "../components/print/settings/defaults"
import type { PrintInvoice } from "../components/print/types"

async function main() {
const sourceDatabase =
  process.env.BEZGROW_QA_DATABASE ||
  "/Users/pushkergera/Library/Application Support/com.bezgrow.erp/bezgrow-offline.db"
const organizationId = "biz_r-g-healthcare"
const qaDirectory = mkdtempSync(path.join(tmpdir(), "bezgrow-final-performance-"))
const databasePath = path.join(qaDirectory, "performance.sqlite")
copyFileSync(sourceDatabase, databasePath)

function percentile(values: number[], ratio: number) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]
}

function round(value: number) {
  return Number(value.toFixed(3))
}

function measureSync(iterations: number, operation: () => void) {
  const values: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now()
    operation()
    values.push(performance.now() - started)
  }
  return { medianMs: round(percentile(values, 0.5)), p95Ms: round(percentile(values, 0.95)) }
}

async function measureAsync(iterations: number, operation: () => Promise<void>) {
  const values: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now()
    await operation()
    values.push(performance.now() - started)
  }
  return { medianMs: round(percentile(values, 0.5)), p95Ms: round(percentile(values, 0.95)) }
}

const databaseStartup = measureSync(12, () => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  database.prepare("PRAGMA schema_version").get()
  database.close()
})

const database = new DatabaseSync(databasePath)
database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;")

const dashboardStatement = database.prepare(`
  SELECT
    (SELECT COUNT(*) FROM products WHERE organization_id = ? AND deleted_at IS NULL) AS products,
    (SELECT COUNT(*) FROM customers WHERE organization_id = ? AND deleted_at IS NULL) AS customers,
    (SELECT COUNT(*) FROM sales_invoices WHERE organization_id = ? AND deleted_at IS NULL) AS invoices,
    (SELECT COALESCE(SUM(grand_total), 0) FROM sales_invoices WHERE organization_id = ? AND deleted_at IS NULL) AS revenue,
    (SELECT COALESCE(SUM(stock * COALESCE(NULLIF(sale_rate, 0), price, 0)), 0) FROM products WHERE organization_id = ? AND deleted_at IS NULL) AS inventory_value
`)
const productsStatement = database.prepare(
  "SELECT id, name, sku, barcode, stock, price, updated_at FROM products WHERE organization_id = ? AND deleted_at IS NULL ORDER BY datetime(updated_at) DESC LIMIT 100"
)
const customersStatement = database.prepare(
  "SELECT id, name, phone, email, gst_number, current_balance, updated_at FROM customers WHERE organization_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE LIMIT 100"
)
const invoicesStatement = database.prepare(
  "SELECT id, invoice_number, invoice_date, customer_id, customer_name, payment_status, grand_total, updated_at FROM sales_invoices WHERE organization_id = ? AND deleted_at IS NULL ORDER BY invoice_date DESC, invoice_number DESC LIMIT 100"
)
const invoiceDetailStatement = database.prepare(`
  SELECT invoice.id, invoice.invoice_number, invoice.grand_total, customer.name, item.product_name, item.quantity, item.line_total
  FROM sales_invoices invoice
  LEFT JOIN customers customer ON customer.id = invoice.customer_id
  LEFT JOIN sales_invoice_items item ON item.invoice_id = invoice.id AND item.deleted_at IS NULL
  WHERE invoice.organization_id = ? AND invoice.id = ?
`)

const firstInvoice = invoicesStatement.get(organizationId) as { id: string }
const dashboardReadiness = measureSync(100, () => {
  dashboardStatement.get(organizationId, organizationId, organizationId, organizationId, organizationId)
})
const productList = measureSync(100, () => {
  productsStatement.all(organizationId)
})
const customerList = measureSync(100, () => {
  customersStatement.all(organizationId)
})
const invoiceList = measureSync(100, () => {
  invoicesStatement.all(organizationId)
})
const invoiceDetail = measureSync(100, () => {
  invoiceDetailStatement.all(organizationId, firstInvoice.id)
})

const customer = database
  .prepare("SELECT id, name FROM customers WHERE organization_id = ? AND deleted_at IS NULL LIMIT 1")
  .get(organizationId) as { id: string; name: string }
const product = database
  .prepare("SELECT id, name FROM products WHERE organization_id = ? AND deleted_at IS NULL LIMIT 1")
  .get(organizationId) as { id: string; name: string }
const insertInvoice = database.prepare(`
  INSERT INTO sales_invoices (
    id, organization_id, customer_id, customer_name, invoice_number, invoice_date,
    subtotal, taxable_amount, tax_amount, total_amount, grand_total, total,
    paid_amount, outstanding_amount, payment_status, status, payment_method
  ) VALUES (?, ?, ?, ?, ?, date('now'), 100, 100, 18, 118, 118, 118, 0, 118, 'unpaid', 'unpaid', 'cash')
`)
const insertItem = database.prepare(`
  INSERT INTO sales_invoice_items (
    id, organization_id, invoice_id, product_id, product_name, quantity,
    unit_price, tax_percent, line_total, gst_amount, cgst_amount, sgst_amount
  ) VALUES (?, ?, ?, ?, ?, 1, 100, 18, 118, 18, 9, 9)
`)
const invoiceSave = measureSync(30, () => {
  database.exec("BEGIN IMMEDIATE")
  try {
    insertInvoice.run(
      "E2E-OFFLINE-FINAL-PERF-invoice",
      organizationId,
      customer.id,
      customer.name,
      "E2E-OFFLINE-FINAL-PERF-00001"
    )
    insertItem.run(
      "E2E-OFFLINE-FINAL-PERF-item",
      organizationId,
      "E2E-OFFLINE-FINAL-PERF-invoice",
      product.id,
      product.name
    )
  } finally {
    database.exec("ROLLBACK")
  }
})

const invoiceRows = invoicesStatement.all(organizationId) as Array<Record<string, unknown>>
const csvColumns = Object.keys(invoiceRows[0] || {}).map((key) => ({
  header: key,
  value: (row: Record<string, unknown>) => row[key],
}))
const csvExport = measureSync(100, () => {
  buildCsvBytes(csvColumns, invoiceRows)
})

const pdfInvoice: PrintInvoice = {
  id: firstInvoice.id,
  invoiceNumber: "INV-00004",
  invoiceTitle: "Tax Invoice",
  invoiceDate: "2026-07-25",
  dueDate: "-",
  salesperson: "-",
  enterprise: {
    organizationId,
    name: "R & G Healthcare",
    businessType: "Pharmacy",
    gstNumber: "-",
    fssai: "-",
    phone: "-",
    email: "-",
    website: "-",
    address: "-",
    logoUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYGJAQoAHgQCAelx2VQAAAAASUVORK5CYII=",
    branchName: "Main Branch",
  },
  customer: {
    id: customer.id,
    name: customer.name,
    phone: "09876543210",
    email: "customer@example.test",
    gstin: "-",
    address: "-",
    state: "-",
    stateCode: "-",
  },
  items: [
    {
      id: "item",
      name: product.name,
      sku: "00001",
      hsnCode: "30049099",
      batchNumber: "BATCH-1",
      manufacturingDate: "",
      expiryDate: "",
      scheduleType: "",
      unit: "pcs",
      quantity: 1,
      freeQuantity: 0,
      rate: 100,
      mrp: 120,
      discountPercent: 0,
      discountAmount: 0,
      taxableValue: 100,
      cgstPercent: 9,
      cgstAmount: 9,
      sgstPercent: 9,
      sgstAmount: 9,
      igstPercent: 0,
      igstAmount: 0,
      finalAmount: 118,
    },
  ],
  payment: { mode: "Cash", paidAmount: 0, dueAmount: 118, balanceAmount: 118, cashReceived: 0 },
  totals: {
    subtotal: 100,
    discount: 0,
    taxableAmount: 100,
    cgst: 9,
    sgst: 9,
    igst: 0,
    roundOff: 0,
    grandTotal: 118,
    amountInWords: "Rupees One Hundred Eighteen Only",
  },
  terms: [],
  notes: "",
  qrValue: "BEZGROW-INVOICE:INV-00004",
  barcodeValue: "INV-00004",
  watermark: "UNPAID",
}
const pdfCreation = await measureAsync(8, async () => {
  await createInvoicePdf(pdfInvoice, defaultPrintSettings, "a4")
})

database.close()

console.log(
  JSON.stringify(
    {
      qaDatabase: databasePath,
      databaseStartup,
      dashboardReadiness,
      productList,
      customerList,
      invoiceList,
      invoiceDetail,
      invoiceSaveTransactionRollback: invoiceSave,
      csvGeneration: csvExport,
      pdfCreation,
    },
    null,
    2
  )
)
}

void main()
