import { createHash } from "node:crypto"
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { createClient } from "@supabase/supabase-js"

const EXPECTED_MANIFEST_SHA256 = "8e5fd0b7a99605cc6ed3eaf2f176969e89503bc01255fae6b6b48ea5ee2664d7"
const DELETE_ORDER = [
  "invoice_share_links",
  "accounting_voucher_entries",
  "accounting_vouchers",
  "chart_of_accounts",
  "bank_accounts",
  "invoice_payments",
  "payment_receipts",
  "invoice_items",
  "sales_invoice_items",
  "sales_invoices",
  "invoices",
  "order_items",
  "orders",
  "quotation_items",
  "quotations",
  "purchase_invoice_items",
  "purchase_invoices",
  "purchase_order_items",
  "purchase_orders",
  "stock_movements",
  "inventory_items",
  "warehouses",
  "products",
  "customers",
  "suppliers",
  "expenses",
  "ledger_entries",
  "invoice_series",
  "financial_years",
  "organization_features",
  "organization_members",
  "organizations",
]

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

async function atomicProtectedWrite(filename, bytes) {
  const temporary = `${filename}.tmp-${process.pid}`
  await writeFile(temporary, bytes, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, filename)
}

async function main() {
  const backupArgument = process.argv.find((value) => value.startsWith("--backup="))?.slice("--backup=".length)
  const confirmedChecksum = process.argv.find((value) => value.startsWith("--confirm-manifest-sha256="))?.slice("--confirm-manifest-sha256=".length)
  if (!backupArgument || !process.argv.includes("--apply") || confirmedChecksum !== EXPECTED_MANIFEST_SHA256) {
    throw new Error(`Cleanup is gated. Supply --backup, --apply, and --confirm-manifest-sha256=${EXPECTED_MANIFEST_SHA256}.`)
  }

  const directory = path.resolve(backupArgument)
  const manifestBytes = await readFile(path.join(directory, "manifest.json"))
  if (sha256(manifestBytes) !== EXPECTED_MANIFEST_SHA256) throw new Error("Protected export manifest checksum does not match.")
  const manifest = JSON.parse(manifestBytes.toString("utf8"))
  if (manifest.verification !== "checksums-and-json-readback-passed") throw new Error("Protected export verification evidence is missing.")

  const comparison = JSON.parse((await readFile(path.join(directory, "local-comparison.json"))).toString("utf8"))
  if (!comparison.safeToRetireCloudCopy || comparison.totals?.missingLocally !== 0 || comparison.sqliteIntegrity !== "ok" || comparison.sqliteForeignKeyViolations !== 0) {
    throw new Error("Local migration verification does not permit cloud cleanup.")
  }
  const importReport = JSON.parse((await readFile(path.join(directory, "local-import.json"))).toString("utf8"))
  if (!importReport.applied || importReport.sqliteIntegrity !== "ok" || importReport.sqliteForeignKeyViolations !== 0 || !importReport.preMigrationBackupChecksumSha256) {
    throw new Error("Applied local import and pre-migration backup evidence is missing.")
  }
  const noWriteAudit = JSON.parse((await readFile(path.join(directory, "supabase-no-write-audit.json"))).toString("utf8"))
  if (!noWriteAudit.allRowCountsUnchanged || noWriteAudit.baselineManifestChecksumSha256 !== EXPECTED_MANIFEST_SHA256) {
    throw new Error("Pre-cleanup Supabase no-write evidence is missing.")
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase URL and service-role key are required.")
  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const tables = []

  for (const table of DELETE_ORDER) {
    const deleted = await client.from(table).delete({ count: "exact" }).not("id", "is", null)
    if (deleted.error && ["42P01", "PGRST205"].includes(deleted.error.code)) {
      tables.push({ table, status: "not_present", deletedRowCount: 0, remainingRowCount: 0 })
      continue
    }
    if (deleted.error) throw new Error(`${table}: ${deleted.error.code || "DELETE_FAILED"}: ${deleted.error.message}`)
    const verified = await client.from(table).select("*", { count: "exact", head: true })
    if (verified.error) throw new Error(`${table}: ${verified.error.code || "VERIFY_FAILED"}: ${verified.error.message}`)
    tables.push({ table, status: "retired", deletedRowCount: deleted.count ?? 0, remainingRowCount: verified.count ?? 0 })
  }

  const allAvailableTablesEmpty = tables.every((table) => table.remainingRowCount === 0)
  if (!allAvailableTablesEmpty) throw new Error("One or more legacy ERP tables still contain rows.")
  const report = {
    format: "bezgrow-supabase-erp-row-cleanup-v1",
    cleanedAt: new Date().toISOString(),
    manifestChecksumSha256: EXPECTED_MANIFEST_SHA256,
    exportVerification: manifest.verification,
    localMigrationVerified: comparison.safeToRetireCloudCopy,
    preMigrationBackupChecksumSha256: importReport.preMigrationBackupChecksumSha256,
    tables,
    deletedRowCount: tables.reduce((total, table) => total + table.deletedRowCount, 0),
    allAvailableTablesEmpty,
    tableDropMigration: "supabase/migrations/20260802000000_retire_cloud_erp.sql",
    tableDropApplied: false,
  }
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8")
  const reportPath = path.join(directory, "supabase-cleanup.json")
  await atomicProtectedWrite(reportPath, bytes)
  const checksumSha256 = sha256(bytes)
  await atomicProtectedWrite(path.join(directory, "supabase-cleanup.sha256"), Buffer.from(`${checksumSha256}  supabase-cleanup.json\n`, "utf8"))
  console.log(JSON.stringify({ reportPath, checksumSha256, ...report }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
