import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { allocateAuthoritativeStock, InsufficientStockError } from "../lib/inventory-availability"
import { LOCAL_DB_VERSION, localMigrations } from "../lib/offline/local/schema"

const organizationId = "fy-billing-integrity-business"
const historicalYearId = `fy:${organizationId}:2025:4`
const currentYearId = `fy:${organizationId}:2026:4`
const directory = mkdtempSync(path.join(tmpdir(), "bezgrow-fy-billing-integrity-"))
const databasePath = path.join(directory, "billing-integrity.db")

function applyMigrations(database: DatabaseSync) {
  database.exec("PRAGMA foreign_keys=ON")
  for (const migration of localMigrations) {
    for (const statement of migration.sql) {
      try {
        database.exec(statement)
      } catch (error) {
        if (!/^\s*ALTER\s+TABLE/i.test(statement) || !/duplicate column name/i.test(String(error))) throw error
      }
    }
    database.prepare("INSERT OR REPLACE INTO schema_migrations(version, name) VALUES (?, ?)").run(migration.version, migration.name)
  }
  database.exec(`PRAGMA user_version=${LOCAL_DB_VERSION}`)
}

function scalar(database: DatabaseSync, query: string, ...values: Array<string | number | null>) {
  return Number(Object.values(database.prepare(query).get(...values) || { value: 0 })[0] || 0)
}

