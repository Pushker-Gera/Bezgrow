import assert from "node:assert/strict"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { LOCAL_DB_VERSION, localMigrations } from "../lib/offline/local/schema"

const directory = mkdtempSync(path.join(tmpdir(), "bezgrow-accounting-migration-"))
const databasePath = path.join(directory, "legacy-v17.db")
const backupPath = path.join(directory, "accounting-backup.db")
const restoredPath = path.join(directory, "accounting-restored.db")

function applyMigration(db: DatabaseSync, version: number) {
  const migration = localMigrations.find((candidate) => candidate.version === version)
  assert.ok(migration, `Migration ${version} exists`)
  db.exec("BEGIN IMMEDIATE")
  try {
    for (const statement of migration.sql) {
      try { db.exec(statement) } catch (error) {
        if (!(/^\s*ALTER\s+TABLE/i.test(statement) && /duplicate column name/i.test(String(error)))) throw error
      }
    }
    db.prepare("INSERT OR REPLACE INTO schema_migrations(version, name, applied_at) VALUES (?, ?, datetime('now'))").run(migration.version, migration.name)
    db.exec(`PRAGMA user_version=${migration.version}`)
    db.exec("COMMIT")
  } catch (error) { db.exec("ROLLBACK"); throw error }
}

function count(db: DatabaseSync, query: string) { return Number((db.prepare(query).get() as { count: number }).count) }

