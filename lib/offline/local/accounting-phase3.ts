"use client"

import { createOfflineId } from "@/lib/offline/db"
import { minorToMoney, moneyToMinor } from "@/lib/accounting/money"
import {
  budgetVariance,
  buildAssetDisposalJournal,
  buildDepreciationJournal,
  buildTcsJournal,
  buildTdsJournal,
  calculateDepreciation,
  classifyGstReconciliation,
  formatVoucherNumber,
  normalizeInvoiceReference,
  schedulePeriods,
  validateDimensionAllocations,
  validateEInvoicePreparation,
  validateEwayBillPreparation,
  type DimensionType,
} from "@/lib/accounting/phase3"
import type { AccountingAccount, JournalLine } from "@/lib/accounting/journal"
import { validateGstinFormat } from "@/lib/accounting/phase2"
import { appendJournal } from "@/lib/offline/local/journal-posting"
import { accountingIntegrity, accountingReport, advanceAccountingVoucherNumber, initializeAccounting, prepareAccountingVoucherNumber, systemAccountMap } from "@/lib/offline/local/accounting"
import { phaseTwoAccountingReport } from "@/lib/offline/local/accounting-phase2"
import { assertFinancialYearWriteAllowed, getFinancialYear } from "@/lib/offline/local/financial-years"
import { getLocalDatabaseService, type SqlExecutor, type SqlValue } from "@/lib/offline/local/service"

type DataRow = Record<string, unknown>
type PageInput = { page?: number; limit?: number }

const service = getLocalDatabaseService()
const VALID_DIMENSIONS = new Set<DimensionType>(["COST_CENTRE", "DEPARTMENT", "PROJECT"])

function nowIso() { return new Date().toISOString() }
function localString(value: unknown, fallback = "") { return typeof value === "string" && value.trim() ? value.trim() : fallback }
function localNumber(value: unknown, fallback = 0) { const result = Number(value); return Number.isFinite(result) ? result : fallback }
function bool(value: unknown) { return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true" }
function strictDate(value: unknown, label = "Date") {
  const result = localString(value).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error(`${label} must use YYYY-MM-DD format.`)
  const [year, month, day] = result.split("-").map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw new Error(`${label} is invalid.`)
  return result
}
function nextBusinessDate(value: string) {
  const [year, month, day] = strictDate(value).split("-").map(Number)
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`
}
function page(input: PageInput) {
  const current = Math.max(1, Math.trunc(input.page || 1))
  const limit = Math.max(1, Math.min(250, Math.trunc(input.limit || 50)))
  return { page: current, limit, offset: (current - 1) * limit }
}
function rowAccount(row: DataRow): AccountingAccount {
  return { id: String(row.id || ""), accountCode: String(row.account_code || ""), accountName: String(row.account_name || ""), accountType: String(row.account_type || ""), systemRole: row.system_role ? String(row.system_role) : null }
}
function safeSnapshot(value: unknown) {
  const redact = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(redact)
    if (!candidate || typeof candidate !== "object") return candidate
    return Object.fromEntries(Object.entries(candidate as DataRow).map(([key, item]) => [key, /password|secret|token|private.?key|authorization|cookie/i.test(key) ? "[redacted]" : redact(item)]))
  }
  const json = JSON.stringify(redact(value))
  return json.length > 20_000 ? JSON.stringify({ truncated: true }) : json
}

async function audit(tx: SqlExecutor, input: {
  organizationId: string
  financialYearId?: string | null
  eventType: string
  entityType: string
  entityId: string
  actor?: string | null
  reason?: string | null
  previous?: unknown
  next?: unknown
}) {
  await tx.execute(
    `INSERT INTO accounting_audit_events (id,organization_id,financial_year_id,event_type,entity_type,entity_id,actor,reason,previous_state_json,new_state_json,source,occurred_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'local',?)`,
    [createOfflineId("accounting-audit"), input.organizationId, input.financialYearId || null, input.eventType, input.entityType, input.entityId,
      input.actor || null, input.reason || null, input.previous === undefined ? null : safeSnapshot(input.previous), input.next === undefined ? null : safeSnapshot(input.next), nowIso()]
  )
}

function defaultPrefix(voucherType: string) {
  return ({
    DEPRECIATION: "DEP", ASSET_ACQUISITION: "FA", ASSET_DISPOSAL: "FAD", TDS: "TDS", TCS: "TCS",
    TDS_PAYMENT: "TDSP", TCS_PAYMENT: "TCSP", ADVANCE_ADJUSTMENT: "ADJ", OPENING: "OPEN",
    JOURNAL: "JV", RECEIPT: "REC", PAYMENT: "PAY", CONTRA: "CONTRA", CREDIT_NOTE: "CN", DEBIT_NOTE: "DN",
  } as Record<string, string>)[voucherType.toUpperCase()] || voucherType.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "VCH"
}

async function nextVoucher(organizationId: string, financialYearId: string, voucherType: string) {
  return prepareAccountingVoucherNumber(organizationId, financialYearId, voucherType, defaultPrefix(voucherType))
}

async function advanceVoucherSeries(tx: SqlExecutor, organizationId: string, financialYearId: string, voucherType: string, series: Awaited<ReturnType<typeof nextVoucher>>) {
  if (series.voucherType !== voucherType) throw new Error("Voucher series type changed while posting.")
  await advanceAccountingVoucherNumber(tx, organizationId, financialYearId, series)
}

async function selectedAccount(organizationId: string, id: string) {
  const db = await service.requireConnection("read")
  const [row] = await db.select<DataRow>("SELECT id,account_code,account_name,account_type,system_role FROM chart_of_accounts WHERE organization_id=? AND id=? AND is_active=1 AND deleted_at IS NULL LIMIT 1", [organizationId, id])
  if (!row) throw new Error("Selected accounting ledger is missing or inactive.")
  return rowAccount(row)
}

function requireRole(accounts: Map<string, AccountingAccount>, role: string) {
  const account = accounts.get(role)
  if (!account) throw new Error(`Required accounting account ${role} is missing.`)
  return account
}

async function ensurePhaseThreeSetup(organizationId: string) {
  const accounts = await systemAccountMap(organizationId)
  const db = await service.requireConnection("read")
  const [categoryCount, integrationCount] = await Promise.all([
    db.select<DataRow>("SELECT COUNT(*) count FROM fixed_asset_categories WHERE organization_id=?", [organizationId]),
    db.select<DataRow>("SELECT COUNT(*) count FROM statutory_integrations WHERE organization_id=?", [organizationId]),
  ])
  if (Number(categoryCount[0]?.count || 0) >= 7 && Number(integrationCount[0]?.count || 0) >= 3) return
  const categories = [
    ["PLANT", "Plant & Machinery", 120], ["FURNITURE", "Furniture", 120], ["COMPUTERS", "Computers", 36],
    ["OFFICE_EQUIPMENT", "Office Equipment", 60], ["VEHICLES", "Vehicles", 96], ["BUILDINGS", "Buildings", 360], ["OTHER", "Other Fixed Assets", 60],
  ] as const
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    for (const [code, name, life] of categories) await tx.execute(
      `INSERT OR IGNORE INTO fixed_asset_categories (id,organization_id,code,name,default_method,default_useful_life_months,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,created_at,updated_at)
       VALUES (?,?,?,?, 'SLM',?,?,?,?,?,?)`,
      [`asset-category:${organizationId}:${code}`, organizationId, code, name, life, requireRole(accounts, "FIXED_ASSETS").id, requireRole(accounts, "ACCUMULATED_DEPRECIATION").id, requireRole(accounts, "DEPRECIATION_EXPENSE").id, timestamp, timestamp]
    )
    for (const type of ["E_INVOICE", "E_WAY_BILL", "GST_RETURN"]) await tx.execute(
      "INSERT OR IGNORE INTO statutory_integrations (id,organization_id,integration_type,configuration_status,created_at,updated_at) VALUES (?,?,?,'NOT_CONFIGURED',?,?)",
      [`statutory:${organizationId}:${type}`, organizationId, type, timestamp, timestamp]
    )
  })
}

export async function saveVoucherSeries(organizationId: string, input: DataRow) {
  const financialYearId = localString(input.financial_year_id)
  const voucherType = localString(input.voucher_type).toUpperCase()
  const prefix = localString(input.prefix).toUpperCase()
  const suffix = localString(input.suffix).toUpperCase() || null
  const padding = Math.max(1, Math.min(12, Math.trunc(localNumber(input.padding, 6))))
  const startingNumber = Math.max(1, Math.trunc(localNumber(input.starting_number, 1)))
  if (!financialYearId || !voucherType) throw new Error("Financial year and voucher type are required.")
  formatVoucherNumber({ prefix, suffix, nextNumber: startingNumber, padding })
  const db = await service.requireConnection("read")
  const [year] = await db.select<DataRow>("SELECT id FROM financial_years WHERE organization_id=? AND id=? LIMIT 1", [organizationId, financialYearId])
  if (!year) throw new Error("Financial year was not found.")
  const [existing] = await db.select<DataRow>("SELECT * FROM accounting_voucher_series WHERE organization_id=? AND financial_year_id=? AND voucher_type=?", [organizationId, financialYearId, voucherType])
  const nextNumber = existing ? Math.max(Number(existing.next_number || 1), startingNumber) : startingNumber
  const id = localString(existing?.id, createOfflineId("voucher-series"))
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO accounting_voucher_series (id,organization_id,financial_year_id,voucher_type,prefix,suffix,padding,starting_number,next_number,is_active,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(organization_id,financial_year_id,voucher_type) DO UPDATE SET
       prefix=excluded.prefix,suffix=excluded.suffix,padding=excluded.padding,starting_number=excluded.starting_number,
       next_number=MAX(accounting_voucher_series.next_number,excluded.starting_number),is_active=1,updated_at=excluded.updated_at`,
      [id, organizationId, financialYearId, voucherType, prefix, suffix, padding, startingNumber, nextNumber, timestamp, timestamp]
    )
    await audit(tx, { organizationId, financialYearId, eventType: existing ? "voucher_series.updated" : "voucher_series.created", entityType: "accounting_voucher_series", entityId: id, actor: localString(input.actor) || null, reason: localString(input.reason) || null, previous: existing, next: { voucherType, prefix, suffix, padding, startingNumber, nextNumber } })
  })
  return { id, voucher_type: voucherType, prefix, suffix, padding, starting_number: startingNumber, next_number: nextNumber }
}

export async function saveAccountingDimension(organizationId: string, input: DataRow) {
  const type = localString(input.dimension_type).toUpperCase() as DimensionType
  const code = localString(input.code).toUpperCase()
  const name = localString(input.name)
  if (!VALID_DIMENSIONS.has(type) || !code || !name) throw new Error("Dimension type, code, and name are required.")
  if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(code)) throw new Error("Dimension code may contain only letters, numbers, underscores, and hyphens.")
  const id = localString(input.id, createOfflineId("dimension"))
  const db = await service.requireConnection("read")
  const [existing] = await db.select<DataRow>("SELECT * FROM accounting_dimensions WHERE organization_id=? AND id=?", [organizationId, id])
  if (existing && String(existing.dimension_type) !== type) throw new Error("A dimension with history cannot change type.")
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO accounting_dimensions (id,organization_id,dimension_type,code,name,parent_id,is_active,notes,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,name=excluded.name,parent_id=excluded.parent_id,is_active=excluded.is_active,notes=excluded.notes,updated_at=excluded.updated_at`,
      [id, organizationId, type, code, name, localString(input.parent_id) || null, input.is_active === false ? 0 : 1, localString(input.notes) || null, timestamp, timestamp]
    )
    await audit(tx, { organizationId, eventType: existing ? "dimension.updated" : "dimension.created", entityType: "accounting_dimension", entityId: id, actor: localString(input.actor) || null, previous: existing, next: { type, code, name } })
  })
  return { id, dimension_type: type, code, name }
}

export async function saveAccountingBudget(organizationId: string, input: DataRow) {
  const financialYearId = localString(input.financial_year_id)
  const periodType = localString(input.period_type, "MONTH").toUpperCase()
  const periodStart = strictDate(input.period_start, "Budget period start")
  const periodEnd = strictDate(input.period_end, "Budget period end")
  if (periodStart > periodEnd || !["MONTH", "QUARTER", "YEAR"].includes(periodType)) throw new Error("Budget period is invalid.")
  await assertFinancialYearWriteAllowed(organizationId, periodStart, financialYearId)
  const year = await getFinancialYear(organizationId, financialYearId)
  if (!year || periodEnd > year.end_date) throw new Error("Budget dates must remain inside the selected financial year.")
  const account = await selectedAccount(organizationId, localString(input.account_id))
  if (!["EXPENSE", "INCOME"].includes(account.accountType)) throw new Error("Budgets must use an income or expense ledger.")
  const budgetMinor = moneyToMinor(input.budget_amount ?? input.budget, "Budget amount")
  const threshold = Math.max(0, Math.trunc(localNumber(input.warning_threshold_basis_points, 10_000)))
  const policy = localString(input.enforcement_policy, "WARN").toUpperCase()
  if (!Number.isSafeInteger(budgetMinor) || budgetMinor < 0 || !["WARN", "BLOCK"].includes(policy)) throw new Error("Budget amount or policy is invalid.")
  const id = localString(input.id, createOfflineId("budget"))
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO accounting_budgets (id,organization_id,financial_year_id,period_type,period_start,period_end,account_id,dimension_id,budget_minor,warning_threshold_basis_points,enforcement_policy,notes,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET period_type=excluded.period_type,period_start=excluded.period_start,period_end=excluded.period_end,account_id=excluded.account_id,dimension_id=excluded.dimension_id,budget_minor=excluded.budget_minor,warning_threshold_basis_points=excluded.warning_threshold_basis_points,enforcement_policy=excluded.enforcement_policy,notes=excluded.notes,updated_at=excluded.updated_at`,
      [id, organizationId, financialYearId, periodType, periodStart, periodEnd, account.id, localString(input.dimension_id) || null, budgetMinor, threshold, policy, localString(input.notes) || null, timestamp, timestamp]
    )
    await audit(tx, { organizationId, financialYearId, eventType: "budget.saved", entityType: "accounting_budget", entityId: id, actor: localString(input.actor) || null, next: { periodStart, periodEnd, accountId: account.id, budgetMinor, policy } })
  })
  return { id, budget_minor: budgetMinor }
}

