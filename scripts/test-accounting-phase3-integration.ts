import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks"

type SqlValue = string | number | null
type StatementPayload = { query: string; bindValues?: SqlValue[]; ignoreDuplicateColumn?: boolean }

const directory = mkdtempSync(path.join(tmpdir(), "bezgrow-phase3-integration-"))
const databasePath = path.join(directory, "business.db")
const db = new DatabaseSync(databasePath)
let injectedFailurePattern: RegExp | null = null

Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true })
Object.defineProperty(globalThis, "location", { value: { hostname: "127.0.0.1", port: "43123" }, configurable: true })
Object.assign(globalThis, { __BEZGROW_DESKTOP__: true, __BEZGROW_RUNTIME__: "tauri-packaged" })

function payloadStatement(payload: unknown) { return (payload as { statement: StatementPayload }).statement }
function run(statement: StatementPayload) {
  if (injectedFailurePattern?.test(statement.query)) throw new Error("injected_phase3_transaction_failure")
  const values = statement.bindValues || []
  if (values.length) return Number(db.prepare(statement.query).run(...values).changes)
  db.exec(statement.query)
  return 0
}
function scalar(query: string, ...values: SqlValue[]) { return Number(Object.values(db.prepare(query).get(...values) as Record<string, unknown>)[0] || 0) }

mockIPC((command, payload) => {
  if (command === "desktop_startup_log") return null
  if (command === "desktop_database_backup") return null
  if (command === "desktop_database_diagnostics") return { applicationVersion: "phase3-test", appConfigDir: directory, appDataDir: directory, databasePath, deviceIdSource: "test", licenseStateSource: "test", legacyMigrationOccurred: false, legacyMigrationSource: null, parentExists: true, parentCreated: false, parentWritable: true, databaseExists: true, databaseBytes: 0 }
  if (command === "desktop_execute") return run(payloadStatement(payload))
  if (command === "desktop_select") {
    const statement = payloadStatement(payload)
    return db.prepare(statement.query).all(...(statement.bindValues || []))
  }
  if (command === "desktop_execute_transaction") {
    const statements = (payload as { statements: StatementPayload[] }).statements
    db.exec("BEGIN IMMEDIATE")
    db.exec("PRAGMA defer_foreign_keys=ON")
    try {
      let rowsAffected = 0
      for (const statement of statements) {
        try { rowsAffected += run(statement) } catch (error) {
          if (statement.ignoreDuplicateColumn && /duplicate column name/i.test(String(error))) continue
          throw new Error(`${String(error)}\nSQL: ${statement.query.slice(0, 1_000)}\nValues: ${JSON.stringify(statement.bindValues || [])}`, { cause: error })
        }
      }
      db.exec("COMMIT")
      return { statements: statements.length, rowsAffected }
    } catch (error) { db.exec("ROLLBACK"); throw error }
  }
  throw new Error(`Unexpected desktop command in Phase 3 integration test: ${command}`)
})

