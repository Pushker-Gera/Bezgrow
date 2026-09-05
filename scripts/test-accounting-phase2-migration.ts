import assert from "node:assert/strict"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { LOCAL_DB_VERSION, localMigrations } from "../lib/offline/local/schema"

const directory = mkdtempSync(path.join(tmpdir(), "bezgrow-accounting-phase2-"))
const databasePath = path.join(directory, "phase2.db")
const restoredPath = path.join(directory, "phase2-restored.db")
let db = new DatabaseSync(databasePath)

function apply(version: number) {
  const migration = localMigrations.find((candidate) => candidate.version === version)
  assert.ok(migration)
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

function scalar(query: string, ...values: Array<string | number | null>) {
  return Number(Object.values(db.prepare(query).get(...values) as Record<string, unknown>)[0] || 0)
}

function postVoucher(id: string, sourceType: string, sourceId: string, amountMinor: number) {
  const cash = asId("CASH")
  const payable = asId("ACCOUNTS_PAYABLE")
  db.prepare(`INSERT INTO accounting_vouchers (id,organization_id,voucher_number,voucher_type,voucher_date,total_debit,total_credit,status,financial_year_id,source_type,source_id,total_debit_minor,total_credit_minor,created_at,updated_at)
    VALUES (?,'org:phase2',?,'purchase','2026-09-05',?,?,'draft','fy:phase2',?,?,?, ?,datetime('now'),datetime('now'))`).run(id, id, amountMinor / 100, amountMinor / 100, sourceType, sourceId, amountMinor, amountMinor)
  db.prepare(`INSERT INTO accounting_voucher_entries (id,organization_id,voucher_id,account_id,account_type,line_no,debit,credit,debit_minor,credit_minor,created_at,updated_at) VALUES
    (?,'org:phase2',?,?,'ASSET',1,?,0,?,0,datetime('now'),datetime('now'))`).run(`${id}:1`, id, cash, amountMinor / 100, amountMinor)
  db.prepare(`INSERT INTO accounting_voucher_entries (id,organization_id,voucher_id,account_id,account_type,line_no,debit,credit,debit_minor,credit_minor,party_type,party_id,supplier_id,created_at,updated_at) VALUES
    (?,'org:phase2',?,?,'LIABILITY',2,0,?,0,?,'supplier','supplier:1','supplier:1',datetime('now'),datetime('now'))`).run(`${id}:2`, id, payable, amountMinor / 100, amountMinor)
  db.prepare("UPDATE accounting_vouchers SET status='posted',finalized_at=datetime('now') WHERE id=?").run(id)
}

function asId(role: string) {
  return String((db.prepare("SELECT id FROM chart_of_accounts WHERE organization_id='org:phase2' AND system_role=?").get(role) as { id: string }).id)
}

try {
  db.exec("PRAGMA foreign_keys=ON")
  for (const migration of localMigrations.filter((candidate) => candidate.version <= 17)) apply(migration.version)
  db.exec("INSERT INTO organizations(id,name,state,created_at,updated_at) VALUES ('org:phase2','Phase 2 Business','MH',datetime('now'),datetime('now'))")
  db.exec("INSERT INTO financial_years(id,organization_id,label,start_date,end_date,status,is_active,created_at) VALUES ('fy:phase2','org:phase2','FY 2026–27','2026-04-01','2027-03-31','OPEN',1,datetime('now'))")
  for (const migration of localMigrations.filter((candidate) => candidate.version > 17)) apply(migration.version)
  assert.equal(scalar("PRAGMA user_version"), LOCAL_DB_VERSION)
  for (const table of ["payment_allocations", "party_advances", "advance_allocations", "bank_reconciliations", "accounting_period_locks", "gst_transaction_classifications", "purchase_attachments"]) assert.equal(scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", table), 1, `${table} must exist`)
  for (const role of ["SUPPLIER_ADVANCES", "CUSTOMER_ADVANCES", "INPUT_CESS", "OUTPUT_CESS", "PURCHASES"]) assert.equal(scalar("SELECT COUNT(*) FROM chart_of_accounts WHERE organization_id='org:phase2' AND system_role=?", role), 1)

  db.exec(`INSERT INTO suppliers(id,organization_id,name,gstin,current_balance,created_at,updated_at) VALUES
    ('supplier:1','org:phase2','Supplier One','27AAPFU0939F1ZV',0,datetime('now'),datetime('now')),
    ('supplier:2','org:phase2','Supplier Two',NULL,0,datetime('now'),datetime('now'))`)
  db.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON")
  db.prepare(`INSERT INTO purchase_invoices (id,organization_id,supplier_id,supplier_name,invoice_kind,bill_number,bill_date,subtotal,taxable_amount,tax_total,grand_total,outstanding_amount,status,financial_year_id,supplier_invoice_number,purchase_date,gross_minor,taxable_minor,cgst_minor,sgst_minor,grand_total_minor,outstanding_minor,accounting_voucher_id,document_status,idempotency_key,created_at,updated_at)
    VALUES ('purchase:1','org:phase2','supplier:1','Supplier One','purchase_invoice','PUR-000001','2026-09-05',118,100,18,118,118,'unpaid','fy:phase2','DUP-100','2026-09-05',10000,10000,900,900,11800,11800,'voucher:purchase','DRAFT','purchase-key-1',datetime('now'),datetime('now'))`).run()
  db.prepare(`INSERT INTO purchase_invoice_items (id,organization_id,purchase_invoice_id,product_name,quantity,unit_cost,tax_percent,tax_amount,line_total,purchase_classification,unit_cost_minor,gross_minor,taxable_minor,gst_rate_basis_points,cgst_minor,sgst_minor,line_total_minor,created_at,updated_at)
    VALUES ('purchase-item:1','org:phase2','purchase:1','Office service',1,100,18,18,118,'EXPENSE',10000,10000,10000,1800,900,900,11800,datetime('now'),datetime('now'))`).run()
  postVoucher("voucher:purchase", "PURCHASE_INVOICE", "purchase:1", 11800)
  db.exec("UPDATE purchase_invoices SET document_status='POSTED' WHERE id='purchase:1'; COMMIT")
  assert.throws(() => db.exec("UPDATE purchase_invoices SET taxable_minor=1 WHERE id='purchase:1'"), /posted_purchase_is_immutable/)
  assert.throws(() => db.exec("UPDATE purchase_invoice_items SET quantity=2 WHERE id='purchase-item:1'"), /posted_purchase_is_immutable/)
  assert.throws(() => db.exec("DELETE FROM purchase_invoice_items WHERE id='purchase-item:1'"), /posted_purchase_is_immutable/)
  assert.throws(() => db.exec(`INSERT INTO purchase_invoices(id,organization_id,supplier_id,invoice_kind,bill_number,bill_date,financial_year_id,supplier_invoice_number,purchase_date,document_status,created_at,updated_at) VALUES ('purchase:duplicate','org:phase2','supplier:1','purchase_invoice','PUR-000002','2026-09-05','fy:phase2','dup-100','2026-09-05','DRAFT',datetime('now'),datetime('now'))`), /UNIQUE constraint/)
  db.exec(`INSERT INTO purchase_invoices(id,organization_id,supplier_id,invoice_kind,bill_number,bill_date,financial_year_id,supplier_invoice_number,purchase_date,document_status,created_at,updated_at) VALUES ('purchase:other-supplier','org:phase2','supplier:2','purchase_invoice','PUR-000003','2026-09-05','fy:phase2','DUP-100','2026-09-05','DRAFT',datetime('now'),datetime('now'))`)

  postVoucher("voucher:payment", "SUPPLIER_PAYMENT", "payment:1", 15000)
  db.exec(`INSERT INTO payments(id,organization_id,party_type,party_id,amount,amount_minor,direction,payment_date,financial_year_id,accounting_voucher_id,payment_account_id,unallocated_minor,created_at,updated_at)
    VALUES ('payment:1','org:phase2','supplier','supplier:1',150,15000,'out','2026-09-05','fy:phase2','voucher:payment','${asId("CASH")}',3200,datetime('now'),datetime('now'))`)
  db.exec("INSERT INTO payment_allocations(id,organization_id,financial_year_id,payment_id,party_type,party_id,document_type,document_id,allocation_minor,allocated_at) VALUES ('allocation:1','org:phase2','fy:phase2','payment:1','supplier','supplier:1','purchase_invoice','purchase:1',11800,datetime('now'))")
  db.exec("INSERT INTO party_advances(id,organization_id,financial_year_id,party_type,party_id,payment_id,source_type,source_id,advance_minor,applied_minor,status,created_at,updated_at) VALUES ('advance:1','org:phase2','fy:phase2','supplier','supplier:1','payment:1','SUPPLIER_PAYMENT','payment:1',3200,0,'OPEN',datetime('now'),datetime('now'))")
  db.exec(`INSERT INTO payments(id,organization_id,party_type,party_id,amount,amount_minor,direction,payment_date,financial_year_id,accounting_voucher_id,payment_account_id,unallocated_minor,created_at,updated_at)
    VALUES ('payment:opening','org:phase2','supplier','supplier:1',1,100,'out','2026-09-05','fy:phase2','voucher:payment','${asId("CASH")}',0,datetime('now'),datetime('now'))`)
  db.exec("INSERT INTO payment_allocations(id,organization_id,financial_year_id,payment_id,party_type,party_id,document_type,document_id,allocation_minor,allocated_at) VALUES ('allocation:opening','org:phase2','fy:phase2','payment:opening','supplier','supplier:1','supplier_opening','voucher:purchase:2',100,datetime('now'))")
  db.exec("INSERT INTO advance_allocations(id,organization_id,financial_year_id,advance_id,document_type,document_id,allocation_minor,accounting_voucher_id,created_at) VALUES ('advance-allocation:opening','org:phase2','fy:phase2','advance:1','supplier_opening','voucher:purchase:2',100,'voucher:payment',datetime('now'))")
  assert.throws(() => db.exec("INSERT INTO payment_allocations(id,organization_id,financial_year_id,payment_id,party_type,party_id,document_type,document_id,allocation_minor,allocated_at) VALUES ('allocation:bad','org:phase2','fy:phase2','payment:1','supplier','supplier:1','purchase_invoice','purchase:1',1,datetime('now'))"), /UNIQUE constraint/)
  assert.throws(() => db.exec("UPDATE party_advances SET applied_minor=3300 WHERE id='advance:1'"), /CHECK constraint/)

  db.exec("INSERT INTO accounting_period_locks(id,organization_id,locked_through,reason,created_at,updated_at) VALUES ('lock:1','org:phase2','2026-09-30','Month closed',datetime('now'),datetime('now'))")
  assert.throws(() => db.exec(`INSERT INTO accounting_vouchers(id,organization_id,voucher_number,voucher_type,voucher_date,status,financial_year_id,source_type,source_id,created_at,updated_at) VALUES ('locked:voucher','org:phase2','LOCKED-1','journal','2026-09-20','draft','fy:phase2','MANUAL_JOURNAL','locked:1',datetime('now'),datetime('now'))`), /accounting_period_locked/)
  db.exec("UPDATE accounting_period_locks SET unlocked_at=datetime('now'),unlock_reason='Reviewed correction' WHERE id='lock:1'")
  db.exec(`INSERT INTO accounting_vouchers(id,organization_id,voucher_number,voucher_type,voucher_date,status,financial_year_id,source_type,source_id,created_at,updated_at) VALUES ('unlocked:voucher','org:phase2','UNLOCKED-1','journal','2026-09-20','draft','fy:phase2','MANUAL_JOURNAL','unlocked:1',datetime('now'),datetime('now'))`)

  assert.equal(scalar("SELECT COUNT(*) FROM pragma_foreign_key_check"), 0)
  assert.equal(String(Object.values(db.prepare("PRAGMA quick_check").get() as Record<string, string>)[0]), "ok")
  copyFileSync(databasePath, restoredPath)
  db.close()
  db = new DatabaseSync(restoredPath, { readOnly: true })
  assert.equal(scalar("SELECT COUNT(*) FROM purchase_invoices WHERE document_status='POSTED'"), 1)
  assert.equal(scalar("SELECT COUNT(*) FROM payment_allocations"), 2)
  assert.equal(scalar("SELECT COUNT(*) FROM party_advances WHERE status='OPEN'"), 1)
  assert.equal(scalar("SELECT COUNT(*) FROM advance_allocations WHERE document_type='supplier_opening'"), 1)
  assert.equal(scalar("SELECT COUNT(*) FROM pragma_foreign_key_check"), 0)
  console.log(JSON.stringify({ status: "ok", schemaVersion: LOCAL_DB_VERSION, duplicateSupplierInvoiceRejected: true, crossSupplierInvoiceAllowed: true, postedPurchaseImmutable: true, paymentAllocation: true, advanceConstraint: true, periodLock: true, backupRestore: true }))
} finally {
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