export async function createFixedAsset(organizationId: string, input: DataRow) {
  await ensurePhaseThreeSetup(organizationId)
  const financialYearId = localString(input.financial_year_id)
  const assetName = localString(input.asset_name)
  const assetCode = localString(input.asset_code).toUpperCase()
  const purchaseDate = strictDate(input.purchase_date, "Purchase date")
  const capitalizationDate = strictDate(input.capitalization_date || input.purchase_date, "Capitalization date")
  if (!assetName || !assetCode || !localString(input.category_id)) throw new Error("Asset name, code, and category are required.")
  if (capitalizationDate < purchaseDate) throw new Error("Capitalization date cannot be before purchase date.")
  await initializeAccounting(organizationId, capitalizationDate)
  const year = await assertFinancialYearWriteAllowed(organizationId, capitalizationDate, financialYearId)
  const originalCostMinor = moneyToMinor(input.original_cost, "Original cost")
  const residualValueMinor = moneyToMinor(input.residual_value || 0, "Residual value")
  const usefulLifeMonths = Math.trunc(localNumber(input.useful_life_months))
  const method = localString(input.depreciation_method, "SLM").toUpperCase()
  const rateBasisPoints = moneyToMinor(input.depreciation_rate || 0, "Depreciation rate")
  if (originalCostMinor <= 0 || residualValueMinor < 0 || residualValueMinor > originalCostMinor) throw new Error("Asset cost and residual value are invalid.")
  if (usefulLifeMonths <= 0 || !["SLM", "WDV"].includes(method)) throw new Error("Useful life and depreciation method are required.")
  if (method === "WDV" && (rateBasisPoints <= 0 || rateBasisPoints > 10_000)) throw new Error("WDV rate must be greater than 0% and no more than 100%.")
  const db = await service.requireConnection("read")
  const [category] = await db.select<DataRow>("SELECT * FROM fixed_asset_categories WHERE organization_id=? AND id=? AND is_active=1 LIMIT 1", [organizationId, localString(input.category_id)])
  if (!category) throw new Error("Fixed asset category was not found.")
  const assetAccount = await selectedAccount(organizationId, localString(input.asset_account_id, String(category.asset_account_id || "")))
  const accumulatedAccount = await selectedAccount(organizationId, localString(input.accumulated_depreciation_account_id, String(category.accumulated_depreciation_account_id || "")))
  const depreciationAccount = await selectedAccount(organizationId, localString(input.depreciation_expense_account_id, String(category.depreciation_expense_account_id || "")))
  if (assetAccount.accountType !== "ASSET" || accumulatedAccount.accountType !== "ASSET" || depreciationAccount.accountType !== "EXPENSE") throw new Error("Asset category ledger mappings are invalid.")

  const purchaseDocumentId = localString(input.purchase_document_id)
  let acquisitionVoucherId = ""
  let acquisitionJournal: Awaited<ReturnType<typeof buildDepreciationJournal>> | null = null
  let series: Awaited<ReturnType<typeof nextVoucher>> | null = null
  if (purchaseDocumentId) {
    const [purchase] = await db.select<DataRow>(
      `SELECT accounting_voucher_id,financial_year_id,document_status,
         COALESCE((SELECT SUM(taxable_minor) FROM purchase_invoice_items item WHERE item.purchase_invoice_id=purchase.id AND item.purchase_classification='FIXED_ASSET'),0) fixed_asset_minor
       FROM purchase_invoices purchase WHERE organization_id=? AND id=? AND deleted_at IS NULL LIMIT 1`,
      [organizationId, purchaseDocumentId]
    )
    if (!purchase || purchase.document_status !== "POSTED" || !purchase.accounting_voucher_id) throw new Error("Linked purchase must be posted before creating the asset register entry.")
    if (Number(purchase.fixed_asset_minor || 0) < originalCostMinor) throw new Error("Asset cost exceeds the fixed-asset value in the linked purchase.")
    acquisitionVoucherId = String(purchase.accounting_voucher_id)
  } else {
    const settlementAccount = await selectedAccount(organizationId, localString(input.payment_account_id))
    series = await nextVoucher(organizationId, year.id, "ASSET_ACQUISITION")
    const lines: JournalLine[] = [
      { accountId: assetAccount.id, accountType: assetAccount.accountType, debitMinor: originalCostMinor, creditMinor: 0, description: `Capitalized asset · ${assetName}` },
      { accountId: settlementAccount.id, accountType: settlementAccount.accountType, debitMinor: 0, creditMinor: originalCostMinor, description: `Asset acquisition settlement · ${assetName}`, partyType: localString(input.supplier_id) ? "supplier" : null, partyId: localString(input.supplier_id) || null, supplierId: localString(input.supplier_id) || null },
    ]
    const { validateJournal } = await import("@/lib/accounting/journal")
    acquisitionJournal = validateJournal({
      id: createOfflineId("asset-acquisition-voucher"), organizationId, financialYearId: year.id, voucherNumber: series.voucherNumber,
      voucherType: "asset_purchase", voucherDate: capitalizationDate, sourceType: "FIXED_ASSET_ACQUISITION", sourceId: createOfflineId("asset-acquisition-source"),
      referenceNo: localString(input.reference_no) || null, narration: `Asset purchase · ${assetName}`, systemGenerated: true, createdBy: localString(input.actor) || null, lines,
    })
    acquisitionVoucherId = acquisitionJournal.id
  }
  const id = createOfflineId("fixed-asset")
  if (acquisitionJournal) acquisitionJournal.sourceId = id
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    if (acquisitionJournal && series) {
      await appendJournal(tx, acquisitionJournal)
      await advanceVoucherSeries(tx, organizationId, year.id, "ASSET_ACQUISITION", series)
    }
    await tx.execute(
      `INSERT INTO fixed_assets (id,organization_id,financial_year_id,asset_code,asset_name,category_id,purchase_date,capitalization_date,supplier_id,purchase_document_type,purchase_document_id,original_cost_minor,gst_itc_treatment,useful_life_months,residual_value_minor,depreciation_method,depreciation_rate_basis_points,accumulated_depreciation_minor,written_down_value_minor,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,location,department_dimension_id,cost_centre_dimension_id,project_dimension_id,acquisition_voucher_id,status,notes,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?)`,
      [id, organizationId, year.id, assetCode, assetName, category.id as SqlValue, purchaseDate, capitalizationDate, localString(input.supplier_id) || null,
        purchaseDocumentId ? "PURCHASE_INVOICE" : "DIRECT_ACQUISITION", purchaseDocumentId || null, originalCostMinor,
        localString(input.gst_itc_treatment, "REVIEW_REQUIRED").toUpperCase(), usefulLifeMonths, residualValueMinor, method, rateBasisPoints,
        originalCostMinor, assetAccount.id, accumulatedAccount.id, depreciationAccount.id, localString(input.location) || null,
        localString(input.department_dimension_id) || null, localString(input.cost_centre_dimension_id) || null, localString(input.project_dimension_id) || null,
        acquisitionVoucherId, localString(input.notes) || null, timestamp, timestamp]
    )
    await audit(tx, { organizationId, financialYearId: year.id, eventType: "fixed_asset.created", entityType: "fixed_asset", entityId: id, actor: localString(input.actor) || null, next: { assetCode, assetName, originalCostMinor, residualValueMinor, method, usefulLifeMonths, acquisitionVoucherId } })
  })
  return { asset_id: id, accounting_voucher_id: acquisitionVoucherId, original_cost_minor: originalCostMinor, written_down_value_minor: originalCostMinor }
}