let db = new DatabaseSync(databasePath)
try {
  db.exec("PRAGMA foreign_keys=ON")
  for (const migration of localMigrations.filter((candidate) => candidate.version <= 17)) applyMigration(db, migration.version)
  db.prepare("INSERT INTO organizations(id, name, state, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))").run("org:migration", "Migration Business", "MH")
  db.prepare("INSERT INTO customers(id, organization_id, name, current_balance, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))").run("customer:1", "org:migration", "Legacy Customer", 1250.25)
  db.prepare("INSERT INTO products(id, organization_id, name, sku, stock, purchase_rate, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))").run("product:1", "org:migration", "Costed stock", "COST-1", 10, 80.5)
  db.prepare("INSERT INTO products(id, organization_id, name, sku, stock, purchase_rate, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, datetime('now'), datetime('now'))").run("product:2", "org:migration", "Unknown-cost stock", "MISS-1", 3)
  db.prepare("INSERT INTO financial_years(id, organization_id, label, start_date, end_date, status, is_active, created_at) VALUES (?, ?, ?, ?, ?, 'OPEN', 1, datetime('now'))").run("fy:migration", "org:migration", "FY 2026–27", "2026-04-01", "2027-03-31")
  db.exec(`
    INSERT INTO chart_of_accounts(id, organization_id, account_code, account_name, account_type, normal_balance, created_at, updated_at) VALUES
      ('legacy-a', 'org:migration', 'L-1', 'Legacy debit', 'asset', 'debit', datetime('now'), datetime('now')),
      ('legacy-b', 'org:migration', 'L-2', 'Legacy credit', 'equity', 'credit', datetime('now'), datetime('now'));
    INSERT INTO accounting_vouchers(id, organization_id, voucher_number, voucher_type, voucher_date, total_debit, total_credit, status, created_at, updated_at)
      VALUES ('legacy-voucher', 'org:migration', 'OLD-1', 'journal', '2026-08-01', 1, 1, 'posted', datetime('now'), datetime('now'));
    INSERT INTO accounting_voucher_entries(id, organization_id, voucher_id, account_id, account_type, line_no, debit, credit, created_at, updated_at) VALUES
      ('legacy-line-1', 'org:migration', 'legacy-voucher', 'legacy-a', 'asset', 1, 1, 0, datetime('now'), datetime('now')),
      ('legacy-line-2', 'org:migration', 'legacy-voucher', 'legacy-b', 'equity', 2, 0, 1, datetime('now'), datetime('now'));
  `)
  applyMigration(db, 18)
  applyMigration(db, 19)

  assert.equal(Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), LOCAL_DB_VERSION)
  assert.equal(count(db, "SELECT COUNT(*) count FROM chart_of_accounts WHERE organization_id = 'org:migration' AND system_role IS NOT NULL"), 32)
  assert.equal(count(db, "SELECT COUNT(*) count FROM accounting_settings WHERE organization_id = 'org:migration' AND initialization_status = 'PENDING'"), 1)
  assert.equal(String((db.prepare("SELECT status FROM accounting_vouchers WHERE id = 'legacy-voucher'").get() as { status: string }).status), "legacy")
  assert.equal(count(db, "SELECT COUNT(*) count FROM pragma_foreign_key_check"), 0)
  assert.equal(String((db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check), "ok")

  const migrationSnapshot = {
    accounts: count(db, "SELECT COUNT(*) count FROM chart_of_accounts WHERE organization_id = 'org:migration'"),
    systemAccounts: count(db, "SELECT COUNT(*) count FROM chart_of_accounts WHERE organization_id = 'org:migration' AND system_role IS NOT NULL"),
    settings: count(db, "SELECT COUNT(*) count FROM accounting_settings WHERE organization_id = 'org:migration'"),
    financialYears: count(db, "SELECT COUNT(*) count FROM financial_years WHERE organization_id = 'org:migration'"),
    invoices: count(db, "SELECT COUNT(*) count FROM sales_invoices WHERE organization_id = 'org:migration'"),
    movements: count(db, "SELECT COUNT(*) count FROM stock_movements WHERE organization_id = 'org:migration'"),
  }
  db.close()
  db = new DatabaseSync(databasePath)
  db.exec("PRAGMA foreign_keys=ON")
  const currentVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)
  for (const migration of localMigrations.filter((candidate) => candidate.version > currentVersion)) applyMigration(db, migration.version)
  assert.deepEqual({
    accounts: count(db, "SELECT COUNT(*) count FROM chart_of_accounts WHERE organization_id = 'org:migration'"),
    systemAccounts: count(db, "SELECT COUNT(*) count FROM chart_of_accounts WHERE organization_id = 'org:migration' AND system_role IS NOT NULL"),
    settings: count(db, "SELECT COUNT(*) count FROM accounting_settings WHERE organization_id = 'org:migration'"),
    financialYears: count(db, "SELECT COUNT(*) count FROM financial_years WHERE organization_id = 'org:migration'"),
    invoices: count(db, "SELECT COUNT(*) count FROM sales_invoices WHERE organization_id = 'org:migration'"),
    movements: count(db, "SELECT COUNT(*) count FROM stock_movements WHERE organization_id = 'org:migration'"),
  }, migrationSnapshot, "Reopening an already-upgraded 0.3.0 database must not duplicate accounting or ERP state.")

  const insertVoucher = db.prepare(`INSERT INTO accounting_vouchers (
    id, organization_id, voucher_number, voucher_type, voucher_date, total_debit, total_credit,
    status, financial_year_id, source_type, source_id, total_debit_minor, total_credit_minor, created_at, updated_at
  ) VALUES (?, 'org:migration', ?, 'journal', '2026-09-03', 1, 1, 'draft', 'fy:migration', ?, ?, 100, 100, datetime('now'), datetime('now'))`)
  insertVoucher.run("voucher:1", "JV-00001", "MANUAL_JOURNAL", "source:1")
  const cash = String((db.prepare("SELECT id FROM chart_of_accounts WHERE organization_id = 'org:migration' AND system_role = 'CASH'").get() as { id: string }).id)
  const sales = String((db.prepare("SELECT id FROM chart_of_accounts WHERE organization_id = 'org:migration' AND system_role = 'SALES'").get() as { id: string }).id)
  const insertLine = db.prepare("INSERT INTO accounting_voucher_entries(id, organization_id, voucher_id, account_id, account_type, line_no, debit, credit, debit_minor, credit_minor, created_at, updated_at) VALUES (?, 'org:migration', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))")
  insertLine.run("line:1", "voucher:1", cash, "ASSET", 1, 1, 0, 100, 0)
  insertLine.run("line:2", "voucher:1", sales, "INCOME", 2, 0, 1, 0, 100)
  db.exec("UPDATE accounting_vouchers SET status = 'posted' WHERE id = 'voucher:1'")
  assert.throws(() => db.exec("UPDATE accounting_vouchers SET narration = 'tampered' WHERE id = 'voucher:1'"), /posted_journal_is_immutable/)
  assert.throws(() => db.exec("UPDATE accounting_voucher_entries SET debit_minor = 99 WHERE id = 'line:1'"), /posted_journal_is_immutable/)
  assert.throws(() => db.exec("DELETE FROM accounting_vouchers WHERE id = 'voucher:1'"), /posted_journal_is_immutable/)
  assert.throws(() => insertVoucher.run("voucher:duplicate", "JV-00002", "MANUAL_JOURNAL", "source:1"), /UNIQUE constraint/)
  db.prepare(`INSERT INTO accounting_vouchers (
    id, organization_id, voucher_number, voucher_type, voucher_date, total_debit, total_credit,
    status, financial_year_id, source_type, source_id, total_debit_minor, total_credit_minor, created_at, updated_at
  ) VALUES ('voucher:bad', 'org:migration', 'JV-00003', 'journal', '2026-09-03', 1, 0.99, 'draft', 'fy:migration', 'MANUAL_JOURNAL', 'source:bad', 100, 99, datetime('now'), datetime('now'))`).run()
  assert.equal(count(db, "SELECT COUNT(*) count FROM accounting_vouchers WHERE id = 'voucher:bad' AND status = 'draft'"), 1)
  assert.throws(() => insertLine.run("bad:real", "voucher:bad", cash, "ASSET", 1, 0.005, 0, 0.5, 0), /journal_line_minor_units_must_be_integer/)
  insertLine.run("bad:1", "voucher:bad", cash, "ASSET", 1, 1, 0, 100, 0)
  insertLine.run("bad:2", "voucher:bad", sales, "INCOME", 2, 0, 0.99, 0, 99)
  assert.throws(() => db.exec("UPDATE accounting_vouchers SET total_credit_minor = 99, status = 'posted' WHERE id = 'voucher:bad'"), /journal_entry_not_balanced/)
  db.exec("DELETE FROM accounting_voucher_entries WHERE voucher_id = 'voucher:bad'; DELETE FROM accounting_vouchers WHERE id = 'voucher:bad'")

  copyFileSync(databasePath, backupPath)
  copyFileSync(backupPath, restoredPath)
  db.close()
  db = new DatabaseSync(restoredPath, { readOnly: true })
  assert.equal(count(db, "SELECT COUNT(*) count FROM accounting_vouchers WHERE status = 'posted'"), 1)
  assert.equal(count(db, "SELECT COUNT(*) count FROM accounting_voucher_entries"), 4)
  assert.equal(count(db, "SELECT COUNT(*) count FROM pragma_foreign_key_check"), 0)
  assert.equal(String((db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check), "ok")
  console.log(JSON.stringify({ status: "ok", upgradedFromRelease: "0.2.5", upgradedFromSchema: 17, schemaVersion: LOCAL_DB_VERSION, defaultAccounts: 32, migrationIdempotency: true, immutablePosting: true, sourceIdempotency: true, backupRestore: "ok" }))
} finally {
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
