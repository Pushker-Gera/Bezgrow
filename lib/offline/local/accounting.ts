"use client"

import { createOfflineId } from "@/lib/offline/db"
import { moneyToMinor, minorToMoney, multiplyMoneyToMinor } from "@/lib/accounting/money"
import {
  buildExpenseJournal,
  buildReversalJournal,
  validateJournal,
  type AccountingAccount,
  type JournalLine,
} from "@/lib/accounting/journal"
import { assertFinancialYearWriteAllowed, getFinancialYear } from "@/lib/offline/local/financial-years"
import { getLocalDatabaseService, type SqlExecutor, type SqlValue } from "@/lib/offline/local/service"
import { appendJournal } from "@/lib/offline/local/journal-posting"

type DataRow = Record<string, unknown>

const service = getLocalDatabaseService()
const accountingInitializationPromises = new Map<string, Promise<DataRow | null>>()

export const DEFAULT_ACCOUNTS = [
  ["1000", "Cash", "ASSET", "CASH", "debit", "CASH"],
  ["1010", "Bank", "ASSET", "BANK", "debit", "BANK"],
  ["1100", "Accounts Receivable", "ASSET", "RECEIVABLE", "debit", "ACCOUNTS_RECEIVABLE"],
  ["1200", "Inventory", "ASSET", "INVENTORY", "debit", "INVENTORY"],
  ["1300", "Other Current Assets", "ASSET", "CURRENT_ASSET", "debit", "OTHER_CURRENT_ASSETS"],
  ["1500", "Fixed Assets", "ASSET", "FIXED_ASSET", "debit", "FIXED_ASSETS"],
  ["2000", "Accounts Payable", "LIABILITY", "PAYABLE", "credit", "ACCOUNTS_PAYABLE"],
  ["2100", "Output CGST", "LIABILITY", "TAX_LIABILITY", "credit", "OUTPUT_CGST"],
  ["2110", "Output SGST", "LIABILITY", "TAX_LIABILITY", "credit", "OUTPUT_SGST"],
  ["2120", "Output IGST", "LIABILITY", "TAX_LIABILITY", "credit", "OUTPUT_IGST"],
  ["2190", "Other Current Liabilities", "LIABILITY", "CURRENT_LIABILITY", "credit", "OTHER_CURRENT_LIABILITIES"],
  ["2200", "Input CGST", "ASSET", "CURRENT_ASSET", "debit", "INPUT_CGST"],
  ["2210", "Input SGST", "ASSET", "CURRENT_ASSET", "debit", "INPUT_SGST"],
  ["2220", "Input IGST", "ASSET", "CURRENT_ASSET", "debit", "INPUT_IGST"],
  ["3000", "Capital", "EQUITY", "CAPITAL", "credit", "CAPITAL"],
  ["3100", "Retained Earnings / Opening Equity", "EQUITY", "CAPITAL", "credit", "OPENING_EQUITY"],
  ["3200", "Drawings", "EQUITY", "CAPITAL", "debit", "DRAWINGS"],
  ["4000", "Sales", "INCOME", "SALES_INCOME", "credit", "SALES"],
  ["4200", "Other Income", "INCOME", "OTHER_INCOME", "credit", "OTHER_INCOME"],
  ["5000", "Cost of Goods Sold", "EXPENSE", "COGS", "debit", "COGS"],
  ["5100", "Discount Allowed / Sales Discount", "EXPENSE", "DIRECT_EXPENSE", "debit", "SALES_DISCOUNT"],
  ["5200", "Freight / Delivery Expense", "EXPENSE", "DIRECT_EXPENSE", "debit", "FREIGHT_EXPENSE"],
  ["6000", "Miscellaneous Expenses", "EXPENSE", "INDIRECT_EXPENSE", "debit", "MISCELLANEOUS_EXPENSES"],
  ["6010", "Rent", "EXPENSE", "INDIRECT_EXPENSE", "debit", "RENT_EXPENSE"],
  ["6020", "Electricity", "EXPENSE", "INDIRECT_EXPENSE", "debit", "ELECTRICITY_EXPENSE"],
  ["6030", "Salary / Wages", "EXPENSE", "INDIRECT_EXPENSE", "debit", "SALARY_EXPENSE"],
  ["6040", "Fuel", "EXPENSE", "INDIRECT_EXPENSE", "debit", "FUEL_EXPENSE"],
  ["6050", "Advertising", "EXPENSE", "INDIRECT_EXPENSE", "debit", "ADVERTISING_EXPENSE"],
  ["6060", "Repairs", "EXPENSE", "INDIRECT_EXPENSE", "debit", "REPAIRS_EXPENSE"],
  ["6070", "Internet / Communication", "EXPENSE", "INDIRECT_EXPENSE", "debit", "COMMUNICATION_EXPENSE"],
  ["6080", "Professional Fees", "EXPENSE", "INDIRECT_EXPENSE", "debit", "PROFESSIONAL_FEES"],
  ["6990", "Round Off / Rounding Adjustment", "EXPENSE", "INDIRECT_EXPENSE", "debit", "ROUND_OFF"],
] as const

function nowIso() {
  return new Date().toISOString()
}

function accountId(organizationId: string, code: string) {
  return `account:${organizationId}:${code}`
}

function rowAccount(row: DataRow): AccountingAccount {
  return {
    id: String(row.id || ""),
    accountCode: String(row.account_code || ""),
    accountName: String(row.account_name || ""),
    accountType: String(row.account_type || ""),
    systemRole: row.system_role ? String(row.system_role) : null,
  }
}

export async function ensureDefaultAccountingAccounts(organizationId: string) {
  const db = await service.requireConnection("read")
  const [organization] = await db.select<DataRow>("SELECT id FROM organizations WHERE id = ? AND deleted_at IS NULL LIMIT 1", [organizationId])
  if (!organization) throw new Error("The licensed business was not found in the local database.")
  const existing = await db.select<DataRow>(
    "SELECT id, account_code, account_name, account_type, system_role FROM chart_of_accounts WHERE organization_id = ? AND deleted_at IS NULL",
    [organizationId]
  )
  const roles = new Set(existing.map((row) => String(row.system_role || "")).filter(Boolean))
  const missing = DEFAULT_ACCOUNTS.filter((seed) => !roles.has(seed[5]))
  const [settings] = await db.select<DataRow>("SELECT organization_id FROM accounting_settings WHERE organization_id = ?", [organizationId])
  if (!missing.length && settings) return

  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    for (const [code, name, type, group, normal, role] of missing) {
      await tx.execute(
        `INSERT OR IGNORE INTO chart_of_accounts (
           id, organization_id, account_code, account_name, account_type, account_group, normal_balance,
           opening_balance, current_balance, is_system, is_cash_account, is_bank_account, is_active,
           system_role, tax_role, sync_status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?, 1, ?, ?, 'local', ?, ?)`,
        [
          accountId(organizationId, code), organizationId, code, name, type, group, normal,
          role === "CASH" ? 1 : 0, role === "BANK" ? 1 : 0, role,
          role.startsWith("INPUT_") || role.startsWith("OUTPUT_") ? role : null,
          timestamp, timestamp,
        ]
      )
      await tx.execute(
        `UPDATE chart_of_accounts SET system_role = ?, tax_role = ?, is_system = 1, is_active = 1, updated_at = ?
         WHERE organization_id = ? AND account_code = ? AND system_role IS NULL`,
        [role, role.startsWith("INPUT_") || role.startsWith("OUTPUT_") ? role : null, timestamp, organizationId, code]
      )
    }
    await tx.execute(
      `INSERT OR IGNORE INTO accounting_settings (
         organization_id, accounting_version, activation_date, opening_date, historical_policy,
         initialization_status, created_at, updated_at
       ) VALUES (?, 1, date('now', 'localtime'), date('now', 'localtime'), 'CONTROLLED_OPENING', 'PENDING', ?, ?)`,
      [organizationId, timestamp, timestamp]
    )
  })
}