export async function postAssetDepreciation(organizationId: string, input: DataRow) {
  const assetId = localString(input.asset_id)
  const periodStart = strictDate(input.period_start, "Depreciation period start")
  const periodEnd = strictDate(input.period_end, "Depreciation period end")
  if (!assetId || periodStart > periodEnd) throw new Error("Asset and a valid depreciation period are required.")
  const db = await service.requireConnection("read")
  const [asset] = await db.select<DataRow>("SELECT * FROM fixed_assets WHERE organization_id=? AND id=? LIMIT 1", [organizationId, assetId])
  if (!asset || !["ACTIVE", "FULLY_DEPRECIATED"].includes(String(asset.status))) throw new Error("An active fixed asset was not found.")
  const year = await assertFinancialYearWriteAllowed(organizationId, periodEnd, localString(input.financial_year_id))
  const [overlap] = await db.select<DataRow>("SELECT id FROM fixed_asset_depreciation WHERE organization_id=? AND asset_id=? AND NOT (period_end < ? OR period_start > ?) LIMIT 1", [organizationId, assetId, periodStart, periodEnd])
  if (overlap) throw new Error("Depreciation has already been posted for all or part of this period.")
  const result = calculateDepreciation({
    originalCostMinor: Number(asset.original_cost_minor), residualValueMinor: Number(asset.residual_value_minor), accumulatedBeforeMinor: Number(asset.accumulated_depreciation_minor),
    method: String(asset.depreciation_method) as "SLM" | "WDV", annualRateBasisPoints: Number(asset.depreciation_rate_basis_points), usefulLifeMonths: Number(asset.useful_life_months),
    capitalizationDate: String(asset.capitalization_date), periodStart, periodEnd,
  })
  if (!result.amountMinor) throw new Error("No depreciation is available for this asset and period.")
  const [expenseAccount, accumulatedAccount] = await Promise.all([
    selectedAccount(organizationId, String(asset.depreciation_expense_account_id)), selectedAccount(organizationId, String(asset.accumulated_depreciation_account_id)),
  ])
  const series = await nextVoucher(organizationId, year.id, "DEPRECIATION")
  const depreciationId = createOfflineId("asset-depreciation")
  const journal = buildDepreciationJournal({
    id: createOfflineId("depreciation-voucher"), organizationId, financialYearId: year.id, voucherNumber: series.voucherNumber,
    voucherType: "depreciation", voucherDate: periodEnd, sourceType: "FIXED_ASSET_DEPRECIATION", sourceId: depreciationId,
    referenceNo: String(asset.asset_code), narration: `Depreciation · ${String(asset.asset_name)} · ${periodStart} to ${periodEnd}`,
    systemGenerated: true, createdBy: localString(input.actor) || null, amountMinor: result.amountMinor,
    depreciationExpenseAccount: expenseAccount, accumulatedDepreciationAccount: accumulatedAccount,
  })
  const accumulated = Number(asset.accumulated_depreciation_minor) + result.amountMinor
  const nextStatus = result.closingWrittenDownValueMinor <= Number(asset.residual_value_minor) ? "FULLY_DEPRECIATED" : "ACTIVE"
  await service.transaction(async (tx) => {
    await appendJournal(tx, journal)
    await advanceVoucherSeries(tx, organizationId, year.id, "DEPRECIATION", series)
    await tx.execute(
      `INSERT INTO fixed_asset_depreciation (id,organization_id,financial_year_id,asset_id,period_start,period_end,days,opening_written_down_value_minor,depreciation_minor,closing_written_down_value_minor,accounting_voucher_id,posted_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [depreciationId, organizationId, year.id, assetId, result.effectiveStart, result.effectiveEnd, result.days, Number(asset.written_down_value_minor), result.amountMinor, result.closingWrittenDownValueMinor, journal.id, localString(input.actor) || null, nowIso()]
    )
    await tx.execute("UPDATE fixed_assets SET accumulated_depreciation_minor=?,written_down_value_minor=?,status=?,updated_at=? WHERE organization_id=? AND id=?", [accumulated, result.closingWrittenDownValueMinor, nextStatus, nowIso(), organizationId, assetId])
    await audit(tx, { organizationId, financialYearId: year.id, eventType: "fixed_asset.depreciation_posted", entityType: "fixed_asset", entityId: assetId, actor: localString(input.actor) || null, previous: { accumulated: asset.accumulated_depreciation_minor, writtenDownValue: asset.written_down_value_minor }, next: { accumulated, writtenDownValue: result.closingWrittenDownValueMinor, depreciationMinor: result.amountMinor, periodStart, periodEnd } })
  })
  return { depreciation_id: depreciationId, accounting_voucher_id: journal.id, depreciation_minor: result.amountMinor, written_down_value_minor: result.closingWrittenDownValueMinor }
}

export async function disposeFixedAsset(organizationId: string, input: DataRow) {
  const assetId = localString(input.asset_id)
  const disposalDate = strictDate(input.disposal_date, "Disposal date")
  const disposalType = localString(input.disposal_type, "SALE").toUpperCase()
  if (!assetId || !["SALE", "WRITE_OFF"].includes(disposalType)) throw new Error("Asset and disposal type are required.")
  const db = await service.requireConnection("read")
  const [asset] = await db.select<DataRow>("SELECT * FROM fixed_assets WHERE organization_id=? AND id=? LIMIT 1", [organizationId, assetId])
  if (!asset || !["ACTIVE", "FULLY_DEPRECIATED"].includes(String(asset.status))) throw new Error("An active fixed asset was not found.")
  if (disposalDate < String(asset.capitalization_date)) throw new Error("Disposal date cannot be before capitalization.")
  const year = await assertFinancialYearWriteAllowed(organizationId, disposalDate, localString(input.financial_year_id))
  const proceedsMinor = disposalType === "WRITE_OFF" ? 0 : moneyToMinor(input.proceeds || 0, "Disposal proceeds")
  const accounts = await systemAccountMap(organizationId)
  const settlement = await selectedAccount(organizationId, localString(input.settlement_account_id))
  const [assetAccount, accumulatedAccount] = await Promise.all([
    selectedAccount(organizationId, String(asset.asset_account_id)), selectedAccount(organizationId, String(asset.accumulated_depreciation_account_id)),
  ])
  const series = await nextVoucher(organizationId, year.id, "ASSET_DISPOSAL")
  const disposalId = createOfflineId("asset-disposal")
  const result = buildAssetDisposalJournal({
    id: createOfflineId("asset-disposal-voucher"), organizationId, financialYearId: year.id, voucherNumber: series.voucherNumber,
    voucherType: "adjustment", voucherDate: disposalDate, sourceType: "FIXED_ASSET_DISPOSAL", sourceId: disposalId,
    referenceNo: String(asset.asset_code), narration: `${disposalType === "WRITE_OFF" ? "Write-off" : "Disposal"} · ${String(asset.asset_name)}`,
    systemGenerated: true, createdBy: localString(input.actor) || null, originalCostMinor: Number(asset.original_cost_minor),
    accumulatedDepreciationMinor: Number(asset.accumulated_depreciation_minor), proceedsMinor,
    assetAccount, accumulatedDepreciationAccount: accumulatedAccount, settlementAccount: settlement,
    gainAccount: requireRole(accounts, "ASSET_DISPOSAL_GAIN"), lossAccount: requireRole(accounts, "ASSET_DISPOSAL_LOSS"),
  })
  await service.transaction(async (tx) => {
    await appendJournal(tx, result.journal)
    await advanceVoucherSeries(tx, organizationId, year.id, "ASSET_DISPOSAL", series)
    await tx.execute(
      `INSERT INTO fixed_asset_disposals (id,organization_id,financial_year_id,asset_id,disposal_date,disposal_type,proceeds_minor,written_down_value_minor,gain_minor,loss_minor,settlement_account_id,accounting_voucher_id,notes,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [disposalId, organizationId, year.id, assetId, disposalDate, disposalType, proceedsMinor, result.writtenDownValueMinor, result.gainMinor, result.lossMinor, settlement.id, result.journal.id, localString(input.notes) || null, nowIso()]
    )
    await tx.execute("UPDATE fixed_assets SET status=?,disposal_date=?,disposal_proceeds_minor=?,updated_at=? WHERE organization_id=? AND id=?", [disposalType === "WRITE_OFF" ? "WRITTEN_OFF" : "DISPOSED", disposalDate, proceedsMinor, nowIso(), organizationId, assetId])
    await audit(tx, { organizationId, financialYearId: year.id, eventType: disposalType === "WRITE_OFF" ? "fixed_asset.written_off" : "fixed_asset.disposed", entityType: "fixed_asset", entityId: assetId, actor: localString(input.actor) || null, reason: localString(input.notes) || null, next: { disposalDate, proceedsMinor, gainMinor: result.gainMinor, lossMinor: result.lossMinor, voucherId: result.journal.id } })
  })
  return { disposal_id: disposalId, accounting_voucher_id: result.journal.id, proceeds_minor: proceedsMinor, gain_minor: result.gainMinor, loss_minor: result.lossMinor }
}

export async function saveTaxRule(organizationId: string, input: DataRow) {
  const taxType = localString(input.tax_type).toUpperCase()
  const sectionCode = localString(input.section_code).toUpperCase()
  const description = localString(input.description)
  const effectiveFrom = strictDate(input.effective_from, "Effective-from date")
  const effectiveTo = localString(input.effective_to) ? strictDate(input.effective_to, "Effective-to date") : null
  const rateBasisPoints = moneyToMinor(input.rate, "Tax rate")
  const thresholdMinor = moneyToMinor(input.threshold || 0, "Tax threshold")
  if (!["TDS", "TCS"].includes(taxType) || !sectionCode || !description) throw new Error("Tax type, section code, and description are required.")
  if (effectiveTo && effectiveTo < effectiveFrom) throw new Error("Tax-rule end date cannot be before its start date.")
  if (rateBasisPoints < 0 || rateBasisPoints > 100_000) throw new Error("Tax rate must be between 0% and 1,000%.")
  const id = localString(input.id, createOfflineId("tax-rule"))
  const db = await service.requireConnection("read")
  const [existing] = await db.select<DataRow>("SELECT rule.*,EXISTS(SELECT 1 FROM tax_transactions tax WHERE tax.tax_rule_id=rule.id) has_history FROM tax_rules rule WHERE rule.organization_id=? AND rule.id=?", [organizationId, id])
  if (existing?.has_history && [taxType, sectionCode, effectiveFrom, effectiveTo, rateBasisPoints, thresholdMinor].some((value, index) => String(value ?? "") !== String([existing.tax_type, existing.section_code, existing.effective_from, existing.effective_to, existing.rate_basis_points, existing.threshold_minor][index] ?? ""))) {
    throw new Error("A tax rule with posted history cannot be rewritten. End-date it and create a new effective rule.")
  }
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO tax_rules (id,organization_id,tax_type,section_code,description,effective_from,effective_to,rate_basis_points,threshold_minor,pan_required,is_active,notes,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET description=excluded.description,effective_to=excluded.effective_to,pan_required=excluded.pan_required,is_active=excluded.is_active,notes=excluded.notes,updated_at=excluded.updated_at`,
      [id, organizationId, taxType, sectionCode, description, effectiveFrom, effectiveTo, rateBasisPoints, thresholdMinor, bool(input.pan_required) ? 1 : 0, input.is_active === false ? 0 : 1, localString(input.notes) || null, timestamp, timestamp]
    )
    await audit(tx, { organizationId, eventType: existing ? "tax_rule.updated" : "tax_rule.created", entityType: "tax_rule", entityId: id, actor: localString(input.actor) || null, reason: localString(input.reason) || null, previous: existing, next: { taxType, sectionCode, effectiveFrom, effectiveTo, rateBasisPoints, thresholdMinor } })
  })
  return { id, tax_type: taxType, section_code: sectionCode, rate_basis_points: rateBasisPoints, threshold_minor: thresholdMinor }
}

async function taxRuleForPosting(organizationId: string, id: string, taxType: "TDS" | "TCS", transactionDate: string) {
  const db = await service.requireConnection("read")
  const [rule] = await db.select<DataRow>("SELECT * FROM tax_rules WHERE organization_id=? AND id=? AND tax_type=? AND is_active=1 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) LIMIT 1", [organizationId, id, taxType, transactionDate, transactionDate])
  if (!rule) throw new Error(`No active ${taxType} rule covers the transaction date.`)
  return rule
}

export async function postTdsTransaction(organizationId: string, input: DataRow) {
  const financialYearId = localString(input.financial_year_id)
  const deductionDate = strictDate(input.deduction_date, "TDS deduction date")
  const year = await assertFinancialYearWriteAllowed(organizationId, deductionDate, financialYearId)
  await initializeAccounting(organizationId, deductionDate)
  const supplierId = localString(input.supplier_id || input.party_id)
  if (!supplierId) throw new Error("Supplier/deductee is required.")
  const rule = await taxRuleForPosting(organizationId, localString(input.tax_rule_id), "TDS", deductionDate)
  const taxableMinor = moneyToMinor(input.taxable_amount, "TDS taxable amount")
  if (taxableMinor < Number(rule.threshold_minor || 0) && !bool(input.override_threshold)) throw new Error("Taxable amount is below the configured TDS threshold. Confirm an explicit threshold override if deduction is still required.")
  const db = await service.requireConnection("read")
  const [supplier] = await db.select<DataRow>("SELECT id,pan,name FROM suppliers WHERE organization_id=? AND id=? AND is_active=1 AND deleted_at IS NULL", [organizationId, supplierId])
  if (!supplier) throw new Error("Supplier/deductee was not found.")
  const partyPan = localString(input.party_pan, localString(supplier.pan)).toUpperCase()
  if (Number(rule.pan_required || 0) && !partyPan) throw new Error("Deductee PAN is required by this configured TDS rule.")
  const mode = localString(input.posting_mode, "EXPENSE_ACCRUAL").toUpperCase() as "EXPENSE_ACCRUAL" | "PAYMENT_DEDUCTION"
  if (!["EXPENSE_ACCRUAL", "PAYMENT_DEDUCTION"].includes(mode)) throw new Error("TDS posting mode is invalid.")
  const accounts = await systemAccountMap(organizationId)
  const expense = mode === "EXPENSE_ACCRUAL" ? await selectedAccount(organizationId, localString(input.expense_account_id)) : requireRole(accounts, "ACCOUNTS_PAYABLE")
  const settlement = mode === "PAYMENT_DEDUCTION" ? await selectedAccount(organizationId, localString(input.payment_account_id)) : undefined
  const series = await nextVoucher(organizationId, year.id, "TDS")
  const id = createOfflineId("tds-transaction")
  const result = buildTdsJournal({
    id: createOfflineId("tds-voucher"), organizationId, financialYearId: year.id, voucherNumber: series.voucherNumber,
    voucherType: "tds", voucherDate: deductionDate, sourceType: "TDS_TRANSACTION", sourceId: id,
    referenceNo: localString(input.reference_no) || null, narration: `TDS ${String(rule.section_code)} · ${String(supplier.name)}`,
    systemGenerated: true, createdBy: localString(input.actor) || null, mode, taxableMinor,
    rateBasisPoints: Number(rule.rate_basis_points), tdsMinor: input.tax_amount === undefined || input.tax_amount === "" ? undefined : moneyToMinor(input.tax_amount, "TDS amount"),
    supplierId, expenseAccount: expense, accountsPayableAccount: requireRole(accounts, "ACCOUNTS_PAYABLE"), tdsPayableAccount: requireRole(accounts, "TDS_PAYABLE"), settlementAccount: settlement,
  })
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await appendJournal(tx, result.journal)
    await advanceVoucherSeries(tx, organizationId, year.id, "TDS", series)
    await tx.execute(
      `INSERT INTO tax_transactions (id,organization_id,financial_year_id,tax_type,tax_rule_id,section_code,party_type,party_id,party_pan,source_type,source_id,deduction_basis,taxable_minor,rate_basis_points,tax_minor,deduction_date,payment_date,challan_reference,status,accounting_voucher_id,notes,created_at,updated_at)
       VALUES (?,?,?,'TDS',?,?,?,?,?,'TDS_TRANSACTION',?,?,?,?,?,?,?,?, 'DEDUCTED',?,?,?,?)`,
      [id, organizationId, year.id, rule.id as SqlValue, rule.section_code as SqlValue, "supplier", supplierId, partyPan || null, id,
        localString(input.deduction_basis, mode), taxableMinor, Number(rule.rate_basis_points), result.tdsMinor, deductionDate,
        localString(input.payment_date) ? strictDate(input.payment_date, "TDS payment date") : null, localString(input.challan_reference) || null,
        result.journal.id, localString(input.notes) || null, timestamp, timestamp]
    )
    await tx.execute("UPDATE suppliers SET current_balance=current_balance+?,updated_at=? WHERE organization_id=? AND id=?", [minorToMoney(mode === "EXPENSE_ACCRUAL" ? result.netPartyMinor : -taxableMinor), timestamp, organizationId, supplierId])
    await audit(tx, { organizationId, financialYearId: year.id, eventType: "tds.deducted", entityType: "tax_transaction", entityId: id, actor: localString(input.actor) || null, next: { supplierId, sectionCode: rule.section_code, taxableMinor, taxMinor: result.tdsMinor, voucherId: result.journal.id } })
  })
  return { tax_transaction_id: id, accounting_voucher_id: result.journal.id, taxable_minor: taxableMinor, tax_minor: result.tdsMinor, net_party_minor: result.netPartyMinor }
}

export async function postTcsTransaction(organizationId: string, input: DataRow) {
  const financialYearId = localString(input.financial_year_id)
  const collectionDate = strictDate(input.collection_date || input.deduction_date, "TCS collection date")
  const year = await assertFinancialYearWriteAllowed(organizationId, collectionDate, financialYearId)
  await initializeAccounting(organizationId, collectionDate)
  const customerId = localString(input.customer_id || input.party_id)
  if (!customerId) throw new Error("Customer/collectee is required.")
  const rule = await taxRuleForPosting(organizationId, localString(input.tax_rule_id), "TCS", collectionDate)
  const taxableMinor = moneyToMinor(input.taxable_amount, "TCS taxable amount")
  if (taxableMinor < Number(rule.threshold_minor || 0) && !bool(input.override_threshold)) throw new Error("Taxable amount is below the configured TCS threshold. Confirm an explicit threshold override if collection is still required.")
  const db = await service.requireConnection("read")
  const [customer] = await db.select<DataRow>("SELECT id,name,pan FROM customers WHERE organization_id=? AND id=? AND is_active=1 AND deleted_at IS NULL", [organizationId, customerId])
  if (!customer) throw new Error("Customer/collectee was not found.")
  const partyPan = localString(input.party_pan, localString(customer.pan)).toUpperCase()
  if (Number(rule.pan_required || 0) && !partyPan) throw new Error("Collectee PAN is required by this configured TCS rule.")
  const accounts = await systemAccountMap(organizationId)
  const series = await nextVoucher(organizationId, year.id, "TCS")
  const id = createOfflineId("tcs-transaction")
  const result = buildTcsJournal({
    id: createOfflineId("tcs-voucher"), organizationId, financialYearId: year.id, voucherNumber: series.voucherNumber,
    voucherType: "tcs", voucherDate: collectionDate, sourceType: "TCS_TRANSACTION", sourceId: id,
    referenceNo: localString(input.reference_no) || null, narration: `TCS ${String(rule.section_code)} · ${String(customer.name)}`,
    systemGenerated: true, createdBy: localString(input.actor) || null, taxableMinor, rateBasisPoints: Number(rule.rate_basis_points),
    tcsMinor: input.tax_amount === undefined || input.tax_amount === "" ? undefined : moneyToMinor(input.tax_amount, "TCS amount"),
    customerId, receivableAccount: requireRole(accounts, "ACCOUNTS_RECEIVABLE"), tcsPayableAccount: requireRole(accounts, "TCS_PAYABLE"),
  })
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await appendJournal(tx, result.journal)
    await advanceVoucherSeries(tx, organizationId, year.id, "TCS", series)
    await tx.execute(
      `INSERT INTO tax_transactions (id,organization_id,financial_year_id,tax_type,tax_rule_id,section_code,party_type,party_id,party_pan,source_type,source_id,deduction_basis,taxable_minor,rate_basis_points,tax_minor,deduction_date,payment_date,challan_reference,status,accounting_voucher_id,notes,created_at,updated_at)
       VALUES (?,?,?,'TCS',?,?,?,?,?,'TCS_TRANSACTION',?,'SALES_COLLECTION',?,?,?,?,?,?, 'COLLECTED',?,?,?,?)`,
      [id, organizationId, year.id, rule.id as SqlValue, rule.section_code as SqlValue, "customer", customerId, partyPan || null, id,
        taxableMinor, Number(rule.rate_basis_points), result.tcsMinor, collectionDate,
        localString(input.payment_date) ? strictDate(input.payment_date, "TCS payment date") : null, localString(input.challan_reference) || null,
        result.journal.id, localString(input.notes) || null, timestamp, timestamp]
    )
    await tx.execute("UPDATE customers SET current_balance=current_balance+?,updated_at=? WHERE organization_id=? AND id=?", [minorToMoney(result.tcsMinor), timestamp, organizationId, customerId])
    await audit(tx, { organizationId, financialYearId: year.id, eventType: "tcs.collected", entityType: "tax_transaction", entityId: id, actor: localString(input.actor) || null, next: { customerId, sectionCode: rule.section_code, taxableMinor, taxMinor: result.tcsMinor, voucherId: result.journal.id } })
  })
  return { tax_transaction_id: id, accounting_voucher_id: result.journal.id, taxable_minor: taxableMinor, tax_minor: result.tcsMinor }
}

export async function recordTaxPayment(organizationId: string, input: DataRow) {
  const id = localString(input.tax_transaction_id || input.id)
  const paymentDate = strictDate(input.payment_date, "Tax payment date")
  const challan = localString(input.challan_reference)
  if (!id || !challan) throw new Error("Tax transaction, payment date, and challan/reference are required.")
  const db = await service.requireConnection("read")
  const [current] = await db.select<DataRow>("SELECT * FROM tax_transactions WHERE organization_id=? AND id=?", [organizationId, id])
  if (!current) throw new Error("Tax transaction was not found.")
  if (current.status === "REVERSED") throw new Error("A reversed tax transaction cannot be marked paid.")
  if (current.status === "PAID" && current.payment_accounting_voucher_id) return { id, status: "PAID", payment_date: current.payment_date, challan_reference: current.challan_reference, payment_accounting_voucher_id: current.payment_accounting_voucher_id, idempotent: true }
  const year = await assertFinancialYearWriteAllowed(organizationId, paymentDate, localString(input.financial_year_id))
  const paymentAccount = await selectedAccount(organizationId, localString(input.payment_account_id))
  if (!paymentAccount || !["CASH", "BANK"].includes(String(paymentAccount.systemRole || ""))) throw new Error("Select an active cash or bank ledger for the tax payment.")
  const accounts = await systemAccountMap(organizationId)
  const taxType = String(current.tax_type) === "TCS" ? "TCS" : "TDS"
  const payable = requireRole(accounts, taxType === "TCS" ? "TCS_PAYABLE" : "TDS_PAYABLE")
  const series = await nextVoucher(organizationId, year.id, `${taxType}_PAYMENT`)
  const paymentVoucherId = createOfflineId(`${taxType.toLowerCase()}-payment-voucher`)
  const paymentJournal = {
    id: paymentVoucherId, organizationId, financialYearId: year.id, voucherNumber: series.voucherNumber, voucherType: "payment",
    voucherDate: paymentDate, sourceType: `${taxType}_PAYMENT`, sourceId: id, referenceNo: challan,
    narration: `${taxType} payment · ${String(current.section_code)} · ${challan}`, systemGenerated: true, createdBy: localString(input.actor) || null,
    lines: [
      { accountId: payable.id, accountType: payable.accountType, debitMinor: Number(current.tax_minor), creditMinor: 0, description: `${taxType} liability settled` },
      { accountId: paymentAccount.id, accountType: paymentAccount.accountType, debitMinor: 0, creditMinor: Number(current.tax_minor), description: `Paid via ${paymentAccount.accountName}` },
    ] as JournalLine[],
  }
  await service.transaction(async (tx) => {
    await appendJournal(tx, paymentJournal)
    await advanceVoucherSeries(tx, organizationId, year.id, `${taxType}_PAYMENT`, series)
    await tx.execute("UPDATE tax_transactions SET status='PAID',payment_date=?,challan_reference=?,payment_accounting_voucher_id=?,notes=?,updated_at=? WHERE organization_id=? AND id=?", [paymentDate, challan, paymentVoucherId, localString(input.notes) || current.notes as SqlValue || null, nowIso(), organizationId, id])
    await audit(tx, { organizationId, financialYearId: year.id, eventType: `${taxType.toLowerCase()}.payment_recorded`, entityType: "tax_transaction", entityId: id, actor: localString(input.actor) || null, reason: localString(input.notes) || null, previous: { status: current.status, paymentDate: current.payment_date, challan: current.challan_reference }, next: { status: "PAID", paymentDate, challan, paymentVoucherId } })
  })
  return { id, status: "PAID", payment_date: paymentDate, challan_reference: challan, payment_accounting_voucher_id: paymentVoucherId }
}

export async function saveGstReturnPeriod(organizationId: string, input: DataRow) {
  const financialYearId = localString(input.financial_year_id)
  const returnType = localString(input.return_type).toUpperCase().replace("-", "")
  const periodStart = strictDate(input.period_start, "GST return period start")
  const periodEnd = strictDate(input.period_end, "GST return period end")
  const status = localString(input.status, "DRAFT").toUpperCase().replaceAll(" ", "_")
  if (!financialYearId || !["GSTR1", "GSTR3B"].includes(returnType) || periodStart > periodEnd) throw new Error("GST return type and period are invalid.")
  if (!["DRAFT", "NEEDS_REVIEW", "READY_FOR_EXPORT", "EXPORTED", "FILED_EXTERNALLY"].includes(status)) throw new Error("GST preparation status is invalid.")
  const year = await getFinancialYear(organizationId, financialYearId)
  if (!year || periodStart < year.start_date || periodEnd > year.end_date) throw new Error("GST return period must be inside the selected financial year.")
  const validation = await phaseTwoAccountingReport({ organizationId, financialYearId, report: "gst-validation", from: periodStart, to: periodEnd, page: 1, limit: 200 })
  const issueCount = Number(validation.total || 0)
  if (["READY_FOR_EXPORT", "EXPORTED"].includes(status) && issueCount > 0) throw new Error(`GST preparation has ${issueCount} validation issue(s). Resolve or review them before marking it ready.`)
  if (status === "FILED_EXTERNALLY" && !bool(input.confirm_external_filing)) throw new Error("Confirm that this return was filed outside BezGrow. BezGrow does not submit it to GSTN.")
  const db = await service.requireConnection("read")
  const [existing] = await db.select<DataRow>("SELECT * FROM gst_return_periods WHERE organization_id=? AND return_type=? AND period_start=? AND period_end=?", [organizationId, returnType, periodStart, periodEnd])
  const id = localString(existing?.id, createOfflineId("gst-return-period"))
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO gst_return_periods (id,organization_id,financial_year_id,return_type,period_start,period_end,status,validation_snapshot_json,exported_at,filed_externally_at,notes,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,return_type,period_start,period_end) DO UPDATE SET status=excluded.status,validation_snapshot_json=excluded.validation_snapshot_json,exported_at=excluded.exported_at,filed_externally_at=excluded.filed_externally_at,notes=excluded.notes,updated_at=excluded.updated_at`,
      [id, organizationId, financialYearId, returnType, periodStart, periodEnd, status, safeSnapshot({ issueCount, checkedAt: timestamp }), status === "EXPORTED" ? timestamp : existing?.exported_at as SqlValue || null, status === "FILED_EXTERNALLY" ? timestamp : existing?.filed_externally_at as SqlValue || null, localString(input.notes) || null, existing?.created_at as SqlValue || timestamp, timestamp]
    )
    await audit(tx, { organizationId, financialYearId, eventType: "gst_return.status_changed", entityType: "gst_return_period", entityId: id, actor: localString(input.actor) || null, reason: localString(input.notes) || null, previous: existing ? { status: existing.status } : null, next: { returnType, periodStart, periodEnd, status, issueCount } })
  })
  return { id, return_type: returnType, status, validation_issues: issueCount }
}

