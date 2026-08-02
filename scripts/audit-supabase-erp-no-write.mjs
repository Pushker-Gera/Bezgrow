import { createHash } from "node:crypto"
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { createClient } from "@supabase/supabase-js"

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
  if (!backupArgument) throw new Error("Usage: audit-supabase-erp-no-write.mjs --backup=<verified-export-directory>")
  const directory = path.resolve(backupArgument)
  const manifestBytes = await readFile(path.join(directory, "manifest.json"))
  const manifest = JSON.parse(manifestBytes.toString("utf8"))
  const expectEmpty = process.argv.includes("--expect-empty")
  const readOnly = process.argv.includes("--read-only")
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) throw new Error("Supabase URL and service-role key are required.")
  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const tables = []

  const entries = expectEmpty
    ? [
        ...(manifest.tables || []),
        ...(manifest.unavailableTables || []).map(({ table }) => ({ table, rowCount: 0 })),
      ]
    : manifest.tables || []
  for (const entry of entries) {
    const result = await client.from(entry.table).select("*", { count: "exact", head: true })
    if (result.error && expectEmpty && ["42P01", "PGRST205"].includes(result.error.code)) {
      tables.push({
        table: entry.table,
        baselineRowCount: entry.rowCount,
        currentRowCount: 0,
        status: "not_present",
        unchanged: true,
      })
      continue
    }
    if (result.error) throw new Error(`${entry.table}: ${result.error.code || "QUERY_FAILED"}: ${result.error.message}`)
    tables.push({
      table: entry.table,
      baselineRowCount: entry.rowCount,
      currentRowCount: result.count ?? 0,
      status: "present",
      unchanged: expectEmpty ? (result.count ?? 0) === 0 : (result.count ?? 0) === entry.rowCount,
    })
  }

  const report = {
    format: "bezgrow-supabase-erp-no-write-audit-v1",
    auditedAt: new Date().toISOString(),
    baselineManifestChecksumSha256: sha256(manifestBytes),
    baselineExportVerification: manifest.verification,
    expectedState: expectEmpty ? "all-classified-erp-relations-empty-or-absent" : "baseline-row-counts-unchanged",
    tables,
    allRowCountsUnchanged: tables.every((table) => table.unchanged),
  }
  if (!report.allRowCountsUnchanged) throw new Error("One or more Supabase ERP table row counts changed after local ERP use.")
  if (readOnly) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8")
  const reportFilename = expectEmpty ? "supabase-post-cleanup-no-write.json" : "supabase-no-write-audit.json"
  const reportPath = path.join(directory, reportFilename)
  await atomicProtectedWrite(reportPath, bytes)
  const checksumSha256 = sha256(bytes)
  await atomicProtectedWrite(path.join(directory, reportFilename.replace(/\.json$/, ".sha256")), Buffer.from(`${checksumSha256}  ${reportFilename}\n`, "utf8"))
  console.log(JSON.stringify({ reportPath, checksumSha256, ...report }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