export async function accountingAccounts(organizationId: string, includeInactive = false) {
  await ensureDefaultAccountingAccounts(organizationId)
  const db = await service.requireConnection("read")
  const rows = await db.select<DataRow>(
    `SELECT account.*, COALESCE(usage.posted_lines, 0) AS posted_lines,
       COALESCE(usage.current_balance_minor, 0) AS current_balance_minor
     FROM chart_of_accounts account
     LEFT JOIN (
       SELECT line.account_id, COUNT(*) posted_lines,
         SUM(line.debit_minor - line.credit_minor) AS current_balance_minor
       FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id = line.voucher_id
       WHERE voucher.organization_id = ? AND voucher.status = 'posted' GROUP BY line.account_id
     ) usage ON usage.account_id = account.id
     WHERE account.organization_id = ? AND account.deleted_at IS NULL ${includeInactive ? "" : "AND account.is_active = 1"}
     ORDER BY account.account_code COLLATE NOCASE`,
    [organizationId, organizationId]
  )
  return rows
}

export async function systemAccountMap(organizationId: string) {
  const rows = await accountingAccounts(organizationId)
  const map = new Map<string, AccountingAccount>()
  for (const row of rows) if (row.system_role) map.set(String(row.system_role), rowAccount(row))
  return map
}