export async function importGstRecords(organizationId: string, input: DataRow) {
  const financialYearId = localString(input.financial_year_id)
  const rows = Array.isArray(input.rows) ? input.rows as DataRow[] : []
  const fileName = localString(input.file_name)
  const fileSha = localString(input.file_sha256).toLowerCase()
  if (!financialYearId || !fileName || !/^[a-f0-9]{64}$/.test(fileSha) || !rows.length) throw new Error("GST import requires a file name, SHA-256, financial year, and at least one structured row.")
  if (fileName.length > 255 || fileName === "." || fileName === ".." || /[\\/]/.test(fileName)) throw new Error("GST import file name must not contain a path.")
  if (rows.length > 100_000) throw new Error("GST import exceeds the 100,000-row safety limit.")
  const year = await getFinancialYear(organizationId, financialYearId)
  if (!year) throw new Error("Financial year was not found.")
  const normalized = rows.map((row, index) => {
    const invoiceNumber = localString(row.invoice_number)
    const invoiceDate = strictDate(row.invoice_date, `GST row ${index + 1} invoice date`)
    if (!invoiceNumber || invoiceDate < year.start_date || invoiceDate > year.end_date) throw new Error(`GST row ${index + 1} has an invalid invoice number or financial-year date.`)
    return {
      id: createOfflineId("gst-import-record"), supplierGstin: localString(row.supplier_gstin || row.gstin).toUpperCase(), invoiceNumber,
      normalizedInvoiceNumber: normalizeInvoiceReference(invoiceNumber), invoiceDate,
      taxableMinor: moneyToMinor(row.taxable_value ?? row.taxable_amount, `GST row ${index + 1} taxable value`),
      cgstMinor: moneyToMinor(row.cgst || 0, `GST row ${index + 1} CGST`), sgstMinor: moneyToMinor(row.sgst || 0, `GST row ${index + 1} SGST`),
      igstMinor: moneyToMinor(row.igst || 0, `GST row ${index + 1} IGST`), cessMinor: moneyToMinor(row.cess || 0, `GST row ${index + 1} cess`),
      rowNumber: index + 1, raw: safeSnapshot(row),
    }
  })
  for (const row of normalized) {
    const gstin = validateGstinFormat(row.supplierGstin)
    if (!row.supplierGstin || !gstin.valid) throw new Error(`GST import row ${row.rowNumber} supplier GSTIN is not format valid.`)
    if ([row.taxableMinor, row.cgstMinor, row.sgstMinor, row.igstMinor, row.cessMinor].some((value) => value < 0)) throw new Error(`GST import row ${row.rowNumber} contains a negative amount.`)
    if (row.igstMinor && (row.cgstMinor || row.sgstMinor)) throw new Error(`GST import row ${row.rowNumber} mixes IGST with CGST/SGST.`)
  }
  const importedKeys = new Set<string>()
  for (const row of normalized) {
    const key = `${row.supplierGstin}:${row.normalizedInvoiceNumber}`
    if (importedKeys.has(key)) throw new Error(`GST import contains duplicate supplier invoice ${row.invoiceNumber}.`)
    importedKeys.add(key)
  }
  const db = await service.requireConnection("read")
  const [duplicate] = await db.select<DataRow>("SELECT id FROM gst_import_batches WHERE organization_id=? AND file_sha256=?", [organizationId, fileSha])
  if (duplicate) return { batch_id: duplicate.id, row_count: rows.length, idempotent: true }
  const books = await db.select<DataRow>(
    `SELECT purchase.id,purchase.supplier_gstin,purchase.supplier_invoice_number,purchase.purchase_date,purchase.taxable_minor,purchase.cgst_minor,purchase.sgst_minor,purchase.igst_minor,purchase.cess_minor
     FROM purchase_invoices purchase WHERE purchase.organization_id=? AND purchase.financial_year_id=? AND purchase.invoice_kind='purchase_invoice' AND purchase.document_status='POSTED' AND purchase.deleted_at IS NULL`,
    [organizationId, financialYearId]
  )
  const batchId = createOfflineId("gst-import")
  const timestamp = nowIso()
  const reconciliations = normalized.map((row) => {
    const candidates = books.filter((book) => row.supplierGstin && String(book.supplier_gstin || "").toUpperCase() === row.supplierGstin)
    const exactNumber = candidates.find((book) => normalizeInvoiceReference(String(book.supplier_invoice_number || "")) === row.normalizedInvoiceNumber)
    const candidate = exactNumber || candidates.find((book) => Number(book.taxable_minor) === row.taxableMinor) || null
    const match = classifyGstReconciliation(candidate ? {
      id: String(candidate.id), gstin: String(candidate.supplier_gstin || ""), invoiceNumber: String(candidate.supplier_invoice_number || ""), invoiceDate: String(candidate.purchase_date), taxableMinor: Number(candidate.taxable_minor), cgstMinor: Number(candidate.cgst_minor), sgstMinor: Number(candidate.sgst_minor), igstMinor: Number(candidate.igst_minor), cessMinor: Number(candidate.cess_minor),
    } : null, { id: row.id, gstin: row.supplierGstin, invoiceNumber: row.invoiceNumber, invoiceDate: row.invoiceDate, taxableMinor: row.taxableMinor, cgstMinor: row.cgstMinor, sgstMinor: row.sgstMinor, igstMinor: row.igstMinor, cessMinor: row.cessMinor })
    return { row, candidate, match }
  })
  const matchedBookIds = new Set(reconciliations.flatMap((item) => item.candidate ? [String(item.candidate.id)] : []))
  const missingImports = books.filter((book) => !matchedBookIds.has(String(book.id)))
  await service.transaction(async (tx) => {
    await tx.execute("INSERT INTO gst_import_batches (id,organization_id,financial_year_id,import_type,file_name,file_sha256,row_count,imported_by,imported_at,status) VALUES (?,?,?,?,?,?,?,?,?,'IMPORTED')", [batchId, organizationId, financialYearId, localString(input.import_type, "GSTR2B"), fileName, fileSha, normalized.length, localString(input.actor) || null, timestamp])
    for (const item of reconciliations) {
      const row = item.row
      await tx.execute("INSERT INTO gst_import_records (id,organization_id,batch_id,supplier_gstin,invoice_number,normalized_invoice_number,invoice_date,taxable_minor,cgst_minor,sgst_minor,igst_minor,cess_minor,source_row_number,raw_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [row.id, organizationId, batchId, row.supplierGstin || null, row.invoiceNumber, row.normalizedInvoiceNumber, row.invoiceDate, row.taxableMinor, row.cgstMinor, row.sgstMinor, row.igstMinor, row.cessMinor, row.rowNumber, row.raw, timestamp])
      await tx.execute("INSERT INTO gst_reconciliations (id,organization_id,financial_year_id,import_record_id,book_source_type,book_source_id,classification,match_score,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", [createOfflineId("gst-reconciliation"), organizationId, financialYearId, row.id, item.candidate ? "PURCHASE" : null, item.candidate ? String(item.candidate.id) : null, item.match.classification, item.match.score, timestamp, timestamp])
    }
    for (const book of missingImports) {
      await tx.execute("INSERT INTO gst_reconciliations (id,organization_id,financial_year_id,import_record_id,book_source_type,book_source_id,classification,match_score,created_at,updated_at) VALUES (?,?,?,NULL,'PURCHASE',?,'MISSING_IN_IMPORTED_DATA',0,?,?)", [createOfflineId("gst-reconciliation"), organizationId, financialYearId, String(book.id), timestamp, timestamp])
    }
    await audit(tx, { organizationId, financialYearId, eventType: "gst_data.imported", entityType: "gst_import_batch", entityId: batchId, actor: localString(input.actor) || null, next: { fileName, fileSha, rowCount: normalized.length, missingInImportedData: missingImports.length } })
  })
  return { batch_id: batchId, row_count: normalized.length, missing_in_imported_data: missingImports.length, classifications: Object.fromEntries([...new Set(reconciliations.map((item) => item.match.classification))].map((classification) => [classification, reconciliations.filter((item) => item.match.classification === classification).length])) }
}

export async function saveEInvoicePreparation(organizationId: string, input: DataRow) {
  const financialYearId = localString(input.financial_year_id)
  const sourceType = localString(input.source_type)
  const sourceId = localString(input.source_id)
  if (!financialYearId || !sourceType || !sourceId) throw new Error("E-invoice source and financial year are required.")
  const validation = validateEInvoicePreparation(input)
  const status = validation.valid ? "READY" : "VALIDATION_FAILED"
  const db = await service.requireConnection("read")
  const [existing] = await db.select<DataRow>("SELECT id FROM e_invoice_preparations WHERE organization_id=? AND source_type=? AND source_id=?", [organizationId, sourceType, sourceId])
  const id = localString(existing?.id, createOfflineId("e-invoice-preparation"))
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await tx.execute(`INSERT INTO e_invoice_preparations (id,organization_id,financial_year_id,source_type,source_id,status,request_json,validation_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,source_type,source_id) DO UPDATE SET status=excluded.status,request_json=excluded.request_json,validation_json=excluded.validation_json,updated_at=excluded.updated_at`,
    [id, organizationId, financialYearId, sourceType, sourceId, status, safeSnapshot(input), safeSnapshot(validation), timestamp, timestamp])
    await audit(tx, { organizationId, financialYearId, eventType: "e_invoice.prepared", entityType: "e_invoice_preparation", entityId: id, actor: localString(input.actor) || null, next: { sourceType, sourceId, status, errors: validation.errors.length, integrationStatus: validation.integrationStatus } })
  })
  return { id, status, validation, message: "E-Invoice Integration Not Configured" }
}

