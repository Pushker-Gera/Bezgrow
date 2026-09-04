import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { localMigrations } from "../lib/offline/local/schema"

const directory = mkdtempSync(path.join(tmpdir(), "bezgrow-accounting-reconciliation-"))
const db = new DatabaseSync(path.join(directory, "reconciliation.db"))

function apply(version: number) {
  const migration = localMigrations.find((candidate) => candidate.version === version)!
  db.exec("BEGIN IMMEDIATE")
  try {
    for (const statement of migration.sql) {
      try { db.exec(statement) } catch (error) {
        if (!(/^\s*ALTER\s+TABLE/i.test(statement) && /duplicate column name/i.test(String(error)))) throw error
      }
    }
    db.prepare("INSERT OR REPLACE INTO schema_migrations(version,name,applied_at) VALUES (?,?,datetime('now'))").run(version, migration.name)
    db.exec(`PRAGMA user_version=${version}; COMMIT`)
  } catch (error) { db.exec("ROLLBACK"); throw error }
}

type Line = { role: string; debit: number; credit: number; customerId?: string }
function post(id: string, sourceType: string, sourceId: string, lines: Line[]) {
  const debit = lines.reduce((sum, line) => sum + line.debit, 0)
  const credit = lines.reduce((sum, line) => sum + line.credit, 0)
  assert.equal(debit, credit)
  db.prepare(`INSERT INTO accounting_vouchers(id,organization_id,voucher_number,voucher_type,voucher_date,total_debit,total_credit,status,financial_year_id,source_type,source_id,total_debit_minor,total_credit_minor,created_at,updated_at)
    VALUES (?,'org:reconcile',?,'journal','2026-09-03',?,?,'draft','fy:reconcile',?,?,?, ?,datetime('now'),datetime('now'))`).run(id, id, debit / 100, credit / 100, sourceType, sourceId, debit, credit)
  const insert = db.prepare(`INSERT INTO accounting_voucher_entries(id,organization_id,voucher_id,account_id,account_type,line_no,debit,credit,debit_minor,credit_minor,customer_id,party_type,party_id,created_at,updated_at)
    SELECT ?, 'org:reconcile', ?, account.id, account.account_type, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now') FROM chart_of_accounts account WHERE account.organization_id='org:reconcile' AND account.system_role=?`)
  lines.forEach((line, index) => insert.run(`${id}:${index + 1}`, id, index + 1, line.debit / 100, line.credit / 100, line.debit, line.credit, line.customerId || null, line.customerId ? "customer" : null, line.customerId || null, line.role))
  db.prepare("UPDATE accounting_vouchers SET status='posted',finalized_at=datetime('now') WHERE id=?").run(id)
}

function scalar(query: string) { return Number(Object.values(db.prepare(query).get() as Record<string, number>)[0] || 0) }