export async function saveAccountingAccount(input: {
  organizationId: string
  id?: string
  accountCode: string
  accountName: string
  accountType: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE"
  accountGroup?: string
  normalBalance: "debit" | "credit"
  notes?: string
}) {
  await ensureDefaultAccountingAccounts(input.organizationId)
  const code = input.accountCode.trim().toUpperCase()
  const name = input.accountName.trim()
  if (!code || !name) throw new Error("Account code and name are required.")
  const timestamp = nowIso()
  const db = await service.requireConnection("read")
  const current = input.id
    ? (await db.select<DataRow>(
        `SELECT account.*, EXISTS (
           SELECT 1 FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id = line.voucher_id
           WHERE line.account_id = account.id AND voucher.status = 'posted'
         ) AS has_history
         FROM chart_of_accounts account WHERE account.organization_id = ? AND account.id = ? AND account.deleted_at IS NULL LIMIT 1`,
        [input.organizationId, input.id]
      ))[0]
    : null
  if (current?.is_system) throw new Error("System accounts cannot be edited. Create a child or custom account instead.")
  if (current?.has_history && (
    String(current.account_type) !== input.accountType
    || String(current.normal_balance) !== input.normalBalance
    || String(current.account_group || "") !== String(input.accountGroup || "").trim().toUpperCase()
  )) throw new Error("An account with posted history may be renamed, but its accounting classification cannot be changed.")
  const id = input.id || createOfflineId("account")
  await service.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO chart_of_accounts (
         id, organization_id, account_code, account_name, account_type, account_group, normal_balance,
         opening_balance, current_balance, is_system, is_cash_account, is_bank_account, is_active,
         notes, sync_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 1, ?, 'local', ?, ?)
       ON CONFLICT(id) DO UPDATE SET account_code = excluded.account_code, account_name = excluded.account_name,
         account_type = excluded.account_type, account_group = excluded.account_group,
         normal_balance = excluded.normal_balance, notes = excluded.notes, updated_at = excluded.updated_at`,
      [id, input.organizationId, code, name, input.accountType, input.accountGroup?.trim().toUpperCase() || null, input.normalBalance, input.notes?.trim() || null, timestamp, timestamp]
    )
  })
  return id
}

export async function deactivateAccountingAccount(organizationId: string, id: string) {
  const db = await service.requireConnection("read")
  const [account] = await db.select<DataRow>(
    `SELECT account.*, EXISTS (
       SELECT 1 FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id = line.voucher_id
       WHERE line.account_id = account.id AND voucher.status = 'posted'
     ) AS has_history FROM chart_of_accounts account WHERE account.organization_id = ? AND account.id = ? LIMIT 1`,
    [organizationId, id]
  )
  if (!account) throw new Error("Account was not found.")
  if (Number(account.is_system || 0)) throw new Error("System accounts cannot be deactivated.")
  await service.transaction(async (tx) => {
    await tx.execute("UPDATE chart_of_accounts SET is_active = 0, updated_at = ? WHERE organization_id = ? AND id = ?", [nowIso(), organizationId, id])
  })
  return { preservedHistory: Boolean(account.has_history) }
}

async function inventoryOpeningValue(organizationId: string) {
  const db = await service.requireConnection("read")
  const [products, batches] = await Promise.all([
    db.select<DataRow>("SELECT id, name, stock, purchase_rate FROM products WHERE organization_id = ? AND deleted_at IS NULL AND stock > 0", [organizationId]),
    db.select<DataRow>(
      "SELECT id, product_id, quantity, purchase_rate FROM stock_batches WHERE organization_id = ? AND deleted_at IS NULL AND quantity > 0 ORDER BY purchase_date, created_at, id",
      [organizationId]
    ),
  ])
  let totalMinor = 0
  const warnings: Array<{ id: string; productId: string; message: string }> = []
  for (const product of products) {
    const productId = String(product.id)
    let remaining = Math.max(0, Number(product.stock || 0))
    for (const batch of batches.filter((candidate) => String(candidate.product_id) === productId)) {
      if (remaining <= 0) break
      const quantity = Math.min(remaining, Math.max(0, Number(batch.quantity || 0)))
      if (quantity <= 0) continue
      if (batch.purchase_rate !== null && batch.purchase_rate !== undefined && String(batch.purchase_rate) !== "") {
        totalMinor += multiplyMoneyToMinor(quantity, batch.purchase_rate, `Recorded batch cost for ${String(product.name || productId)}`)
      } else if (product.purchase_rate !== null && product.purchase_rate !== undefined && String(product.purchase_rate) !== "") {
        totalMinor += multiplyMoneyToMinor(quantity, product.purchase_rate, `Recorded product cost for ${String(product.name || productId)}`)
      } else {
        warnings.push({
          id: `accounting-warning:${organizationId}:opening-cost:${productId}:${String(batch.id)}`,
          productId,
          message: `${String(product.name || "Product")} has ${quantity} units without a recorded purchase cost. That quantity was not valued in the controlled opening.`,
        })
      }
      remaining -= quantity
    }
    if (remaining > 0) {
      if (product.purchase_rate !== null && product.purchase_rate !== undefined && String(product.purchase_rate) !== "") {
        totalMinor += multiplyMoneyToMinor(remaining, product.purchase_rate, `Recorded product cost for ${String(product.name || productId)}`)
      } else {
        warnings.push({
          id: `accounting-warning:${organizationId}:opening-cost:${productId}:unbatched`,
          productId,
          message: `${String(product.name || "Product")} has ${remaining} unbatched units without a recorded purchase cost. That quantity was not valued in the controlled opening.`,
        })
      }
    }
  }
  return { totalMinor, warnings }
}

async function performAccountingInitialization(organizationId: string, openingDate: string) {
  await ensureDefaultAccountingAccounts(organizationId)
  const year = await assertFinancialYearWriteAllowed(organizationId, openingDate)
  const db = await service.requireConnection("read")
  const [setting] = await db.select<DataRow>("SELECT * FROM accounting_settings WHERE organization_id = ?", [organizationId])
  if (setting && String(setting.initialization_status) !== "PENDING") return accountingStatus(organizationId)

  const [customers, suppliers, inventory, accounts] = await Promise.all([
    db.select<DataRow>("SELECT id, name, current_balance FROM customers WHERE organization_id = ? AND deleted_at IS NULL AND current_balance > 0", [organizationId]),
    db.select<DataRow>("SELECT id, name, current_balance FROM suppliers WHERE organization_id = ? AND deleted_at IS NULL AND current_balance > 0", [organizationId]),
    inventoryOpeningValue(organizationId),
    systemAccountMap(organizationId),
  ])
  const lines: JournalLine[] = []
  const ar = accounts.get("ACCOUNTS_RECEIVABLE")
  const ap = accounts.get("ACCOUNTS_PAYABLE")
  const inventoryAccount = accounts.get("INVENTORY")
  const equity = accounts.get("OPENING_EQUITY")
  if (!ar || !ap || !inventoryAccount || !equity) throw new Error("Required controlled-opening accounts are missing.")
  for (const customer of customers) {
    const amount = moneyToMinor(customer.current_balance, `Opening receivable for ${String(customer.name || "customer")}`)
    if (amount > 0) lines.push({ accountId: ar.id, accountType: ar.accountType, debitMinor: amount, creditMinor: 0, partyType: "customer", partyId: String(customer.id), customerId: String(customer.id), description: `Opening receivable — ${String(customer.name || customer.id)}` })
  }
  for (const supplier of suppliers) {
    const amount = moneyToMinor(supplier.current_balance, `Opening payable for ${String(supplier.name || "supplier")}`)
    if (amount > 0) lines.push({ accountId: ap.id, accountType: ap.accountType, debitMinor: 0, creditMinor: amount, partyType: "supplier", partyId: String(supplier.id), supplierId: String(supplier.id), description: `Opening payable — ${String(supplier.name || supplier.id)}` })
  }
  if (inventory.totalMinor > 0) lines.push({ accountId: inventoryAccount.id, accountType: inventoryAccount.accountType, debitMinor: inventory.totalMinor, creditMinor: 0, description: "Opening inventory at recorded cost" })
  const debit = lines.reduce((sum, item) => sum + item.debitMinor, 0)
  const credit = lines.reduce((sum, item) => sum + item.creditMinor, 0)
  if (debit !== credit) lines.push({ accountId: equity.id, accountType: equity.accountType, debitMinor: Math.max(0, credit - debit), creditMinor: Math.max(0, debit - credit), description: "Controlled opening balance" })

  const timestamp = nowIso()
  const voucherId = `accounting-opening:${organizationId}:v1`
  const journal = lines.length >= 2
    ? validateJournal({
        id: voucherId, organizationId, financialYearId: year.id, voucherNumber: "OPENING-00001", voucherType: "opening",
        voucherDate: openingDate, sourceType: "ACCOUNTING_ACTIVATION", sourceId: organizationId,
        narration: "Controlled opening from current receivables, payables, and inventory with recorded cost. Legacy documents were not back-posted.",
        systemGenerated: true, lines,
      })
    : null
  await service.transaction(async (tx) => {
    if (journal) await appendJournal(tx, journal)
    for (const warning of inventory.warnings) {
      await tx.execute(
        `INSERT OR IGNORE INTO accounting_warnings (
           id, organization_id, financial_year_id, source_type, source_id, warning_code, message, status, created_at
         ) VALUES (?, ?, ?, 'ACCOUNTING_ACTIVATION', ?, 'MISSING_INVENTORY_COST', ?, 'OPEN', ?)`,
        [warning.id, organizationId, year.id, warning.productId, warning.message, timestamp]
      )
    }
    await tx.execute(
      `UPDATE accounting_settings SET activation_date = ?, opening_date = ?, opening_voucher_id = ?,
         initialization_status = ?, warning_count = ?, initialized_at = ?, updated_at = ? WHERE organization_id = ?`,
      [openingDate, openingDate, journal?.id || null, inventory.warnings.length ? "NEEDS_REVIEW" : "INITIALIZED", inventory.warnings.length, timestamp, timestamp, organizationId]
    )
    await tx.execute(
      `INSERT INTO local_audit_logs (id, organization_id, action, entity_type, entity_id, description, created_at, updated_at, sync_status)
       VALUES (?, ?, 'accounting.initialized', 'accounting_settings', ?, ?, ?, ?, 'local')`,
      [createOfflineId("accounting-audit"), organizationId, organizationId, `Phase 1 accounting activated with controlled opening; ${inventory.warnings.length} cost warning(s). Legacy documents were preserved without back-posting.`, timestamp, timestamp]
    )
  })
  return accountingStatus(organizationId)
}

export async function initializeAccounting(organizationId: string, openingDate = new Date().toISOString().slice(0, 10)) {
  const existing = accountingInitializationPromises.get(organizationId)
  if (existing) return existing
  const initialization = performAccountingInitialization(organizationId, openingDate)
  accountingInitializationPromises.set(organizationId, initialization)
  try {
    return await initialization
  } finally {
    if (accountingInitializationPromises.get(organizationId) === initialization) accountingInitializationPromises.delete(organizationId)
  }
}

export async function accountingStatus(organizationId: string) {
  await ensureDefaultAccountingAccounts(organizationId)
  const db = await service.requireConnection("read")
  const [settings] = await db.select<DataRow>(
    `SELECT settings.*, voucher.voucher_number AS opening_voucher_number,
       (SELECT COUNT(*) FROM accounting_warnings warning WHERE warning.organization_id = settings.organization_id AND warning.status = 'OPEN') AS open_warnings
     FROM accounting_settings settings LEFT JOIN accounting_vouchers voucher ON voucher.id = settings.opening_voucher_id
     WHERE settings.organization_id = ? LIMIT 1`,
    [organizationId]
  )
  return settings || null
}

export async function postManualJournal(input: {
  organizationId: string
  financialYearId: string
  voucherDate: string
  voucherType: "journal" | "receipt" | "payment" | "contra" | "opening"
  referenceNo?: string
  narration: string
  createdBy?: string
  lines: Array<{ accountId: string; debit: unknown; credit: unknown; description?: string }>
}) {
  await initializeAccounting(input.organizationId, input.voucherDate)
  const year = await assertFinancialYearWriteAllowed(input.organizationId, input.voucherDate, input.financialYearId)
  const db = await service.requireConnection("read")
  const accountRows = await db.select<DataRow>(
    "SELECT id, account_type, system_role FROM chart_of_accounts WHERE organization_id = ? AND deleted_at IS NULL AND is_active = 1",
    [input.organizationId]
  )
  const accounts = new Map(accountRows.map((row) => [String(row.id), { accountType: String(row.account_type), systemRole: String(row.system_role || "") }]))
  const lines = input.lines.map((item) => {
    const account = accounts.get(item.accountId)
    if (!account) throw new Error("One or more journal accounts are missing or inactive.")
    if (input.voucherType === "opening" && ["INVENTORY", "ACCOUNTS_RECEIVABLE", "ACCOUNTS_PAYABLE"].includes(account.systemRole)) {
      throw new Error("Inventory and party opening balances come from the controlled local subledgers and cannot be entered as an unlinked manual amount.")
    }
    return { accountId: item.accountId, accountType: account.accountType, debitMinor: moneyToMinor(item.debit, "Debit"), creditMinor: moneyToMinor(item.credit, "Credit"), description: item.description?.trim() || null }
  })
  const prefix = { journal: "JV", receipt: "RV", payment: "PV", contra: "CV", opening: "OP" }[input.voucherType]
  const [sequence] = await db.select<DataRow>(
    "SELECT next_number FROM accounting_sequences WHERE organization_id = ? AND financial_year_id = ? AND voucher_type = ? LIMIT 1",
    [input.organizationId, year.id, input.voucherType]
  )
  const next = Math.max(1, Number(sequence?.next_number || 1))
  const timestamp = nowIso()
  const draft = validateJournal({
    id: createOfflineId("voucher"), organizationId: input.organizationId, financialYearId: year.id,
    voucherNumber: `${prefix}-${String(next).padStart(5, "0")}`, voucherType: input.voucherType,
    voucherDate: input.voucherDate, sourceType: "MANUAL_JOURNAL", sourceId: createOfflineId("manual-source"),
    referenceNo: input.referenceNo?.trim() || null, narration: input.narration.trim() || "Manual journal",
    systemGenerated: false, createdBy: input.createdBy || null, lines,
  })
  await service.transaction(async (tx) => {
    await tx.execute(
      `INSERT OR IGNORE INTO accounting_sequences (id, organization_id, financial_year_id, voucher_type, prefix, next_number, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [`accounting-sequence:${input.organizationId}:${year.id}:${input.voucherType}`, input.organizationId, year.id, input.voucherType, prefix, timestamp]
    )
    await appendJournal(tx, draft)
    await tx.execute(
      "UPDATE accounting_sequences SET next_number = MAX(next_number, ?), updated_at = ? WHERE organization_id = ? AND financial_year_id = ? AND voucher_type = ?",
      [next + 1, timestamp, input.organizationId, year.id, input.voucherType]
    )
  })
  return draft
}