export async function saveEwayBillPreparation(organizationId: string, input: DataRow) {
  const financialYearId = localString(input.financial_year_id)
  const sourceType = localString(input.source_type)
  const sourceId = localString(input.source_id)
  if (!financialYearId || !sourceType || !sourceId) throw new Error("E-Way Bill source and financial year are required.")
  const validation = validateEwayBillPreparation(input)
  const status = validation.valid ? "READY" : "VALIDATION_FAILED"
  const db = await service.requireConnection("read")
  const [existing] = await db.select<DataRow>("SELECT id FROM e_way_bill_preparations WHERE organization_id=? AND source_type=? AND source_id=?", [organizationId, sourceType, sourceId])
  const id = localString(existing?.id, createOfflineId("e-way-preparation"))
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await tx.execute(`INSERT INTO e_way_bill_preparations (id,organization_id,financial_year_id,source_type,source_id,status,transport_json,validation_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,source_type,source_id) DO UPDATE SET status=excluded.status,transport_json=excluded.transport_json,validation_json=excluded.validation_json,updated_at=excluded.updated_at`,
    [id, organizationId, financialYearId, sourceType, sourceId, status, safeSnapshot(input), safeSnapshot(validation), timestamp, timestamp])
    await audit(tx, { organizationId, financialYearId, eventType: "e_way_bill.prepared", entityType: "e_way_bill_preparation", entityId: id, actor: localString(input.actor) || null, next: { sourceType, sourceId, status, errors: validation.errors.length, integrationStatus: validation.integrationStatus } })
  })
  return { id, status, validation, message: "E-Way Bill Integration Not Configured" }
}

export async function importBankStatement(organizationId: string, input: DataRow) {
  const financialYearId = localString(input.financial_year_id)
  const bankAccountId = localString(input.bank_account_id)
  const fileName = localString(input.file_name)
  const fileSha = localString(input.file_sha256).toLowerCase()
  const rows = Array.isArray(input.rows) ? input.rows as DataRow[] : []
  if (!financialYearId || !bankAccountId || !fileName || !/^[a-f0-9]{64}$/.test(fileSha) || !rows.length) throw new Error("Bank import requires a bank, financial year, file name, SHA-256, and structured rows.")
  if (fileName.length > 255 || fileName === "." || fileName === ".." || /[\\/]/.test(fileName)) throw new Error("Bank import file name must not contain a path.")
  if (rows.length > 100_000) throw new Error("Bank statement exceeds the 100,000-row safety limit.")
  const db = await service.requireConnection("read")
  const [bank] = await db.select<DataRow>("SELECT id,account_id FROM bank_accounts WHERE organization_id=? AND id=? AND is_active=1 AND deleted_at IS NULL", [organizationId, bankAccountId])
  if (!bank) throw new Error("Bank account was not found.")
  const [duplicate] = await db.select<DataRow>("SELECT id FROM bank_statement_imports WHERE organization_id=? AND bank_account_id=? AND file_sha256=?", [organizationId, bankAccountId, fileSha])
  if (duplicate) return { import_id: duplicate.id, row_count: rows.length, idempotent: true }
  const normalized = rows.map((row, index) => {
    const amountMinor = moneyToMinor(row.amount, `Bank row ${index + 1} amount`)
    const direction = localString(row.direction, amountMinor < 0 ? "OUT" : "IN").toUpperCase()
    const signedMinor = direction === "OUT" ? -Math.abs(amountMinor) : Math.abs(amountMinor)
    if (!signedMinor) throw new Error(`Bank row ${index + 1} amount must be non-zero.`)
    return { id: createOfflineId("bank-statement-line"), transactionDate: strictDate(row.transaction_date || row.date, `Bank row ${index + 1} date`), amountMinor: signedMinor, reference: localString(row.reference), description: localString(row.description), rowNumber: index + 1, raw: safeSnapshot(row) }
  })
  const from = normalized.reduce((min, row) => row.transactionDate < min ? row.transactionDate : min, normalized[0].transactionDate)
  const to = normalized.reduce((max, row) => row.transactionDate > max ? row.transactionDate : max, normalized[0].transactionDate)
  const entries = await db.select<DataRow>(
    `SELECT line.id,voucher.voucher_date,line.debit_minor,line.credit_minor,voucher.reference_no,voucher.narration
     FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id
     WHERE line.organization_id=? AND line.account_id=? AND voucher.financial_year_id=? AND voucher.status='posted' AND voucher.voucher_date BETWEEN ? AND ?`,
    [organizationId, String(bank.account_id), financialYearId, from, to]
  )
  const suggestions = normalized.map((row) => {
    const expected = row.amountMinor > 0 ? row.amountMinor : row.amountMinor
    const candidates = entries.map((entry) => {
      const bookSigned = Number(entry.debit_minor || 0) - Number(entry.credit_minor || 0)
      let score = bookSigned === expected ? 70 : 0
      if (String(entry.voucher_date) === row.transactionDate) score += 20
      const reference = normalizeInvoiceReference(row.reference)
      if (reference && normalizeInvoiceReference(String(entry.reference_no || "")).includes(reference)) score += 10
      return { entry, score }
    }).filter((candidate) => candidate.score >= 70).sort((a, b) => b.score - a.score)
    return { row, match: candidates[0] || null }
  })
  const importId = createOfflineId("bank-statement-import")
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await tx.execute("INSERT INTO bank_statement_imports (id,organization_id,financial_year_id,bank_account_id,file_name,file_sha256,row_count,status,created_at) VALUES (?,?,?,?,?,?,?,'IMPORTED',?)", [importId, organizationId, financialYearId, bankAccountId, fileName, fileSha, normalized.length, timestamp])
    for (const suggestion of suggestions) {
      const row = suggestion.row
      await tx.execute("INSERT INTO bank_statement_lines (id,organization_id,import_id,transaction_date,amount_minor,reference,description,source_row_number,raw_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", [row.id, organizationId, importId, row.transactionDate, row.amountMinor, row.reference || null, row.description || null, row.rowNumber, row.raw, timestamp])
      await tx.execute("INSERT INTO bank_statement_matches (id,organization_id,statement_line_id,voucher_entry_id,match_status,match_score,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", [createOfflineId("bank-statement-match"), organizationId, row.id, suggestion.match ? String(suggestion.match.entry.id) : null, suggestion.match ? "SUGGESTED" : "UNMATCHED", suggestion.match?.score || 0, timestamp, timestamp])
    }
    await audit(tx, { organizationId, financialYearId, eventType: "bank_statement.imported", entityType: "bank_statement_import", entityId: importId, actor: localString(input.actor) || null, next: { fileName, fileSha, rowCount: normalized.length, suggestedMatches: suggestions.filter((item) => item.match).length } })
  })
  return { import_id: importId, row_count: normalized.length, suggested_matches: suggestions.filter((item) => item.match).length }
}

export async function confirmBankStatementMatch(organizationId: string, input: DataRow) {
  const matchId = localString(input.match_id)
  const status = localString(input.status).toUpperCase()
  if (!matchId || !["CONFIRMED", "REJECTED"].includes(status) || !bool(input.confirmation)) throw new Error("Match, decision, and confirmation are required.")
  const db = await service.requireConnection("read")
  const [match] = await db.select<DataRow>("SELECT match.*,import.financial_year_id FROM bank_statement_matches match JOIN bank_statement_lines line ON line.id=match.statement_line_id JOIN bank_statement_imports import ON import.id=line.import_id WHERE match.organization_id=? AND match.id=?", [organizationId, matchId])
  if (!match) throw new Error("Bank-statement match was not found.")
  await service.transaction(async (tx) => {
    await tx.execute("UPDATE bank_statement_matches SET match_status=?,confirmed_by=?,confirmed_at=?,notes=?,updated_at=? WHERE organization_id=? AND id=?", [status, localString(input.actor) || null, nowIso(), localString(input.notes) || null, nowIso(), organizationId, matchId])
    await audit(tx, { organizationId, financialYearId: String(match.financial_year_id), eventType: `bank_statement_match.${status.toLowerCase()}`, entityType: "bank_statement_match", entityId: matchId, actor: localString(input.actor) || null, reason: localString(input.notes) || null, previous: { status: match.match_status }, next: { status } })
  })
  return { id: matchId, status }
}

export async function allocateVoucherDimensions(organizationId: string, input: DataRow) {
  const voucherEntryId = localString(input.voucher_entry_id)
  const groups = Array.isArray(input.dimensions) ? input.dimensions as Array<{ type?: unknown; allocations?: Array<DataRow> }> : []
  if (!voucherEntryId || !groups.length) throw new Error("Voucher entry and dimension allocations are required.")
  const db = await service.requireConnection("read")
  const [entry] = await db.select<DataRow>(
    `SELECT line.id,line.debit_minor,line.credit_minor,voucher.id voucher_id,voucher.financial_year_id,voucher.status
     FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id AND voucher.organization_id=line.organization_id
     WHERE line.organization_id=? AND line.id=? LIMIT 1`, [organizationId, voucherEntryId]
  )
  if (!entry || entry.status !== "posted") throw new Error("A posted voucher line is required for dimension allocation.")
  const lineMinor = Math.max(Number(entry.debit_minor || 0), Number(entry.credit_minor || 0))
  const normalized = groups.map((group) => ({
    type: localString(group.type).toUpperCase() as DimensionType,
    allocations: (group.allocations || []).map((allocation) => ({ dimensionId: localString(allocation.dimension_id), amountMinor: moneyToMinor(allocation.amount, "Dimension allocation") })),
  }))
  if (normalized.some((group) => !VALID_DIMENSIONS.has(group.type))) throw new Error("Dimension allocation type is invalid.")
  validateDimensionAllocations({ lineMinor, dimensions: normalized })
  const ids = normalized.flatMap((group) => group.allocations.map((allocation) => allocation.dimensionId))
  const dimensions = ids.length ? await db.select<DataRow>(`SELECT id,dimension_type FROM accounting_dimensions WHERE organization_id=? AND is_active=1 AND id IN (${ids.map(() => "?").join(",")})`, [organizationId, ...ids]) : []
  const byId = new Map(dimensions.map((dimension) => [String(dimension.id), String(dimension.dimension_type)]))
  for (const group of normalized) for (const allocation of group.allocations) if (byId.get(allocation.dimensionId) !== group.type) throw new Error("A selected dimension is missing, inactive, or has the wrong type.")
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    for (const group of normalized) for (const allocation of group.allocations) {
      await tx.execute("INSERT INTO accounting_dimension_allocations (id,organization_id,financial_year_id,voucher_entry_id,dimension_id,dimension_type,amount_minor,created_at) VALUES (?,?,?,?,?,?,?,?)", [createOfflineId("dimension-allocation"), organizationId, String(entry.financial_year_id), voucherEntryId, allocation.dimensionId, group.type, allocation.amountMinor, timestamp])
    }
    await audit(tx, { organizationId, financialYearId: String(entry.financial_year_id), eventType: "voucher.dimension_allocated", entityType: "accounting_voucher", entityId: String(entry.voucher_id), actor: localString(input.actor) || null, next: normalized })
  })
  return { voucher_entry_id: voucherEntryId, allocation_count: normalized.reduce((sum, group) => sum + group.allocations.length, 0) }
}

