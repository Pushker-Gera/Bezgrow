import assert from "node:assert/strict"
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  assertFinancialYearCanStart,
  assertOperationalTransactionDate,
  dateBelongsToFinancialYear,
  FinancialYearDomainError,
  financialYearForDate,
  financialYearIdForDate,
  financialYearRange,
  fiscalStartYear,
  nextFinancialYear,
  normalizeLocalDate,
} from "../lib/financial-years"
import { allocateAuthoritativeStock, InsufficientStockError } from "../lib/inventory-availability"
import { LOCAL_DB_VERSION, localMigrations } from "../lib/offline/local/schema"

const directory = mkdtempSync(path.join(tmpdir(), "bezgrow-financial-years-"))
const databasePath = path.join(directory, "legacy-upgrade.db")
const backupPath = path.join(directory, "multi-year-backup.db")
const corruptPath = path.join(directory, "corrupt.db")
const repairPath = path.join(directory, "legacy-fy-repair.db")
let database = new DatabaseSync(databasePath)

function applyMigrations(db: DatabaseSync, maximumVersion = LOCAL_DB_VERSION) {
  db.exec("PRAGMA foreign_keys=ON")
  for (const migration of localMigrations.filter((candidate) => candidate.version <= maximumVersion)) {
    db.exec("BEGIN IMMEDIATE")
    try {
      for (const statement of migration.sql) {
        try {
          db.exec(statement)
        } catch (error) {
          const duplicateColumn = /^\s*ALTER\s+TABLE/i.test(statement) && /duplicate column name/i.test(String(error))
          if (!duplicateColumn) throw error
        }
      }
      db.prepare("INSERT OR REPLACE INTO schema_migrations(version, name, applied_at) VALUES (?, ?, datetime('now'))").run(migration.version, migration.name)
      db.exec(`PRAGMA user_version=${migration.version}`)
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  }
}

function expectSqlFailure(operation: () => unknown, pattern: RegExp) {
  assert.throws(operation, pattern)
}

try {
  // Calendar rules, including both Indian boundaries and a leap day.
  assert.equal(fiscalStartYear("2025-03-31"), 2024)
  assert.equal(fiscalStartYear("2025-04-01"), 2025)
  assert.equal(fiscalStartYear("2024-02-29"), 2023)
  assert.deepEqual(financialYearRange(2025), { startDate: "2025-04-01", endDate: "2026-03-31" })
  assert.deepEqual(financialYearRange(2023, 3), { startDate: "2023-03-01", endDate: "2024-02-29" })
  assert.equal(financialYearIdForDate("org-a", "2027-03-15"), "fy:org-a:2026:4")
  assert.equal(financialYearForDate("org-a", "2026-08-22").label, "FY 2026–27")
  assert.equal(financialYearForDate("org-a", "2027-03-31").label, "FY 2026–27")
  assert.equal(financialYearForDate("org-a", "2027-04-01").label, "FY 2027–28")
  assert.equal(dateBelongsToFinancialYear("2026-03-31", { start_date: "2025-04-01", end_date: "2026-03-31" }), true)
  expectSqlFailure(() => normalizeLocalDate("2025-02-29"), /valid transaction date/i)
  assert.equal(financialYearForDate("org-a", new Date("2027-03-31T18:29:59.999Z")).label, "FY 2026–27")
  assert.equal(financialYearForDate("org-a", new Date("2027-03-31T18:30:00.000Z")).label, "FY 2027–28")
  assert.equal(financialYearForDate("org-a", new Date("2026-03-31T18:30:00.000Z")).label, "FY 2026–27")
  const prematureYear = nextFinancialYear({ organization_id: "org-a", start_date: "2026-04-01", start_month: 4 })
  assert.throws(
    () => assertFinancialYearCanStart(prematureYear, "2026-08-22"),
    (error: unknown) => error instanceof FinancialYearDomainError && error.code === "NEXT_FINANCIAL_YEAR_NOT_STARTED" && /1 April 2027/.test(error.message),
  )
  assert.doesNotThrow(() => assertFinancialYearCanStart(prematureYear, "2027-04-01"))
  assert.throws(
    () => assertOperationalTransactionDate("2027-04-02", "2026-08-22"),
    (error: unknown) => error instanceof FinancialYearDomainError && error.code === "FUTURE_FINANCIAL_YEAR_POSTING_NOT_ALLOWED",
  )
  assert.throws(
    () => assertOperationalTransactionDate("2025-08-22", "2026-08-22"),
    (error: unknown) => error instanceof FinancialYearDomainError && error.code === "HISTORICAL_FINANCIAL_YEAR_READ_ONLY",
  )

  const legacyBatchProduct = { id: "product-1234", stock: 997, batch_no: "1234", warehouse_id: "warehouse-main", warehouse: "Main Warehouse" }
  const allocation = allocateAuthoritativeStock([legacyBatchProduct], [], [{ product_id: "product-1234", batch_no: "1234", quantity: 3 }], "2026-08-22T12:00:00.000Z")
  assert.equal(allocation.allocations.reduce((sum, row) => sum + row.quantity, 0), 3)
  assert.equal(allocation.allocations[0]?.batchNo, "1234")
  assert.equal(allocation.allocations[0]?.batchId, null)
  assert.throws(
    () => allocateAuthoritativeStock([legacyBatchProduct], [], [{ product_id: "product-1234", batch_no: "1234", quantity: 998 }], "2026-08-22T12:00:00.000Z"),
    (error: unknown) => error instanceof InsufficientStockError && error.available === 997 && /Only 997 units are available in Batch 1234 at Main Warehouse/.test(error.message),
  )

  // Build a real v14 installation first, then populate representative business data.
  applyMigrations(database, 14)
  assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 14)
  database.prepare("INSERT INTO organizations(id, name, business_name, invoice_prefix, next_invoice_number) VALUES (?, ?, ?, 'INV', 9)")
    .run("legacy-business", "Legacy Business", "Legacy Business")
  database.prepare("INSERT INTO warehouses(id, organization_id, name) VALUES ('warehouse-main', 'legacy-business', 'Main Warehouse')").run()
  database.prepare("INSERT INTO products(id, organization_id, name, warehouse_id, stock, purchase_rate, sale_rate, mrp, batch_no, expiry_date) VALUES ('product-a', 'legacy-business', 'Rezol DSR', 'warehouse-main', 10, 72, 100, 110, '1234', '2027-09-30')").run()
  database.prepare("INSERT INTO stock_batches(id, organization_id, product_id, warehouse_id, batch_no, expiry_date, quantity, purchase_rate, mrp) VALUES ('batch-a', 'legacy-business', 'product-a', 'warehouse-main', '1234', '2027-09-30', 6, 72, 110)").run()
  database.prepare("INSERT INTO customers(id, organization_id, name, current_balance) VALUES ('customer-a', 'legacy-business', 'Customer A', 25000)").run()
  database.prepare("INSERT INTO suppliers(id, organization_id, name, current_balance) VALUES ('supplier-a', 'legacy-business', 'Supplier A', 3000)").run()
  const insertLegacyInvoice = database.prepare(
    `INSERT INTO sales_invoices(id, organization_id, customer_id, invoice_number, invoice_date, taxable_amount, tax_amount, tax_total, total_amount, grand_total, total, outstanding_amount, payment_status)
     VALUES (?, 'legacy-business', 'customer-a', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  insertLegacyInvoice.run("invoice-mar", "INV-00001", "2025-03-31", 100, 18, 18, 118, 118, 118, 118, "unpaid")
  insertLegacyInvoice.run("invoice-apr", "INV-00002", "2025-04-01", 200, 36, 36, 236, 236, 236, 0, "paid")
  database.prepare("INSERT INTO sales_invoice_items(id, organization_id, invoice_id, product_id, quantity, unit_price, tax_percent, line_total, gst_amount) VALUES ('item-mar', 'legacy-business', 'invoice-mar', 'product-a', 1, 100, 18, 100, 18)").run()
  database.prepare("INSERT INTO payments(id, organization_id, party_type, party_id, document_type, document_id, amount, payment_date) VALUES ('payment-apr', 'legacy-business', 'customer', 'customer-a', 'sales_invoice', 'invoice-mar', 10, '2025-04-02')").run()
  database.prepare("INSERT INTO stock_movements(id, organization_id, product_id, warehouse_id, batch_id, type, quantity, movement_date) VALUES ('movement-mar', 'legacy-business', 'product-a', 'warehouse-main', 'batch-a', 'sale', -1, '2025-03-31')").run()
  database.prepare("INSERT INTO gst_invoice_summary(id, organization_id, invoice_id, gst_rate, taxable_amount, cgst_amount, sgst_amount) VALUES ('gst-mar', 'legacy-business', 'invoice-mar', 18, 100, 9, 9)").run()
  database.prepare("INSERT INTO gst_hsn_summary(id, organization_id, period_key, hsn_code, quantity, taxable_amount, tax_amount) VALUES ('hsn-old', 'legacy-business', '2024-05', '3004', 1, 100, 18)").run()

  // Upgrade through the current schema exactly as an application update does.
  applyMigrations(database)
  assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, LOCAL_DB_VERSION)
  assert.equal(database.prepare("SELECT financial_year_id FROM sales_invoices WHERE id='invoice-mar'").get()?.financial_year_id, "fy:legacy-business:2024:4")
  assert.equal(database.prepare("SELECT financial_year_id FROM sales_invoices WHERE id='invoice-apr'").get()?.financial_year_id, "fy:legacy-business:2025:4")
  assert.equal(database.prepare("SELECT financial_year_id FROM payments WHERE id='payment-apr'").get()?.financial_year_id, "fy:legacy-business:2025:4")
  assert.equal(database.prepare("SELECT financial_year_id FROM stock_movements WHERE id='movement-mar'").get()?.financial_year_id, "fy:legacy-business:2024:4")
  assert.equal(database.prepare("SELECT financial_year_id FROM gst_invoice_summary WHERE id='gst-mar'").get()?.financial_year_id, "fy:legacy-business:2024:4")
  assert.equal(database.prepare("SELECT financial_year_id FROM gst_hsn_summary WHERE id='hsn-old'").get()?.financial_year_id, "fy:legacy-business:2024:4")
  assert.equal(database.prepare("SELECT display_invoice_number FROM sales_invoices WHERE id='invoice-mar'").get()?.display_invoice_number, "INV-00001")
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM financial_years WHERE organization_id='legacy-business' AND is_active=1").get()?.count, 1)
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM financial_years WHERE organization_id='legacy-business' AND start_date='2025-04-01'").get()?.count, 1)

  // Re-running the migration statements is safe and does not duplicate years or relationships.
  const yearsBeforeRerun = database.prepare("SELECT COUNT(*) AS count FROM financial_years WHERE organization_id='legacy-business'").get()?.count
  const migration15 = localMigrations.find((migration) => migration.version === 15)
  assert.ok(migration15)
  for (const statement of migration15.sql) {
    try { database.exec(statement) } catch (error) {
      if (!/^\s*ALTER\s+TABLE/i.test(statement) || !/duplicate column name/i.test(String(error))) throw error
    }
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM financial_years WHERE organization_id='legacy-business'").get()?.count, yearsBeforeRerun)

  // Only one active year is permitted.
  expectSqlFailure(
    () => database.prepare("INSERT INTO financial_years(id, organization_id, label, start_date, end_date, status, is_active) VALUES ('fy:duplicate-active', 'legacy-business', 'FY 2098–99', '2098-04-01', '2099-03-31', 'OPEN', 1)").run(),
    /unique constraint/i,
  )

  // Create a next year atomically and carry exact physical/batch/cost/expiry/warehouse snapshots.
  const active = database.prepare("SELECT * FROM financial_years WHERE organization_id='legacy-business' AND is_active=1").get() as Record<string, unknown>
  const next = nextFinancialYear(active as never)
  database.exec("BEGIN IMMEDIATE")
  try {
    database.prepare("UPDATE financial_years SET is_active=0 WHERE organization_id='legacy-business'").run()
    database.prepare("INSERT INTO financial_years(id, organization_id, label, start_date, end_date, start_month, status, is_active, previous_financial_year_id, invoice_numbering_mode, opening_snapshot_json) VALUES (?, 'legacy-business', ?, ?, ?, 4, 'OPEN', 1, ?, 'RESTART', '{}')")
      .run(next.id, next.label, next.startDate, next.endDate, active.id)
    database.prepare("INSERT INTO financial_year_invoice_sequences(id, organization_id, financial_year_id, prefix, next_number) VALUES (?, 'legacy-business', ?, 'INV', 1)").run(`fy-seq:${next.id}`, next.id)
    database.prepare("INSERT INTO financial_year_opening_balances(id, organization_id, financial_year_id, source_financial_year_id, party_type, party_id, balance_type, amount) SELECT 'opening-customer', organization_id, ?, ?, 'customer', id, 'RECEIVABLE', current_balance FROM customers WHERE id='customer-a'").run(next.id, active.id)
    database.prepare("INSERT INTO financial_year_opening_balances(id, organization_id, financial_year_id, source_financial_year_id, party_type, party_id, balance_type, amount) SELECT 'opening-supplier', organization_id, ?, ?, 'supplier', id, 'PAYABLE', current_balance FROM suppliers WHERE id='supplier-a'").run(next.id, active.id)
    database.prepare("INSERT INTO financial_year_inventory_openings(id, organization_id, financial_year_id, source_financial_year_id, inventory_key, product_id, warehouse_id, batch_id, batch_no, expiry_date, quantity, purchase_rate, mrp) SELECT 'opening-batch', organization_id, ?, ?, 'batch:batch-a', product_id, warehouse_id, id, batch_no, expiry_date, quantity, purchase_rate, mrp FROM stock_batches WHERE id='batch-a'").run(next.id, active.id)
    database.prepare("INSERT INTO financial_year_inventory_openings(id, organization_id, financial_year_id, source_financial_year_id, inventory_key, product_id, warehouse_id, batch_no, expiry_date, quantity, purchase_rate, mrp) SELECT 'opening-residual', organization_id, ?, ?, 'unbatched:product-a', id, warehouse_id, batch_no, expiry_date, stock - 6, purchase_rate, mrp FROM products WHERE id='product-a'").run(next.id, active.id)
    database.prepare("UPDATE financial_years SET opening_snapshot_json=opening_snapshot_json WHERE id=?").run(next.id)
    database.exec("COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
  const opening = database.prepare("SELECT SUM(quantity) AS quantity, MIN(purchase_rate) AS rate, MIN(expiry_date) AS expiry, MIN(warehouse_id) AS warehouse FROM financial_year_inventory_openings WHERE financial_year_id=?").get(next.id)
  assert.equal(opening?.quantity, 10)
  assert.equal(opening?.rate, 72)
  assert.equal(opening?.expiry, "2027-09-30")
  assert.equal(opening?.warehouse, "warehouse-main")
  assert.equal(database.prepare("SELECT amount FROM financial_year_opening_balances WHERE id='opening-customer'").get()?.amount, 25000)
  assert.equal(database.prepare("SELECT amount FROM financial_year_opening_balances WHERE id='opening-supplier'").get()?.amount, 3000)
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sales_invoices WHERE financial_year_id=?").get(next.id)?.count, 0)
  assert.equal(database.prepare("SELECT COALESCE(SUM(tax_amount), 0) AS tax FROM sales_invoices WHERE financial_year_id=?").get(next.id)?.tax, 0)
  assert.equal(database.prepare("SELECT next_number FROM financial_year_invoice_sequences WHERE financial_year_id=?").get(next.id)?.next_number, 1)
  expectSqlFailure(() => database.prepare("INSERT INTO financial_year_opening_balances(id, organization_id, financial_year_id, party_type, party_id, balance_type, amount) VALUES ('duplicate-opening', 'legacy-business', ?, 'customer', 'customer-a', 'RECEIVABLE', 25000)").run(next.id), /unique constraint/i)

  // Restart mode permits the same display number while preserving a globally unique database number.
  database.prepare("INSERT INTO sales_invoices(id, organization_id, customer_id, invoice_number, display_invoice_number, invoice_date, financial_year_id, total_amount, grand_total, total) VALUES ('new-year-invoice', 'legacy-business', 'customer-a', ?, 'INV-00001', ?, ?, 50, 50, 50)")
    .run(`${next.id}/INV-00001`, next.startDate, next.id)
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sales_invoices WHERE display_invoice_number='INV-00001'").get()?.count, 2)

  // Wrong-year dates and closed-year mutations fail at the SQLite boundary.
  expectSqlFailure(
    () => database.prepare("INSERT INTO sales_invoices(id, organization_id, invoice_number, invoice_date, financial_year_id) VALUES ('wrong-year', 'legacy-business', 'WRONG-1', '2025-03-31', ?)").run(next.id),
    /financial_year_date_mismatch/i,
  )
  database.prepare("UPDATE financial_years SET status='CLOSED', is_active=0, closed_at=datetime('now') WHERE id=?").run(next.id)
  expectSqlFailure(() => database.prepare("DELETE FROM sales_invoices WHERE id='new-year-invoice'").run(), /financial_year_closed/i)
  expectSqlFailure(() => database.prepare("UPDATE financial_year_inventory_openings SET quantity=9 WHERE id='opening-batch'").run(), /financial_year_closed/i)
  expectSqlFailure(() => database.prepare("INSERT INTO payments(id, organization_id, party_type, amount, payment_date, financial_year_id) VALUES ('closed-payment', 'legacy-business', 'customer', 1, ?, ?)").run(next.startDate, next.id), /financial_year_closed/i)

  // Controlled reopening makes corrections possible again; the audit contract is implemented in the service.
  database.prepare("UPDATE financial_years SET status='OPEN', reopened_at=datetime('now'), reopen_reason='Correction approved by owner' WHERE id=?").run(next.id)
  database.prepare("UPDATE sales_invoices SET total_amount=51, grand_total=51, total=51 WHERE id='new-year-invoice'").run()
  assert.equal(database.prepare("SELECT total_amount FROM sales_invoices WHERE id='new-year-invoice'").get()?.total_amount, 51)

  // Expiry/renewal state changes do not mutate accounting data.
  database.prepare("INSERT INTO license_state(id, organization_id, status, expiry_date) VALUES ('license-a', 'legacy-business', 'expired', '2020-01-01')").run()
  const yearCountWhileExpired = database.prepare("SELECT COUNT(*) AS count FROM financial_years WHERE organization_id='legacy-business'").get()?.count
  database.prepare("UPDATE license_state SET status='active', expiry_date='2099-01-01' WHERE id='license-a'").run()
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM financial_years WHERE organization_id='legacy-business'").get()?.count, yearCountWhileExpired)

  const quickCheck = database.prepare("PRAGMA quick_check").all()
  assert.equal(quickCheck.length, 1)
  assert.equal(quickCheck[0]?.quick_check, "ok")
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0)
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM (SELECT organization_id, financial_year_id, party_type, party_id, balance_type, COUNT(*) entries FROM financial_year_opening_balances GROUP BY organization_id, financial_year_id, party_type, party_id, balance_type HAVING entries > 1)").get()?.count, 0)

  // A full SQLite backup preserves all years and relationships exactly.
  database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`)
  const beforeBackup = database.prepare("SELECT COUNT(*) AS count FROM financial_years WHERE organization_id='legacy-business'").get()?.count
  database.prepare("DELETE FROM sales_invoices WHERE id='new-year-invoice'").run()
  database.close()
  copyFileSync(backupPath, databasePath)
  database = new DatabaseSync(databasePath)
  database.exec("PRAGMA foreign_keys=ON")
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM financial_years WHERE organization_id='legacy-business'").get()?.count, beforeBackup)
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sales_invoices WHERE id='new-year-invoice'").get()?.count, 1)
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0)
  writeFileSync(corruptPath, "not a sqlite backup")
  const corruptDatabase = new DatabaseSync(corruptPath)
  try {
    expectSqlFailure(() => corruptDatabase.prepare("PRAGMA quick_check").all(), /database|file|encrypted/i)
  } finally {
    corruptDatabase.close()
  }

  // Upgrade repair: an impossible future ACTIVE row is demoted, the current
  // FY is restored, date-provable assignments are corrected, and genuinely
  // future-dated rows remain preserved for review.
  const repairDatabase = new DatabaseSync(repairPath)
  try {
    applyMigrations(repairDatabase, 14)
    repairDatabase.prepare("INSERT INTO organizations(id, name, invoice_prefix, next_invoice_number) VALUES ('repair-org', 'Repair Org', 'INV', 2), ('preserve-org', 'Preserve Org', 'INV', 1)").run()
    repairDatabase.prepare("INSERT INTO customers(id, organization_id, name) VALUES ('repair-customer', 'repair-org', 'Repair Customer')").run()
    repairDatabase.prepare("INSERT INTO products(id, organization_id, name, stock, batch_no) VALUES ('repair-product', 'repair-org', 'Batch Product', 997, '1234'), ('preserve-product', 'preserve-org', 'Future Product', 5, 'FUTURE')").run()
    repairDatabase.prepare("INSERT INTO sales_invoices(id, organization_id, customer_id, invoice_number, invoice_date, grand_total, total_amount, total, outstanding_amount) VALUES ('repair-invoice', 'repair-org', 'repair-customer', 'INV-00001', '2026-08-18', 100, 100, 100, 100)").run()
    applyMigrations(repairDatabase, 15)
    const repairCurrent = "fy:repair-org:2026:4"
    const repairFuture = "fy:repair-org:2027:4"
    const preserveCurrent = "fy:preserve-org:2026:4"
    const preserveFuture = "fy:preserve-org:2027:4"
    repairDatabase.prepare("UPDATE financial_years SET is_active=0 WHERE organization_id IN ('repair-org', 'preserve-org')").run()
    repairDatabase.prepare("INSERT INTO financial_years(id, organization_id, label, start_date, end_date, status, is_active, previous_financial_year_id) VALUES (?, 'repair-org', 'FY 2027–28', '2027-04-01', '2028-03-31', 'OPEN', 1, ?), (?, 'preserve-org', 'FY 2027–28', '2027-04-01', '2028-03-31', 'OPEN', 1, ?)")
      .run(repairFuture, repairCurrent, preserveFuture, preserveCurrent)
    repairDatabase.prepare("INSERT INTO sales_invoices(id, organization_id, customer_id, invoice_number, invoice_date, financial_year_id, grand_total, total_amount, total, paid_amount, outstanding_amount, payment_status, status) VALUES ('repair-paid-label', 'repair-org', 'repair-customer', 'INV-PAID-LABEL', '2026-08-18', ?, 100, 100, 100, 0, 100, 'paid', 'paid'), ('repair-unpaid-label', 'repair-org', 'repair-customer', 'INV-UNPAID-LABEL', '2026-08-18', ?, 100, 100, 100, 100, 0, 'unpaid', 'unpaid')")
      .run(repairCurrent, repairCurrent)
    repairDatabase.prepare("INSERT INTO purchase_invoices(id, organization_id, bill_number, bill_date, financial_year_id, grand_total, paid_amount, outstanding_amount, status) VALUES ('repair-purchase-label', 'repair-org', 'BILL-LABEL', '2026-08-18', ?, 75, 0, 75, 'paid')")
      .run(repairCurrent)
    repairDatabase.exec("DROP TRIGGER trg_fy_date_sales_invoice_update")
    repairDatabase.prepare("UPDATE sales_invoices SET financial_year_id=? WHERE id='repair-invoice'").run(repairFuture)
    const invoiceDateTrigger = localMigrations.find((migration) => migration.version === 15)?.sql.find((statement) => statement.includes("trg_fy_date_sales_invoice_update"))
    assert.ok(invoiceDateTrigger)
    repairDatabase.exec(invoiceDateTrigger)
    repairDatabase.prepare("INSERT INTO stock_movements(id, organization_id, product_id, type, quantity, movement_date, financial_year_id) VALUES ('preserved-future-movement', 'preserve-org', 'preserve-product', 'opening_stock', 5, '2027-04-02', ?)").run(preserveFuture)
    applyMigrations(repairDatabase)
    assert.equal(repairDatabase.prepare("SELECT id FROM financial_years WHERE organization_id='repair-org' AND is_active=1").get()?.id, repairCurrent)
    assert.equal(repairDatabase.prepare("SELECT financial_year_id FROM sales_invoices WHERE id='repair-invoice'").get()?.financial_year_id, repairCurrent)
    assert.equal(repairDatabase.prepare("SELECT status FROM financial_years WHERE id=?").get(repairFuture)?.status, "ARCHIVED")
    assert.equal(repairDatabase.prepare("SELECT id FROM financial_years WHERE organization_id='preserve-org' AND is_active=1").get()?.id, preserveCurrent)
    assert.equal(repairDatabase.prepare("SELECT is_active FROM financial_years WHERE id=?").get(preserveFuture)?.is_active, 0)
    assert.equal(repairDatabase.prepare("SELECT financial_year_id FROM stock_movements WHERE id='preserved-future-movement'").get()?.financial_year_id, preserveFuture)
    assert.equal(repairDatabase.prepare("SELECT COUNT(*) AS count FROM local_audit_logs WHERE action='financial_year.legacy_state_repaired'").get()?.count, 2)
    assert.deepEqual(
      { ...repairDatabase.prepare("SELECT payment_status, status, paid_amount, outstanding_amount FROM sales_invoices WHERE id='repair-paid-label'").get() },
      { payment_status: "unpaid", status: "unpaid", paid_amount: 0, outstanding_amount: 100 },
    )
    assert.deepEqual(
      { ...repairDatabase.prepare("SELECT payment_status, status, paid_amount, outstanding_amount FROM sales_invoices WHERE id='repair-unpaid-label'").get() },
      { payment_status: "paid", status: "paid", paid_amount: 100, outstanding_amount: 0 },
    )
    assert.equal(repairDatabase.prepare("SELECT status FROM purchase_invoices WHERE id='repair-purchase-label'").get()?.status, "unpaid")
    assert.equal(repairDatabase.prepare("SELECT COUNT(*) AS count FROM local_audit_logs WHERE action='invoice.settlement_status_repaired' AND organization_id='repair-org'").get()?.count, 1)
    assert.equal(repairDatabase.prepare("PRAGMA quick_check").get()?.quick_check, "ok")
    assert.equal(repairDatabase.prepare("PRAGMA foreign_key_check").all().length, 0)
  } finally {
    repairDatabase.close()
  }

  // Financial-year business logic is local-only and closing invokes backup before status mutation.
  const financialSource = readFileSync(path.join(process.cwd(), "lib/offline/local/financial-years.ts"), "utf8")
  const apiSource = readFileSync(path.join(process.cwd(), "lib/offline/local/api.ts"), "utf8")
  const customerSource = readFileSync(path.join(process.cwd(), "app/dashboard/customers/page.tsx"), "utf8")
  assert.doesNotMatch(financialSource, /supabase|fetch\(\s*["']https?:/i)
  assert.doesNotMatch(apiSource.slice(apiSource.indexOf("financialYearsList"), apiSource.indexOf("localWorkspaceBootstrap")), /supabase/i)
  assert.ok(financialSource.indexOf('invokeTauri<BackupResult | null>("desktop_database_backup"') < financialSource.indexOf("SET status = 'CLOSED'"))
  assert.match(financialSource, /reason\.trim\(\)\.length < 10/)
  const createYearSource = financialSource.slice(financialSource.indexOf("export async function createNextFinancialYear"), financialSource.indexOf("export async function financialYearClosingChecks"))
  assert.ok(createYearSource.indexOf("assertFinancialYearCanStart(next, currentDate)") < createYearSource.indexOf("createFinancialYearSafetyBackup(next.label)"))
  assert.ok(createYearSource.indexOf("createFinancialYearSafetyBackup(next.label)") < createYearSource.indexOf("await service.transaction(async (db)"))
  assert.match(apiSource, /\/api\/customers\/financial-year-ledger/)
  assert.match(customerSource, /\/api\/customers\/financial-year-ledger/)

  console.log(JSON.stringify({
    calendarBoundaries: "passed",
    upgradedFrom: 14,
    upgradedTo: LOCAL_DB_VERSION,
    migratedInvoices: 2,
    financialYears: beforeBackup,
    openingInventoryQuantity: opening?.quantity,
    futureYearProtection: "passed",
    legacyRepair: "passed",
    batch1234Available: 997,
    backupRestore: "passed",
    quickCheck: "ok",
    foreignKeyViolations: 0,
    localFirst: true,
  }, null, 2))
} finally {
  try { database.close() } catch {}
  rmSync(directory, { recursive: true, force: true })
}
