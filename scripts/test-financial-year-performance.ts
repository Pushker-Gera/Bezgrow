import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { LOCAL_DB_VERSION, localMigrations } from "../lib/offline/local/schema"

const organizationId = "financial-year-scale-business"
const directory = mkdtempSync(path.join(tmpdir(), "bezgrow-financial-year-scale-"))
const databasePath = path.join(directory, "financial-year-scale.db")
const outputPath = process.env.BEZGROW_FY_PERFORMANCE_RESULTS || path.join(tmpdir(), "bezgrow-financial-year-performance.json")
const dataset = { products: 2_000, customers: 5_000, invoices: 20_000, invoiceItems: 20_000, stockMovements: 20_000, payments: 20_000, batches: 1_000, financialYears: 3 }

type Measurement = { p50Ms: number; p95Ms: number; worstMs: number; iterations: number }

function round(value: number) { return Number(value.toFixed(3)) }
function measure(iterations: number, operation: () => unknown): Measurement {
  const samples: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now()
    operation()
    samples.push(performance.now() - started)
  }
  samples.sort((left, right) => left - right)
  return {
    p50Ms: round(samples[Math.floor((samples.length - 1) * 0.5)] || 0),
    p95Ms: round(samples[Math.floor((samples.length - 1) * 0.95)] || 0),
    worstMs: round(samples.at(-1) || 0),
    iterations,
  }
}

function applyMigrations(db: DatabaseSync) {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-64000")
  for (const migration of localMigrations) {
    for (const statement of migration.sql) {
      try { db.exec(statement) } catch (error) {
        if (!/^\s*ALTER\s+TABLE/i.test(statement) || !/duplicate column name/i.test(String(error))) throw error
      }
    }
    db.prepare("INSERT OR REPLACE INTO schema_migrations(version, name) VALUES (?, ?)").run(migration.version, migration.name)
  }
  db.exec(`PRAGMA user_version=${LOCAL_DB_VERSION}`)
}

function dateForInvoice(index: number) {
  const startYear = 2024 + (index % 3)
  const dayOffset = index % 365
  const date = new Date(Date.UTC(startYear, 3, 1 + dayOffset))
  return date.toISOString().slice(0, 10)
}

