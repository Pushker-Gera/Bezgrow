import { DatabaseSync } from "node:sqlite"
import process from "node:process"
import { normalizeLicenseEnvKey, parseLicenseInput } from "../lib/license/codec"
import { verifyStoredLicenseRows } from "../lib/license/verification"
import type { StoredLicenseRow } from "../lib/license/policy"

async function main() {
  const databaseArgument = process.argv.find((value) => value.startsWith("--database="))?.slice("--database=".length)
  if (!databaseArgument) throw new Error("Usage: audit-local-license-signatures.ts --database=<sqlite-file>")

  const publicKey = normalizeLicenseEnvKey(process.env.NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY || "")
  if (!publicKey) throw new Error("NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY is required.")

  const database = new DatabaseSync(databaseArgument, { readOnly: true })
  const rows = database.prepare("SELECT * FROM license_state WHERE deleted_at IS NULL").all() as StoredLicenseRow[]
  let signatureVerifiedRows = 0
  const algorithms: Record<string, number> = {}

  for (const row of rows) {
    try {
      const parsed = parseLicenseInput(row.license_key)
      const algorithm = parsed.payload.signature_algorithm || "unspecified"
      algorithms[algorithm] = (algorithms[algorithm] || 0) + 1
      const verified = await verifyStoredLicenseRows([row], {
        publicKey,
        deviceId: parsed.payload.device_id,
      })
      if (verified.length === 1) signatureVerifiedRows += 1
    } catch {
      // Report only aggregate invalid-row counts; never print license contents.
    }
  }
  database.close()

  console.log(JSON.stringify({
    storedRows: rows.length,
    signatureVerifiedRows,
    invalidRows: rows.length - signatureVerifiedRows,
    algorithms,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
