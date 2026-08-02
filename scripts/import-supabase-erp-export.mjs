import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { backup, DatabaseSync } from "node:sqlite"

function argument(name) {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
}

function normalized(value) {
  return value == null ? "" : String(value).trim().toLowerCase()
}

function numeric(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-")
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
    if (sha256(bytes) !== entry.checksumSha256) throw new Error(`Checksum verification failed for ${entry.table}.`)
    const parsed = JSON.parse(bytes.toString("utf8"))
    if (parsed.table !== entry.table || !Array.isArray(parsed.rows) || parsed.rows.length !== entry.rowCount) {
      throw new Error(`Read-back verification failed for ${entry.table}.`)
    }
    files.set(entry.table, parsed.rows)
  }
  return { files, manifest, manifestChecksumSha256: sha256(manifestBytes) }
}

function tableColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name))
}

function insert(database, table, row) {
  const allowed = tableColumns(database, table)
  const entries = Object.entries(row).filter(([column, value]) => allowed.has(column) && value !== undefined)
  if (!entries.length) throw new Error(`No importable columns were supplied for ${table}.`)
  const columns = entries.map(([column]) => `"${column}"`).join(", ")
  const placeholders = entries.map(() => "?").join(", ")
  database.prepare(`INSERT INTO "${table}" (${columns}) VALUES (${placeholders})`).run(...entries.map(([, value]) => value))
}

function findOrganization(database, row) {
  return database.prepare("SELECT id FROM organizations WHERE id = ?").get(row.id)
    || database.prepare("SELECT id FROM organizations WHERE lower(trim(coalesce(name, business_name, ''))) = ? LIMIT 1").get(normalized(row.name))
}

function findProduct(database, organizationId, row) {
  const byId = database.prepare("SELECT id FROM products WHERE id = ?").get(row.id)
  if (byId) return byId
  if (row.sku) {
    const bySku = database.prepare("SELECT id FROM products WHERE organization_id = ? AND lower(trim(coalesce(sku, ''))) = ? LIMIT 1").get(organizationId, normalized(row.sku))
    if (bySku) return bySku
  }
  if (row.barcode) {
    const byBarcode = database.prepare("SELECT id FROM products WHERE organization_id = ? AND lower(trim(coalesce(barcode, ''))) = ? LIMIT 1").get(organizationId, normalized(row.barcode))
    if (byBarcode) return byBarcode
  }
  return database.prepare("SELECT id FROM products WHERE organization_id = ? AND lower(trim(name)) = ? LIMIT 1").get(organizationId, normalized(row.name))
}

function findCustomer(database, organizationId, row) {
  const byId = database.prepare("SELECT id FROM customers WHERE id = ?").get(row.id)
  if (byId) return byId
  if (row.email) {
    const byEmail = database.prepare("SELECT id FROM customers WHERE organization_id = ? AND lower(trim(coalesce(email, ''))) = ? LIMIT 1").get(organizationId, normalized(row.email))
    if (byEmail) return byEmail
  }
  if (row.phone) {
    const byPhone = database.prepare("SELECT id FROM customers WHERE organization_id = ? AND trim(coalesce(phone, '')) = ? LIMIT 1").get(organizationId, String(row.phone).trim())
    if (byPhone) return byPhone
  }
  return database.prepare("SELECT id FROM customers WHERE organization_id = ? AND lower(trim(name)) = ? LIMIT 1").get(organizationId, normalized(row.name))
}

function findInvoice(database, organizationId, row) {
  return database.prepare("SELECT id FROM sales_invoices WHERE id = ?").get(row.id)
    || database.prepare("SELECT id FROM sales_invoices WHERE organization_id = ? AND invoice_number = ? LIMIT 1").get(organizationId, row.invoice_number)
}

function localDate(value) {
  return value ? String(value).slice(0, 10) : new Date().toISOString().slice(0, 10)
}

async function main() {
  const backupDirectoryArgument = argument("backup")
  const databaseArgument = argument("database")
  const apply = process.argv.includes("--apply")
  const reportName = argument("report-name") || (apply ? "local-import.json" : "local-import-preview.json")
  if (!backupDirectoryArgument || !databaseArgument) {
    throw new Error("Usage: node scripts/import-supabase-erp-export.mjs --backup=<directory> --database=<sqlite-file> [--apply]")
  }

  const exportDirectory = path.resolve(backupDirectoryArgument)
  const databasePath = path.resolve(databaseArgument)
  const exported = await loadAndVerifyExport(exportDirectory)
  const database = new DatabaseSync(databasePath)
  database.exec("PRAGMA foreign_keys = ON")
  database.exec("PRAGMA busy_timeout = 5000")
  const beforeIntegrity = database.prepare("PRAGMA quick_check").all()
  if (!beforeIntegrity.every((row) => Object.values(row).includes("ok"))) throw new Error("SQLite integrity check failed before import.")
  if (database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("SQLite foreign key check failed before import.")

  let preMigrationBackup = null
  let preMigrationBackupChecksumSha256 = null
  if (apply) {
    const backupDirectory = path.join(path.dirname(databasePath), "bezgrow-migration-backups")
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 })
    await chmod(backupDirectory, 0o700)
    preMigrationBackup = path.join(backupDirectory, `before-cloud-retirement-${timestampForPath()}.db`)
    await backup(database, preMigrationBackup)
    await chmod(preMigrationBackup, 0o600)
    preMigrationBackupChecksumSha256 = sha256(await readFile(preMigrationBackup))
  }

  const cloud = (table) => exported.files.get(table) || []
  const organizationIds = new Map()
  const productIds = new Map()
  const customerIds = new Map()
  const invoiceIds = new Map()
  const imported = {
    local_users: 0,
    organization_members: 0,
    organization_features: 0,
    invoices: 0,
    invoice_items: 0,
    stock_movements: 0,
  }

  database.exec("BEGIN IMMEDIATE")
  try {
    for (const row of cloud("organizations")) {
      const local = findOrganization(database, row)
      if (!local) throw new Error("A cloud organization is missing locally; foundational organization import requires manual review.")
      organizationIds.set(normalized(row.id), local.id)
    }
    const organizationId = (row) => organizationIds.get(normalized(row.organization_id))

    for (const row of cloud("products")) {
      const localOrganizationId = organizationId(row)
      const local = localOrganizationId && findProduct(database, localOrganizationId, row)
      if (!local) throw new Error("A cloud product is missing locally; foundational product import requires manual review.")
      productIds.set(normalized(row.id), local.id)
    }
    const productId = (row) => row.product_id ? productIds.get(normalized(row.product_id)) || null : null

    for (const row of cloud("customers")) {
      const localOrganizationId = organizationId(row)
      const local = localOrganizationId && findCustomer(database, localOrganizationId, row)
      if (!local) throw new Error("A cloud customer is missing locally; foundational customer import requires manual review.")
      customerIds.set(normalized(row.id), local.id)
    }
    const customerId = (row) => row.customer_id ? customerIds.get(normalized(row.customer_id)) || null : null

    for (const row of cloud("organization_members")) {
      const localOrganizationId = organizationId(row)
      if (!localOrganizationId) throw new Error("An organization member references an unmapped organization.")
      let localUser = database.prepare("SELECT id FROM local_users WHERE id = ?").get(row.user_id)
      if (!localUser) {
        insert(database, "local_users", {
          id: row.user_id,
          organization_id: localOrganizationId,
          full_name: "Imported local member",
          role: row.role || "member",
          approved: 1,
          business_created: 1,
          is_suspended: 0,
          created_at: row.created_at,
          updated_at: row.created_at,
        })
        imported.local_users += 1
        localUser = { id: row.user_id }
      }
      const existing = database.prepare("SELECT id FROM organization_members WHERE id = ? OR (organization_id = ? AND user_id = ?) LIMIT 1").get(row.id, localOrganizationId, localUser.id)
      if (!existing) {
        insert(database, "organization_members", {
          id: row.id,
          organization_id: localOrganizationId,
          user_id: localUser.id,
          role: row.role || "member",
          is_active: 1,
          created_at: row.created_at,
          updated_at: row.created_at,
        })
        imported.organization_members += 1
      }
    }

    for (const row of cloud("organization_features")) {
      const localOrganizationId = organizationId(row)
      if (!localOrganizationId) throw new Error("An organization feature references an unmapped organization.")
      const existing = database.prepare("SELECT id FROM feature_flags WHERE id = ? OR (organization_id = ? AND feature_key = ?) LIMIT 1").get(row.id, localOrganizationId, row.feature_key)
      if (!existing) {
        insert(database, "feature_flags", {
          id: row.id,
          organization_id: localOrganizationId,
          feature_key: row.feature_key,
          is_enabled: row.is_enabled ? 1 : 0,
          updated_at: row.created_at,
        })
        imported.organization_features += 1
      }
    }

    for (const row of cloud("invoices")) {
      const localOrganizationId = organizationId(row)
      if (!localOrganizationId) throw new Error("An invoice references an unmapped organization.")
      let local = findInvoice(database, localOrganizationId, row)
      if (!local) {
        const total = numeric(row.grand_total ?? row.total_amount)
        const paymentStatus = row.payment_status || "unpaid"
        insert(database, "sales_invoices", {
          id: row.id,
          organization_id: localOrganizationId,
          customer_id: customerId(row),
          invoice_number: row.invoice_number,
          invoice_date: localDate(row.invoice_date),
          date: localDate(row.invoice_date),
          due_date: row.due_date ? localDate(row.due_date) : null,
          subtotal: numeric(row.subtotal),
          discount_amount: numeric(row.discount_total),
          discount_total: numeric(row.discount_total),
          taxable_amount: Math.max(0, numeric(row.subtotal) - numeric(row.discount_total)),
          tax_amount: numeric(row.tax_amount ?? row.tax_total),
          tax_total: numeric(row.tax_total ?? row.tax_amount),
          total_amount: total,
          grand_total: total,
          total,
          paid_amount: paymentStatus === "paid" ? total : 0,
          outstanding_amount: paymentStatus === "paid" ? 0 : total,
          payment_status: paymentStatus,
          status: paymentStatus,
          payment_method: row.payment_method || row.payment_mode || "cash",
          notes: row.notes,
          created_at: row.created_at,
          updated_at: row.updated_at || row.created_at,
        })
        imported.invoices += 1
        local = { id: row.id }
      }
      invoiceIds.set(normalized(row.id), local.id)
    }
    const invoiceId = (row) => invoiceIds.get(normalized(row.invoice_id))

    for (const row of cloud("invoice_items")) {
      const localInvoiceId = invoiceId(row)
      const localOrganizationId = organizationId(row)
      if (!localInvoiceId || !localOrganizationId) throw new Error("An invoice item references an unmapped invoice or organization.")
      const existing = database.prepare("SELECT id FROM sales_invoice_items WHERE id = ? LIMIT 1").get(row.id)
      if (!existing) {
        insert(database, "sales_invoice_items", {
          id: row.id,
          organization_id: localOrganizationId,
          invoice_id: localInvoiceId,
          product_id: productId(row),
          product_name: row.product_name,
          quantity: numeric(row.quantity),
          unit_price: numeric(row.unit_price),
          tax_percent: numeric(row.tax_percent),
          discount_percent: numeric(row.discount_percent),
          line_total: numeric(row.line_total),
          gst_amount: numeric(row.gst_amount),
          created_at: row.created_at,
          updated_at: row.created_at,
        })
        imported.invoice_items += 1
      }
    }

    for (const row of cloud("stock_movements")) {
      const localOrganizationId = organizationId(row)
      if (!localOrganizationId) throw new Error("A stock movement references an unmapped organization.")
      const existing = database.prepare("SELECT id FROM stock_movements WHERE id = ? LIMIT 1").get(row.id)
      if (!existing) {
        insert(database, "stock_movements", {
          id: row.id,
          organization_id: localOrganizationId,
          product_id: productId(row),
          warehouse_id: row.warehouse_id || null,
          type: row.type,
          quantity: numeric(row.quantity),
          previous_stock: row.previous_stock == null ? null : numeric(row.previous_stock),
          new_stock: row.new_stock == null ? null : numeric(row.new_stock),
          reason: row.reason,
          reference_no: row.reference_no,
          reference_type: row.invoice_id ? "sales_invoice" : null,
          reference_id: row.invoice_id ? invoiceIds.get(normalized(row.invoice_id)) || null : null,
          movement_date: localDate(row.created_at),
          created_at: row.created_at,
          updated_at: row.created_at,
        })
        imported.stock_movements += 1
      }
    }

    const afterIntegrity = database.prepare("PRAGMA quick_check").all()
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all()
    if (!afterIntegrity.every((row) => Object.values(row).includes("ok")) || foreignKeyViolations.length) {
      throw new Error("SQLite verification failed after import; transaction rolled back.")
    }
    database.exec(apply ? "COMMIT" : "ROLLBACK")
  } catch (error) {
    try { database.exec("ROLLBACK") } catch {}
    database.close()
    throw error
  }

  const finalIntegrity = database.prepare("PRAGMA quick_check").all()
  const finalForeignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length
  database.close()
  const importedTotal = Object.values(imported).reduce((total, count) => total + count, 0)
  const report = {
    format: "bezgrow-supabase-erp-local-import-v1",
    applied: apply,
    completedAt: new Date().toISOString(),
    sourceManifestChecksumSha256: exported.manifestChecksumSha256,
    sourceExportVerification: exported.manifest.verification,
    sqliteDatabaseFilename: path.basename(databasePath),
    preMigrationBackup,
    preMigrationBackupChecksumSha256,
    imported,
    importedTotal: apply ? importedTotal : 0,
    previewedTotal: apply ? 0 : importedTotal,
    sqliteIntegrity: finalIntegrity.every((row) => Object.values(row).includes("ok")) ? "ok" : "failed",
    sqliteForeignKeyViolations: finalForeignKeyViolations,
  }
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8")
  const reportPath = path.join(exportDirectory, reportName)
  await atomicProtectedWrite(reportPath, bytes)
  const reportChecksumSha256 = sha256(bytes)
  await atomicProtectedWrite(path.join(exportDirectory, reportName.replace(/\.json$/, ".sha256")), Buffer.from(`${reportChecksumSha256}  ${reportName}\n`, "utf8"))
  console.log(JSON.stringify({ reportPath, reportChecksumSha256, ...report }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