export async function loadPostedJournal(organizationId: string, voucherId: string) {
  const db = await service.requireConnection("read")
  const [voucher] = await db.select<DataRow>("SELECT * FROM accounting_vouchers WHERE organization_id = ? AND id = ? AND status = 'posted' LIMIT 1", [organizationId, voucherId])
  if (!voucher) return null
  const rows = await db.select<DataRow>("SELECT * FROM accounting_voucher_entries WHERE organization_id = ? AND voucher_id = ? ORDER BY line_no", [organizationId, voucherId])
  return validateJournal({
    id: String(voucher.id), organizationId, financialYearId: String(voucher.financial_year_id), voucherNumber: String(voucher.voucher_number),
    voucherType: String(voucher.voucher_type), voucherDate: String(voucher.voucher_date), sourceType: String(voucher.source_type), sourceId: String(voucher.source_id),
    referenceNo: voucher.reference_no ? String(voucher.reference_no) : null, narration: String(voucher.narration || ""), systemGenerated: Boolean(voucher.is_system_generated),
    createdBy: voucher.created_by ? String(voucher.created_by) : null,
    lines: rows.map((row) => ({
      accountId: String(row.account_id), accountType: String(row.account_type), debitMinor: Number(row.debit_minor), creditMinor: Number(row.credit_minor),
      partyType: row.party_type as JournalLine["partyType"], partyId: row.party_id ? String(row.party_id) : null,
      customerId: row.customer_id ? String(row.customer_id) : null, supplierId: row.supplier_id ? String(row.supplier_id) : null,
      description: row.description ? String(row.description) : null, reference: row.reference ? String(row.reference) : null,
    })),
  })
}

export async function loadPostedSourceJournal(organizationId: string, sourceType: string, sourceId: string) {
  const db = await service.requireConnection("read")
  const [voucher] = await db.select<DataRow>(
    "SELECT id FROM accounting_vouchers WHERE organization_id = ? AND source_type = ? AND source_id = ? AND status = 'posted' LIMIT 1",
    [organizationId, sourceType, sourceId]
  )
  return voucher ? loadPostedJournal(organizationId, String(voucher.id)) : null
}

