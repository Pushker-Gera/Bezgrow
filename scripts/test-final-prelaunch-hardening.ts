import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { calculateInventoryCost } from "../lib/offline/local/inventory-cost"

const exactCost = calculateInventoryCost(
  [
    { id: "p1", stock: 8, purchase_rate: 20 },
    { id: "p2", stock: 3, purchase_rate: 7.5 },
  ],
  [
    { id: "new", product_id: "p1", quantity: 5, purchase_rate: 14, purchase_date: "2026-02-01" },
    { id: "old", product_id: "p1", quantity: 2, purchase_rate: 10.25, purchase_date: "2026-01-01" },
  ],
)
assert.equal(exactCost, 2 * 10.25 + 5 * 14 + 1 * 20 + 3 * 7.5, "Inventory cost must use FIFO batch costs and product-rate fallback without rounding")

const read = (path: string) => readFileSync(path, "utf8")
const inventory = read("app/dashboard/inventory/page.tsx")
const localApi = read("lib/offline/local/api.ts")
const localErp = read("lib/offline/local/erp.ts")
const schema = read("lib/offline/local/schema.ts")
const profile = read("app/profile/page.tsx")
const invoices = read("app/dashboard/invoices/page.tsx")
const billing = read("app/dashboard/billing/page.tsx")
const products = read("app/dashboard/products/page.tsx")
const settings = read("app/dashboard/settings/page.tsx")

assert.match(inventory, /label: "Inventory Cost"/)
assert.match(inventory, /label: "Inventory Value"/, "Inventory Cost must not replace the existing selling-value metric")
assert.match(inventory, /inventoryCost: calculateInventoryCost\(\[product\], cachedBatches\)/)
assert.match(inventory, /purchase_date: mode === "add" \? purchaseDate \|\| null : null/)
assert.match(inventory, /purchase_rate: mode === "add" \? parsedPurchaseRate : null/)
assert.doesNotMatch(localErp, /purchase_date: now\.slice\(0, 10\)/, "Optional purchase dates must not be silently fabricated")
assert.match(localApi, /consumeInvoiceBatches\(batches, items, now\)/)
assert.match(localApi, /batchDeltas,/)
assert.match(localApi, /deleteNormalizedInvoiceAtomic\(/, "Invoice deletion must reverse stock in one bounded SQLite transaction.")
assert.match(localApi, /reference_type: "invoice_delete"/)
assert.match(schema, /LOCAL_DB_VERSION = 15/)
assert.match(schema, /ALTER TABLE organizations ADD COLUMN joined_at TEXT/)
assert.match(schema, /trg_products_nonnegative_stock_update/, "SQLite must abort concurrent invoice stock underflow.")
assert.match(localApi, /inventoryDeltas: consumedBatches\.allocations/, "Invoice stock must update one matching inventory lot per allocation.")
assert.match(profile, /Joined Bezgrow/)
for (const source of [invoices, billing]) {
  for (const column of ["Invoice #", "Date", "Customer", "Status", "Total", "Paid", "Due", "Actions"]) assert.match(source, new RegExp(`>${column}<`))
}
assert.doesNotMatch(products, /Product Coverage|Operating Modules|Enabled Features/)
assert.doesNotMatch(settings, /Setup Readiness/)

console.log("final-prelaunch-hardening-ok inventory-cost=exact batch-lifecycle=covered joined-date=stable billing-table=compact")
