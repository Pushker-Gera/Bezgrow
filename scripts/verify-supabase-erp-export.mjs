import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

const EXPECTED_FORMAT = "bezgrow-supabase-erp-retirement-export-v1"
const EXPECTED_MANIFEST_SHA256 = "8e5fd0b7a99605cc6ed3eaf2f176969e89503bc01255fae6b6b48ea5ee2664d7"

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function protectedMode(stats, expected, label) {
  const actual = stats.mode & 0o777
  assert(actual === expected, `${label} permissions are ${actual.toString(8)}, expected ${expected.toString(8)}.`)
}

async function main() {
  const backupArgument = process.argv.find((value) => value.startsWith("--backup="))?.slice("--backup=".length)
  if (!backupArgument) {
    throw new Error("Usage: verify-supabase-erp-export.mjs --backup=<protected-export-directory>")
  }

  const directory = path.resolve(backupArgument)
  protectedMode(await stat(directory), 0o700, "Protected export directory")

  const manifestPath = path.join(directory, "manifest.json")
  const manifestBytes = await readFile(manifestPath)
  const manifestChecksum = sha256(manifestBytes)
  assert(
    manifestChecksum === EXPECTED_MANIFEST_SHA256,
    `Manifest SHA-256 is ${manifestChecksum}, expected ${EXPECTED_MANIFEST_SHA256}.`
  )

  const sidecar = (await readFile(path.join(directory, "manifest.sha256"), "utf8")).trim()
  assert(sidecar === `${manifestChecksum}  manifest.json`, "manifest.sha256 does not match manifest.json.")

  const manifest = JSON.parse(manifestBytes.toString("utf8"))
  assert(manifest.format === EXPECTED_FORMAT, `Unexpected export format: ${manifest.format}`)
  assert(manifest.verification === "checksums-and-json-readback-passed", "Export was not marked read-back verified.")
  assert(Array.isArray(manifest.tables) && manifest.tables.length > 0, "Manifest contains no exported tables.")

  const seenTables = new Set()
  let rowCount = 0
  for (const entry of manifest.tables) {
    assert(entry.classification === "customer_erp", `${entry.table} has an unexpected classification.`)
    assert(!seenTables.has(entry.table), `Manifest contains duplicate table ${entry.table}.`)
    seenTables.add(entry.table)
    assert(path.basename(entry.exportFilename) === entry.exportFilename, `${entry.table} export path is unsafe.`)

    const exportPath = path.join(directory, entry.exportFilename)
    protectedMode(await stat(exportPath), 0o600, entry.exportFilename)
    const bytes = await readFile(exportPath)
    assert(sha256(bytes) === entry.checksumSha256, `${entry.table} checksum verification failed.`)
    const payload = JSON.parse(bytes.toString("utf8"))
    assert(payload.table === entry.table, `${entry.table} read-back table name does not match.`)
    assert(Array.isArray(payload.rows), `${entry.table} export does not contain a rows array.`)
    assert(payload.rows.length === entry.rowCount, `${entry.table} row count does not match its manifest entry.`)
    rowCount += payload.rows.length
  }

  const files = await readdir(directory)
  let checksumSidecars = 0
  let readableJsonFiles = 0
  for (const filename of files) {
    if (filename.endsWith(".json")) {
      JSON.parse(await readFile(path.join(directory, filename), "utf8"))
      readableJsonFiles += 1
    }
    if (!filename.endsWith(".sha256")) continue
    const value = (await readFile(path.join(directory, filename), "utf8")).trim()
    const match = /^([a-f0-9]{64})  ([^/]+)$/i.exec(value)
    assert(match, `${filename} is not a valid SHA-256 sidecar.`)
    const target = path.join(directory, match[2])
    assert(sha256(await readFile(target)) === match[1].toLowerCase(), `${filename} checksum verification failed.`)
    checksumSidecars += 1
  }

  console.log(JSON.stringify({
    directory,
    manifestPath,
    manifestChecksumSha256: manifestChecksum,
    exportedTables: manifest.tables.length,
    exportedRows: rowCount,
    unavailableTablesRecorded: Array.isArray(manifest.unavailableTables) ? manifest.unavailableTables.length : 0,
    readableJsonFiles,
    checksumSidecars,
    verification: "protected-export-readable-and-checksums-valid",
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