export async function reverseJournal(input: { organizationId: string; voucherId: string; reversalDate: string; reason: string; sourceType?: string; sourceId?: string }) {
  if (!input.reason.trim()) throw new Error("A reversal reason is required.")
  const original = await loadPostedJournal(input.organizationId, input.voucherId)
  if (!original) throw new Error("Posted journal was not found.")
  const db = await service.requireConnection("read")
  const [stored] = await db.select<DataRow>("SELECT reversed_by_voucher_id FROM accounting_vouchers WHERE organization_id = ? AND id = ?", [input.organizationId, input.voucherId])
  if (stored?.reversed_by_voucher_id) return loadPostedJournal(input.organizationId, String(stored.reversed_by_voucher_id))
  if (original.sourceType === "SALES_INVOICE") throw new Error("Cancel a sales invoice from Invoices so stock, settlements, and every linked journal reverse together.")
  const [payment] = original.sourceType === "PAYMENT"
    ? await db.select<DataRow>("SELECT * FROM payments WHERE organization_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1", [input.organizationId, original.sourceId])
    : []
  const [expense] = original.sourceType === "EXPENSE"
    ? await db.select<DataRow>("SELECT * FROM expenses WHERE organization_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1", [input.organizationId, original.sourceId])
    : []
  const year = await assertFinancialYearWriteAllowed(input.organizationId, input.reversalDate)
  const reversal = buildReversalJournal(original, {
    id: createOfflineId("reversal"), voucherNumber: `REV-${original.voucherNumber}`, voucherDate: input.reversalDate,
    financialYearId: year.id, sourceType: input.sourceType || `${original.sourceType}_REVERSAL`, sourceId: input.sourceId || original.sourceId,
    narration: `Reversal of ${original.voucherNumber}: ${input.reason.trim()}`, createdBy: null,
  })
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await appendJournal(tx, reversal)
    if (payment) {
      const amount = Number(payment.amount || 0)
      await tx.execute(
        "UPDATE payments SET reversed_at = ?, reversal_voucher_id = ?, sync_status = 'pending_update', updated_at = ? WHERE organization_id = ? AND id = ? AND reversed_at IS NULL",
        [timestamp, reversal.id, timestamp, input.organizationId, original.sourceId]
      )
      if (payment.direction === "in" && payment.party_type === "customer" && payment.party_id) {
        await tx.execute(
          "UPDATE customers SET current_balance = COALESCE(current_balance, 0) + ?, sync_status = 'pending_update', updated_at = ? WHERE organization_id = ? AND id = ?",
          [amount, timestamp, input.organizationId, payment.party_id as SqlValue]
        )
        if (payment.document_type === "sales_invoice" && payment.document_id) {
          await tx.execute(
            `UPDATE sales_invoices SET paid_amount = MAX(0, COALESCE(paid_amount, 0) - ?),
               outstanding_amount = MAX(0, COALESCE(grand_total, total_amount, total, 0) - MAX(0, COALESCE(paid_amount, 0) - ?)),
               payment_status = CASE WHEN MAX(0, COALESCE(paid_amount, 0) - ?) <= 0.0001 THEN 'unpaid' ELSE 'partial' END,
               status = CASE WHEN MAX(0, COALESCE(paid_amount, 0) - ?) <= 0.0001 THEN 'unpaid' ELSE 'partial' END,
               sync_status = 'pending_update', updated_at = ? WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`,
            [amount, amount, amount, amount, timestamp, input.organizationId, payment.document_id as SqlValue]
          )
        }
      }
      if (payment.direction === "out" && payment.party_type === "supplier" && payment.party_id) {
        await tx.execute(
          "UPDATE suppliers SET current_balance = COALESCE(current_balance, 0) + ?, sync_status = 'pending_update', updated_at = ? WHERE organization_id = ? AND id = ?",
          [amount, timestamp, input.organizationId, payment.party_id as SqlValue]
        )
        if (payment.document_type === "purchase_invoice" && payment.document_id) {
          await tx.execute(
            `UPDATE purchase_invoices SET paid_amount = MAX(0, COALESCE(paid_amount, 0) - ?),
               outstanding_amount = MAX(0, COALESCE(grand_total, 0) - MAX(0, COALESCE(paid_amount, 0) - ?)),
               status = CASE WHEN MAX(0, COALESCE(paid_amount, 0) - ?) <= 0.0001 THEN 'unpaid' ELSE 'partial' END,
               sync_status = 'pending_update', updated_at = ? WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`,
            [amount, amount, amount, timestamp, input.organizationId, payment.document_id as SqlValue]
          )
        }
      }
    }
    if (expense) {
      await tx.execute(
        "UPDATE expenses SET reversed_at = ?, sync_status = 'pending_update', updated_at = ? WHERE organization_id = ? AND id = ? AND reversed_at IS NULL",
        [timestamp, timestamp, input.organizationId, original.sourceId]
      )
    }
  })
  return reversal
}

export type AccountingExpenseInput = {
  organizationId: string
  expenseDate: string
  description: string
  vendorName?: string
  category?: string
  expenseAccountId: string
  paymentAccountId: string
  amount: unknown
  cgst?: unknown
  sgst?: unknown
  igst?: unknown
  paymentMethod?: string
  referenceNo?: string
}

async function prepareAccountingExpense(input: AccountingExpenseInput) {
  await initializeAccounting(input.organizationId, input.expenseDate)
  const year = await assertFinancialYearWriteAllowed(input.organizationId, input.expenseDate)
  const db = await service.requireConnection("read")
  const selected = await db.select<DataRow>(
    `SELECT id, account_code, account_name, account_type, system_role FROM chart_of_accounts
     WHERE organization_id = ? AND id IN (?, ?) AND is_active = 1 AND deleted_at IS NULL`,
    [input.organizationId, input.expenseAccountId, input.paymentAccountId]
  )
  const expenseAccount = selected.find((row) => row.id === input.expenseAccountId)
  const paymentAccount = selected.find((row) => row.id === input.paymentAccountId)
  if (!expenseAccount || String(expenseAccount.account_type) !== "EXPENSE") throw new Error("Select an active expense account.")
  if (!paymentAccount || !["ASSET", "LIABILITY"].includes(String(paymentAccount.account_type))) throw new Error("Select an active payment account.")
  const system = await systemAccountMap(input.organizationId)
  const inputCgst = system.get("INPUT_CGST")
  const inputSgst = system.get("INPUT_SGST")
  const inputIgst = system.get("INPUT_IGST")
  if (!inputCgst || !inputSgst || !inputIgst) throw new Error("Input GST accounts are missing.")
  const expenseId = createOfflineId("expense")
  const expensePosting = buildExpenseJournal({
    id: createOfflineId("expense-voucher"), organizationId: input.organizationId, financialYearId: year.id,
    voucherNumber: `EXP-${expenseId.slice(-8).toUpperCase()}`, voucherType: "expense", voucherDate: input.expenseDate,
    sourceType: "EXPENSE", sourceId: expenseId, referenceNo: input.referenceNo?.trim() || null,
    narration: input.description.trim() || "Expense", systemGenerated: true,
    expenseAccount: rowAccount(expenseAccount), paymentAccount: rowAccount(paymentAccount),
    inputCgstAccount: inputCgst, inputSgstAccount: inputSgst, inputIgstAccount: inputIgst,
    amountMinor: moneyToMinor(input.amount, "Expense amount"), cgstMinor: moneyToMinor(input.cgst || 0, "CGST"),
    sgstMinor: moneyToMinor(input.sgst || 0, "SGST"), igstMinor: moneyToMinor(input.igst || 0, "IGST"),
  })
  const journal = expensePosting.journal
  const timestamp = nowIso()
  const isUnpaid = String(paymentAccount.account_type) === "LIABILITY"
  return { expenseId, expensePosting, journal, timestamp, isUnpaid, financialYearId: year.id }
}

async function insertAccountingExpense(tx: SqlExecutor, input: AccountingExpenseInput, prepared: Awaited<ReturnType<typeof prepareAccountingExpense>>, revision = 1, replacesExpenseId: string | null = null) {
  const { expenseId, expensePosting, journal, timestamp, isUnpaid, financialYearId } = prepared
  await tx.execute(
    `INSERT INTO expenses (
       id, organization_id, category, description, amount, tax_amount, expense_date, payment_status,
       paid_amount, outstanding_amount, payment_method, reference_no, financial_year_id, expense_account_id,
       payment_account_id, accounting_voucher_id, vendor_name, amount_minor, cgst_minor, sgst_minor, igst_minor,
       revision, replaces_expense_id, sync_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?)`,
    [
      expenseId, input.organizationId, input.category?.trim() || null, input.description.trim(), minorToMoney(expensePosting.amountMinor),
      minorToMoney(expensePosting.cgstMinor + expensePosting.sgstMinor + expensePosting.igstMinor), input.expenseDate,
      isUnpaid ? "unpaid" : "paid", isUnpaid ? 0 : minorToMoney(expensePosting.amountMinor), isUnpaid ? minorToMoney(expensePosting.amountMinor) : 0,
      input.paymentMethod || "cash", input.referenceNo?.trim() || null, financialYearId, input.expenseAccountId, input.paymentAccountId,
      journal.id, input.vendorName?.trim() || null, expensePosting.amountMinor, expensePosting.cgstMinor, expensePosting.sgstMinor, expensePosting.igstMinor,
      revision, replacesExpenseId, timestamp, timestamp,
    ]
  )
  await appendJournal(tx, journal)
}