const database = new DatabaseSync(databasePath)
try {
  applyMigrations(database)
  database.prepare("INSERT INTO organizations(id, name, business_name, invoice_prefix, next_invoice_number) VALUES (?, 'Integrity Business', 'Integrity Business', 'INV', 1)").run(organizationId)
  database.prepare("INSERT INTO financial_years(id, organization_id, label, start_date, end_date, status, is_active) VALUES (?, ?, 'FY 2025–26', '2025-04-01', '2026-03-31', 'OPEN', 0)").run(historicalYearId, organizationId)
  database.prepare("INSERT INTO financial_years(id, organization_id, label, start_date, end_date, status, is_active, previous_financial_year_id) VALUES (?, ?, 'FY 2026–27', '2026-04-01', '2027-03-31', 'OPEN', 1, ?)").run(currentYearId, organizationId, historicalYearId)
  database.prepare("INSERT INTO financial_year_invoice_sequences(id, organization_id, financial_year_id, prefix, next_number) VALUES ('sequence-current', ?, ?, 'INV', 1)").run(organizationId, currentYearId)
  database.prepare("INSERT INTO customers(id, organization_id, name, current_balance) VALUES ('customer-1', ?, 'Customer One', 100)").run(organizationId)
  database.prepare("INSERT INTO suppliers(id, organization_id, name, current_balance) VALUES ('supplier-1', ?, 'Supplier One', 100)").run(organizationId)
  database.prepare("INSERT INTO products(id, organization_id, name, sku, batch_no, warehouse, stock, purchase_rate, sale_rate) VALUES ('product-1', ?, 'Batch Product', 'BATCH-PRODUCT', '1234', 'Main Warehouse', 997, 10, 20)").run(organizationId)

  const product = database.prepare("SELECT * FROM products WHERE id='product-1'").get() as Record<string, unknown>
  const allocation = allocateAuthoritativeStock([product], [], [{ product_id: "product-1", product_name: "Batch Product", batch_no: "1234", quantity: 3 }], "2026-08-22T12:00:00.000Z")
  assert.equal(allocation.allocations.length, 1)
  assert.equal(allocation.allocations[0]?.quantity, 3)
  assert.equal(allocation.allocations[0]?.batchId, null)

  database.exec("BEGIN IMMEDIATE")
  try {
    database.prepare("INSERT INTO sales_invoices(id, organization_id, customer_id, invoice_number, display_invoice_number, invoice_date, date, financial_year_id, grand_total, total_amount, total, outstanding_amount, payment_status, status) VALUES ('invoice-valid', ?, 'customer-1', 'INV-00001', 'INV-00001', '2026-08-22', '2026-08-22', ?, 60, 60, 60, 60, 'unpaid', 'unpaid')").run(organizationId, currentYearId)
    database.prepare("INSERT INTO sales_invoice_items(id, organization_id, invoice_id, product_id, product_name, batch_no, quantity, unit_price, line_total) VALUES ('item-valid', ?, 'invoice-valid', 'product-1', 'Batch Product', '1234', 3, 20, 60)").run(organizationId)
    database.prepare("UPDATE products SET stock=stock-3 WHERE organization_id=? AND id='product-1'").run(organizationId)
    database.prepare("INSERT INTO stock_movements(id, organization_id, product_id, product_name, type, quantity, movement_date, reference_id, financial_year_id) VALUES ('movement-valid', ?, 'product-1', 'Batch Product', 'sale', -3, '2026-08-22', 'invoice-valid', ?)").run(organizationId, currentYearId)
    database.prepare("UPDATE financial_year_invoice_sequences SET next_number=2 WHERE organization_id=? AND financial_year_id=?").run(organizationId, currentYearId)
    database.prepare("UPDATE organizations SET next_invoice_number=2 WHERE id=?").run(organizationId)
    database.exec("COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
  assert.equal(scalar(database, "SELECT stock FROM products WHERE id='product-1'"), 994)

  const beforeFailure = {
    invoices: scalar(database, "SELECT COUNT(*) FROM sales_invoices"),
    items: scalar(database, "SELECT COUNT(*) FROM sales_invoice_items"),
    movements: scalar(database, "SELECT COUNT(*) FROM stock_movements"),
    payments: scalar(database, "SELECT COUNT(*) FROM payments"),
    stock: scalar(database, "SELECT stock FROM products WHERE id='product-1'"),
    sequence: scalar(database, "SELECT next_number FROM financial_year_invoice_sequences WHERE financial_year_id=?", currentYearId),
  }
  assert.throws(
    () => allocateAuthoritativeStock(
      [database.prepare("SELECT * FROM products WHERE id='product-1'").get() as Record<string, unknown>],
      [],
      [{ product_id: "product-1", product_name: "Batch Product", batch_no: "1234", quantity: 995 }],
      "2026-08-22T12:00:00.000Z"
    ),
    (error) => error instanceof InsufficientStockError && error.available === 994 && /Only 994 units are available in Batch 1234 at Main Warehouse/.test(error.message)
  )

  database.exec("BEGIN IMMEDIATE")
  try {
    database.prepare("INSERT INTO sales_invoices(id, organization_id, customer_id, invoice_number, invoice_date, financial_year_id, grand_total, total_amount, total, outstanding_amount) VALUES ('invoice-rollback', ?, 'customer-1', 'INV-00002', '2026-08-22', ?, 20, 20, 20, 20)").run(organizationId, currentYearId)
    database.prepare("INSERT INTO sales_invoice_items(id, organization_id, invoice_id, product_id, quantity, unit_price, line_total) VALUES ('item-rollback', ?, 'invoice-rollback', 'product-1', 1000, 20, 20000)").run(organizationId)
    database.prepare("UPDATE products SET stock=stock-1000 WHERE organization_id=? AND id='product-1'").run(organizationId)
    database.prepare("UPDATE financial_year_invoice_sequences SET next_number=3 WHERE organization_id=? AND financial_year_id=?").run(organizationId, currentYearId)
    database.exec("COMMIT")
    assert.fail("The non-negative stock invariant should have aborted the invoice transaction.")
  } catch (error) {
    database.exec("ROLLBACK")
    assert.match(String(error), /(?:stock_cannot_be_negative|insufficient_product_stock)/)
  }
  assert.deepEqual({
    invoices: scalar(database, "SELECT COUNT(*) FROM sales_invoices"),
    items: scalar(database, "SELECT COUNT(*) FROM sales_invoice_items"),
    movements: scalar(database, "SELECT COUNT(*) FROM stock_movements"),
    payments: scalar(database, "SELECT COUNT(*) FROM payments"),
    stock: scalar(database, "SELECT stock FROM products WHERE id='product-1'"),
    sequence: scalar(database, "SELECT next_number FROM financial_year_invoice_sequences WHERE financial_year_id=?", currentYearId),
  }, beforeFailure)

  database.prepare("INSERT INTO sales_invoices(id, organization_id, customer_id, invoice_number, display_invoice_number, invoice_date, date, financial_year_id, grand_total, total_amount, total, paid_amount, outstanding_amount, payment_status, status) VALUES ('invoice-old', ?, 'customer-1', 'OLD-00001', 'OLD-00001', '2026-03-31', '2026-03-31', ?, 100, 100, 100, 0, 100, 'unpaid', 'unpaid')").run(organizationId, historicalYearId)
  database.prepare("INSERT INTO purchase_invoices(id, organization_id, supplier_id, bill_number, bill_date, financial_year_id, grand_total, paid_amount, outstanding_amount, status) VALUES ('purchase-old', ?, 'supplier-1', 'OLD-BILL-1', '2026-03-31', ?, 100, 0, 100, 'unpaid')").run(organizationId, historicalYearId)
  database.prepare("UPDATE financial_years SET status='CLOSED', closed_at='2026-04-01T00:00:00Z' WHERE id=?").run(historicalYearId)

  database.exec("BEGIN IMMEDIATE")
  try {
    database.prepare("INSERT INTO payments(id, organization_id, party_type, party_id, document_type, document_id, amount, direction, payment_date, financial_year_id) VALUES ('payment-old-partial', ?, 'customer', 'customer-1', 'sales_invoice', 'invoice-old', 40, 'in', '2026-08-22', ?)").run(organizationId, currentYearId)
    database.prepare("INSERT INTO payment_receipts(id, organization_id, customer_id, invoice_id, receipt_number, receipt_type, amount, received_at, financial_year_id) VALUES ('receipt-old-partial', ?, 'customer-1', 'invoice-old', 'RCPT-OLD-1', 'customer_receipt', 40, '2026-08-22T12:00:00', ?)").run(organizationId, currentYearId)
    database.prepare("INSERT INTO ledger_entries(id, organization_id, account_type, account_id, document_type, document_id, entry_date, credit, financial_year_id) VALUES ('ledger-old-partial', ?, 'customer', 'customer-1', 'sales_invoice', 'payment-old-partial', '2026-08-22', 40, ?)").run(organizationId, currentYearId)
    database.prepare("UPDATE sales_invoices SET paid_amount=40, outstanding_amount=60, payment_status='partial', status='partial', updated_at='2026-08-22T12:00:00Z' WHERE id='invoice-old'").run()
    database.prepare("UPDATE customers SET current_balance=current_balance-40 WHERE id='customer-1'").run()
    database.exec("COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
  const settledInvoice = database.prepare("SELECT financial_year_id, paid_amount, outstanding_amount, payment_status FROM sales_invoices WHERE id='invoice-old'").get() as Record<string, unknown>
  assert.deepEqual({ ...settledInvoice }, { financial_year_id: historicalYearId, paid_amount: 40, outstanding_amount: 60, payment_status: "partial" })
  assert.equal(database.prepare("SELECT financial_year_id FROM payments WHERE id='payment-old-partial'").get()?.financial_year_id, currentYearId)
  database.prepare("UPDATE purchase_invoices SET paid_amount=40, outstanding_amount=60, status='partial' WHERE id='purchase-old'").run()
  assert.deepEqual(
    { ...database.prepare("SELECT financial_year_id, paid_amount, outstanding_amount, status FROM purchase_invoices WHERE id='purchase-old'").get() },
    { financial_year_id: historicalYearId, paid_amount: 40, outstanding_amount: 60, status: "partial" },
  )
  assert.throws(() => database.prepare("UPDATE sales_invoices SET notes='changed after close' WHERE id='invoice-old'").run(), /financial_year_closed/)
  assert.throws(() => database.prepare("UPDATE purchase_invoices SET notes='changed after close' WHERE id='purchase-old'").run(), /financial_year_closed/)
  assert.throws(() => database.prepare("INSERT INTO sales_invoices(id, organization_id, invoice_number, invoice_date, financial_year_id) VALUES ('duplicate-number', ?, 'INV-00001', '2026-08-22', ?)").run(organizationId, currentYearId), /UNIQUE constraint failed/)

  const repositorySource = readFileSync(path.resolve("lib/offline/local/repositories.ts"), "utf8")
  const closeDialogSource = readFileSync(path.resolve("components/financial-years/FinancialYearManagement.tsx"), "utf8")
  assert.match(repositorySource, /export async function createNormalizedInvoiceAtomic[\s\S]*service\.transaction/)
  assert.match(repositorySource, /export async function createNormalizedPaymentAtomic[\s\S]*service\.transaction/)
  assert.match(closeDialogSource, /max-h-\[calc\(100dvh-2rem\)\]/)
  assert.match(closeDialogSource, /overflow-y-auto/)
  assert.match(closeDialogSource, /sticky bottom-0/)
  assert.match(closeDialogSource, /event\.key === "Enter"/)
  assert.equal(database.prepare("PRAGMA quick_check").get()?.quick_check, "ok")
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0)

  console.log(JSON.stringify({
    batch1234StartingStock: 997,
    validInvoiceQuantity: 3,
    remainingStock: 994,
    failedInvoiceAtomic: true,
    sequencePreserved: true,
    historicalInvoiceFinancialYearPreserved: true,
    crossYearPartialPayment: 40,
    remainingReceivable: 60,
    currentYearPaymentPosting: true,
    crossYearPayableSettlement: true,
    duplicateInvoiceNumberGuard: true,
    closeDialogViewportGuard: true,
    quickCheck: "ok",
    foreignKeyViolations: 0,
  }, null, 2))
} finally {
  database.close()
  rmSync(directory, { recursive: true, force: true })
}
