import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { DatabaseSync } from "node:sqlite"
import { localMigrations } from "../lib/offline/local/schema"

const directory = mkdtempSync(path.join(tmpdir(), "bezgrow-accounting-scale-"))
const databasePath = path.join(directory, "scale.db")
const db = new DatabaseSync(databasePath)

function applyMigrations() {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON")
  for (const migration of localMigrations) {
    db.exec("BEGIN IMMEDIATE")
    try {
      for (const statement of migration.sql) {
        try { db.exec(statement) } catch (error) {
          if (!(/^\s*ALTER\s+TABLE/i.test(statement) && /duplicate column name/i.test(String(error)))) throw error
        }
      }
      db.prepare("INSERT OR REPLACE INTO schema_migrations(version, name, applied_at) VALUES (?, ?, datetime('now'))").run(migration.version, migration.name)
      db.exec(`PRAGMA user_version=${migration.version}; COMMIT`)
    } catch (error) { db.exec("ROLLBACK"); throw error }
  }
}

function timed<T>(work: () => T) { const started = performance.now(); const result = work(); return { result, milliseconds: performance.now() - started } }

try {
  applyMigrations()
  db.exec("BEGIN IMMEDIATE")
  db.prepare("INSERT INTO organizations(id, name, created_at, updated_at) VALUES ('org:scale', 'Scale Business', datetime('now'), datetime('now'))").run()
  db.prepare("INSERT INTO financial_years(id, organization_id, label, start_date, end_date, status, is_active, created_at) VALUES ('fy:scale', 'org:scale', 'FY 2026–27', '2026-04-01', '2027-03-31', 'OPEN', 1, datetime('now'))").run()
  const product = db.prepare("INSERT INTO products(id, organization_id, name, sku, stock, purchase_rate, created_at, updated_at) VALUES (?, 'org:scale', ?, ?, 100, 50, datetime('now'), datetime('now'))")
  for (let index = 0; index < 2_000; index += 1) product.run(`product:${index}`, `Product ${index}`, `SKU-${index}`)
  const customer = db.prepare("INSERT INTO customers(id, organization_id, name, current_balance, created_at, updated_at) VALUES (?, 'org:scale', ?, 0, datetime('now'), datetime('now'))")
  for (let index = 0; index < 5_000; index += 1) customer.run(`customer:${index}`, `Customer ${index}`)
  const invoice = db.prepare("INSERT INTO sales_invoices(id, organization_id, customer_id, invoice_number, invoice_date, subtotal, taxable_amount, tax_amount, grand_total, total_amount, total, paid_amount, outstanding_amount, payment_status, status, financial_year_id, created_at, updated_at) VALUES (?, 'org:scale', ?, ?, ?, 100, 100, 18, 118, 118, 118, 118, 0, 'paid', 'paid', 'fy:scale', datetime('now'), datetime('now'))")
  const invoiceItem = db.prepare("INSERT INTO sales_invoice_items(id, organization_id, invoice_id, product_id, product_name, quantity, unit_price, line_total, gst_amount, created_at, updated_at) VALUES (?, 'org:scale', ?, ?, ?, 1, 50, 59, 9, datetime('now'), datetime('now'))")
  for (let index = 0; index < 20_000; index += 1) {
    invoice.run(`invoice:${index}`, `customer:${index % 5_000}`, `INV-${index}`, `2026-${String(4 + (index % 9)).padStart(2, "0")}-${String(1 + (index % 27)).padStart(2, "0")}`)
    invoiceItem.run(`invoice-item:${index}:1`, `invoice:${index}`, `product:${index % 2_000}`, `Product ${index % 2_000}`)
    invoiceItem.run(`invoice-item:${index}:2`, `invoice:${index}`, `product:${(index + 1) % 2_000}`, `Product ${(index + 1) % 2_000}`)
  }
  const accountInsert = db.prepare("INSERT INTO chart_of_accounts(id, organization_id, account_code, account_name, account_type, account_group, normal_balance, is_system, is_cash_account, is_active, system_role, created_at, updated_at) VALUES (?, 'org:scale', ?, ?, ?, ?, ?, 1, ?, 1, ?, datetime('now'), datetime('now'))")
  accountInsert.run("account:cash", "1000", "Cash", "ASSET", "CASH", "debit", 1, "CASH")
  accountInsert.run("account:sales", "4000", "Sales", "INCOME", "SALES_INCOME", "credit", 0, "SALES")
  const voucher = db.prepare("INSERT INTO accounting_vouchers(id, organization_id, voucher_number, voucher_type, voucher_date, total_debit, total_credit, status, financial_year_id, source_type, source_id, total_debit_minor, total_credit_minor, is_system_generated, created_at, updated_at, finalized_at) VALUES (?, 'org:scale', ?, 'sale', ?, 118, 118, 'draft', 'fy:scale', 'SALES_INVOICE', ?, 11800, 11800, 1, datetime('now'), datetime('now'), datetime('now'))")
  const line = db.prepare("INSERT INTO accounting_voucher_entries(id, organization_id, voucher_id, account_id, account_type, line_no, debit, credit, debit_minor, credit_minor, created_at, updated_at) VALUES (?, 'org:scale', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))")
  const post = db.prepare("UPDATE accounting_vouchers SET status = 'posted' WHERE id = ?")
  for (let index = 0; index < 12_000; index += 1) {
    const id = `voucher:${index}`
    const date = `2026-${String(4 + (index % 9)).padStart(2, "0")}-${String(1 + (index % 27)).padStart(2, "0")}`
    voucher.run(id, `SALE-${index}`, date, `invoice:${index}`)
    line.run(`${id}:1`, id, "account:cash", "ASSET", 1, 118, 0, 11800, 0)
    line.run(`${id}:2`, id, "account:sales", "INCOME", 2, 0, 118, 0, 11800)
    post.run(id)
  }
  db.exec("COMMIT")

  const trialBalance = timed(() => db.prepare(`SELECT account.account_code, SUM(line.debit_minor) debit_minor, SUM(line.credit_minor) credit_minor
    FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id = line.voucher_id
    JOIN chart_of_accounts account ON account.id = line.account_id
    WHERE line.organization_id = 'org:scale' AND voucher.financial_year_id = 'fy:scale' AND voucher.status = 'posted'
    GROUP BY account.id ORDER BY account.account_code`).all())
  const profitLoss = timed(() => db.prepare(`SELECT SUM(CASE WHEN account.account_type = 'INCOME' THEN line.credit_minor - line.debit_minor ELSE 0 END) income_minor,
    SUM(CASE WHEN account.account_type = 'EXPENSE' THEN line.debit_minor - line.credit_minor ELSE 0 END) expense_minor
    FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id = line.voucher_id
    JOIN chart_of_accounts account ON account.id = line.account_id WHERE line.organization_id = 'org:scale' AND voucher.financial_year_id = 'fy:scale' AND voucher.status = 'posted'`).get())
  const generalLedger = timed(() => db.prepare(`SELECT voucher.voucher_date, voucher.voucher_number, line.debit_minor, line.credit_minor,
    SUM(line.debit_minor-line.credit_minor) OVER (ORDER BY voucher.voucher_date, voucher.id, line.line_no) running_minor
    FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id = line.voucher_id
    WHERE line.organization_id = 'org:scale' AND line.account_id = 'account:cash' AND voucher.financial_year_id = 'fy:scale' AND voucher.status = 'posted'
    ORDER BY voucher.voucher_date, voucher.id LIMIT 100`).all())
  const integrity = timed(() => db.prepare(`SELECT COUNT(*) invalid FROM (
    SELECT voucher.id FROM accounting_vouchers voucher JOIN accounting_voucher_entries line ON line.voucher_id = voucher.id
    WHERE voucher.organization_id = 'org:scale' AND voucher.status = 'posted' GROUP BY voucher.id
    HAVING SUM(line.debit_minor) <> SUM(line.credit_minor) OR SUM(line.debit_minor) <> voucher.total_debit_minor)`).get() as { invalid: number })
  const productSearch = timed(() => db.prepare("SELECT id, name, stock FROM products WHERE organization_id = 'org:scale' AND deleted_at IS NULL AND (name LIKE '%Product 1999%' OR sku LIKE '%SKU-1999%') LIMIT 50").all())
  const customerSearch = timed(() => db.prepare("SELECT id, name, current_balance FROM customers WHERE organization_id = 'org:scale' AND deleted_at IS NULL AND name LIKE '%Customer 4999%' LIMIT 50").all())
  const invoiceList = timed(() => db.prepare("SELECT id, invoice_number, invoice_date, grand_total FROM sales_invoices WHERE organization_id = 'org:scale' AND financial_year_id = 'fy:scale' AND deleted_at IS NULL ORDER BY invoice_date DESC, created_at DESC LIMIT 100").all())
  const journalList = timed(() => db.prepare("SELECT id, voucher_number, voucher_date, total_debit_minor FROM accounting_vouchers WHERE organization_id = 'org:scale' AND financial_year_id = 'fy:scale' AND status = 'posted' ORDER BY voucher_date DESC, created_at DESC LIMIT 100").all())
  const balanceSheet = timed(() => db.prepare(`SELECT account.account_type, SUM(line.debit_minor-line.credit_minor) signed_minor
    FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id = line.voucher_id
    JOIN chart_of_accounts account ON account.id = line.account_id WHERE line.organization_id = 'org:scale'
    AND voucher.financial_year_id = 'fy:scale' AND voucher.status = 'posted' AND account.account_type IN ('ASSET','LIABILITY','EQUITY') GROUP BY account.account_type`).all())

  assert.equal(Number(integrity.result.invalid), 0)
  assert.equal((trialBalance.result as unknown[]).length, 2)
  assert.ok(trialBalance.milliseconds < 1_500, `Trial balance took ${trialBalance.milliseconds.toFixed(1)}ms`)
  assert.ok(profitLoss.milliseconds < 1_500, `P&L took ${profitLoss.milliseconds.toFixed(1)}ms`)
  assert.ok(generalLedger.milliseconds < 1_500, `General ledger took ${generalLedger.milliseconds.toFixed(1)}ms`)
  assert.ok(integrity.milliseconds < 1_500, `Integrity scan took ${integrity.milliseconds.toFixed(1)}ms`)
  for (const [name, measurement] of Object.entries({ productSearch, customerSearch, invoiceList, journalList, balanceSheet })) assert.ok(measurement.milliseconds < 1_500, `${name} took ${measurement.milliseconds.toFixed(1)}ms`)
  const reopen = timed(() => { const connection = new DatabaseSync(databasePath, { readOnly: true }); connection.prepare("SELECT 1").get(); connection.close() })
  assert.ok(reopen.milliseconds < 1_500, `Database reopen took ${reopen.milliseconds.toFixed(1)}ms`)
  console.log(JSON.stringify({ dataset: { products: 2_000, customers: 5_000, invoices: 20_000, invoiceLines: 40_000, journals: 12_000, journalLines: 24_000 }, milliseconds: { databaseReopen: +reopen.milliseconds.toFixed(2), productSearch: +productSearch.milliseconds.toFixed(2), customerSearch: +customerSearch.milliseconds.toFixed(2), invoiceList: +invoiceList.milliseconds.toFixed(2), journalList: +journalList.milliseconds.toFixed(2), generalLedger: +generalLedger.milliseconds.toFixed(2), trialBalance: +trialBalance.milliseconds.toFixed(2), profitLoss: +profitLoss.milliseconds.toFixed(2), balanceSheet: +balanceSheet.milliseconds.toFixed(2), integrity: +integrity.milliseconds.toFixed(2) } }, null, 2))
} finally {
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
