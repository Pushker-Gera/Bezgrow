import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"

const root = process.cwd()
const files = [
  "lib/accounting/money.ts", "lib/accounting/journal.ts", "lib/offline/local/accounting.ts",
  "lib/accounting/phase2.ts", "lib/offline/local/accounting-phase2.ts", "lib/offline/local/journal-posting.ts",
  "components/accounting/AccountingWorkspace.tsx", "components/accounting/AccountingPhase2Views.tsx",
]
const source = files.map((file) => readFileSync(path.join(root, file), "utf8")).join("\n")
assert.doesNotMatch(source, /@supabase|supabase-js|from\(["'][^"']+["']\)/i, "Accounting source must not depend on Supabase or a cloud table client")
assert.match(source, /debit_minor/)
assert.match(source, /credit_minor/)
assert.match(source, /reversalOfVoucherId|reversal_of_voucher_id/)
assert.match(source, /CONTROLLED_OPENING/)
assert.match(readFileSync(path.join(root, "lib/offline/local/schema.ts"), "utf8"), /posted_journal_is_immutable/)
assert.match(readFileSync(path.join(root, "app/dashboard/layout.tsx"), "utf8"), /\/dashboard\/accounting/)
const schema = readFileSync(path.join(root, "lib/offline/local/schema.ts"), "utf8")
const localApi = readFileSync(path.join(root, "lib/offline/local/api.ts"), "utf8")
const views = readFileSync(path.join(root, "lib/accounting/views.ts"), "utf8")
const dynamicRoute = readFileSync(path.join(root, "app/dashboard/accounting/[view]/page.tsx"), "utf8")
const native = readFileSync(path.join(root, "src-tauri/src/lib.rs"), "utf8")
assert.match(schema, /LOCAL_DB_VERSION = 21/)
for (const table of ["payment_allocations", "party_advances", "advance_allocations", "bank_reconciliations", "accounting_period_locks", "gst_transaction_classifications", "purchase_attachments"]) assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))
for (const endpoint of ["/api/purchases/reverse", "/api/accounting/reference-data", "/api/accounting/advances/apply", "/api/accounting/bank-reconciliation/save", "/api/accounting/period-lock", "/api/accounting/period-unlock"]) assert.match(localApi, new RegExp(endpoint.replaceAll("/", "\\/")))
for (const group of ["Sales & Receivables", "Purchases & Payables", "Banking", "Tax", "Reports", "Setup"]) assert.match(views, new RegExp(group.replace("&", "&")))
assert.match(dynamicRoute, /@\/lib\/accounting\/views/)
assert.doesNotMatch(dynamicRoute, /import\s*\{[^}]*accountingViews[^}]*\}\s*from\s*["']@\/components\/accounting\/AccountingWorkspace/, "The server route must not execute a client-module export; that caused the packaged accounting page crash.")
assert.match(native, /broken_phase_two_links/)
assert.doesNotMatch(localApi, /createPurchaseDocument\(organizationId, body, kind\)[\s\S]{0,100}purchase_invoice/, "Posted purchase invoices must use the exact Phase 2 service, not the legacy floating ledger helper.")
console.log(JSON.stringify({ status: "ok", localAuthority: "SQLite", cloudAccountingImports: 0, accountingNavigation: true, phaseTwoRoutes: true, serverSafeViewValidation: true, nativeBackupLinks: true }))
