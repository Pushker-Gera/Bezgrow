import { createHash } from "node:crypto"
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { DatabaseSync } from "node:sqlite"

function argument(name) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function normalized(value) {
  return value == null ? "" : String(value).trim().toLowerCase()
}

function key(...values) {
  return values.map(normalized).join("\u001f")
}

function numberKey(value) {
  const number = Number(value ?? 0)
  return Number.isFinite(number) ? number.toFixed(6) : "0.000000"
}

async function atomicProtectedWrite(filename, bytes) {
  const temporary = `${filename}.tmp-${process.pid}`
  await writeFile(temporary, bytes, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, filename)
}

async function loadAndVerifyExport(directory) {
  const manifestBytes = await readFile(path.join(directory, "manifest.json"))
  const manifest = JSON.parse(manifestBytes.toString("utf8"))
  const files = new Map()

  for (const entry of manifest.tables || []) {
    const bytes = await readFile(path.join(directory, entry.exportFilename))
    if (sha256(bytes) !== entry.checksumSha256) {
      throw new Error(`Checksum verification failed for ${entry.table}.`)
    }
    const parsed = JSON.parse(bytes.toString("utf8"))
    if (parsed.table !== entry.table || !Array.isArray(parsed.rows) || parsed.rows.length !== entry.rowCount) {
      throw new Error(`Read-back verification failed for ${entry.table}.`)
    }
    files.set(entry.table, parsed.rows)
  }

  return { manifest, manifestChecksumSha256: sha256(manifestBytes), files }
}

function allRows(database, table) {
  const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  return exists ? database.prepare(`SELECT * FROM "${table}"`).all() : []
}

function matchTable(cloudRows, localRows, exactKey, naturalKeys) {
  const used = new Set()
  const matches = new Map()
  let exactMatches = 0
  let naturalMatches = 0

  const exactIndex = new Map()
  const naturalIndexes = naturalKeys.map(() => new Map())
  localRows.forEach((row, index) => {
    const exact = exactKey(row)
    if (exact) (exactIndex.get(exact) || exactIndex.set(exact, []).get(exact)).push(index)
    naturalKeys.forEach((naturalKey, keyIndex) => {
      const natural = naturalKey(row)
      if (natural) {
        const indexMap = naturalIndexes[keyIndex]
        ;(indexMap.get(natural) || indexMap.set(natural, []).get(natural)).push(index)
      }
    })
  })

  function take(indices) {
    const index = indices?.find((candidate) => !used.has(candidate))
    if (index == null) return null
    used.add(index)
    return index
  }

  cloudRows.forEach((row, cloudIndex) => {
    let localIndex = take(exactIndex.get(exactKey(row)))
    if (localIndex != null) {
      exactMatches += 1
    } else {
      for (let keyIndex = 0; keyIndex < naturalKeys.length; keyIndex += 1) {
        localIndex = take(naturalIndexes[keyIndex].get(naturalKeys[keyIndex](row)))
        if (localIndex != null) {
          naturalMatches += 1
          break
        }
      }
    }
    if (localIndex != null) matches.set(cloudIndex, localIndex)
  })

  return {
    exactMatches,
    naturalMatches,
    missingLocally: cloudRows.length - matches.size,
    localRowCount: localRows.length,
    matches,
  }
}

function compact(result, cloudRowCount) {
  return {
    cloudRowCount,
    localRowCount: result.localRowCount,
    exactMatches: result.exactMatches,
    naturalMatches: result.naturalMatches,
    missingLocally: result.missingLocally,
  }
}