export async function createAccountingExpense(input: AccountingExpenseInput) {
  const prepared = await prepareAccountingExpense(input)
  await service.transaction(async (tx) => {
    await insertAccountingExpense(tx, input, prepared)
  })
  return { id: prepared.expenseId, voucherId: prepared.journal.id }
}

export async function reverseAccountingExpense(organizationId: string, expenseId: string, reversalDate: string, reason: string) {
  const db = await service.requireConnection("read")
  const [expense] = await db.select<DataRow>(
    "SELECT accounting_voucher_id, reversed_at FROM expenses WHERE organization_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1",
    [organizationId, expenseId]
  )
  if (!expense) throw new Error("Expense was not found.")
  if (!expense.accounting_voucher_id) throw new Error("This legacy expense predates the controlled opening and requires a reviewed manual adjustment.")
  return reverseJournal({ organizationId, voucherId: String(expense.accounting_voucher_id), reversalDate, reason, sourceType: "EXPENSE_REVERSAL", sourceId: expenseId })
}

export async function replaceAccountingExpense(expenseId: string, input: AccountingExpenseInput, reason: string) {
  if (!reason.trim()) throw new Error("Explain why the expense is being replaced.")
  const db = await service.requireConnection("read")
  const [original] = await db.select<DataRow>("SELECT revision, reversed_at, accounting_voucher_id FROM expenses WHERE organization_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1", [input.organizationId, expenseId])
  if (!original) throw new Error("Expense was not found.")
  if (original.reversed_at) throw new Error("This expense has already been reversed or replaced.")
  if (!original.accounting_voucher_id) throw new Error("This legacy expense predates the controlled opening and requires a reviewed manual adjustment.")
  const originalJournal = await loadPostedJournal(input.organizationId, String(original.accounting_voucher_id))
  if (!originalJournal) throw new Error("The expense journal was not found.")
  const [storedJournal] = await db.select<DataRow>("SELECT reversed_by_voucher_id FROM accounting_vouchers WHERE organization_id = ? AND id = ?", [input.organizationId, originalJournal.id])
  if (storedJournal?.reversed_by_voucher_id) throw new Error("This expense has already been reversed or replaced.")
  const replacement = await prepareAccountingExpense(input)
  const reversal = buildReversalJournal(originalJournal, {
    id: createOfflineId("expense-reversal"), voucherNumber: `REV-${originalJournal.voucherNumber}`,
    voucherDate: input.expenseDate, financialYearId: replacement.financialYearId,
    sourceType: "EXPENSE_REVERSAL", sourceId: expenseId,
    narration: `Expense replaced: ${reason.trim()}`, createdBy: null,
  })
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await appendJournal(tx, reversal)
    await tx.execute(
      "UPDATE expenses SET reversed_at = ?, reversal_voucher_id = ?, replaced_by_expense_id = ?, sync_status = 'pending_update', updated_at = ? WHERE organization_id = ? AND id = ? AND reversed_at IS NULL",
      [timestamp, reversal.id, replacement.expenseId, timestamp, input.organizationId, expenseId]
    )
    await insertAccountingExpense(tx, input, replacement, Math.max(1, Number(original.revision || 1)) + 1, expenseId)
  })
  return { originalExpenseId: expenseId, replacementExpenseId: replacement.expenseId, reversalVoucherId: reversal.id, replacementVoucherId: replacement.journal.id }
}

export async function accountingIntegrity(organizationId: string, financialYearId?: string | null) {
  const db = await service.requireConnection("read")
  const yearFilter = financialYearId ? "AND voucher.financial_year_id = ?" : ""
  const values: SqlValue[] = financialYearId ? [organizationId, financialYearId] : [organizationId]
  const [summary] = await db.select<DataRow>(
    `SELECT
       COUNT(*) AS posted_vouchers,
       COALESCE(SUM(CASE WHEN totals.debit_minor <> totals.credit_minor OR totals.debit_minor <> totals.header_debit OR totals.credit_minor <> totals.header_credit THEN 1 ELSE 0 END), 0) AS unbalanced_vouchers,
       COALESCE(SUM(CASE WHEN totals.line_count < 2 THEN 1 ELSE 0 END), 0) AS incomplete_vouchers
     FROM (
       SELECT voucher.id, voucher.total_debit_minor AS header_debit, voucher.total_credit_minor AS header_credit,
         COUNT(line.id) AS line_count, COALESCE(SUM(line.debit_minor), 0) AS debit_minor, COALESCE(SUM(line.credit_minor), 0) AS credit_minor
       FROM accounting_vouchers voucher LEFT JOIN accounting_voucher_entries line ON line.voucher_id = voucher.id AND line.organization_id = voucher.organization_id
       WHERE voucher.organization_id = ? AND voucher.status = 'posted' ${yearFilter}
       GROUP BY voucher.id
     ) totals`,
    values
  )
  const [orphans] = await db.select<DataRow>(
    `SELECT COUNT(*) AS count FROM accounting_voucher_entries line
     LEFT JOIN accounting_vouchers voucher ON voucher.id = line.voucher_id AND voucher.organization_id = line.organization_id
     LEFT JOIN chart_of_accounts account ON account.id = line.account_id AND account.organization_id = line.organization_id
     WHERE line.organization_id = ? AND (voucher.id IS NULL OR account.id IS NULL)`,
    [organizationId]
  )
  const [duplicateSources] = await db.select<DataRow>(
    `SELECT COUNT(*) AS count FROM (
       SELECT source_type, source_id FROM accounting_vouchers WHERE organization_id = ? AND status = 'posted'
       AND source_type IS NOT NULL AND source_id IS NOT NULL GROUP BY source_type, source_id HAVING COUNT(*) > 1
     )`,
    [organizationId]
  )
  const [invalidFinancialYears] = await db.select<DataRow>(
    `SELECT COUNT(*) AS count FROM accounting_vouchers voucher
     LEFT JOIN financial_years year ON year.id = voucher.financial_year_id AND year.organization_id = voucher.organization_id
     WHERE voucher.organization_id = ? AND voucher.status = 'posted'
       AND (year.id IS NULL OR voucher.voucher_date < year.start_date OR voucher.voucher_date > year.end_date)`,
    [organizationId]
  )
  const [invalidCurrencyLines] = await db.select<DataRow>(
    `SELECT COUNT(*) AS count FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id = line.voucher_id
     WHERE line.organization_id = ? AND voucher.status = 'posted' AND (
       line.debit_minor < 0 OR line.credit_minor < 0
       OR (line.debit_minor = 0 AND line.credit_minor = 0)
       OR (line.debit_minor > 0 AND line.credit_minor > 0)
       OR typeof(line.debit_minor) <> 'integer' OR typeof(line.credit_minor) <> 'integer'
     )`,
    [organizationId]
  )
  const [openWarnings] = await db.select<DataRow>("SELECT COUNT(*) AS count FROM accounting_warnings WHERE organization_id = ? AND status = 'OPEN'", [organizationId])
  const report = {
    postedVouchers: Number(summary?.posted_vouchers || 0),
    unbalancedVouchers: Number(summary?.unbalanced_vouchers || 0),
    incompleteVouchers: Number(summary?.incomplete_vouchers || 0),
    orphanLines: Number(orphans?.count || 0),
    duplicateSources: Number(duplicateSources?.count || 0),
    invalidFinancialYears: Number(invalidFinancialYears?.count || 0),
    invalidCurrencyLines: Number(invalidCurrencyLines?.count || 0),
    openWarnings: Number(openWarnings?.count || 0),
  }
  return { ...report, ok: report.unbalancedVouchers === 0 && report.incompleteVouchers === 0 && report.orphanLines === 0 && report.duplicateSources === 0 && report.invalidFinancialYears === 0 && report.invalidCurrencyLines === 0 }
}