export async function phaseThreeReferenceData(organizationId: string, financialYearId: string) {
  await ensurePhaseThreeSetup(organizationId)
  const db = await service.requireConnection("read")
  const [categories, assets, dimensions, budgets, taxRules, integrations, series] = await Promise.all([
    db.select<DataRow>("SELECT * FROM fixed_asset_categories WHERE organization_id=? AND is_active=1 ORDER BY name", [organizationId]),
    db.select<DataRow>("SELECT id,asset_code,asset_name,status,written_down_value_minor FROM fixed_assets WHERE organization_id=? ORDER BY asset_code", [organizationId]),
    db.select<DataRow>("SELECT * FROM accounting_dimensions WHERE organization_id=? AND is_active=1 ORDER BY dimension_type,name", [organizationId]),
    db.select<DataRow>("SELECT * FROM accounting_budgets WHERE organization_id=? AND financial_year_id=? ORDER BY period_start,account_id", [organizationId, financialYearId]),
    db.select<DataRow>("SELECT * FROM tax_rules WHERE organization_id=? AND is_active=1 ORDER BY tax_type,section_code,effective_from DESC", [organizationId]),
    db.select<DataRow>("SELECT integration_type,provider_code,configuration_status,last_verified_at FROM statutory_integrations WHERE organization_id=? ORDER BY integration_type", [organizationId]),
    db.select<DataRow>("SELECT * FROM accounting_voucher_series WHERE organization_id=? AND financial_year_id=? ORDER BY voucher_type", [organizationId, financialYearId]),
  ])
  return { categories, assets, dimensions, budgets, taxRules, integrations, series }
}

export async function accountingHealth(organizationId: string, financialYearId?: string | null) {
  const db = await service.requireConnection("read")
  const integrity = await accountingIntegrity(organizationId, financialYearId)
  const yearClause = financialYearId ? "AND voucher.financial_year_id=?" : ""
  const yearValues: SqlValue[] = financialYearId ? [organizationId, financialYearId] : [organizationId]
  const [dimensionMismatch, unreconciledBank, reconciliationReview, missingTaxClassification, overdueReceivables, overduePayables, fixedAssetRegister, fixedAssetLedger, arLedger, apLedger, customerSubledger, supplierSubledger] = await Promise.all([
    db.select<DataRow>(
      `SELECT COUNT(*) count FROM (
         SELECT allocation.voucher_entry_id,allocation.dimension_type
         FROM accounting_dimension_allocations allocation JOIN accounting_voucher_entries line ON line.id=allocation.voucher_entry_id
         JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id
         WHERE allocation.organization_id=? ${yearClause}
         GROUP BY allocation.voucher_entry_id,allocation.dimension_type
         HAVING SUM(allocation.amount_minor) <> MAX(line.debit_minor,line.credit_minor)
       )`, yearValues),
    db.select<DataRow>(`SELECT COUNT(*) count FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN bank_accounts bank ON bank.account_id=line.account_id LEFT JOIN bank_reconciliations reconciliation ON reconciliation.voucher_entry_id=line.id AND reconciliation.organization_id=line.organization_id WHERE line.organization_id=? AND voucher.status='posted' ${yearClause} AND COALESCE(reconciliation.status,'UNRECONCILED')<>'CLEARED'`, yearValues),
    db.select<DataRow>(`SELECT COUNT(*) count FROM gst_reconciliations WHERE organization_id=? ${financialYearId ? "AND financial_year_id=?" : ""} AND classification NOT IN ('EXACT_MATCH','PROBABLE_MATCH') AND confirmed_at IS NULL`, yearValues),
    db.select<DataRow>(`SELECT COUNT(*) count FROM gst_transaction_classifications WHERE organization_id=? ${financialYearId ? "AND financial_year_id=?" : ""} AND (transaction_type IS NULL OR supply_type IS NULL OR tax_category IS NULL OR itc_status='REVIEW_REQUIRED')`, yearValues),
    db.select<DataRow>("SELECT COUNT(*) count,COALESCE(SUM(outstanding_minor),0) amount FROM sales_invoices WHERE organization_id=? AND deleted_at IS NULL AND outstanding_minor>0 AND due_date<date('now','localtime')" + (financialYearId ? " AND financial_year_id=?" : ""), yearValues),
    db.select<DataRow>("SELECT COUNT(*) count,COALESCE(SUM(outstanding_minor),0) amount FROM purchase_invoices WHERE organization_id=? AND deleted_at IS NULL AND invoice_kind='purchase_invoice' AND document_status='POSTED' AND outstanding_minor>0 AND due_date<date('now','localtime')" + (financialYearId ? " AND financial_year_id=?" : ""), yearValues),
    db.select<DataRow>("SELECT COALESCE(SUM(written_down_value_minor),0) amount FROM fixed_assets WHERE organization_id=? AND status IN ('ACTIVE','FULLY_DEPRECIATED')", [organizationId]),
    db.select<DataRow>(`SELECT COALESCE(SUM(line.debit_minor-line.credit_minor),0) amount FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN chart_of_accounts account ON account.id=line.account_id WHERE line.organization_id=? AND voucher.status='posted' ${yearClause} AND account.system_role IN ('FIXED_ASSETS','ACCUMULATED_DEPRECIATION')`, yearValues),
    db.select<DataRow>(`SELECT COALESCE(SUM(line.debit_minor-line.credit_minor),0) amount FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN chart_of_accounts account ON account.id=line.account_id WHERE line.organization_id=? AND voucher.status='posted' ${yearClause} AND account.system_role='ACCOUNTS_RECEIVABLE'`, yearValues),
    db.select<DataRow>(`SELECT COALESCE(SUM(line.credit_minor-line.debit_minor),0) amount FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN chart_of_accounts account ON account.id=line.account_id WHERE line.organization_id=? AND voucher.status='posted' ${yearClause} AND account.system_role='ACCOUNTS_PAYABLE'`, yearValues),
    db.select<DataRow>("SELECT COALESCE(SUM(CAST(ROUND(current_balance*100) AS INTEGER)),0) amount FROM customers WHERE organization_id=? AND deleted_at IS NULL", [organizationId]),
    db.select<DataRow>("SELECT COALESCE(SUM(CAST(ROUND(current_balance*100) AS INTEGER)),0) amount FROM suppliers WHERE organization_id=? AND deleted_at IS NULL", [organizationId]),
  ])
  const [[selectedYear], inventoryLedger, inventoryRegister, invalidInventoryState] = await Promise.all([
    financialYearId ? db.select<DataRow>("SELECT is_active FROM financial_years WHERE organization_id=? AND id=?", [organizationId, financialYearId]) : Promise.resolve([{ is_active: 1 }]),
    db.select<DataRow>(`SELECT COALESCE(SUM(line.debit_minor-line.credit_minor),0) amount FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN chart_of_accounts account ON account.id=line.account_id WHERE line.organization_id=? AND voucher.status='posted' ${yearClause} AND account.system_role='INVENTORY'`, yearValues),
    db.select<DataRow>("SELECT COALESCE(SUM(CAST(ROUND(stock*COALESCE(purchase_rate,0)*100) AS INTEGER)),0) amount, SUM(CASE WHEN stock<>0 AND purchase_rate IS NULL THEN 1 ELSE 0 END) missing_cost_count FROM products WHERE organization_id=? AND deleted_at IS NULL", [organizationId]),
    db.select<DataRow>(`SELECT
       (SELECT COUNT(*) FROM products WHERE organization_id=? AND deleted_at IS NULL AND stock<0) negative_products,
       (SELECT COUNT(*) FROM stock_batches WHERE organization_id=? AND deleted_at IS NULL AND quantity<0) negative_batches`, [organizationId, organizationId]),
  ])
  const gstValidation = financialYearId ? await phaseTwoAccountingReport({ organizationId, financialYearId, report: "gst-validation", page: 1, limit: 1 }) : { total: 0 }
  const issues: DataRow[] = []
  const add = (severity: "CRITICAL" | "WARNING" | "INFO", code: string, count: number, message: string, amountMinor?: number) => { if (count || severity === "INFO") issues.push({ id: code, severity, code, count, message, amount_minor: amountMinor ?? null }) }
  add("CRITICAL", "UNBALANCED_JOURNALS", integrity.unbalancedVouchers, "Posted journals whose debit and credit totals do not agree.")
  add("CRITICAL", "ORPHAN_JOURNAL_LINES", integrity.orphanLines, "Journal lines missing a valid voucher or ledger.")
  add("CRITICAL", "DUPLICATE_SOURCE_POSTING", integrity.duplicateSources, "Source documents posted more than once.")
  add("CRITICAL", "INVALID_FINANCIAL_YEAR", integrity.invalidFinancialYears, "Posted vouchers outside their assigned financial year.")
  add("CRITICAL", "INVALID_CURRENCY_LINES", integrity.invalidCurrencyLines, "Journal lines with invalid integer-minor amounts.")
  add("CRITICAL", "DIMENSION_ALLOCATION_MISMATCH", Number(dimensionMismatch[0]?.count || 0), "Dimension allocations that do not reconcile to their journal line.")
  add("WARNING", "GST_VALIDATION", Number(gstValidation.total || 0), "GST records needing data-quality review.")
  add("WARNING", "MISSING_TAX_CLASSIFICATION", Number(missingTaxClassification[0]?.count || 0), "Transactions with incomplete GST or ITC classification.")
  add("WARNING", "UNREVIEWED_GST_RECONCILIATION", Number(reconciliationReview[0]?.count || 0), "Imported GST records with unresolved reconciliation differences.")
  add("WARNING", "UNRECONCILED_BANK", Number(unreconciledBank[0]?.count || 0), "Posted bank entries not marked cleared.")
  add("WARNING", "OVERDUE_RECEIVABLES", Number(overdueReceivables[0]?.count || 0), "Customer invoices past their due date.", Number(overdueReceivables[0]?.amount || 0))
  add("WARNING", "OVERDUE_PAYABLES", Number(overduePayables[0]?.count || 0), "Supplier bills past their due date.", Number(overduePayables[0]?.amount || 0))
  const assetDifference = Number(fixedAssetLedger[0]?.amount || 0) - Number(fixedAssetRegister[0]?.amount || 0)
  add("WARNING", "FIXED_ASSET_REGISTER_GL", assetDifference === 0 ? 0 : 1, "Fixed asset register written-down value differs from mapped fixed-asset ledgers.", assetDifference)
  const arDifference = Number(arLedger[0]?.amount || 0) - Number(customerSubledger[0]?.amount || 0)
  const apDifference = Number(apLedger[0]?.amount || 0) - Number(supplierSubledger[0]?.amount || 0)
  add("WARNING", "RECEIVABLE_SUBLEDGER_GL", arDifference === 0 ? 0 : 1, "Customer subledger does not agree with Accounts Receivable.", arDifference)
  add("WARNING", "PAYABLE_SUBLEDGER_GL", apDifference === 0 ? 0 : 1, "Supplier subledger does not agree with Accounts Payable.", apDifference)
  const inventoryDifference = Number(inventoryLedger[0]?.amount || 0) - Number(inventoryRegister[0]?.amount || 0)
  if (!financialYearId || Number(selectedYear?.is_active || 0) === 1) {
    add("WARNING", "INVENTORY_REGISTER_GL", inventoryDifference === 0 ? 0 : 1, "Inventory Asset differs from product quantity × recorded purchase cost. Review batches, stock movements, and valuation before correcting either record.", inventoryDifference)
  }
  add("WARNING", "INVENTORY_COST_MISSING", Number(inventoryRegister[0]?.missing_cost_count || 0), "Products with stock on hand have no recorded purchase cost, so inventory valuation is incomplete.")
  add("CRITICAL", "NEGATIVE_INVENTORY_STATE", Number(invalidInventoryState[0]?.negative_products || 0) + Number(invalidInventoryState[0]?.negative_batches || 0), "Products or batches have an invalid negative inventory quantity.")
  const critical = issues.filter((issue) => issue.severity === "CRITICAL").reduce((sum, issue) => sum + Number(issue.count || 0), 0)
  const warnings = issues.filter((issue) => issue.severity === "WARNING").reduce((sum, issue) => sum + Number(issue.count || 0), 0)
  return { ok: critical === 0, critical, warnings, integrity, issues }
}

export type PhaseThreeReportInput = {
  organizationId: string
  financialYearId: string
  report: string
  from?: string
  to?: string
  page?: number
  limit?: number
  search?: string
  partyId?: string
  dimensionId?: string
  status?: string
}

