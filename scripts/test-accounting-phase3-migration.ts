import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { LOCAL_DB_VERSION, localMigrations } from "../lib/offline/local/schema"

const directory = mkdtempSync(path.join(tmpdir(), "bezgrow-phase3-migration-"))
const productionPath = path.join(directory, "production-schema-21.db")
const upgradeCopyPath = path.join(directory, "phase3-upgrade-copy.db")
const restorePath = path.join(directory, "phase3-restored.db")

function apply(db: DatabaseSync, version: number) {
  const migration = localMigrations.find((candidate) => candidate.version === version)
  assert.ok(migration, `Migration ${version} must exist.`)
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

function scalar(db: DatabaseSync, query: string, ...values: Array<string | number | null>) {
  return Number(Object.values(db.prepare(query).get(...values) as Record<string, unknown>)[0] || 0)
}

function preservedSnapshot(db: DatabaseSync) {
  const queries: Record<string, string> = {
    organizations: "SELECT id,name,state,gst_number,currency,timezone FROM organizations ORDER BY id",
    customers: "SELECT id,organization_id,name,current_balance FROM customers ORDER BY id",
    products: "SELECT id,organization_id,name,sku,stock,purchase_rate FROM products ORDER BY id",
    sales_invoices: "SELECT id,organization_id,invoice_number,grand_total FROM sales_invoices ORDER BY id",
    stock_movements: "SELECT id,organization_id,product_id,quantity FROM stock_movements ORDER BY id",
    business_settings: "SELECT id,organization_id,key,value_text,value_number,value_boolean FROM business_settings ORDER BY id",
    license_state: "SELECT id,organization_id,license_key,device_id,status FROM license_state ORDER BY id",
    device_activations: "SELECT id,organization_id,license_id,device_id,device_name,is_active FROM device_activations ORDER BY id",
    financial_years: "SELECT id,organization_id,label,start_date,end_date,status,is_active FROM financial_years ORDER BY id",
    accounting_vouchers: "SELECT id,organization_id,voucher_number,total_debit_minor,total_credit_minor,status FROM accounting_vouchers ORDER BY id",
    accounting_voucher_entries: "SELECT id,organization_id,voucher_id,account_id,debit_minor,credit_minor FROM accounting_voucher_entries ORDER BY id",
    purchase_invoices: "SELECT id,organization_id,bill_number,grand_total_minor FROM purchase_invoices ORDER BY id",
    suppliers: "SELECT id,organization_id,name,current_balance FROM suppliers ORDER BY id",
    bank_accounts: "SELECT id,organization_id,display_name,account_id FROM bank_accounts ORDER BY id",
    gst_transaction_classifications: "SELECT id,organization_id,source_type,source_id FROM gst_transaction_classifications ORDER BY id",
  }
  const tables = Object.keys(queries)
  const data = Object.fromEntries(tables.map((table) => [table, db.prepare(queries[table]).all()]))
  return { counts: Object.fromEntries(tables.map((table) => [table, (data[table] as unknown[]).length])), checksum: createHash("sha256").update(JSON.stringify(data)).digest("hex") }
}

const source = new DatabaseSync(productionPath)
let upgraded: DatabaseSync | null = null
try {
  source.exec("PRAGMA foreign_keys=ON")
  for (const migration of localMigrations.filter((candidate) => candidate.version <= 17)) apply(source, migration.version)
  source.exec(`
    INSERT INTO organizations(id,name,state,gst_number,created_at,updated_at) VALUES ('org:phase3-migration','Preserved Business','MH','27AAPFU0939F1ZV',datetime('now'),datetime('now'));
    INSERT INTO customers(id,organization_id,name,current_balance,created_at,updated_at) VALUES ('customer:preserved','org:phase3-migration','Preserved Customer',125.50,datetime('now'),datetime('now'));
    INSERT INTO products(id,organization_id,name,sku,stock,purchase_rate,created_at,updated_at) VALUES ('product:preserved','org:phase3-migration','Preserved Product','KEEP-1',12,25.75,datetime('now'),datetime('now'));
    INSERT INTO business_settings(id,organization_id,key,value_text) VALUES ('setting:preserved','org:phase3-migration','invoice_note','keep exactly');
    INSERT INTO financial_years(id,organization_id,label,start_date,end_date,start_month,status,is_active,created_at) VALUES ('fy:org:phase3-migration:2026:4','org:phase3-migration','FY 2026-27','2026-04-01','2027-03-31',4,'OPEN',1,datetime('now'));
    INSERT INTO license_state(id,organization_id,license_key,device_id,status,created_at,updated_at) VALUES ('license:preserved','org:phase3-migration','TEST-NONSECRET-LICENSE','device:preserved','active',datetime('now'),datetime('now'));
    INSERT INTO device_activations(id,organization_id,license_id,device_id,device_name,created_at,updated_at) VALUES ('activation:preserved','org:phase3-migration','license:preserved','device:preserved','Migration fixture',datetime('now'),datetime('now'));
  `)
  for (const migration of localMigrations.filter((candidate) => candidate.version > 17 && candidate.version <= 21)) apply(source, migration.version)
  assert.equal(scalar(source, "PRAGMA user_version"), 21)
  // Keep one deliberately customized initialization row to prove the repair
  // never replaces existing business policy or initialization state.
  source.exec(`
    INSERT INTO organizations(id,name,state,created_at,updated_at) VALUES ('org:settings-preserved','Settings Preserved','KA',datetime('now'),datetime('now'));
    INSERT INTO accounting_settings(
      organization_id,accounting_version,activation_date,opening_date,historical_policy,
      initialization_status,warning_count,initialized_at,created_at,updated_at
    ) VALUES (
      'org:settings-preserved',2,'2025-04-01','2025-04-01','CONTROLLED_OPENING',
      'INITIALIZED',7,'2025-04-02 10:00:00','2025-04-01 09:00:00','2025-04-02 10:00:00'
    );
  `)
  // Reproduce an installed legacy business whose runtime-created chart only had
  // the original five foundational ledgers and no initialization record.
  // The accounting migration must repair both before any accounting screen is opened.
  source.exec(`UPDATE chart_of_accounts SET is_system=0
    WHERE organization_id='org:phase3-migration'
      AND system_role NOT IN ('CASH','BANK','ACCOUNTS_RECEIVABLE','INVENTORY','ACCOUNTS_PAYABLE');
    DELETE FROM chart_of_accounts
    WHERE organization_id='org:phase3-migration'
      AND system_role NOT IN ('CASH','BANK','ACCOUNTS_RECEIVABLE','INVENTORY','ACCOUNTS_PAYABLE');
    DELETE FROM accounting_settings WHERE organization_id='org:phase3-migration'`)
  assert.equal(scalar(source, "SELECT COUNT(*) FROM chart_of_accounts WHERE organization_id='org:phase3-migration' AND system_role IS NOT NULL"), 5)
  assert.equal(scalar(source, "SELECT COUNT(*) FROM accounting_settings WHERE organization_id='org:phase3-migration'"), 0)
  const before = preservedSnapshot(source)
  source.close()

  copyFileSync(productionPath, upgradeCopyPath)
  upgraded = new DatabaseSync(upgradeCopyPath)
  upgraded.exec("PRAGMA foreign_keys=ON")
  for (const migration of localMigrations.filter((candidate) => candidate.version > 21)) apply(upgraded, migration.version)
  assert.equal(scalar(upgraded, "PRAGMA user_version"), LOCAL_DB_VERSION)
  assert.deepEqual(preservedSnapshot(upgraded), before, "Phase 3 migration must preserve every representative Phase 1/2 and control-plane row byte-for-byte.")

  const phaseThreeTables = ["accounting_voucher_series", "accounting_dimensions", "accounting_dimension_allocations", "accounting_budgets", "fixed_asset_categories", "fixed_assets", "fixed_asset_depreciation", "fixed_asset_disposals", "tax_rules", "tax_transactions", "gst_return_periods", "gst_import_batches", "gst_import_records", "gst_reconciliations", "statutory_integrations", "e_invoice_preparations", "e_way_bill_preparations", "bank_statement_imports", "bank_statement_lines", "bank_statement_matches", "accounting_audit_events"]
  for (const table of phaseThreeTables) assert.equal(scalar(upgraded, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", table), 1, `${table} must exist after upgrading schema 21 to the current version.`)
  assert.equal(scalar(upgraded, "SELECT COUNT(*) FROM chart_of_accounts WHERE organization_id='org:phase3-migration' AND system_role IS NOT NULL"), 43)
  assert.equal(scalar(upgraded, "SELECT COUNT(*) FROM accounting_settings WHERE organization_id='org:phase3-migration'"), 1)
  assert.deepEqual({ ...upgraded.prepare(`SELECT accounting_version,activation_date,opening_date,historical_policy,
    initialization_status,warning_count,initialized_at,created_at
    FROM accounting_settings WHERE organization_id='org:settings-preserved'`).get() }, {
    accounting_version: 3,
    activation_date: "2025-04-01",
    opening_date: "2025-04-01",
    historical_policy: "CONTROLLED_OPENING",
    initialization_status: "INITIALIZED",
    warning_count: 7,
    initialized_at: "2025-04-02 10:00:00",
    created_at: "2025-04-01 09:00:00",
  })
  assert.equal(scalar(upgraded, "SELECT COUNT(*) FROM fixed_asset_categories WHERE organization_id='org:phase3-migration'"), 7)
  assert.equal(scalar(upgraded, "SELECT COUNT(*) FROM statutory_integrations WHERE organization_id='org:phase3-migration' AND configuration_status='NOT_CONFIGURED'"), 3)
  assert.equal(scalar(upgraded, "SELECT COUNT(*) FROM pragma_foreign_key_check"), 0)
  assert.equal(String(Object.values(upgraded.prepare("PRAGMA quick_check").get() as Record<string, string>)[0]), "ok")

  const countsBeforeIdempotency = phaseThreeTables.map((table) => scalar(upgraded!, `SELECT COUNT(*) FROM ${table}`))
  const migration = localMigrations.find((candidate) => candidate.version === 22)!
  upgraded.exec("BEGIN IMMEDIATE")
  try {
    for (const statement of migration.sql) {
      try { upgraded.exec(statement) } catch (error) {
        if (!(/^\s*ALTER\s+TABLE/i.test(statement) && /duplicate column name/i.test(String(error)))) throw error
      }
    }
    upgraded.exec("COMMIT")
  } catch (error) { upgraded.exec("ROLLBACK"); throw error }
  assert.deepEqual(phaseThreeTables.map((table) => scalar(upgraded!, `SELECT COUNT(*) FROM ${table}`)), countsBeforeIdempotency)

  upgraded.prepare("INSERT INTO accounting_audit_events(id,organization_id,event_type,entity_type,entity_id,source,occurred_at) VALUES (?,?,?,?,?,'test',datetime('now'))").run("audit:immutable", "org:phase3-migration", "migration.verified", "database", "upgrade-copy")
  assert.throws(() => upgraded!.exec("UPDATE accounting_audit_events SET event_type='tampered' WHERE id='audit:immutable'"), /accounting_audit_event_is_immutable/)
  copyFileSync(upgradeCopyPath, restorePath)
  upgraded.close(); upgraded = new DatabaseSync(restorePath, { readOnly: true })
  assert.equal(scalar(upgraded, "SELECT COUNT(*) FROM accounting_audit_events WHERE id='audit:immutable'"), 1)
  assert.deepEqual(preservedSnapshot(upgraded), before)
  assert.equal(scalar(upgraded, "SELECT COUNT(*) FROM pragma_foreign_key_check"), 0)
  assert.equal(String(Object.values(upgraded.prepare("PRAGMA quick_check").get() as Record<string, string>)[0]), "ok")
  console.log(JSON.stringify({ status: "ok", upgradedFromSchema: 21, schemaVersion: LOCAL_DB_VERSION, preservedCounts: before.counts, preservedChecksum: before.checksum, defaultAccounts: 43, accountingInitializationRepaired: true, existingAccountingInitializationPreserved: true, phaseThreeTables: phaseThreeTables.length, migrationIdempotent: true, auditImmutable: true, backupRestore: true, foreignKeyViolations: 0, quickCheck: "ok" }))
} finally {
  try { source.close() } catch {}
  try { upgraded?.close() } catch {}
  rmSync(directory, { recursive: true, force: true })
}
