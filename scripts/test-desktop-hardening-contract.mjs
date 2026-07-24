import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

const service = read("lib/offline/local/service.ts")
const sqlite = read("lib/offline/sqlite.ts")
const repositories = read("lib/offline/local/repositories.ts")
const localApi = read("lib/offline/local/api.ts")
const localErp = read("lib/offline/local/erp.ts")
const schema = read("lib/offline/local/schema.ts")
const network = read("lib/offline/network.ts")
const rootLayout = read("app/layout.tsx")
const bootstrap = read("components/desktop/DesktopDatabaseBootstrap.tsx")
const dashboard = read("app/dashboard/layout.tsx")
const products = read("app/dashboard/products/page.tsx")
const customers = read("app/dashboard/customers/page.tsx")
const invoices = read("app/dashboard/invoices/page.tsx")
const invoiceCreate = read("app/dashboard/invoices/create/page.tsx")
const inventory = read("app/dashboard/inventory/page.tsx")
const orders = read("app/dashboard/orders/page.tsx")
const settings = read("app/dashboard/settings/page.tsx")
const recovery = read("components/offline/LocalDatabaseRecovery.tsx")
const rust = read("src-tauri/src/lib.rs")

// One application-lifetime database authority and one concurrent startup.
assert.match(service, /__BEZGROW_LOCAL_DATABASE_MANAGER__/, "Database manager must be global for the application session.")
assert.match(service, /if \(!this\.startupPromise\)[\s\S]*this\.startupPromise = this\.bootstrap\(\)/, "Concurrent callers must share one startup promise.")
assert.match(service, /private transactionTail: Promise<void> = Promise\.resolve\(\)/, "Mutations must serialize on the one SQLite connection.")
assert.doesNotMatch(sqlite, /\bdbPromise\b/, "No second SQLite startup promise may exist in the facade.")
assert.match(rootLayout, /DesktopDatabaseBootstrap/, "Desktop SQLite must initialize from the root application lifecycle.")
assert.match(bootstrap, /ensureReady\(\)/, "Root bootstrap must initialize SQLite before page-specific use.")
assert.doesNotMatch(bootstrap, /onCloseRequested|closeForAppShutdown|desktop_exit/, "Frontend shutdown code must not close SQLite before the native process exits.")
assert.doesNotMatch(service, /closeForAppShutdown|pluginConnection\.close/, "The frontend must never leave a closed plugin pool inside a live desktop process.")
assert.match(recovery, /retryInitialization\(\)/, "Recovery UI must retry the retained database startup failure.")
assert.match(recovery, />\s*Retry Database\s*</, "Recovery UI must expose a deterministic Retry Database action.")
assert.match(rust, /WindowEvent::CloseRequested[\s\S]*Native close requested[\s\S]*stop_next_server\(&app\)[\s\S]*app\.exit\(0\)/, "Every native red-button close must stop the bundled server and exit the process.")