export async function phaseThreeAccountingReport(input: PhaseThreeReportInput) {
  const db = await service.requireConnection("read")
  const year = await getFinancialYear(input.organizationId, input.financialYearId)
  if (!year) throw new Error("Financial year was not found.")
  const from = input.from || year.start_date
  const to = input.to || year.end_date
  if (from < year.start_date || to > year.end_date || from > to) throw new Error("Report dates must be within the selected financial year.")
  const pagination = page(input)
  const base = [input.organizationId, input.financialYearId, from, to] as SqlValue[]
  const term = `%${localString(input.search)}%`

  if (input.report === "dimensions") {
    const rows = await db.select<DataRow>("SELECT * FROM accounting_dimensions WHERE organization_id=? ORDER BY dimension_type,code LIMIT ? OFFSET ?", [input.organizationId, pagination.limit, pagination.offset])
    const [count] = await db.select<DataRow>("SELECT COUNT(*) count FROM accounting_dimensions WHERE organization_id=?", [input.organizationId])
    return { report: input.report, year, from, to, rows, total: Number(count?.count || 0), ...pagination }
  }
  if (input.report === "voucher-numbering") {
    const [rows, count] = await Promise.all([
      db.select<DataRow>("SELECT * FROM accounting_voucher_series WHERE organization_id=? AND financial_year_id=? ORDER BY voucher_type LIMIT ? OFFSET ?", [input.organizationId, input.financialYearId, pagination.limit, pagination.offset]),
      db.select<DataRow>("SELECT COUNT(*) count FROM accounting_voucher_series WHERE organization_id=? AND financial_year_id=?", [input.organizationId, input.financialYearId]),
    ])
    return { report: input.report, year, from, to, rows, total: Number(count[0]?.count || 0), ...pagination }
  }
  if (input.report === "bank-statement-import") {
    const rows = await db.select<DataRow>(
      `SELECT match.id,import.file_name,bank.display_name bank_name,line.transaction_date,line.amount_minor,line.reference,line.description,
         match.match_status,match.match_score,match.voucher_entry_id,voucher.voucher_number,voucher.voucher_date book_date,voucher.reference_no book_reference
       FROM bank_statement_matches match
       JOIN bank_statement_lines line ON line.id=match.statement_line_id
       JOIN bank_statement_imports import ON import.id=line.import_id
       JOIN bank_accounts bank ON bank.id=import.bank_account_id
       LEFT JOIN accounting_voucher_entries entry ON entry.id=match.voucher_entry_id
       LEFT JOIN accounting_vouchers voucher ON voucher.id=entry.voucher_id
       WHERE import.organization_id=? AND import.financial_year_id=? ORDER BY import.created_at DESC,line.source_row_number LIMIT ? OFFSET ?`,
      [input.organizationId, input.financialYearId, pagination.limit, pagination.offset]
    )
    const [summary] = await db.select<DataRow>(`SELECT COUNT(*) count,SUM(CASE WHEN match.match_status='SUGGESTED' THEN 1 ELSE 0 END) suggested_count,SUM(CASE WHEN match.match_status='CONFIRMED' THEN 1 ELSE 0 END) confirmed_count,SUM(CASE WHEN match.match_status='UNMATCHED' THEN 1 ELSE 0 END) unmatched_count FROM bank_statement_matches match JOIN bank_statement_lines line ON line.id=match.statement_line_id JOIN bank_statement_imports import ON import.id=line.import_id WHERE import.organization_id=? AND import.financial_year_id=?`, [input.organizationId, input.financialYearId])
    return { report: input.report, year, from, to, rows, total: Number(summary?.count || 0), ...summary, ...pagination }
  }

  if (input.report === "fixed-assets") {
    const rows = await db.select<DataRow>(`SELECT asset.*,category.name category_name,supplier.name supplier_name FROM fixed_assets asset JOIN fixed_asset_categories category ON category.id=asset.category_id LEFT JOIN suppliers supplier ON supplier.id=asset.supplier_id WHERE asset.organization_id=? ${input.status && input.status !== "all" ? "AND asset.status=?" : ""} ORDER BY asset.asset_code LIMIT ? OFFSET ?`, input.status && input.status !== "all" ? [input.organizationId, input.status, pagination.limit, pagination.offset] : [input.organizationId, pagination.limit, pagination.offset])
    const [count] = await db.select<DataRow>("SELECT COUNT(*) count,COALESCE(SUM(original_cost_minor),0) original_cost_minor,COALESCE(SUM(accumulated_depreciation_minor),0) accumulated_depreciation_minor,COALESCE(SUM(written_down_value_minor),0) written_down_value_minor FROM fixed_assets WHERE organization_id=?", [input.organizationId])
    return { report: input.report, year, from, to, rows, total: Number(count?.count || 0), ...count, ...pagination }
  }
  if (input.report === "depreciation-schedule") {
    const assetValues: SqlValue[] = input.partyId ? [input.organizationId, input.partyId] : [input.organizationId]
    const [posted, assets] = await Promise.all([
      db.select<DataRow>(`SELECT depreciation.*,asset.asset_code,asset.asset_name,voucher.voucher_number,'POSTED' schedule_status FROM fixed_asset_depreciation depreciation JOIN fixed_assets asset ON asset.id=depreciation.asset_id JOIN accounting_vouchers voucher ON voucher.id=depreciation.accounting_voucher_id WHERE depreciation.organization_id=? AND depreciation.financial_year_id=? AND depreciation.period_end BETWEEN ? AND ? ${input.partyId ? "AND depreciation.asset_id=?" : ""}`, input.partyId ? [...base, input.partyId] : base),
      db.select<DataRow>(`SELECT asset.*,MAX(depreciation.period_end) last_period_end FROM fixed_assets asset LEFT JOIN fixed_asset_depreciation depreciation ON depreciation.asset_id=asset.id WHERE asset.organization_id=? AND asset.status IN ('ACTIVE','FULLY_DEPRECIATED') ${input.partyId ? "AND asset.id=?" : ""} GROUP BY asset.id`, assetValues),
    ])
    const projected: DataRow[] = []
    for (const asset of assets) {
      const start = [from, String(asset.capitalization_date), asset.last_period_end ? nextBusinessDate(String(asset.last_period_end)) : ""].filter(Boolean).sort().at(-1)!
      if (start > to || Number(asset.written_down_value_minor) <= Number(asset.residual_value_minor)) continue
      let accumulatedMinor = Number(asset.accumulated_depreciation_minor || 0)
      let openingWrittenDownValueMinor = Number(asset.written_down_value_minor || 0)
      for (const period of schedulePeriods(start, to)) {
        const calculation = calculateDepreciation({
          method: String(asset.depreciation_method) as "SLM" | "WDV", originalCostMinor: Number(asset.original_cost_minor),
          accumulatedBeforeMinor: accumulatedMinor, residualValueMinor: Number(asset.residual_value_minor), usefulLifeMonths: Number(asset.useful_life_months),
          capitalizationDate: String(asset.capitalization_date),
          annualRateBasisPoints: Number(asset.depreciation_rate_basis_points), periodStart: period.from, periodEnd: period.to,
        })
        if (!calculation.amountMinor) break
        projected.push({ id: `projection:${asset.id}:${period.from}`, asset_id: asset.id, asset_code: asset.asset_code, asset_name: asset.asset_name,
          period_start: period.from, period_end: period.to, days: calculation.days, opening_written_down_value_minor: openingWrittenDownValueMinor,
          depreciation_minor: calculation.amountMinor, closing_written_down_value_minor: calculation.closingWrittenDownValueMinor,
          voucher_number: null, schedule_status: "PROJECTED_NOT_POSTED" })
        accumulatedMinor += calculation.amountMinor
        openingWrittenDownValueMinor = calculation.closingWrittenDownValueMinor
      }
    }
    const schedule = [...posted, ...projected].sort((left, right) => `${right.period_end}:${right.asset_code}`.localeCompare(`${left.period_end}:${left.asset_code}`))
    return { report: input.report, year, from, to, rows: schedule.slice(pagination.offset, pagination.offset + pagination.limit), total: schedule.length, postedCount: posted.length, projectedCount: projected.length, ...pagination }
  }
  if (input.report === "tds-register" || input.report === "tcs-register") {
    const taxType = input.report.startsWith("tds") ? "TDS" : "TCS"
    const rows = await db.select<DataRow>(`SELECT tax.*,rule.description rule_description,voucher.voucher_number,CASE tax.party_type WHEN 'supplier' THEN supplier.name ELSE customer.name END party_name FROM tax_transactions tax JOIN tax_rules rule ON rule.id=tax.tax_rule_id JOIN accounting_vouchers voucher ON voucher.id=tax.accounting_voucher_id LEFT JOIN suppliers supplier ON tax.party_type='supplier' AND supplier.id=tax.party_id LEFT JOIN customers customer ON tax.party_type='customer' AND customer.id=tax.party_id WHERE tax.organization_id=? AND tax.financial_year_id=? AND tax.deduction_date BETWEEN ? AND ? AND tax.tax_type=? ${input.status && input.status !== "all" ? "AND tax.status=?" : ""} ORDER BY tax.deduction_date DESC LIMIT ? OFFSET ?`, input.status && input.status !== "all" ? [...base, taxType, input.status, pagination.limit, pagination.offset] : [...base, taxType, pagination.limit, pagination.offset])
    const [totals] = await db.select<DataRow>("SELECT COUNT(*) count,COALESCE(SUM(taxable_minor),0) taxable_minor,COALESCE(SUM(tax_minor),0) tax_minor,COALESCE(SUM(CASE WHEN status<>'PAID' THEN tax_minor ELSE 0 END),0) outstanding_minor FROM tax_transactions WHERE organization_id=? AND financial_year_id=? AND deduction_date BETWEEN ? AND ? AND tax_type=?", [...base, taxType])
    return { report: input.report, year, from, to, rows, total: Number(totals?.count || 0), ...totals, ...pagination }
  }
  if (["cost-centre-pl", "department-pl", "project-pl"].includes(input.report)) {
    const dimensionType = input.report === "cost-centre-pl" ? "COST_CENTRE" : input.report === "department-pl" ? "DEPARTMENT" : "PROJECT"
    const values: SqlValue[] = input.dimensionId ? [...base, dimensionType, input.dimensionId] : [...base, dimensionType]
    const rows = await db.select<DataRow>(`SELECT dimension.id,dimension.code,dimension.name,account.account_type,account.account_group,account.account_code,account.account_name,SUM(CASE WHEN line.debit_minor>0 THEN allocation.amount_minor ELSE -allocation.amount_minor END) signed_minor FROM accounting_dimension_allocations allocation JOIN accounting_dimensions dimension ON dimension.id=allocation.dimension_id JOIN accounting_voucher_entries line ON line.id=allocation.voucher_entry_id JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN chart_of_accounts account ON account.id=line.account_id WHERE allocation.organization_id=? AND allocation.financial_year_id=? AND voucher.voucher_date BETWEEN ? AND ? AND voucher.status='posted' AND allocation.dimension_type=? ${input.dimensionId ? "AND dimension.id=?" : ""} AND account.account_type IN ('INCOME','EXPENSE') GROUP BY dimension.id,account.id ORDER BY dimension.name,account.account_type,account.account_code`, values)
    const incomeMinor = rows.filter((row) => row.account_type === "INCOME").reduce((sum, row) => sum - Number(row.signed_minor || 0), 0)
    const expenseMinor = rows.filter((row) => row.account_type === "EXPENSE").reduce((sum, row) => sum + Number(row.signed_minor || 0), 0)
    return { report: input.report, year, from, to, rows, incomeMinor, expenseMinor, netProfitMinor: incomeMinor - expenseMinor, total: rows.length, page: 1, limit: rows.length || 1 }
  }
  if (input.report === "budget-vs-actual") {
    const budgets = await db.select<DataRow>(
      `WITH direct_actual AS (
         SELECT budget.id budget_id,SUM(line.debit_minor-line.credit_minor) amount
         FROM accounting_budgets budget
         JOIN accounting_vouchers voucher ON voucher.organization_id=budget.organization_id AND voucher.financial_year_id=budget.financial_year_id AND voucher.status='posted'
           AND voucher.voucher_date BETWEEN MAX(budget.period_start,?) AND MIN(budget.period_end,?)
         JOIN accounting_voucher_entries line ON line.voucher_id=voucher.id AND line.account_id=budget.account_id
         WHERE budget.organization_id=? AND budget.financial_year_id=? AND budget.dimension_id IS NULL
         GROUP BY budget.id
       ), dimension_actual AS (
         SELECT budget.id budget_id,SUM(CASE WHEN line.debit_minor>0 THEN allocation.amount_minor ELSE -allocation.amount_minor END) amount
         FROM accounting_budgets budget
         JOIN accounting_dimension_allocations allocation ON allocation.organization_id=budget.organization_id AND allocation.financial_year_id=budget.financial_year_id AND allocation.dimension_id=budget.dimension_id
         JOIN accounting_voucher_entries line ON line.id=allocation.voucher_entry_id AND line.account_id=budget.account_id
         JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id AND voucher.status='posted'
           AND voucher.voucher_date BETWEEN MAX(budget.period_start,?) AND MIN(budget.period_end,?)
         WHERE budget.organization_id=? AND budget.financial_year_id=? AND budget.dimension_id IS NOT NULL
         GROUP BY budget.id
       ), actual AS (
         SELECT * FROM direct_actual UNION ALL SELECT * FROM dimension_actual
       )
       SELECT budget.*,account.account_code,account.account_name,dimension.name dimension_name,COALESCE(actual.amount,0) actual_minor
       FROM accounting_budgets budget
       JOIN chart_of_accounts account ON account.id=budget.account_id
       LEFT JOIN accounting_dimensions dimension ON dimension.id=budget.dimension_id
       LEFT JOIN actual ON actual.budget_id=budget.id
       WHERE budget.organization_id=? AND budget.financial_year_id=? AND budget.period_end>=? AND budget.period_start<=?
       ORDER BY budget.period_start,account.account_code`,
      [from, to, input.organizationId, input.financialYearId, from, to, input.organizationId, input.financialYearId, input.organizationId, input.financialYearId, from, to]
    )
    const rows = budgets.map((budget) => ({ ...budget, ...budgetVariance(Number(budget.budget_minor), Number(budget.actual_minor || 0)) }))
    return { report: input.report, year, from, to, rows, total: rows.length, page: 1, limit: rows.length || 1 }
  }
  if (input.report === "gst-return-preparation") {
    const rows = await db.select<DataRow>("SELECT * FROM gst_return_periods WHERE organization_id=? AND financial_year_id=? AND period_end>=? AND period_start<=? ORDER BY period_start DESC,return_type", base)
    const validation = await phaseTwoAccountingReport({ organizationId: input.organizationId, financialYearId: input.financialYearId, report: "gst-validation", from, to, page: 1, limit: 200 })
    const overview = await phaseTwoAccountingReport({ organizationId: input.organizationId, financialYearId: input.financialYearId, report: "gst-overview", from, to })
    return { report: input.report, year, from, to, rows, validationIssues: validation.rows, validationIssueCount: validation.total, overview, total: rows.length, page: 1, limit: rows.length || 1 }
  }
  if (input.report === "gst-reconciliation") {
    const rows = await db.select<DataRow>(`SELECT reconciliation.*,import.invoice_number,import.invoice_date,import.supplier_gstin,import.taxable_minor imported_taxable_minor,import.cgst_minor imported_cgst_minor,import.sgst_minor imported_sgst_minor,import.igst_minor imported_igst_minor,purchase.supplier_invoice_number book_invoice_number,purchase.purchase_date book_invoice_date,purchase.taxable_minor book_taxable_minor FROM gst_reconciliations reconciliation LEFT JOIN gst_import_records import ON import.id=reconciliation.import_record_id LEFT JOIN purchase_invoices purchase ON reconciliation.book_source_type='PURCHASE' AND purchase.id=reconciliation.book_source_id WHERE reconciliation.organization_id=? AND reconciliation.financial_year_id=? ${input.status && input.status !== "all" ? "AND reconciliation.classification=?" : ""} ORDER BY reconciliation.created_at DESC LIMIT ? OFFSET ?`, input.status && input.status !== "all" ? [input.organizationId, input.financialYearId, input.status, pagination.limit, pagination.offset] : [input.organizationId, input.financialYearId, pagination.limit, pagination.offset])
    const summary = await db.select<DataRow>("SELECT classification,COUNT(*) count FROM gst_reconciliations WHERE organization_id=? AND financial_year_id=? GROUP BY classification ORDER BY classification", [input.organizationId, input.financialYearId])
    return { report: input.report, year, from, to, rows, summary, total: summary.reduce((sum, row) => sum + Number(row.count || 0), 0), ...pagination }
  }
  if (input.report === "e-invoice") {
    const [rows, integrations, counts] = await Promise.all([
      db.select<DataRow>("SELECT id,source_type,source_id,status,validation_json,irn,acknowledgement_number,acknowledgement_date,cancellation_state,created_at,updated_at FROM e_invoice_preparations WHERE organization_id=? AND financial_year_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?", [input.organizationId, input.financialYearId, pagination.limit, pagination.offset]),
      db.select<DataRow>("SELECT configuration_status,provider_code,last_verified_at FROM statutory_integrations WHERE organization_id=? AND integration_type='E_INVOICE'", [input.organizationId]),
      db.select<DataRow>("SELECT COUNT(*) count FROM e_invoice_preparations WHERE organization_id=? AND financial_year_id=?", [input.organizationId, input.financialYearId]),
    ])
    const integration = integrations[0]
    return { report: input.report, year, from, to, rows, integration: integration || { configuration_status: "NOT_CONFIGURED" }, integrationMessage: integration?.configuration_status === "CONFIGURED" ? null : "E-Invoice Integration Not Configured", total: Number(counts[0]?.count || 0), ...pagination }
  }
  if (input.report === "e-way-bill") {
    const [rows, integrations, counts] = await Promise.all([
      db.select<DataRow>("SELECT id,source_type,source_id,status,validation_json,eway_bill_number,valid_until,cancellation_state,created_at,updated_at FROM e_way_bill_preparations WHERE organization_id=? AND financial_year_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?", [input.organizationId, input.financialYearId, pagination.limit, pagination.offset]),
      db.select<DataRow>("SELECT configuration_status,provider_code,last_verified_at FROM statutory_integrations WHERE organization_id=? AND integration_type='E_WAY_BILL'", [input.organizationId]),
      db.select<DataRow>("SELECT COUNT(*) count FROM e_way_bill_preparations WHERE organization_id=? AND financial_year_id=?", [input.organizationId, input.financialYearId]),
    ])
    const integration = integrations[0]
    return { report: input.report, year, from, to, rows, integration: integration || { configuration_status: "NOT_CONFIGURED" }, integrationMessage: integration?.configuration_status === "CONFIGURED" ? null : "E-Way Bill Integration Not Configured", total: Number(counts[0]?.count || 0), ...pagination }
  }
  if (input.report === "audit-trail" || input.report === "auditor-mode") {
    const searchClause = localString(input.search) ? "AND (event_type LIKE ? OR entity_type LIKE ? OR entity_id LIKE ? OR actor LIKE ? OR reason LIKE ?)" : ""
    const values: SqlValue[] = [input.organizationId, input.financialYearId, from, to]
    if (localString(input.search)) values.push(term, term, term, term, term)
    const rows = await db.select<DataRow>(`SELECT id,occurred_at,event_type,entity_type,entity_id,actor,reason,source FROM accounting_audit_events WHERE organization_id=? AND (financial_year_id=? OR financial_year_id IS NULL) AND date(occurred_at) BETWEEN ? AND ? ${searchClause} ORDER BY occurred_at DESC LIMIT ? OFFSET ?`, [...values, pagination.limit, pagination.offset])
    const [count] = await db.select<DataRow>(`SELECT COUNT(*) count FROM accounting_audit_events WHERE organization_id=? AND (financial_year_id=? OR financial_year_id IS NULL) AND date(occurred_at) BETWEEN ? AND ? ${searchClause}`, values)
    return { report: input.report, year, from, to, rows, total: Number(count?.count || 0), readOnly: true, ...pagination }
  }
  if (input.report === "accounting-search") {
    const search = localString(input.search)
    if (search.length < 2) return { report: input.report, year, from, to, rows: [], total: 0, ...pagination }
    const amountMinor = /^-?[\d,]+(?:\.\d{1,2})?$/.test(search) ? Math.abs(moneyToMinor(search, "Search amount")) : null
    const searchSql = `
         SELECT voucher.id,'VOUCHER' result_type,voucher.voucher_number result_number,voucher.voucher_date result_date,voucher.narration title,voucher.reference_no reference,voucher.total_debit_minor amount_minor,voucher.source_type,voucher.source_id
         FROM accounting_vouchers voucher WHERE voucher.organization_id=? AND voucher.financial_year_id=? AND voucher.status='posted' AND (voucher.voucher_number LIKE ? OR voucher.reference_no LIKE ? OR voucher.narration LIKE ? ${amountMinor !== null ? "OR voucher.total_debit_minor=?" : ""})
         UNION ALL
         SELECT invoice.id,'SALE',COALESCE(invoice.display_invoice_number,invoice.invoice_number),invoice.invoice_date,COALESCE(invoice.customer_name,customer.name),invoice.reference_no,invoice.grand_total_minor,'SALES_INVOICE',invoice.id
         FROM sales_invoices invoice LEFT JOIN customers customer ON customer.id=invoice.customer_id WHERE invoice.organization_id=? AND invoice.financial_year_id=? AND invoice.deleted_at IS NULL AND (invoice.invoice_number LIKE ? OR invoice.display_invoice_number LIKE ? OR invoice.customer_name LIKE ? ${amountMinor !== null ? "OR invoice.grand_total_minor=?" : ""})
         UNION ALL
         SELECT purchase.id,'PURCHASE',purchase.supplier_invoice_number,purchase.purchase_date,COALESCE(purchase.supplier_name,supplier.name),purchase.reference_no,purchase.grand_total_minor,'PURCHASE_INVOICE',purchase.id
         FROM purchase_invoices purchase LEFT JOIN suppliers supplier ON supplier.id=purchase.supplier_id WHERE purchase.organization_id=? AND purchase.financial_year_id=? AND purchase.deleted_at IS NULL AND purchase.document_status='POSTED' AND (purchase.supplier_invoice_number LIKE ? OR purchase.bill_number LIKE ? OR purchase.supplier_name LIKE ? ${amountMinor !== null ? "OR purchase.grand_total_minor=?" : ""})
       `
    const values: SqlValue[] = [input.organizationId, input.financialYearId, term, term, term, ...(amountMinor !== null ? [amountMinor] : []), input.organizationId, input.financialYearId, term, term, term, ...(amountMinor !== null ? [amountMinor] : []), input.organizationId, input.financialYearId, term, term, term, ...(amountMinor !== null ? [amountMinor] : [])]
    const [[count], rows] = await Promise.all([
      db.select<DataRow>(`SELECT COUNT(*) count FROM (${searchSql}) results`, values),
      db.select<DataRow>(`SELECT * FROM (${searchSql}) results ORDER BY result_date DESC,result_number LIMIT ? OFFSET ?`, [...values, pagination.limit, pagination.offset]),
    ])
    return { report: input.report, year, from, to, rows, total: Number(count?.count || 0), ...pagination }
  }
  if (input.report === "customer-statement" || input.report === "supplier-statement") {
    const partyType = input.report.startsWith("customer") ? "customer" : "supplier"
    if (!input.partyId) return { report: input.report, year, from, to, rows: [], openingMinor: 0, closingMinor: 0, total: 0, ...pagination }
    const idColumn = partyType === "customer" ? "line.customer_id" : "line.supplier_id"
    const sign = partyType === "customer" ? "line.debit_minor-line.credit_minor" : "line.credit_minor-line.debit_minor"
    const [openingRows, periodRows] = await Promise.all([
      db.select<DataRow>(`SELECT COALESCE(SUM(${sign}),0) amount FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id WHERE line.organization_id=? AND voucher.financial_year_id=? AND voucher.status='posted' AND ${idColumn}=? AND voucher.voucher_date<?`, [input.organizationId, input.financialYearId, input.partyId, from]),
      db.select<DataRow>(`SELECT COUNT(*) count,COALESCE(SUM(${sign}),0) amount FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id WHERE line.organization_id=? AND voucher.financial_year_id=? AND voucher.status='posted' AND ${idColumn}=? AND voucher.voucher_date BETWEEN ? AND ?`, [input.organizationId, input.financialYearId, input.partyId, from, to]),
    ])
    const openingMinor = Number(openingRows[0]?.amount || 0)
    const rows = await db.select<DataRow>(`SELECT line.id,voucher.voucher_date,voucher.voucher_type,voucher.voucher_number,voucher.reference_no,voucher.narration,line.description,line.debit_minor,line.credit_minor,?+SUM(${sign}) OVER (ORDER BY voucher.voucher_date,voucher.created_at,line.line_no,line.id) running_balance_minor FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id WHERE line.organization_id=? AND voucher.financial_year_id=? AND voucher.status='posted' AND ${idColumn}=? AND voucher.voucher_date BETWEEN ? AND ? ORDER BY voucher.voucher_date,voucher.created_at,line.line_no,line.id LIMIT ? OFFSET ?`, [openingMinor, input.organizationId, input.financialYearId, input.partyId, from, to, pagination.limit, pagination.offset])
    return { report: input.report, year, from, to, rows, partyType, partyId: input.partyId, openingMinor, closingMinor: openingMinor + Number(periodRows[0]?.amount || 0), total: Number(periodRows[0]?.count || 0), ...pagination }
  }
  if (input.report === "accounting-health") {
    const health = await accountingHealth(input.organizationId, input.financialYearId)
    return { report: input.report, year, from, to, rows: health.issues, ...health, total: health.issues.length, page: 1, limit: health.issues.length || 1 }
  }
  if (input.report === "financial-insights") {
    const profit = await accountingReport({ organizationId: input.organizationId, financialYearId: input.financialYearId, report: "profit-loss", from, to })
    const health = await accountingHealth(input.organizationId, input.financialYearId)
    const rows: DataRow[] = []
    if (Number(profit.netProfitMinor || 0) > 0 && Number(health.issues.find((issue) => issue.code === "OVERDUE_RECEIVABLES")?.amount_minor || 0) > 0) rows.push({ id: "profit-vs-overdue", severity: "INFO", insight: "Profit is positive while customer money remains overdue.", amount_minor: health.issues.find((issue) => issue.code === "OVERDUE_RECEIVABLES")?.amount_minor, basis: "Posted P&L and overdue receivable invoices" })
    if (Number(profit.operatingExpenseMinor || 0) > Number(profit.incomeMinor || 0) * 0.5) rows.push({ id: "expense-ratio", severity: "INFO", insight: "Operating expenses exceed half of recorded income for this period.", amount_minor: profit.operatingExpenseMinor, basis: "Posted income and expense journal ledgers" })
    return { report: input.report, year, from, to, rows, deterministic: true, label: "Rule-based financial insights", total: rows.length, page: 1, limit: rows.length || 1 }
  }
  if (input.report === "comparative-financials") {
    const currentProfit = await accountingReport({ organizationId: input.organizationId, financialYearId: input.financialYearId, report: "profit-loss", from, to })
    const [previousYear] = await db.select<DataRow>("SELECT * FROM financial_years WHERE organization_id=? AND end_date<? ORDER BY end_date DESC LIMIT 1", [input.organizationId, year.start_date])
    if (!previousYear) return { report: input.report, year, from, to, rows: [], current: currentProfit, previous: null, message: "No previous financial year is available for comparison.", total: 0, page: 1, limit: 1 }
    const previousProfit = await accountingReport({ organizationId: input.organizationId, financialYearId: String(previousYear.id), report: "profit-loss", from: String(previousYear.start_date), to: String(previousYear.end_date) })
    const metrics = [["Revenue", "incomeMinor"], ["COGS", "cogsMinor"], ["Gross Profit", "grossProfitMinor"], ["Operating Expenses", "operatingExpenseMinor"], ["Net Profit", "netProfitMinor"]] as const
    const rows = metrics.map(([label, key]) => {
      const currentMinor = Number(currentProfit[key] || 0)
      const previousMinor = Number(previousProfit[key] || 0)
      const differenceMinor = currentMinor - previousMinor
      return { id: key, label, current_minor: currentMinor, previous_minor: previousMinor, difference_minor: differenceMinor, change_basis_points: previousMinor === 0 ? null : Math.trunc(differenceMinor * 10_000 / Math.abs(previousMinor)) }
    })
    return { report: input.report, year, previousYear, from, to, rows, total: rows.length, page: 1, limit: rows.length }
  }
  if (input.report === "accountant-workspace") {
    const [health, trial, profit, balance, cashFlow] = await Promise.all([
      accountingHealth(input.organizationId, input.financialYearId),
      accountingReport({ organizationId: input.organizationId, financialYearId: input.financialYearId, report: "trial-balance", from, to }),
      accountingReport({ organizationId: input.organizationId, financialYearId: input.financialYearId, report: "profit-loss", from, to }),
      accountingReport({ organizationId: input.organizationId, financialYearId: input.financialYearId, report: "balance-sheet", from, to }),
      accountingReport({ organizationId: input.organizationId, financialYearId: input.financialYearId, report: "cash-flow", from, to }),
    ])
    return { report: input.report, year, from, to, rows: health.issues, health, trialBalance: { debitMinor: trial.totalDebitMinor, creditMinor: trial.totalCreditMinor }, profitLoss: { incomeMinor: profit.incomeMinor, expenseMinor: profit.expenseMinor, netProfitMinor: profit.netProfitMinor }, balanceSheet: { assetMinor: balance.assetMinor, liabilitiesMinor: balance.liabilitiesMinor, equityMinor: balance.equityMinor, differenceMinor: balance.differenceMinor }, cashFlow: { openingMinor: cashFlow.openingMinor, closingMinor: cashFlow.closingMinor }, total: health.issues.length, page: 1, limit: health.issues.length || 1 }
  }

  throw new Error("Unknown Phase 3 accounting report.")
}
