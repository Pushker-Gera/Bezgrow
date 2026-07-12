import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

const schema = read("lib/offline/local/schema.ts");
const service = read("lib/offline/local/service.ts");
const bootstrap = read("lib/offline/bootstrap.ts");
const repositories = read("lib/offline/local/repositories.ts");

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
  "idx_sync_queue_status",
  "idx_sync_queue_org",
  "idx_backup_verification",
];

for (const indexName of requiredIndexes) {
  assert.match(schema, new RegExp(indexName), `Performance-critical index missing: ${indexName}`);
}

const indexes = schema.match(/CREATE INDEX IF NOT EXISTS/g) || [];
assert.ok(indexes.length >= 40, `Expected at least 40 local indexes; found ${indexes.length}.`);

for (const pragma of [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA cache_size = -64000",
]) {
  assert.match(service, new RegExp(pragma.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `SQLite performance pragma missing: ${pragma}`);
}

assert.match(service, /BEGIN IMMEDIATE/, "Local writes must use explicit write transactions.");
assert.match(bootstrap, /const pageSize = 100/, "Offline preparation must page network downloads.");
assert.match(bootstrap, /page <= 1000/, "Offline preparation must cap page loops.");
assert.match(repositories, /ORDER BY datetime\(updated_at\) DESC/, "Backup exports should stream organizations in deterministic recent order.");
assert.match(repositories, /SELECT name FROM sqlite_master WHERE type = 'table' AND name = \? LIMIT 1/, "Legacy import table checks must be indexed metadata probes.");

console.log("performance-contract-ok");
