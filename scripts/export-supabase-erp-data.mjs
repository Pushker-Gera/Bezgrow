import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { createClient } from "@supabase/supabase-js"

const ERP_TABLES = [
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
  "sales_invoices",
  "sales_invoice_items",
  "chart_of_accounts",
  "accounting_vouchers",
  "accounting_voucher_entries",
  "bank_accounts",
  "invoice_share_links",
]

const PAGE_SIZE = 500

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-")
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

async function atomicProtectedWrite(filename, bytes) {
  const temporary = `${filename}.tmp-${process.pid}`
  await writeFile(temporary, bytes, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, filename)
}

async function readAllRows(client, table) {
  const rows = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await client.from(table).select("*").range(from, from + PAGE_SIZE - 1)
    if (result.error) {
      if (["42P01", "PGRST205"].includes(result.error.code)) {
        return { available: false, rows: [], error: result.error }
      }
      throw new Error(`${table}: ${result.error.code || "QUERY_FAILED"}: ${result.error.message}`)
    }
    const page = result.data || []
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return { available: true, rows, error: null }
}

async function verifyExport(directory, entries) {
  for (const entry of entries) {
    const filename = path.join(directory, entry.exportFilename)
    const bytes = await readFile(filename)
    if (sha256(bytes) !== entry.checksumSha256) {
      throw new Error(`Checksum verification failed for ${entry.table}.`)
    }
    const parsed = JSON.parse(bytes.toString("utf8"))
    if (parsed.table !== entry.table || !Array.isArray(parsed.rows) || parsed.rows.length !== entry.rowCount) {
      throw new Error(`Read-back verification failed for ${entry.table}.`)
    }
  }
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")
  }

  const exportedAt = new Date().toISOString()
  const outputArgument = process.argv.find((argument) => argument.startsWith("--output="))?.slice("--output=".length)
  const directory = path.resolve(outputArgument || `private/migration-backups/${timestampForPath()}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const entries = []
  const unavailableTables = []

  for (const table of ERP_TABLES) {
    const result = await readAllRows(client, table)
    if (!result.available) {
      unavailableTables.push({ table, code: result.error?.code || "NOT_AVAILABLE" })
      continue
    }

    const exportFilename = `${table}.json`
    const payload = Buffer.from(`${JSON.stringify({ table, exportedAt, rows: result.rows }, null, 2)}\n`, "utf8")
    const checksumSha256 = sha256(payload)
    await atomicProtectedWrite(path.join(directory, exportFilename), payload)
    entries.push({
      table,
      classification: "customer_erp",
      rowCount: result.rows.length,
      exportFilename,
      exportTimestamp: exportedAt,
      checksumSha256,
    })
  }

  await verifyExport(directory, entries)
  const manifest = {
    format: "bezgrow-supabase-erp-retirement-export-v1",
    protectedDirectory: true,
    directoryMode: "0700",
    fileMode: "0600",
    exportedAt,
    verifiedAt: new Date().toISOString(),
    verification: "checksums-and-json-readback-passed",
    tables: entries,
    unavailableTables,
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  await atomicProtectedWrite(path.join(directory, "manifest.json"), manifestBytes)
  const manifestChecksum = sha256(manifestBytes)
  await atomicProtectedWrite(path.join(directory, "manifest.sha256"), Buffer.from(`${manifestChecksum}  manifest.json\n`, "utf8"))

  console.log(JSON.stringify({
    directory,
    manifest: path.join(directory, "manifest.json"),
    manifestChecksumSha256: manifestChecksum,
    tables: entries.map(({ table, rowCount, checksumSha256 }) => ({ table, rowCount, checksumSha256 })),
    unavailableTables,
    verification: manifest.verification,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
