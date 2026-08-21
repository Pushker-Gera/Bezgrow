import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

const schema = read("lib/offline/local/schema.ts");
const service = read("lib/offline/local/service.ts");
const bootstrap = read("lib/offline/bootstrap.ts");
const repositories = read("lib/offline/local/repositories.ts");
const localApi = read("lib/offline/local/api.ts");

const requiredIndexes = [
  "idx_products_org_name",
  "idx_products_org_sku",
  "idx_customers_org_name",
  "idx_sales_invoices_org_created",
  "idx_sales_invoices_org_customer",
  "idx_orders_org_created",
  "idx_inventory_product_warehouse",
  "idx_stock_movements_org_type_date",
  "idx_ledger_org_account_date",
  "idx_backup_verification",
];

for (const indexName of requiredIndexes) {
  assert.match(schema, new RegExp(indexName), `Performance-critical index missing: ${indexName}`);
}

const indexes = schema.match(/CREATE INDEX IF NOT EXISTS/g) || [];
assert.ok(indexes.length >= 40, `Expected at least 40 local indexes; found ${indexes.length}.`);

for (const pragma of [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = FULL",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA cache_size = -64000",
]) {
  assert.match(service, new RegExp(pragma.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `SQLite performance pragma missing: ${pragma}`);
}

assert.match(service, /desktop_execute_transaction/, "Local writes must use the native single-connection transaction command.");
assert.doesNotMatch(bootstrap, /fetch\s*\(/, "Local startup must not wait for network downloads.");
assert.match(bootstrap, /local-sqlite-only/, "Offline preparation must terminate at the local SQLite workspace.");
assert.match(repositories, /ORDER BY datetime\(updated_at\) DESC/, "Backup exports should stream organizations in deterministic recent order.");
assert.match(repositories, /SELECT name FROM sqlite_master WHERE type = 'table' AND name = \? LIMIT 1/, "Legacy import table checks must be indexed metadata probes.");
for (const query of ["queryNormalizedProducts", "queryNormalizedCustomers", "queryNormalizedInvoices"]) {
  assert.match(repositories, new RegExp(`export async function ${query}`), `${query} must query SQLite directly.`);
}
assert.match(repositories, /LIMIT \? OFFSET \?/, "Desktop list queries must be bounded in SQLite.");
assert.match(repositories, /COUNT\(\*\) AS total/, "Desktop pagination totals must come from SQLite.");
assert.match(schema, /trg_products_nonnegative_stock_update/, "Concurrent invoice writes need a database-level nonnegative stock guard.");
assert.match(repositories, /invoice_id IN \(SELECT id FROM invoice_page\)/, "Invoice item aggregation must be limited to the current page.");
assert.match(repositories, /queryNormalizedDashboardSummary/, "Dashboard totals must be aggregated by SQLite.");
assert.match(repositories, /queryNormalizedAnalyticsReport/, "Report charts must be aggregated by SQLite.");
assert.match(schema, /idx_movements_org_reference_active/, "Invoice reversal lookups must be indexed by their bounded reference.");
assert.match(repositories, /deleteNormalizedInvoiceAtomic/, "Invoice reversal must use a single normalized SQLite transaction.");
assert.match(localApi, /readNormalizedInvoiceDeletionContext/, "Invoice deletion must load only the selected invoice context.");
const deletionBody = localApi.slice(localApi.indexOf("async function deleteInvoice"), localApi.indexOf("function normalizedCommercialItems"));
assert.doesNotMatch(deletionBody, /readCollection/, "Invoice deletion must not load complete historical collections.");

console.log("performance-contract-ok");