try {
  db.exec("PRAGMA foreign_keys=ON")
  for (const migration of localMigrations.filter((candidate) => candidate.version <= 17)) apply(migration.version)
  db.exec("INSERT INTO organizations(id,name,created_at,updated_at) VALUES ('org:reconcile','Reconcile Business',datetime('now'),datetime('now'))")
  db.exec("INSERT INTO financial_years(id,organization_id,label,start_date,end_date,status,is_active,created_at) VALUES ('fy:reconcile','org:reconcile','FY 2026–27','2026-04-01','2027-03-31','OPEN',1,datetime('now'))")
  apply(18)
  apply(19)
  db.exec("INSERT INTO customers(id,organization_id,name,current_balance,created_at,updated_at) VALUES ('customer:1','org:reconcile','Customer',0,datetime('now'),datetime('now'))")
  db.exec("INSERT INTO products(id,organization_id,name,sku,stock,purchase_rate,created_at,updated_at) VALUES ('product:1','org:reconcile','Product','P-1',8,5,datetime('now'),datetime('now'))")
  db.exec("INSERT INTO sales_invoices(id,organization_id,customer_id,invoice_number,invoice_date,subtotal,taxable_amount,tax_amount,grand_total,total_amount,total,paid_amount,outstanding_amount,payment_status,status,financial_year_id,created_at,updated_at) VALUES ('invoice:1','org:reconcile','customer:1','INV-1','2026-09-03',10,10,1.8,11.8,11.8,11.8,11.8,0,'paid','paid','fy:reconcile',datetime('now'),datetime('now'))")
  db.exec("INSERT INTO expenses(id,organization_id,description,amount,expense_date,payment_status,paid_amount,outstanding_amount,financial_year_id,amount_minor,created_at,updated_at) VALUES ('expense:1','org:reconcile','Rent',1,'2026-09-03','paid',1,0,'fy:reconcile',100,datetime('now'),datetime('now'))")

  post("opening:1", "ACCOUNTING_ACTIVATION", "org:reconcile", [{ role: "INVENTORY", debit: 5000, credit: 0 }, { role: "OPENING_EQUITY", debit: 0, credit: 5000 }])
  post("sale:1", "SALES_INVOICE", "invoice:1", [
    { role: "ACCOUNTS_RECEIVABLE", debit: 1180, credit: 0, customerId: "customer:1" },
    { role: "COGS", debit: 1000, credit: 0 }, { role: "SALES", debit: 0, credit: 1000 },
    { role: "OUTPUT_CGST", debit: 0, credit: 90 }, { role: "OUTPUT_SGST", debit: 0, credit: 90 }, { role: "INVENTORY", debit: 0, credit: 1000 },
  ])
  post("receipt:1", "PAYMENT", "payment:1", [{ role: "CASH", debit: 1180, credit: 0 }, { role: "ACCOUNTS_RECEIVABLE", debit: 0, credit: 1180, customerId: "customer:1" }])
  post("expense:1", "EXPENSE", "expense:1", [{ role: "RENT_EXPENSE", debit: 100, credit: 0 }, { role: "CASH", debit: 0, credit: 100 }])

  const arLedger = scalar("SELECT SUM(line.debit_minor-line.credit_minor) FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN chart_of_accounts account ON account.id=line.account_id WHERE voucher.status='posted' AND account.system_role='ACCOUNTS_RECEIVABLE'")
  const customerOutstanding = scalar("SELECT ROUND(SUM(current_balance)*100) FROM customers WHERE organization_id='org:reconcile' AND deleted_at IS NULL")
  assert.equal(arLedger, customerOutstanding)
  assert.equal(scalar("SELECT SUM(line.debit_minor-line.credit_minor) FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN chart_of_accounts account ON account.id=line.account_id WHERE voucher.status='posted' AND account.system_role='INVENTORY'"), scalar("SELECT ROUND(SUM(stock*purchase_rate)*100) FROM products WHERE organization_id='org:reconcile'"))
  assert.equal(scalar("SELECT SUM(line.debit_minor-line.credit_minor) FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN chart_of_accounts account ON account.id=line.account_id WHERE voucher.status='posted' AND account.system_role='CASH'"), 1080)
  assert.equal(scalar("SELECT SUM(line.credit_minor-line.debit_minor) FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN chart_of_accounts account ON account.id=line.account_id WHERE voucher.status='posted' AND account.system_role='SALES'"), 1000)
  assert.equal(scalar("SELECT SUM(line.credit_minor-line.debit_minor) FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN chart_of_accounts account ON account.id=line.account_id WHERE voucher.status='posted' AND account.system_role IN ('OUTPUT_CGST','OUTPUT_SGST','OUTPUT_IGST')"), 180)
  assert.equal(scalar("SELECT SUM(line.debit_minor) FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id WHERE voucher.source_type='SALES_INVOICE' AND voucher.source_id='invoice:1' AND line.account_id IN (SELECT id FROM chart_of_accounts WHERE system_role IN ('CASH','BANK','ACCOUNTS_RECEIVABLE'))"), 1180)
  assert.equal(scalar("SELECT SUM(line.debit_minor)-SUM(line.credit_minor) FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id WHERE voucher.status='posted'"), 0)

  const assets = scalar("SELECT SUM(line.debit_minor-line.credit_minor) FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN chart_of_accounts account ON account.id=line.account_id WHERE voucher.status='posted' AND account.account_type='ASSET'")
  const liabilities = -scalar("SELECT SUM(line.debit_minor-line.credit_minor) FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN chart_of_accounts account ON account.id=line.account_id WHERE voucher.status='posted' AND account.account_type='LIABILITY'")
  const equity = -scalar("SELECT SUM(line.debit_minor-line.credit_minor) FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN chart_of_accounts account ON account.id=line.account_id WHERE voucher.status='posted' AND account.account_type='EQUITY'")
  const profit = scalar("SELECT SUM(CASE WHEN account.account_type='INCOME' THEN line.credit_minor-line.debit_minor WHEN account.account_type='EXPENSE' THEN line.credit_minor-line.debit_minor ELSE 0 END) FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN chart_of_accounts account ON account.id=line.account_id WHERE voucher.status='posted'")
  assert.equal(assets, liabilities + equity + profit)
  assert.equal(assets, 5080)
  assert.equal(profit, -100)
  assert.equal(0 + 1180 - 100, 1080)

  db.exec("UPDATE financial_years SET status='CLOSED',is_active=0 WHERE id='fy:reconcile'")
  assert.throws(() => db.exec("INSERT INTO accounting_vouchers(id,organization_id,voucher_number,voucher_type,voucher_date,status,financial_year_id,source_type,source_id,created_at,updated_at) VALUES ('closed:1','org:reconcile','JV-CLOSED','journal','2026-09-03','draft','fy:reconcile','MANUAL_JOURNAL','closed:1',datetime('now'),datetime('now'))"), /financial_year_closed/)
  assert.equal(scalar("SELECT COUNT(*) FROM pragma_foreign_key_check"), 0)
  assert.equal(String(Object.values(db.prepare("PRAGMA quick_check").get() as Record<string, string>)[0]), "ok")
  console.log(JSON.stringify({ status: "ok", receivables: arLedger, inventoryAtCost: 4000, cash: 1080, sales: 1000, outputGst: 180, netProfit: profit, balanceSheet: { assets, liabilities, equityIncludingResult: equity + profit }, closedYearRejected: true }))
} finally {
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