export type AccountingReportName = "overview" | "journals" | "general-ledger" | "trial-balance" | "profit-loss" | "balance-sheet" | "cash-flow" | "expenses" | "warnings"

export async function accountingReport(input: {
  organizationId: string
  financialYearId: string
  report: AccountingReportName
  from?: string
  to?: string
  accountId?: string
  page?: number
  limit?: number
  transactionType?: string
  direction?: "asc" | "desc"
  search?: string
}) {
  await ensureDefaultAccountingAccounts(input.organizationId)
  const year = await getFinancialYear(input.organizationId, input.financialYearId)
  if (!year) throw new Error("Financial year was not found.")
  const from = input.from || year.start_date
  const to = input.to || year.end_date
  if (from < year.start_date || to > year.end_date || from > to) throw new Error("Report dates must be within the selected financial year.")
  const db = await service.requireConnection("read")
  if (input.report === "journals") {
    const page = Math.max(1, input.page || 1)
    const limit = Math.min(200, Math.max(1, input.limit || 50))
    const transactionType = input.transactionType && input.transactionType !== "all" ? input.transactionType : null
    const typeClause = transactionType ? "AND voucher_type = ?" : ""
    const search = input.search?.trim() || null
    const searchClause = search ? "AND (voucher_number LIKE ? OR narration LIKE ? OR reference_no LIKE ? OR source_type LIKE ?)" : ""
    const queryValues: SqlValue[] = [input.organizationId, input.financialYearId, from, to]
    if (transactionType) queryValues.push(transactionType)
    if (search) queryValues.push(...Array.from({ length: 4 }, () => `%${search}%`))
    const [count] = await db.select<DataRow>(
      `SELECT COUNT(*) count FROM accounting_vouchers WHERE organization_id = ? AND financial_year_id = ? AND status = 'posted' AND voucher_date BETWEEN ? AND ? ${typeClause} ${searchClause}`,
      queryValues
    )
    const rows = await db.select<DataRow>(
      `SELECT voucher.*, original.voucher_number AS reversal_of_number
       FROM accounting_vouchers voucher LEFT JOIN accounting_vouchers original ON original.id = voucher.reversal_of_voucher_id
       WHERE voucher.organization_id = ? AND voucher.financial_year_id = ? AND voucher.status = 'posted' AND voucher.voucher_date BETWEEN ? AND ? ${transactionType ? "AND voucher.voucher_type = ?" : ""} ${search ? "AND (voucher.voucher_number LIKE ? OR voucher.narration LIKE ? OR voucher.reference_no LIKE ? OR voucher.source_type LIKE ?)" : ""}
       ORDER BY voucher.voucher_date ${input.direction === "asc" ? "ASC" : "DESC"}, voucher.created_at ${input.direction === "asc" ? "ASC" : "DESC"} LIMIT ? OFFSET ?`,
      [...queryValues, limit, (page - 1) * limit]
    )
    const voucherIds = rows.map((row) => String(row.id)).filter(Boolean)
    const entries = voucherIds.length
      ? await db.select<DataRow>(
          `SELECT line.*, account.account_code, account.account_name
           FROM accounting_voucher_entries line JOIN chart_of_accounts account ON account.id = line.account_id
           WHERE line.organization_id = ? AND line.voucher_id IN (${voucherIds.map(() => "?").join(", ")})
           ORDER BY line.voucher_id, line.line_no`,
          [input.organizationId, ...voucherIds]
        )
      : []
    return { report: input.report, year, from, to, rows, entries, total: Number(count?.count || 0), page, limit }
  }
  if (input.report === "general-ledger") {
    if (!input.accountId) throw new Error("Select an account for the general ledger.")
    const page = Math.max(1, input.page || 1)
    const limit = Math.min(500, Math.max(1, input.limit || 100))
    const [opening] = await db.select<DataRow>(
      `SELECT COALESCE(SUM(line.debit_minor - line.credit_minor), 0) balance_minor
       FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id = line.voucher_id
       WHERE line.organization_id = ? AND line.account_id = ? AND voucher.status = 'posted'
         AND voucher.financial_year_id = ? AND voucher.voucher_date < ?`,
      [input.organizationId, input.accountId, input.financialYearId, from]
    )
    const transactionType = input.transactionType && input.transactionType !== "all" ? input.transactionType : null
    const periodValues: SqlValue[] = transactionType
      ? [input.organizationId, input.accountId, input.financialYearId, from, to, transactionType]
      : [input.organizationId, input.accountId, input.financialYearId, from, to]
    const [count] = await db.select<DataRow>(
      `SELECT COUNT(*) count FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id = line.voucher_id
       WHERE line.organization_id = ? AND line.account_id = ? AND voucher.status = 'posted'
         AND voucher.financial_year_id = ? AND voucher.voucher_date BETWEEN ? AND ? ${transactionType ? "AND voucher.voucher_type = ?" : ""}`,
      periodValues
    )
    const rows = await db.select<DataRow>(
      `SELECT voucher.voucher_date, voucher.voucher_number, voucher.voucher_type, voucher.reference_no, voucher.narration,
         line.line_no, line.description, line.debit_minor, line.credit_minor,
         ? + SUM(line.debit_minor - line.credit_minor) OVER (ORDER BY voucher.voucher_date, voucher.created_at, line.line_no, line.id) AS running_balance_minor
       FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id = line.voucher_id
       WHERE line.organization_id = ? AND line.account_id = ? AND voucher.status = 'posted'
         AND voucher.financial_year_id = ? AND voucher.voucher_date BETWEEN ? AND ? ${transactionType ? "AND voucher.voucher_type = ?" : ""}
       ORDER BY voucher.voucher_date ${input.direction === "desc" ? "DESC" : "ASC"}, voucher.created_at ${input.direction === "desc" ? "DESC" : "ASC"}, line.line_no ${input.direction === "desc" ? "DESC" : "ASC"}, line.id ${input.direction === "desc" ? "DESC" : "ASC"} LIMIT ? OFFSET ?`,
      [Number(opening?.balance_minor || 0), ...periodValues, limit, (page - 1) * limit]
    )
    return { report: input.report, year, from, to, openingMinor: Number(opening?.balance_minor || 0), rows, total: Number(count?.count || 0), page, limit }
  }

  const balances = await db.select<DataRow>(
    `SELECT account.id, account.account_code, account.account_name, account.account_type, account.account_group, account.normal_balance,
       COALESCE(SUM(CASE WHEN voucher.voucher_date < ? THEN line.debit_minor - line.credit_minor ELSE 0 END), 0) AS opening_minor,
       COALESCE(SUM(CASE WHEN voucher.voucher_date BETWEEN ? AND ? THEN line.debit_minor ELSE 0 END), 0) AS debit_minor,
       COALESCE(SUM(CASE WHEN voucher.voucher_date BETWEEN ? AND ? THEN line.credit_minor ELSE 0 END), 0) AS credit_minor,
       COALESCE(SUM(CASE WHEN voucher.voucher_date <= ? THEN line.debit_minor - line.credit_minor ELSE 0 END), 0) AS closing_minor
     FROM chart_of_accounts account
     LEFT JOIN accounting_voucher_entries line ON line.account_id = account.id AND line.organization_id = account.organization_id
     LEFT JOIN accounting_vouchers voucher ON voucher.id = line.voucher_id AND voucher.status = 'posted' AND voucher.financial_year_id = ?
     WHERE account.organization_id = ? AND account.deleted_at IS NULL
     GROUP BY account.id ORDER BY account.account_code COLLATE NOCASE`,
    [from, from, to, from, to, to, input.financialYearId, input.organizationId]
  )
  const active: DataRow[] = balances
    .filter((row) => Number(row.opening_minor || 0) || Number(row.debit_minor || 0) || Number(row.credit_minor || 0))
    .map((row): DataRow => ({
      ...row,
      opening_debit_minor: Math.max(0, Number(row.opening_minor || 0)),
      opening_credit_minor: Math.max(0, -Number(row.opening_minor || 0)),
      closing_debit_minor: Math.max(0, Number(row.closing_minor || 0)),
      closing_credit_minor: Math.max(0, -Number(row.closing_minor || 0)),
    }))
  const byType = (types: string[]) => active.filter((row) => types.includes(String(row.account_type)))
  const signed = (row: DataRow) => Number(row.closing_minor || 0)
  const incomeMinor = byType(["INCOME"]).reduce((sum, row) => sum - signed(row), 0)
  const expenseMinor = byType(["EXPENSE"]).reduce((sum, row) => sum + signed(row), 0)
  const cogsMinor = active.filter((row) => row.account_group === "COGS").reduce((sum, row) => sum + signed(row), 0)
  const operatingExpenseMinor = expenseMinor - cogsMinor
  const cashRows = active.filter((row) => ["CASH", "BANK"].includes(String(row.account_group)))
  const integrity = await accountingIntegrity(input.organizationId, input.financialYearId)
  if (input.report === "trial-balance") {
    return { report: input.report, year, from, to, rows: active, totalDebitMinor: active.reduce((sum, row) => sum + Math.max(0, signed(row)), 0), totalCreditMinor: active.reduce((sum, row) => sum + Math.max(0, -signed(row)), 0), integrity }
  }
  if (input.report === "profit-loss") return { report: input.report, year, from, to, income: byType(["INCOME"]), expenses: byType(["EXPENSE"]), incomeMinor, cogsMinor, grossProfitMinor: incomeMinor - cogsMinor, operatingExpenseMinor, expenseMinor, netProfitMinor: incomeMinor - expenseMinor, integrity }
  if (input.report === "balance-sheet") {
    const assets = byType(["ASSET"])
    const liabilities = byType(["LIABILITY"])
    const equityRows = byType(["EQUITY"])
    const assetMinor = assets.reduce((sum, row) => sum + signed(row), 0)
    const liabilitiesMinor = liabilities.reduce((sum, row) => sum - signed(row), 0)
    const equityMinor = equityRows.reduce((sum, row) => sum - signed(row), 0) + incomeMinor - expenseMinor
    return { report: input.report, year, from, to, assets, liabilities, equity: equityRows, assetMinor, liabilitiesMinor, equityMinor, differenceMinor: assetMinor - liabilitiesMinor - equityMinor, integrity }
  }
  if (input.report === "cash-flow") {
    const openingMinor = cashRows.reduce((sum, row) => sum + Number(row.opening_minor || 0), 0)
    const inflowMinor = cashRows.reduce((sum, row) => sum + Number(row.debit_minor || 0), 0)
    const outflowMinor = cashRows.reduce((sum, row) => sum + Number(row.credit_minor || 0), 0)
    return { report: input.report, year, from, to, rows: cashRows, openingMinor, inflowMinor, outflowMinor, netMovementMinor: inflowMinor - outflowMinor, closingMinor: openingMinor + inflowMinor - outflowMinor, sections: [{ name: "Operating activities", movementMinor: inflowMinor - outflowMinor }, { name: "Investing activities", movementMinor: 0 }, { name: "Financing activities", movementMinor: 0 }], classificationBasis: "Conservative Phase 1 cash-account reconciliation; unclassified cash movements are operating until account groups are expanded.", integrity }
  }
  if (input.report === "expenses") {
    const page = Math.max(1, input.page || 1)
    const limit = Math.min(200, Math.max(1, input.limit || 50))
    const search = input.search?.trim() || null
    const searchClause = search ? "AND (description LIKE ? OR vendor_name LIKE ? OR category LIKE ? OR reference_no LIKE ?)" : ""
    const values: SqlValue[] = search
      ? [input.organizationId, input.financialYearId, from, to, ...Array.from({ length: 4 }, () => `%${search}%`)]
      : [input.organizationId, input.financialYearId, from, to]
    const [count] = await db.select<DataRow>(`SELECT COUNT(*) count FROM expenses WHERE organization_id = ? AND financial_year_id = ? AND deleted_at IS NULL AND expense_date BETWEEN ? AND ? ${searchClause}`, values)
    const rows = await db.select<DataRow>(`SELECT * FROM expenses WHERE organization_id = ? AND financial_year_id = ? AND deleted_at IS NULL AND expense_date BETWEEN ? AND ? ${searchClause} ORDER BY expense_date DESC, created_at DESC LIMIT ? OFFSET ?`, [...values, limit, (page - 1) * limit])
    return { report: input.report, year, from, to, rows, total: Number(count?.count || 0), page, limit, totalMinor: rows.reduce((sum, row) => sum + Number(row.amount_minor || 0), 0), integrity }
  }
  if (input.report === "warnings") {
    const rows = await db.select<DataRow>("SELECT * FROM accounting_warnings WHERE organization_id = ? ORDER BY status, created_at DESC", [input.organizationId])
    return { report: input.report, year, from, to, rows, integrity }
  }
  return { report: "overview", year, from, to, incomeMinor, expenseMinor, cogsMinor, netProfitMinor: incomeMinor - expenseMinor, cashMinor: cashRows.reduce((sum, row) => sum + signed(row), 0), inventoryMinor: active.filter((row) => row.account_group === "INVENTORY").reduce((sum, row) => sum + signed(row), 0), receivablesMinor: active.filter((row) => row.account_group === "RECEIVABLE").reduce((sum, row) => sum + signed(row), 0), payablesMinor: active.filter((row) => row.account_group === "PAYABLE").reduce((sum, row) => sum - signed(row), 0), integrity }
}
