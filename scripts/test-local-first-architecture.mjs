import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import process from "node:process"

const root = process.cwd()
const sourceExtensions = new Set([".js", ".mjs", ".ts", ".tsx"])

function filesUnder(relativePath) {
  const absolute = path.join(root, relativePath)
  if (!statSync(absolute).isDirectory()) return [relativePath]
  const output = []
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(relativePath, entry.name)
    if (entry.isDirectory()) output.push(...filesUnder(child))
    else if (sourceExtensions.has(path.extname(entry.name))) output.push(child)
  }
  return output
}

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8")
}

const prohibitedModuleRoots = [
  "app/dashboard",
  "lib/offline",
  "components/offline",
  "components/print",
  "app/api/customers",
  "app/api/dashboard",
  "app/api/inventory",
  "app/api/invoice-shares",
  "app/api/invoices",
  "app/api/orders",
  "app/api/products",
  "app/api/report-shares",
  "app/api/settings",
  "app/api/workspace",
]

const prohibitedFiles = [
  "app/api/[...erp]/route.ts",
  "lib/api/professional-erp.ts",
  "lib/api/stock-movements.ts",
  "lib/api/tenant.ts",
  "lib/get-organization-features.ts",
  "lib/secure-invoice-share-client.ts",
  "lib/server/invoice-share.ts",
]

const prohibitedModules = [...new Set([...prohibitedModuleRoots.flatMap(filesUnder), ...prohibitedFiles])]
const importViolations = prohibitedModules.filter((filename) => /(?:@\/lib\/supabase|@supabase\/)/.test(read(filename)))
assert.deepEqual(importViolations, [], `Local ERP modules import Supabase:\n${importViolations.join("\n")}`)

const erpTables = [
  "organizations",
  "organization_members",
  "organization_features",
  "products",
  "customers",
  "suppliers",
  "invoices",
  "invoice_items",
  "invoice_payments",
  "orders",
  "order_items",
  "warehouses",
  "inventory_items",
  "stock_movements",
  "financial_years",
  "invoice_series",
  "quotations",
  "quotation_items",
  "purchase_orders",
  "purchase_order_items",
  "purchase_invoices",
  "purchase_invoice_items",
  "payment_receipts",
  "expenses",
  "ledger_entries",
  "invoice_share_links",
]
const tableCallPattern = new RegExp(`\\.from\\(\\s*["'](?:${erpTables.join("|")})["']\\s*\\)`)
const runtimeFiles = [...filesUnder("app"), ...filesUnder("lib"), ...filesUnder("components")]
const tableViolations = runtimeFiles.filter((filename) => tableCallPattern.test(read(filename)))
assert.deepEqual(tableViolations, [], `Runtime code still queries cloud ERP tables:\n${tableViolations.join("\n")}`)

const cloudRoutes = [
  "app/api/[...erp]/route.ts",
  ...[
    "customers",
    "dashboard",
    "inventory",
    "invoice-shares",
    "invoices",
    "orders",
    "products",
    "report-shares",
    "settings",
    "workspace",
  ].flatMap((directory) => filesUnder(`app/api/${directory}`)).filter((filename) => filename.endsWith("route.ts")),
]
for (const filename of cloudRoutes) {
  assert.match(read(filename), /localErpOnly/, `${filename} must fail closed instead of serving cloud ERP data.`)
}

const bootstrap = read("lib/offline/bootstrap.ts")
const sync = read("lib/offline/sync.ts")
const localApi = read("lib/offline/local/api.ts")
const repositories = read("lib/offline/local/repositories.ts")
const adapter = read("lib/offline/local/adapters.ts")
const desktopProxy = read("app/api/desktop-proxy/route.ts")
const license = read("lib/offline/local/license.ts")
const shareClient = read("lib/secure-invoice-share-client.ts")
const updateCoordinator = read("components/desktop/DesktopUpdateCoordinator.tsx")
const loginPage = read("app/login/page.tsx")

