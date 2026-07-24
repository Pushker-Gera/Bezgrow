import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

const api = read("lib/offline/local/api.ts")
const repositories = read("lib/offline/local/repositories.ts")
const runtime = read("lib/desktop/tauri.ts")
const service = read("lib/offline/local/service.ts")
const products = read("app/dashboard/products/page.tsx")
const customers = read("app/dashboard/customers/page.tsx")
const invoices = read("app/dashboard/invoices/page.tsx")

assert.match(api, /"X-Bezgrow-Data-Source": "sqlite"/, "Local list responses must identify SQLite as their source.")
for (const route of ["products", "customers", "invoices"]) {
  assert.match(api, new RegExp(`url\\.pathname === "/api/${route}/list"`), `${route} must have a desktop-local route.`)
  assert.match(api, new RegExp(`return localListResponse\\("${route}"`), `${route} must return the tagged stable local contract.`)
}
assert.match(
  api,
  /async function listSuppliers[\s\S]*?return jsonResponse\(paginate\(url, rows\)\)\n}/,
  "Supplier responses must retain their own untagged generic contract."
)

assert.ok(api.includes('Number.parseInt(url.searchParams.get("page") || "1"'), "Page must be safely parsed.")
assert.ok(api.includes('url.searchParams.get("limit") || url.searchParams.get("pageSize")'), "limit and pageSize must share one contract.")
assert.ok(api.includes("Number.isFinite(requestedPage)"), "Invalid and empty pagination values need deterministic defaults.")
assert.ok(api.includes('rowMatches(row, ["name", "sku", "category", "supplier", "barcode"]'), "Product search fields regressed.")
assert.ok(api.includes('rowMatches(row, ["name", "email", "phone", "gst_number", "tax_id"]'), "Customer search fields regressed.")
assert.ok(api.includes('rowMatches(invoice, ["invoice_number", "payment_method", "customer_name", "notes"]'), "Invoice search fields regressed.")
for (const parameter of ["category", "supplier", "stock", "customer_type", "gst_status", "status", "customer_id", "period"]) {
  assert.match(api, new RegExp(`searchParams\\.get\\("${parameter}"\\)`), `Missing local filter: ${parameter}`)
}
assert.ok(api.includes("rows.slice(from, from + limit)"), "Pagination must slice once with a stable offset.")
assert.ok(repositories.includes("WHERE organization_id = ? AND deleted_at IS NULL"), "Normalized lists must be workspace scoped.")
assert.ok(runtime.includes("__BEZGROW_RUNTIME__"), "Desktop selection must use an injected runtime marker.")
assert.ok(api.includes('if (mode === "sqlite") return true'), "Online state must not override SQLite selection.")
assert.ok(service.includes("transactionTail"), "SQLite writes must serialize on the shared connection.")

for (const [name, page] of [["products", products], ["customers", customers], ["invoices", invoices]]) {
  assert.ok(page.includes('headers.get("X-Bezgrow-Data-Source") !== "sqlite"'), `${name} must not write a local list back into SQLite.`)
}
assert.match(customers, /finally \{\s*setLoading\(false\)/s, "Customer loader must complete after success and errors.")
assert.match(invoices, /finally \{\s*setLoading\(false\)/s, "Invoice loader must complete after success and errors.")

console.log("local-list-contract-ok")