let database = new DatabaseSync(databasePath)
try {
  const migrationStarted = performance.now()
  applyMigrations(database)
  const migrationMs = round(performance.now() - migrationStarted)
  database.prepare("INSERT INTO organizations(id, name, business_name, invoice_prefix, next_invoice_number) VALUES (?, 'Scale Business', 'Scale Business', 'INV', 20001)").run(organizationId)
  for (const startYear of [2024, 2025, 2026]) {
    database.prepare("INSERT INTO financial_years(id, organization_id, label, start_date, end_date, status, is_active, invoice_numbering_mode) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, 'CONTINUE')")
      .run(`fy:${organizationId}:${startYear}:4`, organizationId, `FY ${startYear}–${String((startYear + 1) % 100).padStart(2, "0")}`, `${startYear}-04-01`, `${startYear + 1}-03-31`, startYear === 2026 ? 1 : 0)
    database.prepare("INSERT INTO financial_year_invoice_sequences(id, organization_id, financial_year_id, prefix, next_number) VALUES (?, ?, ?, 'INV', 20001)")
      .run(`sequence-${startYear}`, organizationId, `fy:${organizationId}:${startYear}:4`)
  }

  const insertProduct = database.prepare("INSERT INTO products(id, organization_id, name, sku, barcode, category, warehouse, stock, min_stock, purchase_rate, sale_rate, mrp, expiry_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 5, ?, ?, ?, ?)")
  const insertBatch = database.prepare("INSERT INTO stock_batches(id, organization_id, product_id, batch_no, expiry_date, quantity, purchase_rate, mrp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  database.exec("BEGIN IMMEDIATE")
  for (let index = 0; index < dataset.products; index += 1) {
    const stock = 100 + (index % 500)
    const cost = 10 + (index % 90)
    insertProduct.run(`product-${index}`, organizationId, `Product ${String(index).padStart(5, "0")}`, `SKU-${index}`, `890${String(index).padStart(10, "0")}`, `Category ${index % 40}`, `Warehouse ${index % 8}`, stock, cost, cost * 1.3, cost * 1.5, `202${7 + (index % 3)}-${String((index % 12) + 1).padStart(2, "0")}-28`)
    if (index % 2 === 0) insertBatch.run(`batch-${index}`, organizationId, `product-${index}`, `B-${index}`, `202${7 + (index % 3)}-12-28`, Math.floor(stock / 2), cost, cost * 1.5)
  }
  database.exec("COMMIT")

  const insertCustomer = database.prepare("INSERT INTO customers(id, organization_id, name, email, phone, gst_number, current_balance, total_sales) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  database.exec("BEGIN IMMEDIATE")
  for (let index = 0; index < dataset.customers; index += 1) {
    insertCustomer.run(`customer-${index}`, organizationId, `Customer ${String(index).padStart(5, "0")}`, `customer${index}@example.test`, `98${String(index).padStart(8, "0")}`, index % 3 === 0 ? `06ABCDE${String(index).padStart(4, "0")}F1Z5` : null, index % 10 === 0 ? 2500 : 0, index * 118)
  }
  database.exec("COMMIT")

  const insertInvoice = database.prepare("INSERT INTO sales_invoices(id, organization_id, customer_id, invoice_number, display_invoice_number, invoice_date, financial_year_id, taxable_amount, tax_amount, tax_total, total_amount, grand_total, total, paid_amount, outstanding_amount, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?, 100, 18, 18, 118, 118, 118, ?, ?, ?)")
  const insertItem = database.prepare("INSERT INTO sales_invoice_items(id, organization_id, invoice_id, product_id, product_name, quantity, unit_price, tax_percent, line_total, gst_amount) VALUES (?, ?, ?, ?, ?, 1, 100, 18, 100, 18)")
  const insertMovement = database.prepare("INSERT INTO stock_movements(id, organization_id, product_id, type, quantity, movement_date, financial_year_id) VALUES (?, ?, ?, 'sale', -1, ?, ?)")
  const insertPayment = database.prepare("INSERT INTO payments(id, organization_id, party_type, party_id, document_type, document_id, amount, direction, payment_date, financial_year_id) VALUES (?, ?, 'customer', ?, 'sales_invoice', ?, ?, 'in', ?, ?)")
  database.exec("BEGIN IMMEDIATE")
  for (let index = 0; index < dataset.invoices; index += 1) {
    const date = dateForInvoice(index)
    const startYear = Number(date.slice(0, 4)) - (Number(date.slice(5, 7)) < 4 ? 1 : 0)
    const yearId = `fy:${organizationId}:${startYear}:4`
    const invoiceId = `invoice-${index}`
    const customerId = `customer-${index % dataset.customers}`
    const productId = `product-${index % dataset.products}`
    const paid = index % 5 === 0 ? 0 : 118
    insertInvoice.run(invoiceId, organizationId, customerId, `DB-${String(index).padStart(7, "0")}`, `INV-${String(index).padStart(7, "0")}`, date, yearId, paid, 118 - paid, paid ? "paid" : "unpaid")
    insertItem.run(`item-${index}`, organizationId, invoiceId, productId, `Product ${String(index % dataset.products).padStart(5, "0")}`)
    insertMovement.run(`movement-${index}`, organizationId, productId, date, yearId)
    insertPayment.run(`payment-${index}`, organizationId, customerId, invoiceId, paid, date, yearId)
  }
  database.exec("COMMIT")

  database.close()
  const databaseOpen = measure(7, () => { const candidate = new DatabaseSync(databasePath); candidate.prepare("SELECT 1").get(); candidate.close() })
  database = new DatabaseSync(databasePath)
  database.exec("PRAGMA foreign_keys=ON; PRAGMA cache_size=-64000")
  const yearId = `fy:${organizationId}:2026:4`
  const measurements: Record<string, Measurement | number> = {
    schemaMigrationMs: migrationMs,
    databaseOpen,
    dashboard: measure(15, () => database.prepare("SELECT COUNT(*) invoice_count, SUM(grand_total) revenue, SUM(tax_amount) gst, SUM(outstanding_amount) outstanding FROM sales_invoices WHERE organization_id=? AND financial_year_id=? AND deleted_at IS NULL").get(organizationId, yearId)),
    invoiceHistory: measure(15, () => database.prepare("SELECT id, display_invoice_number, invoice_date, grand_total FROM sales_invoices WHERE organization_id=? AND financial_year_id=? AND deleted_at IS NULL ORDER BY invoice_date DESC, id DESC LIMIT 50").all(organizationId, yearId)),
    invoiceSearch: measure(15, () => database.prepare("SELECT id, display_invoice_number FROM sales_invoices WHERE organization_id=? AND financial_year_id=? AND (invoice_number LIKE ? OR display_invoice_number LIKE ?) LIMIT 50").all(organizationId, yearId, "DB-0001%", "INV-0001%")),
    customerSearch: measure(15, () => database.prepare("SELECT id, name, current_balance FROM customers WHERE organization_id=? AND deleted_at IS NULL AND name LIKE ? COLLATE NOCASE ORDER BY name LIMIT 50").all(organizationId, "Customer 01%")),
    financialYearSwitch: measure(15, () => database.prepare("SELECT financial_year_id, COUNT(*) invoice_count, SUM(grand_total) revenue FROM sales_invoices WHERE organization_id=? AND financial_year_id IN (?, ?, ?) GROUP BY financial_year_id").all(organizationId, `fy:${organizationId}:2024:4`, `fy:${organizationId}:2025:4`, yearId)),
    salesReport: measure(15, () => database.prepare("SELECT invoice_date, SUM(grand_total) revenue FROM sales_invoices WHERE organization_id=? AND financial_year_id=? GROUP BY invoice_date ORDER BY invoice_date").all(organizationId, yearId)),
    customerLedger: measure(15, () => database.prepare("SELECT payment_date, amount FROM payments WHERE organization_id=? AND financial_year_id=? AND party_id=? ORDER BY payment_date, id").all(organizationId, yearId, "customer-42")),
    gstReport: measure(15, () => database.prepare("SELECT SUM(taxable_amount) taxable, SUM(tax_amount) gst FROM sales_invoices WHERE organization_id=? AND financial_year_id=? AND invoice_type <> 'proforma'").get(organizationId, yearId)),
    inventoryCalculation: measure(15, () => database.prepare("SELECT SUM(stock) quantity, SUM(stock * purchase_rate) cost, SUM(stock * sale_rate) selling_value FROM products WHERE organization_id=? AND deleted_at IS NULL").get(organizationId)),
    stockHistory: measure(15, () => database.prepare("SELECT id, product_id, quantity, movement_date FROM stock_movements WHERE organization_id=? AND financial_year_id=? ORDER BY movement_date DESC, id DESC LIMIT 100").all(organizationId, yearId)),
    yearEndSummary: measure(15, () => database.prepare("SELECT COUNT(*) invoices, SUM(grand_total) revenue, SUM(tax_amount) gst, SUM(outstanding_amount) receivables FROM sales_invoices WHERE organization_id=? AND financial_year_id=?").get(organizationId, yearId)),
  }

  const nextYearId = `fy:${organizationId}:2027:4`
  const createStarted = performance.now()
  database.exec("BEGIN IMMEDIATE")
  database.prepare("UPDATE financial_years SET is_active=0 WHERE organization_id=?").run(organizationId)
  database.prepare("INSERT INTO financial_years(id, organization_id, label, start_date, end_date, status, is_active, previous_financial_year_id, invoice_numbering_mode, opening_snapshot_json) VALUES (?, ?, 'FY 2027–28', '2027-04-01', '2028-03-31', 'OPEN', 1, ?, 'CONTINUE', '{}')").run(nextYearId, organizationId, yearId)
  database.prepare("INSERT INTO financial_year_opening_balances(id, organization_id, financial_year_id, source_financial_year_id, party_type, party_id, balance_type, amount) SELECT 'opening:' || id, organization_id, ?, ?, 'customer', id, 'RECEIVABLE', current_balance FROM customers WHERE organization_id=? AND current_balance > 0").run(nextYearId, yearId, organizationId)
  database.prepare("INSERT INTO financial_year_inventory_openings(id, organization_id, financial_year_id, source_financial_year_id, inventory_key, product_id, batch_id, batch_no, expiry_date, quantity, purchase_rate, mrp) SELECT 'opening:batch:' || id, organization_id, ?, ?, 'batch:' || id, product_id, id, batch_no, expiry_date, quantity, purchase_rate, mrp FROM stock_batches WHERE organization_id=? AND quantity > 0").run(nextYearId, yearId, organizationId)
  database.prepare("INSERT INTO financial_year_inventory_openings(id, organization_id, financial_year_id, source_financial_year_id, inventory_key, product_id, expiry_date, quantity, purchase_rate, mrp) SELECT 'opening:residual:' || product.id, product.organization_id, ?, ?, 'unbatched:' || product.id, product.id, product.expiry_date, product.stock - COALESCE(batch.quantity, 0), product.purchase_rate, product.mrp FROM products product LEFT JOIN (SELECT product_id, SUM(quantity) quantity FROM stock_batches WHERE organization_id=? GROUP BY product_id) batch ON batch.product_id=product.id WHERE product.organization_id=? AND product.stock - COALESCE(batch.quantity, 0) > 0").run(nextYearId, yearId, organizationId, organizationId)
  database.prepare("UPDATE financial_years SET opening_snapshot_json=opening_snapshot_json WHERE id=?").run(nextYearId)
  database.exec("COMMIT")
  measurements.financialYearCreation = { p50Ms: round(performance.now() - createStarted), p95Ms: round(performance.now() - createStarted), worstMs: round(performance.now() - createStarted), iterations: 1 }
  measurements.closingChecks = measure(5, () => {
    database.prepare("PRAGMA quick_check").all()
    database.prepare("PRAGMA foreign_key_check").all()
    database.prepare("SELECT COUNT(*) FROM products WHERE organization_id=? AND stock < 0").get(organizationId)
    database.prepare("SELECT COUNT(*) FROM sales_invoices invoice JOIN financial_years fy ON fy.id=invoice.financial_year_id WHERE invoice.organization_id=? AND date(invoice.invoice_date) NOT BETWEEN fy.start_date AND fy.end_date").get(organizationId)
  })

  const openingQuantity = Number(database.prepare("SELECT SUM(quantity) quantity FROM financial_year_inventory_openings WHERE financial_year_id=?").get(nextYearId)?.quantity || 0)
  const physicalQuantity = Number(database.prepare("SELECT SUM(stock) quantity FROM products WHERE organization_id=?").get(organizationId)?.quantity || 0)
  assert.equal(openingQuantity, physicalQuantity)
  assert.equal(database.prepare("PRAGMA quick_check").get()?.quick_check, "ok")
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0)
  for (const [name, result] of Object.entries(measurements)) {
    if (typeof result === "number") continue
    assert.ok(result.worstMs < 2_000, `${name} exceeded the 2-second local performance guard (${result.worstMs} ms).`)
  }

  const output = { dataset, measurements, openingInventoryQuantity: openingQuantity, physicalInventoryQuantity: physicalQuantity, quickCheck: "ok", foreignKeyViolations: 0, databasePathRetained: false }
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`)
  console.log(JSON.stringify({ ...output, resultsFile: outputPath }, null, 2))
} finally {
  try { database.close() } catch {}
  rmSync(directory, { recursive: true, force: true })
}