assert.doesNotMatch(bootstrap, /fetch\s*\(/, "Offline bootstrap must not hydrate ERP data from the network.")
assert.doesNotMatch(sync, /fetch\s*\(/, "Retired cloud synchronization must not make network calls.")
assert.match(sync, /disabled:\s*true/, "The compatibility sync entry point must explicitly report that it is disabled.")
assert.doesNotMatch(repositories, /INSERT INTO offline_sync_queue/, "SQLite mutations must not create upload queue rows.")
assert.match(localApi, /SQLite is authoritative and there is no cloud upload queue/, "Local API must document the final SQLite commit boundary.")
assert.doesNotMatch(adapter, /CloudAdapter|"supabase"/, "The local repository adapter must not expose a Supabase fallback mode.")
assert.doesNotMatch(shareClient, /fetch\s*\(|pdfBase64/, "Invoice/report sharing must not upload local PDFs.")
assert.doesNotMatch(desktopProxy, /api\/(products|customers|invoices|orders|inventory|suppliers|purchases|expenses|reports)/, "Desktop proxy must not whitelist ERP APIs.")
assert.doesNotMatch(license, /fetch\("\/api\/license\/verify"/, "Stored licenses must verify locally without a server fallback.")
assert.doesNotMatch(license, /operating_system:/, "Device check-ins must not send a user-agent/OS fingerprint.")
assert.match(license, /verifyStoredLicenseRows/, "Stored license rows must be signature-verified before policy evaluation.")
assert.doesNotMatch(updateCoordinator, /CHECK_INTERVAL_MS|setInterval\([^\n]*checkForUpdate|setTimeout\([^\n]*checkForUpdate|addEventListener\("online"/, "Normal desktop startup must not make an implicit control-plane request.")
assert.match(updateCoordinator, /addEventListener\(UPDATE_CHECK_EVENT, handleCheck\)/, "Desktop release checks must remain explicitly user-triggered.")
assert.match(loginPage, /Continue with Verified Local License/, "Offline logout/reopen must retain a locally verified entry path.")
assert.match(loginPage, /localLicenseSnapshot\(organizationId\)[\s\S]*markDesktopSessionActive\(\)/, "The offline entry path must verify the signed local license before restoring access.")

const clientSecretViolations = runtimeFiles.filter((filename) => {
  const source = read(filename)
  return /^\s*["']use client["']/m.test(source) && /(SUPABASE_SERVICE_ROLE_KEY|BEZGROW_LICENSE_PRIVATE_KEY)/.test(source)
})
assert.deepEqual(clientSecretViolations, [], `Client modules reference server secrets:\n${clientSecretViolations.join("\n")}`)

const cleanup = read("supabase/migrations/20260802000000_retire_cloud_erp.sql")
assert.match(cleanup, /verified export evidence is required/, "Cloud ERP cleanup must be backup-gated.")
assert.match(cleanup, /verified local migration evidence is required/, "Cloud ERP cleanup must be local-migration-gated.")
assert.match(cleanup, /select count\(\*\) from public\.%I/, "Cloud ERP cleanup must count rows before dropping tables.")
assert.match(cleanup, /contains % row\(s\)/, "Cloud ERP cleanup must refuse non-empty ERP tables.")
assert.match(cleanup, /protected control-plane object/, "Cloud ERP cleanup must preserve protected control-plane objects.")
assert.match(cleanup, /remaining_erp_relations/, "Cloud ERP cleanup must expose a pre-commit verification result.")
assert.match(cleanup, /issue ROLLBACK/, "Cloud ERP cleanup must document rollback and recovery.")
assert.doesNotMatch(cleanup, /drop\s+(?:table|function|view)[^;]*\bcascade\b/i, "Cloud ERP cleanup must not use broad CASCADE drops.")
for (const table of ["products", "customers", "invoices", "invoice_items", "stock_movements", "organizations"]) {
  assert.match(cleanup, new RegExp(`drop table if exists public\\.${table}\\b`), `Cleanup must retire public.${table}.`)
}
for (const table of ["profiles", "platform_customers", "platform_businesses", "licenses", "registered_devices", "desktop_releases", "release_artifacts", "support_cases", "diagnostic_uploads", "platform_settings", "admin_control_plane_schema_versions", "admin_audit_logs"]) {
  assert.doesNotMatch(cleanup, new RegExp(`drop table if exists public\\.${table}\\b`), `Cleanup must preserve control-plane table public.${table}.`)
}

console.log("Local-first architecture boundary passed.")