async function main() {
  const backupDirectory = path.resolve(argument("backup") || "")
  const databasePath = path.resolve(argument("database") || "")
  if (!argument("backup") || !argument("database")) {
    throw new Error("Usage: node scripts/compare-supabase-erp-export.mjs --backup=<directory> --database=<sqlite-file>")
  }

  const exported = await loadAndVerifyExport(backupDirectory)
  const database = new DatabaseSync(databasePath, { readOnly: true })
  const integrityRows = database.prepare("PRAGMA quick_check").all()
  const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all()
  const cloud = (table) => exported.files.get(table) || []
  const local = (table) => allRows(database, table)
  const results = {}

  const organizations = matchTable(
    cloud("organizations"),
    local("organizations"),
    (row) => normalized(row.id),
    [(row) => key(row.name || row.business_name)],
  )
  results.organizations = compact(organizations, cloud("organizations").length)

  const organizationIds = new Map()
  organizations.matches.forEach((localIndex, cloudIndex) => {
    organizationIds.set(normalized(cloud("organizations")[cloudIndex].id), normalized(local("organizations")[localIndex].id))
  })
  const mappedOrganization = (row) => organizationIds.get(normalized(row.organization_id)) || normalized(row.organization_id)

  const products = matchTable(
    cloud("products"),
    local("products"),
    (row) => normalized(row.id),
    [
      (row) => row.sku ? key(mappedOrganization(row), row.sku) : "",
      (row) => row.barcode ? key(mappedOrganization(row), row.barcode) : "",
      (row) => key(mappedOrganization(row), row.name),
    ],
  )
  results.products = compact(products, cloud("products").length)

  const productIds = new Map()
  products.matches.forEach((localIndex, cloudIndex) => {
    productIds.set(normalized(cloud("products")[cloudIndex].id), normalized(local("products")[localIndex].id))
  })
  const mappedProduct = (row) => productIds.get(normalized(row.product_id)) || normalized(row.product_id)

  const customers = matchTable(
    cloud("customers"),
    local("customers"),
    (row) => normalized(row.id),
    [
      (row) => row.email ? key(mappedOrganization(row), row.email) : "",
      (row) => row.phone ? key(mappedOrganization(row), row.phone) : "",
      (row) => key(mappedOrganization(row), row.name),
    ],
  )
  results.customers = compact(customers, cloud("customers").length)

  const customerIds = new Map()
  customers.matches.forEach((localIndex, cloudIndex) => {
    customerIds.set(normalized(cloud("customers")[cloudIndex].id), normalized(local("customers")[localIndex].id))
  })
  const mappedCustomer = (row) => customerIds.get(normalized(row.customer_id)) || normalized(row.customer_id)

  const invoices = matchTable(
    cloud("invoices"),
    local("sales_invoices"),
    (row) => normalized(row.id),
    [
      (row) => key(mappedOrganization(row), row.invoice_number),
      (row) => key(
        mappedOrganization(row),
        mappedCustomer(row),
        row.invoice_date || row.date,
        numberKey(row.grand_total ?? row.total_amount ?? row.total),
      ),
    ],
  )
  results.invoices = compact(invoices, cloud("invoices").length)

  const invoiceIds = new Map()
  invoices.matches.forEach((localIndex, cloudIndex) => {
    invoiceIds.set(normalized(cloud("invoices")[cloudIndex].id), normalized(local("sales_invoices")[localIndex].id))
  })
  const mappedInvoice = (row) => invoiceIds.get(normalized(row.invoice_id)) || normalized(row.invoice_id)

  const tableDefinitions = [
    ["organization_members", "organization_members", [(row) => key(mappedOrganization(row), row.user_id)]],
    ["organization_features", "feature_flags", [(row) => key(mappedOrganization(row), row.feature_key)]],
    ["suppliers", "suppliers", [(row) => row.email ? key(mappedOrganization(row), row.email) : "", (row) => row.phone ? key(mappedOrganization(row), row.phone) : "", (row) => key(mappedOrganization(row), row.name)]],
    ["orders", "orders", [(row) => key(mappedOrganization(row), row.order_number)]],
    ["warehouses", "warehouses", [(row) => key(mappedOrganization(row), row.code || row.name)]],
    ["inventory_items", "inventory_items", [(row) => key(mappedOrganization(row), mappedProduct(row), row.warehouse_id)]],
    ["stock_movements", "stock_movements", [
      (row) => key(mappedOrganization(row), mappedProduct(row), row.type, numberKey(row.quantity), row.reference_no, row.reason),
      (row) => key(mappedOrganization(row), mappedProduct(row), row.type, numberKey(row.quantity), numberKey(row.previous_stock), numberKey(row.new_stock), row.created_at),
    ]],
    ["quotations", "quotations", [(row) => key(mappedOrganization(row), row.quote_number)]],
    ["purchase_invoices", "purchase_invoices", [(row) => key(mappedOrganization(row), row.bill_number)]],
    ["payment_receipts", "payment_receipts", [(row) => key(mappedOrganization(row), row.receipt_number)]],
    ["expenses", "expenses", [(row) => key(mappedOrganization(row), row.reference_no, row.expense_date, numberKey(row.amount))]],
    ["ledger_entries", "ledger_entries", [(row) => key(mappedOrganization(row), row.document_type, row.document_id, row.entry_date, numberKey(row.debit), numberKey(row.credit))]],
  ]

  for (const [cloudTable, localTable, naturalKeys] of tableDefinitions) {
    const compared = matchTable(cloud(cloudTable), local(localTable), (row) => normalized(row.id), naturalKeys)
    results[cloudTable] = compact(compared, cloud(cloudTable).length)
  }

  const invoiceItems = matchTable(
    cloud("invoice_items"),
    local("sales_invoice_items"),
    (row) => normalized(row.id),
    [(row) => key(mappedInvoice(row), mappedProduct(row), row.product_name, numberKey(row.quantity), numberKey(row.unit_price), numberKey(row.line_total))],
  )
  results.invoice_items = compact(invoiceItems, cloud("invoice_items").length)

  const zeroOrLegacyTables = [
    "invoice_payments",
    "order_items",
    "financial_years",
    "invoice_series",
    "quotation_items",
    "purchase_orders",
    "purchase_order_items",
  ]
  for (const table of zeroOrLegacyTables) {
    const cloudRows = cloud(table)
    const localTable = table === "invoice_payments" ? "payments" : table
    const compared = matchTable(cloudRows, local(localTable), (row) => normalized(row.id), [])
    results[table] = compact(compared, cloudRows.length)
  }

  const totalCloudRows = Object.values(results).reduce((total, result) => total + result.cloudRowCount, 0)
  const totalMissingLocally = Object.values(results).reduce((total, result) => total + result.missingLocally, 0)
  const report = {
    format: "bezgrow-supabase-erp-local-comparison-v1",
    comparedAt: new Date().toISOString(),
    sourceManifestChecksumSha256: exported.manifestChecksumSha256,
    sourceExportVerification: exported.manifest.verification,
    sqliteDatabaseFilename: path.basename(databasePath),
    sqliteIntegrity: integrityRows.every((row) => Object.values(row).includes("ok")) ? "ok" : "failed",
    sqliteForeignKeyViolations: foreignKeyRows.length,
    totals: { cloudRowsCompared: totalCloudRows, missingLocally: totalMissingLocally },
    tables: results,
    safeToRetireCloudCopy: totalMissingLocally === 0 && foreignKeyRows.length === 0,
  }
  database.close()

  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8")
  const reportPath = path.join(backupDirectory, "local-comparison.json")
  await atomicProtectedWrite(reportPath, reportBytes)
  const reportChecksumSha256 = sha256(reportBytes)
  await atomicProtectedWrite(path.join(backupDirectory, "local-comparison.sha256"), Buffer.from(`${reportChecksumSha256}  local-comparison.json\n`, "utf8"))
  const readBack = JSON.parse((await readFile(reportPath)).toString("utf8"))
  if (readBack.totals?.missingLocally !== report.totals.missingLocally) {
    throw new Error("Comparison report read-back verification failed.")
  }

  console.log(JSON.stringify({ reportPath, reportChecksumSha256, ...report }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