async function main() {
  try {
    const [{ getLocalDatabaseService }, { accountingReport, initializeAccounting }, phase2, phase3, schema] = await Promise.all([
      import("../lib/offline/local/service"),
      import("../lib/offline/local/accounting"),
      import("../lib/offline/local/accounting-phase2"),
      import("../lib/offline/local/accounting-phase3"),
      import("../lib/offline/local/schema"),
    ])
    await getLocalDatabaseService().ensureReady()
    assert.equal(scalar("PRAGMA user_version"), schema.LOCAL_DB_VERSION)
    db.exec("INSERT INTO organizations(id,name,state,gst_number,created_at,updated_at) VALUES ('org:phase3','Phase 3 Business','MH','27AAPFU0939F1ZV',datetime('now'),datetime('now'))")
    db.exec("INSERT INTO financial_years(id,organization_id,label,start_date,end_date,start_month,status,is_active,created_at) VALUES ('fy:org:phase3:2026:4','org:phase3','FY 2026-27','2026-04-01','2027-03-31',4,'OPEN',1,datetime('now'))")
    db.exec("INSERT INTO suppliers(id,organization_id,name,pan,current_balance,created_at,updated_at) VALUES ('supplier:phase3','org:phase3','Professional Vendor','ABCDE1234F',0,datetime('now'),datetime('now'))")
    db.exec("INSERT INTO customers(id,organization_id,name,pan,current_balance,created_at,updated_at) VALUES ('customer:phase3','org:phase3','Tax Customer','ABCDE1234F',0,datetime('now'),datetime('now'))")
    await initializeAccounting("org:phase3", "2026-04-01")
    const reference = await phase3.phaseThreeReferenceData("org:phase3", "fy:org:phase3:2026:4")
    assert.equal(reference.categories.length, 7)
    assert.equal(reference.integrations.every((row) => row.configuration_status === "NOT_CONFIGURED"), true)
    const accountId = (role: string) => String((db.prepare("SELECT id FROM chart_of_accounts WHERE organization_id='org:phase3' AND system_role=?").get(role) as { id: string }).id)

    const costCentre = await phase3.saveAccountingDimension("org:phase3", { dimension_type: "COST_CENTRE", code: "DIGITAL", name: "Digital Marketing" })
    const budgetsBeforeFailure = scalar("SELECT COUNT(*) FROM accounting_budgets")
    injectedFailurePattern = /INSERT INTO accounting_audit_events/
    await assert.rejects(() => phase3.saveAccountingBudget("org:phase3", { financial_year_id: "fy:org:phase3:2026:4", period_type: "MONTH", period_start: "2026-08-01", period_end: "2026-08-31", account_id: accountId("PROFESSIONAL_FEES"), budget_amount: 1_000 }), /injected_phase3_transaction_failure/)
    injectedFailurePattern = null
    assert.equal(scalar("SELECT COUNT(*) FROM accounting_budgets"), budgetsBeforeFailure, "A mid-transaction failure must roll back the budget row.")
    await phase3.saveAccountingBudget("org:phase3", { financial_year_id: "fy:org:phase3:2026:4", period_type: "MONTH", period_start: "2026-09-01", period_end: "2026-09-30", account_id: accountId("PROFESSIONAL_FEES"), dimension_id: costCentre.id, budget_amount: 150_000 })
    await phase3.saveVoucherSeries("org:phase3", { financial_year_id: "fy:org:phase3:2026:4", voucher_type: "DEPRECIATION", prefix: "DEP", padding: 6, starting_number: 1 })

    const asset = await phase3.createFixedAsset("org:phase3", {
      financial_year_id: "fy:org:phase3:2026:4", asset_name: "Design Workstation", asset_code: "COMP-001", category_id: reference.categories.find((row) => row.code === "COMPUTERS")?.id,
      purchase_date: "2026-06-01", capitalization_date: "2026-06-01", original_cost: 120_000, residual_value: 0,
      useful_life_months: 60, depreciation_method: "SLM", depreciation_rate: 20, payment_account_id: accountId("CASH"), location: "Head Office",
    })
    assert.equal(scalar("SELECT total_debit_minor-total_credit_minor FROM accounting_vouchers WHERE id=?", String(asset.accounting_voucher_id)), 0)
    const depreciation = await phase3.postAssetDepreciation("org:phase3", { financial_year_id: "fy:org:phase3:2026:4", asset_id: asset.asset_id, period_start: "2026-06-01", period_end: "2026-06-30" })
    assert.equal(Number(depreciation.depreciation_minor), 197_260)
    await assert.rejects(() => phase3.postAssetDepreciation("org:phase3", { financial_year_id: "fy:org:phase3:2026:4", asset_id: asset.asset_id, period_start: "2026-06-15", period_end: "2026-07-15" }), /already been posted/)

    const tdsRule = await phase3.saveTaxRule("org:phase3", { tax_type: "TDS", section_code: "CONFIG-194J", description: "Configured professional fee deduction", effective_from: "2026-04-01", rate: 10, threshold: 0, pan_required: true })
    const tds = await phase3.postTdsTransaction("org:phase3", { financial_year_id: "fy:org:phase3:2026:4", tax_rule_id: tdsRule.id, supplier_id: "supplier:phase3", deduction_date: "2026-09-06", taxable_amount: 100_000, expense_account_id: accountId("PROFESSIONAL_FEES"), posting_mode: "EXPENSE_ACCRUAL" })
    assert.equal(Number(tds.tax_minor), 1_000_000)
    assert.equal(scalar("SELECT total_debit_minor-total_credit_minor FROM accounting_vouchers WHERE id=?", String(tds.accounting_voucher_id)), 0)
    assert.equal(scalar("SELECT ROUND(current_balance*100) FROM suppliers WHERE id='supplier:phase3'"), 9_000_000)
    const tdsPayment = await phase3.recordTaxPayment("org:phase3", { financial_year_id: "fy:org:phase3:2026:4", tax_transaction_id: tds.tax_transaction_id, payment_date: "2026-10-07", payment_account_id: accountId("CASH"), challan_reference: "CHALLAN-TDS-001" })
    assert.equal(scalar("SELECT total_debit_minor-total_credit_minor FROM accounting_vouchers WHERE id=?", String(tdsPayment.payment_accounting_voucher_id)), 0)

    const tcsRule = await phase3.saveTaxRule("org:phase3", { tax_type: "TCS", section_code: "CONFIG-206C", description: "Configured collection", effective_from: "2026-04-01", rate: 0.1, threshold: 0, pan_required: true })
    const tcs = await phase3.postTcsTransaction("org:phase3", { financial_year_id: "fy:org:phase3:2026:4", tax_rule_id: tcsRule.id, customer_id: "customer:phase3", collection_date: "2026-09-06", taxable_amount: 200_000 })
    assert.equal(Number(tcs.tax_minor), 20_000)
    assert.equal(scalar("SELECT ROUND(current_balance*100) FROM customers WHERE id='customer:phase3'"), 20_000)

    const expenseLine = db.prepare("SELECT line.id FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN chart_of_accounts account ON account.id=line.account_id WHERE voucher.id=? AND account.system_role='PROFESSIONAL_FEES'").get(String(tds.accounting_voucher_id)) as { id: string }
    await phase3.allocateVoucherDimensions("org:phase3", { voucher_entry_id: expenseLine.id, dimensions: [{ type: "COST_CENTRE", allocations: [{ dimension_id: costCentre.id, amount: 100_000 }] }] })
    assert.equal(scalar("SELECT SUM(amount_minor) FROM accounting_dimension_allocations WHERE voucher_entry_id=?", expenseLine.id), 10_000_000)

    const bank = await phase2.saveBankAccount("org:phase3", { display_name: "Operating Bank", bank_name: "Test Bank", account_number: "1234567890", account_type: "CURRENT", opening_balance: 1_000, opening_date: "2026-09-06" })
    const bankImport = await phase3.importBankStatement("org:phase3", { financial_year_id: "fy:org:phase3:2026:4", bank_account_id: bank.bank_account_id, file_name: "statement.csv", file_sha256: "b".repeat(64), rows: [{ transaction_date: "2026-09-06", amount: 1_000, direction: "IN", reference: "opening" }] })
    assert.equal(bankImport.suggested_matches, 1)
    const bankMatch = db.prepare("SELECT id FROM bank_statement_matches WHERE organization_id='org:phase3' AND match_status='SUGGESTED'").get() as { id: string }
    await phase3.confirmBankStatementMatch("org:phase3", { match_id: bankMatch.id, status: "CONFIRMED", confirmation: true })

    const gstImport = await phase3.importGstRecords("org:phase3", { financial_year_id: "fy:org:phase3:2026:4", import_type: "GSTR2B", file_name: "gstr2b.json", file_sha256: "c".repeat(64), rows: [{ supplier_gstin: "27AAPFU0939F1ZV", invoice_number: "NO-BOOK-1", invoice_date: "2026-09-06", taxable_value: 100, cgst: 9, sgst: 9 }] })
    assert.equal(gstImport.row_count, 1)
    await assert.rejects(() => phase3.importGstRecords("org:phase3", { financial_year_id: "fy:org:phase3:2026:4", file_name: "../gstr2b.json", file_sha256: "d".repeat(64), rows: [{ supplier_gstin: "27AAPFU0939F1ZV", invoice_number: "NO-BOOK-2", invoice_date: "2026-09-06", taxable_value: 100 }] }), /must not contain a path/)
    assert.equal(scalar("SELECT COUNT(*) FROM gst_reconciliations WHERE classification='MISSING_IN_BOOKS'"), 1)
    const gstReturn = await phase3.saveGstReturnPeriod("org:phase3", { financial_year_id: "fy:org:phase3:2026:4", return_type: "GSTR-1", period_start: "2026-09-01", period_end: "2026-09-30", status: "DRAFT" })
    assert.equal(gstReturn.status, "DRAFT")

    const einvoice = await phase3.saveEInvoicePreparation("org:phase3", { financial_year_id: "fy:org:phase3:2026:4", source_type: "SALES_INVOICE", source_id: "invoice:future", supplier_gstin: "27AAPFU0939F1ZV", recipient_gstin: "27AAPFU0939F1ZV", document_number: "INV-1", document_date: "2026-09-06", document_type: "INV", place_of_supply: "27", lines: [{ hsn: "8471", quantity: 1, unit: "NOS", taxable_minor: 10000, cgst_minor: 900, sgst_minor: 900, igst_minor: 0 }] })
    assert.equal(einvoice.status, "READY")
    assert.match(einvoice.message, /Not Configured/)
    const eway = await phase3.saveEwayBillPreparation("org:phase3", { financial_year_id: "fy:org:phase3:2026:4", source_type: "SALES_INVOICE", source_id: "invoice:future", document_reference: "INV-1", transaction_type: "OUTWARD", transport_mode: "ROAD", vehicle_number: "MH12AB1234", distance_km: 150, origin: "Pune", destination: "Mumbai" })
    assert.equal(eway.status, "READY")

    const assets = await phase3.phaseThreeAccountingReport({ organizationId: "org:phase3", financialYearId: "fy:org:phase3:2026:4", report: "fixed-assets" })
    assert.equal(assets.total, 1)
    const depreciationSchedule = await phase3.phaseThreeAccountingReport({ organizationId: "org:phase3", financialYearId: "fy:org:phase3:2026:4", report: "depreciation-schedule" })
    const depreciationScheduleSummary = depreciationSchedule as unknown as { postedCount: number; projectedCount: number; rows: Array<Record<string, unknown>> }
    assert.equal(depreciationScheduleSummary.postedCount, 1)
    assert.ok(Number(depreciationScheduleSummary.projectedCount) > 0, "The depreciation schedule must clearly include future, not-posted periods.")
    assert.equal((depreciationSchedule.rows as Array<Record<string, unknown>>).some((row) => row.schedule_status === "PROJECTED_NOT_POSTED"), true)
    const tdsReport = await phase3.phaseThreeAccountingReport({ organizationId: "org:phase3", financialYearId: "fy:org:phase3:2026:4", report: "tds-register" })
    assert.equal(Number((tdsReport as unknown as Record<string, unknown>).tax_minor), 1_000_000)
    const budget = await phase3.phaseThreeAccountingReport({ organizationId: "org:phase3", financialYearId: "fy:org:phase3:2026:4", report: "budget-vs-actual" })
    assert.equal((budget.rows as Array<Record<string, unknown>>)[0].actualMinor, 10_000_000)
    const costCentrePl = await phase3.phaseThreeAccountingReport({ organizationId: "org:phase3", financialYearId: "fy:org:phase3:2026:4", report: "cost-centre-pl" })
    assert.equal(costCentrePl.expenseMinor, 10_000_000)
    const septemberProfitLoss = await accountingReport({ organizationId: "org:phase3", financialYearId: "fy:org:phase3:2026:4", report: "profit-loss", from: "2026-09-01", to: "2026-09-30" })
    assert.equal(septemberProfitLoss.expenseMinor, 10_000_000, "Custom-period P&L must include September professional fees.")
    assert.equal(septemberProfitLoss.depreciationMinor, 0, "Custom-period P&L must not leak June depreciation into September.")
    const health = await phase3.accountingHealth("org:phase3", "fy:org:phase3:2026:4")
    assert.equal(health.integrity.unbalancedVouchers, 0)
    assert.ok(scalar("SELECT COUNT(*) FROM accounting_audit_events") >= 14)
    assert.equal(scalar("SELECT COUNT(*) FROM accounting_audit_events WHERE event_type IN ('fixed_asset.depreciation_posted','tds.deducted','tcs.collected')"), 3)

    const disposal = await phase3.disposeFixedAsset("org:phase3", { financial_year_id: "fy:org:phase3:2026:4", asset_id: asset.asset_id, disposal_date: "2026-10-01", disposal_type: "SALE", proceeds: 110_000, settlement_account_id: accountId("CASH") })
    assert.equal(scalar("SELECT total_debit_minor-total_credit_minor FROM accounting_vouchers WHERE id=?", String(disposal.accounting_voucher_id)), 0)
    assert.equal(scalar("SELECT COUNT(*) FROM pragma_foreign_key_check"), 0)
    assert.equal(String(Object.values(db.prepare("PRAGMA quick_check").get() as Record<string, string>)[0]), "ok")
    console.log(JSON.stringify({ status: "ok", schemaVersion: schema.LOCAL_DB_VERSION, assetLifecycle: true, projectedDepreciationSchedule: true, tds: true, tcs: true, dimensions: true, budgets: true, customPeriodProfitLoss: true, gstImportReconciliation: true, gstReturnPreparation: true, statutoryPreparation: true, bankImportSuggestions: true, auditTrail: true, transactionRollback: true, unbalancedPostedJournals: 0, foreignKeyViolations: 0, quickCheck: "ok" }))
  } finally {
    clearMocks()
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })
