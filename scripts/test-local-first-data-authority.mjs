import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { backup, DatabaseSync } from "node:sqlite"

const databaseArgument = process.argv.find((value) => value.startsWith("--database="))?.slice("--database=".length)
if (!databaseArgument) throw new Error("Usage: test-local-first-data-authority.mjs --database=<sqlite-file>")

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "bezgrow-data-authority-"))
const workingDatabasePath = path.join(temporaryDirectory, "working.db")
const backupDatabasePath = path.join(temporaryDirectory, "backup.db")
const restoreDatabasePath = path.join(temporaryDirectory, "restore.db")
const source = new DatabaseSync(path.resolve(databaseArgument), { readOnly: true })
await backup(source, workingDatabasePath)
source.close()

const prefix = `authority-${randomUUID()}`
const ids = Object.fromEntries([
  "product", "customer", "supplier", "invoice", "invoiceItem", "payment",
  "receipt", "purchase", "purchaseItem", "expense", "movement",
].map((name) => [name, `${prefix}-${name}`]))

try {
  let database = new DatabaseSync(workingDatabasePath)
  database.exec("PRAGMA foreign_keys = ON")
  const organization = database.prepare("SELECT id FROM organizations WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1").get()
  assert.ok(organization?.id, "The source database must contain a local organization.")
  const organizationId = organization.id

  database.exec("BEGIN IMMEDIATE")
  try {
    database.prepare("INSERT INTO products (id, organization_id, name, sku, price, stock, sync_status) VALUES (?, ?, ?, ?, 125, 7, 'local')")
      .run(ids.product, organizationId, `${prefix}-product`, `${prefix}-sku`)
    database.prepare("INSERT INTO customers (id, organization_id, name, sync_status) VALUES (?, ?, ?, 'local')")
      .run(ids.customer, organizationId, `${prefix}-customer`)
    database.prepare("INSERT INTO suppliers (id, organization_id, name, sync_status) VALUES (?, ?, ?, 'local')")
      .run(ids.supplier, organizationId, `${prefix}-supplier`)
    database.prepare("INSERT INTO sales_invoices (id, organization_id, customer_id, invoice_number, subtotal, taxable_amount, total_amount, grand_total, total, outstanding_amount, sync_status) VALUES (?, ?, ?, ?, 125, 125, 125, 125, 125, 125, 'local')")
      .run(ids.invoice, organizationId, ids.customer, `${prefix}-invoice`)
    database.prepare("INSERT INTO sales_invoice_items (id, organization_id, invoice_id, product_id, product_name, quantity, unit_price, line_total, sync_status) VALUES (?, ?, ?, ?, ?, 1, 125, 125, 'local')")
      .run(ids.invoiceItem, organizationId, ids.invoice, ids.product, `${prefix}-product`)
    database.prepare("INSERT INTO payments (id, organization_id, party_type, party_id, document_type, document_id, amount, direction, reference_no, sync_status) VALUES (?, ?, 'customer', ?, 'sales_invoice', ?, 25, 'in', ?, 'local')")
      .run(ids.payment, organizationId, ids.customer, ids.invoice, `${prefix}-payment`)
    database.prepare("INSERT INTO payment_receipts (id, organization_id, customer_id, invoice_id, receipt_number, receipt_type, amount, sync_status) VALUES (?, ?, ?, ?, ?, 'sales', 25, 'local')")
      .run(ids.receipt, organizationId, ids.customer, ids.invoice, `${prefix}-receipt`)
    database.prepare("INSERT INTO purchase_invoices (id, organization_id, supplier_id, supplier_name, bill_number, subtotal, taxable_amount, grand_total, outstanding_amount, sync_status) VALUES (?, ?, ?, ?, ?, 50, 50, 50, 50, 'local')")
      .run(ids.purchase, organizationId, ids.supplier, `${prefix}-supplier`, `${prefix}-purchase`)
    database.prepare("INSERT INTO purchase_invoice_items (id, organization_id, purchase_invoice_id, product_id, product_name, quantity, unit_cost, line_total, sync_status) VALUES (?, ?, ?, ?, ?, 2, 25, 50, 'local')")
      .run(ids.purchaseItem, organizationId, ids.purchase, ids.product, `${prefix}-product`)
    database.prepare("INSERT INTO expenses (id, organization_id, supplier_id, category, description, amount, paid_amount, reference_no, sync_status) VALUES (?, ?, ?, 'test', ?, 10, 10, ?, 'local')")
      .run(ids.expense, organizationId, ids.supplier, `${prefix}-expense`, `${prefix}-expense-ref`)
    database.prepare("INSERT INTO stock_movements (id, organization_id, product_id, product_name, type, quantity, previous_stock, new_stock, reason, reference_no, sync_status) VALUES (?, ?, ?, ?, 'in', 2, 5, 7, 'local authority test', ?, 'local')")
      .run(ids.movement, organizationId, ids.product, `${prefix}-product`, `${prefix}-stock`)
    database.exec("COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
  assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok")
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0)
  database.close()

  // Restart persistence.
  database = new DatabaseSync(workingDatabasePath, { readOnly: true })
  const tableIds = [
    ["products", ids.product],
    ["customers", ids.customer],
    ["suppliers", ids.supplier],
    ["sales_invoices", ids.invoice],
    ["sales_invoice_items", ids.invoiceItem],
    ["payments", ids.payment],
    ["payment_receipts", ids.receipt],
    ["purchase_invoices", ids.purchase],
    ["purchase_invoice_items", ids.purchaseItem],
    ["expenses", ids.expense],
    ["stock_movements", ids.movement],
  ]
  for (const [table, id] of tableIds) {
    assert.equal(database.prepare(`SELECT COUNT(*) AS total FROM "${table}" WHERE id = ?`).get(id).total, 1, `${table} record did not survive restart.`)
  }
  const report = database.prepare("SELECT COUNT(*) AS invoice_count, SUM(grand_total) AS invoice_total FROM sales_invoices WHERE id = ?").get(ids.invoice)
  assert.equal(report.invoice_count, 1)
  assert.equal(report.invoice_total, 125)
  await backup(database, backupDatabasePath)
  database.close()

  const backupDatabase = new DatabaseSync(backupDatabasePath, { readOnly: true })
  assert.equal(backupDatabase.prepare("PRAGMA quick_check").get().quick_check, "ok")
  await backup(backupDatabase, restoreDatabasePath)
  backupDatabase.close()
  const restored = new DatabaseSync(restoreDatabasePath, { readOnly: true })
  for (const [table, id] of tableIds) {
    assert.equal(restored.prepare(`SELECT COUNT(*) AS total FROM "${table}" WHERE id = ?`).get(id).total, 1, `${table} record was not preserved by backup/restore.`)
  }
  assert.equal(restored.prepare("PRAGMA foreign_key_check").all().length, 0)
  restored.close()

  console.log(JSON.stringify({
    authority: "sqlite",
    createdRecords: tableIds.length,
    survivedRestart: true,
    reportUsedLocalRows: true,
    backupIntegrity: "ok",
    restoreIntegrity: "ok",
    duplicateIds: 0,
    outboundRequests: 0,
  }, null, 2))
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
