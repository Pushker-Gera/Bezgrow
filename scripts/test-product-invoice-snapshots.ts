import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { buildPrintInvoice, type PrintRow } from "../lib/print-invoice-builder"

const invoice: PrintRow = {
  id: "invoice-1",
  invoice_number: "INV-00003",
  invoice_date: "2026-08-13",
  grand_total: 118,
  total_amount: 118,
  subtotal: 100,
  taxable_amount: 100,
  tax_amount: 18,
  payment_status: "paid",
  paid_amount: 118,
}
const snapshot: PrintRow = {
  id: "item-1",
  invoice_id: invoice.id,
  product_id: "product-1",
  product_name: "Snapshot Medicine",
  batch_no: "BATCH-ORIGINAL",
  expiry_date: "2028-04-30",
  hsn_code: "30049099",
  unit: "box",
  mrp: 125,
  quantity: 1,
  unit_price: 100,
  tax_percent: 18,
  gst_amount: 18,
  line_total: 100,
}
const editedProduct: PrintRow = {
  id: "product-1",
  name: "Edited Medicine",
  batch_no: "BATCH-CHANGED",
  expiry_date: "2030-01-01",
  hsn_code: "99999999",
  unit: "pcs",
  mrp: 999,
}

const printable = buildPrintInvoice({
  invoice,
  items: [snapshot],
  organization: { id: "org-1", name: "R & G Healthcare" },
  customer: { id: "customer-1", name: "Customer" },
  products: [editedProduct],
  origin: "http://127.0.0.1",
})

assert.equal(printable.items[0].batchNumber, "BATCH-ORIGINAL")
assert.equal(printable.items[0].expiryDate, "2028-04-30")
assert.equal(printable.items[0].hsnCode, "30049099")
assert.equal(printable.items[0].unit, "box")
assert.equal(printable.items[0].mrp, 125)

const schema = readFileSync(new URL("../lib/offline/local/schema.ts", import.meta.url), "utf8")
const billing = readFileSync(new URL("../app/dashboard/invoices/create/page.tsx", import.meta.url), "utf8")
const localApi = readFileSync(new URL("../lib/offline/local/api.ts", import.meta.url), "utf8")
const repository = readFileSync(new URL("../lib/offline/local/repositories.ts", import.meta.url), "utf8")
const printBuilder = readFileSync(new URL("../lib/print-invoice-builder.ts", import.meta.url), "utf8")
const productPage = readFileSync(new URL("../app/dashboard/products/page.tsx", import.meta.url), "utf8")
assert.match(schema, /version: 9[\s\S]*invoice_item_product_snapshot_fields/)
for (const field of ["batch_no", "expiry_date", "unit", "mrp"]) {
  assert.match(schema, new RegExp(`ALTER TABLE sales_invoice_items ADD COLUMN ${field}`))
}
assert.match(schema, /hsn_code = COALESCE/)
for (const field of ["batch_no", "expiry_date", "hsn_code", "unit", "mrp"]) {
  assert.match(billing, new RegExp(`${field}: item\\.${field}`), `Billing must include ${field} in the saved invoice-item payload`)
  assert.match(localApi, new RegExp(`${field}:`), `The local invoice service must snapshot ${field}`)
  assert.match(repository, new RegExp(`${field}:`), `SQLite normalization must persist ${field}`)
}
assert.match(printBuilder, /batchNumber: stringFrom\(item, \["batch_no", "batch_number"\]\)/)
assert.match(printBuilder, /expiryDate: dateValue\(item, \["expiry_date"\]\)/)
assert.doesNotMatch(printBuilder, /batchNumber:[^\n]*product|expiryDate:[^\n]*product|hsnCode:[^\n]*product/, "Historical invoice rendering must not re-read mutable product fields")
assert.match(productPage, /placeholder="BATCH NO\."/, "The ordinary product form must expose Batch No.")
assert.match(productPage, /placeholder="HSN \/ SAC Code"/, "The product form must expose HSN / SAC")
assert.doesNotMatch(productPage, /placeholder="SKU"/, "The ordinary product form must not ask users for an SKU")

console.log("product-invoice-snapshots-ok batch=BATCH-ORIGINAL expiry=2028-04-30 hsn=30049099 historical=true")