// Rollback and diagnostic guarantees use one native connection instead of a
// pooled sequence of unrelated BEGIN/write/COMMIT calls.
assert.match(service, /executeNativeTransaction\(statements\)/, "Buffered writes must cross the native atomic transaction boundary.")
assert.match(service, /recordOperationFailure\("sqlite_transaction"[\s\S]*desktop_execute_transaction/, "Transaction diagnostics must retain the exact native command.")
assert.match(rust, /BEGIN IMMEDIATE[\s\S]*PRAGMA defer_foreign_keys = ON[\s\S]*ROLLBACK[\s\S]*COMMIT/s, "Native batches must use one immediate transaction, defer intermediate FK checks, and roll back failures.")
assert.match(localApi, /recordOperationFailure\([\s\S]*local_api:[\s\S]*url\.pathname/, "Local adapter diagnostics must retain the exact route.")
assert.match(localApi, /error instanceof LocalDatabaseUnavailableError/, "Only a typed startup failure may show the database-start message.")

// Core domain data and its sync intent must commit in the same SQLite transaction.
assert.match(repositories, /putNormalizedCollectionsInTransaction\([\s\S]*action\?: OfflineAction[\s\S]*service\.transaction[\s\S]*queueNormalizedActionWithDb/s, "Collection changes and pending sync actions must commit together.")
assert.match(repositories, /organization_id: undefined,[\s\S]*id: text\(input, \["id"\], organizationId\)/, "Tenant-root organization writes must not target a nonexistent organization_id column.")
assert.match(repositories, /previousImporterCompleted[\s\S]*normalized_legacy_import_complete/, "Completed legacy imports must not rerun after application upgrades.")
assert.match(localApi, /pendingAction\(createOfflineId\("product-action"\), "save_product"/, "Product create/update must include its sync action in the transaction.")
assert.match(localApi, /pendingAction\(createOfflineId\("customer-action"\), "save_customer"/, "Customer create/update must include its sync action in the transaction.")
assert.match(localApi, /pendingAction\(offlineClientId, "create_invoice"/, "Invoice rows, stock, ledger, payment, and sync action must share one transaction.")
assert.match(localApi, /largestExistingSequence \+ 1/, "Invoice numbering must advance past the largest stored invoice even when the organization counter is stale.")
assert.match(localApi, /next_invoice_number: invoiceSequence \+ 1/, "A successful invoice must persist the sequence after the number actually assigned.")
assert.match(localApi, /pendingAction\(createOfflineId\("invoice-delete-action"\), "delete_invoice"/, "Invoice correction and stock restoration must share one transaction.")
assert.match(localApi, /pendingAction\(createOfflineId\("stock-action"\), "stock_movement"/, "Simple stock changes must include their sync action in the transaction.")
assert.match(localErp, /createPaymentTransaction\([^)]*action\?: OfflineAction[\s\S]*writeCollections\([^;]*action\)/s, "Payments and ledger effects must include their sync action in the transaction.")
assert.match(localErp, /createInventoryMovement\([^)]*action\?: OfflineAction[\s\S]*writeCollections\([^;]*action\)/s, "Professional stock changes must include their sync action in the transaction.")

// Validation, rollback-sensitive invoice correction, and workspace isolation.
assert.match(localApi, /A product with this SKU already exists/, "Unique SKU must have an accurate validation response.")
assert.match(service, /sqlite_unique_constraint/, "Operation diagnostics must classify unique-constraint failures without mislabeling SQLite itself as a missing plugin.")
assert.match(localApi, /Opening stock must be a valid number/, "Invalid opening stock must fail before mutation.")
assert.match(localApi, /Enter a valid customer email address/, "Customer email validation must not be reported as database startup failure.")
assert.match(localApi, /deleted and stock restored/, "Invoice correction must create an explicit stock-restoration movement.")
assert.match(localApi, /sync_status: "pending_delete"/, "Invoice correction must retain an offline deletion tombstone instead of leaving pending local rows active.")
assert.match(localApi, /alreadyRestoredByProduct[\s\S]*Math\.max\(0, quantity -/, "Invoice correction retries must never restore the same product stock twice.")
assert.match(localApi, /last_purchase_at: remainingCustomerInvoices/, "Invoice correction must recompute the customer's last purchase from remaining invoices.")
assert.match(repositories, /WHERE organization_id = \? AND deleted_at IS NULL/, "Business rows must be scoped to the selected workspace.")
assert.match(repositories, /queryNormalizedProducts[\s\S]*LIMIT \? OFFSET \?/, "Product list must be bounded in SQLite.")
assert.match(repositories, /queryNormalizedCustomers[\s\S]*LIMIT \? OFFSET \?/, "Customer list must be bounded in SQLite.")
assert.match(repositories, /queryNormalizedInvoices[\s\S]*LIMIT \? OFFSET \?/, "Invoice list must be bounded in SQLite.")
assert.match(schema, /idx_products_org_sku_unique/, "Active SKU uniqueness must be enforced by SQLite.")
for (const index of [
  "idx_products_org_active_created",
  "idx_products_org_category_supplier",
  "idx_customers_org_active_created",
  "idx_customers_org_filters",
  "idx_sales_invoices_org_active_created",
  "idx_sales_invoices_org_filters",
  "idx_sales_items_invoice_active",
]) {
  assert.match(schema, new RegExp(index), `Missing hardened list index: ${index}`)
}

// Online state cannot select a different packaged storage authority.
assert.match(network, /shouldUseWebOfflineFallback[\s\S]*return !\(await isDesktopRuntime/, "Browser cache fallback must be disabled in packaged Tauri.")
for (const [name, page] of [
  ["products", products],
  ["customers", customers],
  ["invoices", invoices],
  ["invoice create", invoiceCreate],
  ["inventory", inventory],
  ["orders", orders],
  ["settings", settings],
]) {
  assert.match(page, /shouldUseWebOfflineFallback/, `${name} must explicitly reject the web fallback in packaged Tauri.`)
}
assert.match(dashboard, /router\.replace\("\/login"\)[\s\S]*void supabase\.auth\.signOut\(\)/, "Optional cloud logout must not block local navigation.")
assert.doesNotMatch(dashboard, /clearOfflineData|clearNormalizedData/, "Logout must not delete business data or the license.")

// Loaders and stale requests must terminate deterministically.
assert.match(customers, /skipNextCustomersRefresh/, "Customer initialization must not duplicate its initial fetch.")
assert.match(customers, /finally \{\s*setLoading\(false\)/s, "Customer loader must terminate after success or error.")
assert.match(invoices, /finally \{\s*setLoading\(false\)/s, "Invoice loader must terminate after success or error.")
assert.match(products, /productsRequest\.current\?\.abort\(\)/, "Product filters must cancel a stale request.")
assert.match(customers, /customersRequest\.current\?\.abort\(\)/, "Customer filters must cancel a stale request.")
assert.match(invoices, /billingRequest\.current\?\.abort\(\)/, "Invoice filters must cancel a stale request.")

// Incomplete modules stay out of production; the dormant path remains auditable in development.
assert.match(settings, /const showExperimentalModules = process\.env\.NODE_ENV === "development"/, "Incomplete module cards must be development-only.")
assert.match(settings, /\{showExperimentalModules && \([\s\S]*data-development-only="business-modules"/, "Production must not render the experimental module catalog.")
assert.match(localApi, /settings\.feature_toggled/, "A persisted module change must create an audit entry.")
assert.match(localApi, /pendingAction\(createOfflineId\("feature-action"\), "save_settings"/, "Settings value, audit entry, and sync intent must commit together.")

console.log("desktop-hardening-contract-ok")
