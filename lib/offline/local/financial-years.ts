"use client"

import { invokeTauri } from "@/lib/desktop/tauri"
import {
  closeConfirmation,
  financialYearForDate,
  nextFinancialYear,
  normalizeLocalDate,
  reopenConfirmation,
  type FinancialYear,
  type InvoiceNumberingMode,
} from "@/lib/financial-years"
import { createOfflineId } from "@/lib/offline/db"
import { getLocalDatabaseService, type SqlValue } from "@/lib/offline/local/service"

type DataRow = Record<string, unknown>

export type FinancialYearSummary = {
  financialYearId: string
  invoiceCount: number
  revenue: number
  taxableRevenue: number
  gst: number
  paidInvoices: number
  outstandingInvoices: number
  outstandingReceivables: number
  supplierPayables: number
  productCount: number
  customerCount: number
  supplierCount: number
  warehouseCount: number
  closingInventoryQuantity: number
  closingInventorySellingValue: number
  closingInventoryCost: number
  batchCount: number
}

export type FinancialYearClosingChecks = {
  integrity: { quickCheck: unknown; foreignKeyViolations: number; ok: boolean }
  blockers: string[]
  warnings: string[]
}

type BackupResult = {
  backupPath: string
  checksumSha256: string
  bytes: number
  createdAt: string
}

const service = getLocalDatabaseService()

function nowIso() {
  return new Date().toISOString()
}

function numeric(row: DataRow | undefined, key: string) {
  return Number(row?.[key] || 0)
}

function boolInt(value: unknown) {
  return Number(value || 0) === 1
}

function normalizeYear(row: DataRow): FinancialYear {
  return {
    ...(row as unknown as FinancialYear),
    status: String(row.status || "OPEN") as FinancialYear["status"],
    is_active: boolInt(row.is_active),
    start_month: Number(row.start_month || 4),
    invoice_numbering_mode: String(row.invoice_numbering_mode || "CONTINUE") as InvoiceNumberingMode,
    schema_version: Number(row.schema_version || 1),
  }
}

async function ensureCurrentFinancialYear(organizationId: string) {
  const current = financialYearForDate(organizationId, new Date())
  const timestamp = new Date().toISOString()
  await service.transaction(async (tx) => {
    const [organization] = await tx.select<DataRow>("SELECT id, next_invoice_number FROM organizations WHERE id = ? LIMIT 1", [organizationId])
    if (!organization) throw new Error("The licensed business was not found in the local database.")
    await tx.execute(
      `INSERT OR IGNORE INTO financial_years (
         id, organization_id, label, start_date, end_date, start_month, status, is_active,
         invoice_numbering_mode, opening_snapshot_json, schema_version, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'OPEN',
         CASE WHEN NOT EXISTS (SELECT 1 FROM financial_years WHERE organization_id = ? AND is_active = 1) THEN 1 ELSE 0 END,
         'CONTINUE', ?, 1, ?)`,
      [current.id, organizationId, current.label, current.startDate, current.endDate, current.startMonth, organizationId, JSON.stringify({ kind: "initial_financial_year", generated_at: timestamp }), timestamp]
    )
    await tx.execute(
      `INSERT OR IGNORE INTO financial_year_invoice_sequences (id, organization_id, financial_year_id, next_number, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [`fy-sequence:${current.id}`, organizationId, current.id, Math.max(1, Number(organization.next_invoice_number || 1)), timestamp]
    )
  })
}

export async function listFinancialYears(organizationId: string) {
  let db = await service.requireConnection("read")
  let rows = await db.select<DataRow>(
    `SELECT fy.*,
       (SELECT COUNT(*) FROM sales_invoices invoice WHERE invoice.organization_id = fy.organization_id AND invoice.financial_year_id = fy.id AND invoice.deleted_at IS NULL) AS invoice_count
     FROM financial_years fy
     WHERE fy.organization_id = ?
     ORDER BY fy.start_date DESC`,
    [organizationId]
  )
  if (rows.length === 0) {
    await ensureCurrentFinancialYear(organizationId)
    db = await service.requireConnection("read")
    rows = await db.select<DataRow>(
      `SELECT fy.*,
         (SELECT COUNT(*) FROM sales_invoices invoice WHERE invoice.organization_id = fy.organization_id AND invoice.financial_year_id = fy.id AND invoice.deleted_at IS NULL) AS invoice_count
       FROM financial_years fy WHERE fy.organization_id = ? ORDER BY fy.start_date DESC`,
      [organizationId]
    )
  }
  return rows.map(normalizeYear)
}

export async function getFinancialYear(organizationId: string, financialYearIdValue: string) {
  const db = await service.requireConnection("read")
  const [row] = await db.select<DataRow>("SELECT * FROM financial_years WHERE organization_id = ? AND id = ? LIMIT 1", [organizationId, financialYearIdValue])
  return row ? normalizeYear(row) : null
}

export async function getActiveFinancialYear(organizationId: string) {
  const db = await service.requireConnection("read")
  const [row] = await db.select<DataRow>("SELECT * FROM financial_years WHERE organization_id = ? AND is_active = 1 LIMIT 1", [organizationId])
  return row ? normalizeYear(row) : null
}

export async function financialYearForTransactionDate(organizationId: string, value: string) {
  const date = normalizeLocalDate(value)
  const db = await service.requireConnection("read")
  const [row] = await db.select<DataRow>(
    "SELECT * FROM financial_years WHERE organization_id = ? AND date(?) BETWEEN date(start_date) AND date(end_date) LIMIT 1",
    [organizationId, date]
  )
  return row ? normalizeYear(row) : null
}

export async function assertFinancialYearWriteAllowed(organizationId: string, value: string, requestedFinancialYearId?: string | null) {
  const date = normalizeLocalDate(value)
  let year = await financialYearForTransactionDate(organizationId, date)
  if (!year) {
    const db = await service.requireConnection("read")
    const [existing] = await db.select<DataRow>("SELECT COUNT(*) AS count FROM financial_years WHERE organization_id = ?", [organizationId])
    if (numeric(existing, "count") === 0) {
      await ensureCurrentFinancialYear(organizationId)
      year = await financialYearForTransactionDate(organizationId, date)
    }
  }
  if (!year) {
    const calculated = financialYearForDate(organizationId, date)
    throw new Error(`${calculated.label} has not been created. Create it in Settings → Financial Years before entering this transaction.`)
  }
  if (requestedFinancialYearId && requestedFinancialYearId !== year.id) {
    throw new Error(`${new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${date}T12:00:00`))} belongs to ${year.label}. Switch to that financial year and try again.`)
  }
  if (year.status !== "OPEN") {
    throw new Error(`${year.label} is closed. Reopen it from Settings → Financial Years before creating or changing dated transactions.`)
  }
  return year
}

export async function financialYearSummary(organizationId: string, financialYearIdValue: string): Promise<FinancialYearSummary> {
  const db = await service.requireConnection("read")
  const year = await getFinancialYear(organizationId, financialYearIdValue)
  if (!year) throw new Error("Financial year was not found for this business.")
  if (year.status !== "OPEN" && year.close_summary_json) {
    try {
      return JSON.parse(year.close_summary_json) as FinancialYearSummary
    } catch {
      // Older closed snapshots can be recomputed from their immutable transactions.
    }
  }
  const [invoiceRows, masterRows, inventoryRows, batchRows] = await Promise.all([
    db.select<DataRow>(
      `SELECT COUNT(*) AS invoiceCount,
        COALESCE(SUM(COALESCE(grand_total, total_amount, total, 0)), 0) AS revenue,
        COALESCE(SUM(COALESCE(taxable_amount, 0)), 0) AS taxableRevenue,
        COALESCE(SUM(COALESCE(tax_total, tax_amount, 0)), 0) AS gst,
        SUM(CASE WHEN lower(COALESCE(payment_status, status, '')) IN ('paid', 'completed', 'success') THEN 1 ELSE 0 END) AS paidInvoices,
        SUM(CASE WHEN COALESCE(outstanding_amount, 0) > 0 THEN 1 ELSE 0 END) AS outstandingInvoices
       FROM sales_invoices WHERE organization_id = ? AND financial_year_id = ? AND deleted_at IS NULL AND invoice_type <> 'proforma'`,
      [organizationId, financialYearIdValue]
    ),
    db.select<DataRow>(
      `SELECT
        (SELECT COUNT(*) FROM products WHERE organization_id = ? AND deleted_at IS NULL) AS productCount,
        (SELECT COUNT(*) FROM customers WHERE organization_id = ? AND deleted_at IS NULL) AS customerCount,
        (SELECT COUNT(*) FROM suppliers WHERE organization_id = ? AND deleted_at IS NULL) AS supplierCount,
        (SELECT COUNT(*) FROM warehouses WHERE organization_id = ? AND deleted_at IS NULL) AS warehouseCount,
        (SELECT COALESCE(SUM(MAX(current_balance, 0)), 0) FROM customers WHERE organization_id = ? AND deleted_at IS NULL) AS outstandingReceivables,
        (SELECT COALESCE(SUM(MAX(current_balance, 0)), 0) FROM suppliers WHERE organization_id = ? AND deleted_at IS NULL) AS supplierPayables`,
      [organizationId, organizationId, organizationId, organizationId, organizationId, organizationId]
    ),
    db.select<DataRow>(
      `SELECT COALESCE(SUM(stock), 0) AS closingInventoryQuantity,
        COALESCE(SUM(stock * COALESCE(NULLIF(sale_rate, 0), NULLIF(price, 0), mrp, purchase_rate, 0)), 0) AS closingInventorySellingValue,
        COALESCE(SUM(stock * COALESCE(purchase_rate, 0)), 0) AS closingInventoryCost
       FROM products WHERE organization_id = ? AND deleted_at IS NULL`,
      [organizationId]
    ),
    db.select<DataRow>("SELECT COUNT(*) AS batchCount FROM stock_batches WHERE organization_id = ? AND deleted_at IS NULL AND quantity > 0", [organizationId]),
  ])
  const invoice = invoiceRows[0]
  const master = masterRows[0]
  const inventory = inventoryRows[0]
  return {
    financialYearId: financialYearIdValue,
    invoiceCount: numeric(invoice, "invoiceCount"),
    revenue: numeric(invoice, "revenue"),
    taxableRevenue: numeric(invoice, "taxableRevenue"),
    gst: numeric(invoice, "gst"),
    paidInvoices: numeric(invoice, "paidInvoices"),
    outstandingInvoices: numeric(invoice, "outstandingInvoices"),
    outstandingReceivables: numeric(master, "outstandingReceivables"),
    supplierPayables: numeric(master, "supplierPayables"),
    productCount: numeric(master, "productCount"),
    customerCount: numeric(master, "customerCount"),
    supplierCount: numeric(master, "supplierCount"),
    warehouseCount: numeric(master, "warehouseCount"),
    closingInventoryQuantity: numeric(inventory, "closingInventoryQuantity"),
    closingInventorySellingValue: numeric(inventory, "closingInventorySellingValue"),
    closingInventoryCost: numeric(inventory, "closingInventoryCost"),
    batchCount: numeric(batchRows[0], "batchCount"),
  }
}

async function inventoryCarryForwardBlockers(organizationId: string) {
  const db = await service.requireConnection("read")
  const rows = await db.select<DataRow>(
    `SELECT product.id, product.name, product.stock, COALESCE(SUM(batch.quantity), 0) AS batch_quantity
     FROM products product
     LEFT JOIN stock_batches batch ON batch.organization_id = product.organization_id AND batch.product_id = product.id AND batch.deleted_at IS NULL AND batch.quantity > 0
     WHERE product.organization_id = ? AND product.deleted_at IS NULL
     GROUP BY product.id
     HAVING COALESCE(SUM(batch.quantity), 0) > product.stock + 0.0001`,
    [organizationId]
  )
  return rows.map((row) => `${String(row.name || "Product")} has batch quantity ${Number(row.batch_quantity)} above physical stock ${Number(row.stock)}.`)
}

export async function createNextFinancialYear(organizationId: string, sourceFinancialYearId: string) {
  const source = await getFinancialYear(organizationId, sourceFinancialYearId)
  if (!source) throw new Error("The source financial year was not found.")
  const next = nextFinancialYear(source)
  if (await getFinancialYear(organizationId, next.id)) throw new Error(`${next.label} already exists.`)
  const blockers = await inventoryCarryForwardBlockers(organizationId)
  if (blockers.length) throw new Error(`Stock carry-forward cannot continue: ${blockers[0]}`)
  const summary = await financialYearSummary(organizationId, source.id)
  const createdAt = nowIso()
  const snapshot = JSON.stringify({
    sourceFinancialYearId: source.id,
    createdAt,
    stockBasis: "continuous-physical-inventory-snapshot",
    receivableBasis: "customer-current-balance",
    payableBasis: "supplier-current-balance",
    summary,
  })
  await service.transaction(async (db) => {
    await db.execute("UPDATE financial_years SET is_active = 0 WHERE organization_id = ? AND is_active = 1", [organizationId])
    await db.execute(
      `INSERT INTO financial_years (
        id, organization_id, label, start_date, end_date, start_month, status, is_active,
        previous_financial_year_id, invoice_numbering_mode, opening_snapshot_json, created_at, schema_version
       ) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', 1, ?, ?, ?, ?, 1)`,
      [next.id, organizationId, next.label, next.startDate, next.endDate, next.startMonth, source.id, source.invoice_numbering_mode, snapshot, createdAt]
    )
    await db.execute(
      `INSERT INTO financial_year_invoice_sequences (id, organization_id, financial_year_id, prefix, next_number, updated_at)
       SELECT ?, ?, ?, CASE WHEN trim(COALESCE(invoice_prefix, '')) = '' THEN 'INV' ELSE trim(invoice_prefix) END,
         CASE WHEN ? = 'RESTART' THEN 1 ELSE MAX(1, COALESCE(next_invoice_number, 1)) END, ?
       FROM organizations WHERE id = ?`,
      [`fy-seq:${next.id}`, organizationId, next.id, source.invoice_numbering_mode, createdAt, organizationId]
    )
    await db.execute(
      `INSERT INTO financial_year_opening_balances (
        id, organization_id, financial_year_id, source_financial_year_id, party_type, party_id, balance_type, amount, created_at
       )
       SELECT 'fy-opening:' || ? || ':customer:' || id, organization_id, ?, ?, 'customer', id, 'RECEIVABLE', MAX(current_balance, 0), ?
       FROM customers WHERE organization_id = ? AND deleted_at IS NULL AND current_balance > 0`,
      [next.id, next.id, source.id, createdAt, organizationId]
    )
    await db.execute(
      `INSERT INTO financial_year_opening_balances (
        id, organization_id, financial_year_id, source_financial_year_id, party_type, party_id, balance_type, amount, created_at
       )
       SELECT 'fy-opening:' || ? || ':supplier:' || id, organization_id, ?, ?, 'supplier', id, 'PAYABLE', MAX(current_balance, 0), ?
       FROM suppliers WHERE organization_id = ? AND deleted_at IS NULL AND current_balance > 0`,
      [next.id, next.id, source.id, createdAt, organizationId]
    )
    await db.execute(
      `INSERT INTO financial_year_inventory_openings (
        id, organization_id, financial_year_id, source_financial_year_id, inventory_key, product_id,
        warehouse_id, batch_id, batch_no, expiry_date, quantity, purchase_rate, mrp, created_at
       )
       SELECT 'fy-inventory:' || ? || ':batch:' || batch.id, batch.organization_id, ?, ?, 'batch:' || batch.id,
         batch.product_id, batch.warehouse_id, batch.id, batch.batch_no, batch.expiry_date, batch.quantity,
         batch.purchase_rate, batch.mrp, ?
       FROM stock_batches batch
       JOIN products product ON product.id = batch.product_id AND product.organization_id = batch.organization_id AND product.deleted_at IS NULL
       WHERE batch.organization_id = ? AND batch.deleted_at IS NULL AND batch.quantity > 0`,
      [next.id, next.id, source.id, createdAt, organizationId]
    )
    await db.execute(
      `INSERT INTO financial_year_inventory_openings (
        id, organization_id, financial_year_id, source_financial_year_id, inventory_key, product_id,
        warehouse_id, batch_id, batch_no, expiry_date, quantity, purchase_rate, mrp, created_at
       )
       SELECT 'fy-inventory:' || ? || ':unbatched:' || product.id, product.organization_id, ?, ?, 'unbatched:' || product.id,
         product.id, product.warehouse_id, NULL, product.batch_no, product.expiry_date,
         MAX(0, product.stock - COALESCE(batch_totals.quantity, 0)), product.purchase_rate, product.mrp, ?
       FROM products product
       LEFT JOIN (
         SELECT organization_id, product_id, SUM(quantity) AS quantity FROM stock_batches
         WHERE deleted_at IS NULL AND quantity > 0 GROUP BY organization_id, product_id
       ) batch_totals ON batch_totals.organization_id = product.organization_id AND batch_totals.product_id = product.id
       WHERE product.organization_id = ? AND product.deleted_at IS NULL AND product.stock - COALESCE(batch_totals.quantity, 0) > 0.0001`,
      [next.id, next.id, source.id, createdAt, organizationId]
    )
    await db.execute(
      `INSERT INTO local_audit_logs (id, organization_id, action, entity_type, entity_id, description, created_at, updated_at, sync_status)
       VALUES (?, ?, 'financial_year.created', 'financial_year', ?, ?, ?, ?, 'local')`,
      [createOfflineId("fy-audit"), organizationId, next.id, `${next.label} created from ${source.label}; stock and party balances recorded as opening snapshots.`, createdAt, createdAt]
    )
    // This no-op update invokes the database invariant trigger. A mismatch
    // aborts and rolls back the entire creation transaction.
    await db.execute("UPDATE financial_years SET opening_snapshot_json = opening_snapshot_json WHERE organization_id = ? AND id = ?", [organizationId, next.id])
  })

  const db = await service.requireConnection("read")
  const [opening] = await db.select<DataRow>(
    "SELECT COALESCE(SUM(quantity), 0) AS quantity FROM financial_year_inventory_openings WHERE organization_id = ? AND financial_year_id = ?",
    [organizationId, next.id]
  )
  if (Math.abs(numeric(opening, "quantity") - summary.closingInventoryQuantity) > 0.0001) {
    throw new Error("Financial-year inventory verification failed.")
  }
  return { year: await getFinancialYear(organizationId, next.id), summary, openingInventoryQuantity: numeric(opening, "quantity") }
}

export async function financialYearClosingChecks(organizationId: string, financialYearIdValue: string): Promise<FinancialYearClosingChecks> {
  const db = await service.requireConnection("read")
  const integrity = await service.integrityReport()
  const [negative, invalidAssignments, invalidInvoiceCalculations, duplicateOpenings, duplicateInventoryOpenings, overlappingYears, activeRows, unpaid] = await Promise.all([
    db.select<DataRow>("SELECT id FROM products WHERE organization_id = ? AND deleted_at IS NULL AND stock < 0 LIMIT 20", [organizationId]),
    db.select<DataRow>(
      `SELECT id FROM (
         SELECT invoice.id FROM sales_invoices invoice LEFT JOIN financial_years fy ON fy.id = invoice.financial_year_id AND fy.organization_id = invoice.organization_id
         WHERE invoice.organization_id = ? AND invoice.deleted_at IS NULL AND (fy.id IS NULL OR date(COALESCE(invoice.invoice_date, invoice.date, invoice.created_at)) NOT BETWEEN date(fy.start_date) AND date(fy.end_date))
         UNION ALL
         SELECT purchase.id FROM purchase_invoices purchase LEFT JOIN financial_years fy ON fy.id = purchase.financial_year_id AND fy.organization_id = purchase.organization_id
         WHERE purchase.organization_id = ? AND purchase.deleted_at IS NULL AND (fy.id IS NULL OR date(COALESCE(purchase.bill_date, purchase.created_at)) NOT BETWEEN date(fy.start_date) AND date(fy.end_date))
         UNION ALL
         SELECT movement.id FROM stock_movements movement LEFT JOIN financial_years fy ON fy.id = movement.financial_year_id AND fy.organization_id = movement.organization_id
         WHERE movement.organization_id = ? AND movement.deleted_at IS NULL AND (fy.id IS NULL OR date(COALESCE(movement.movement_date, movement.created_at)) NOT BETWEEN date(fy.start_date) AND date(fy.end_date))
         UNION ALL
         SELECT payment.id FROM payments payment LEFT JOIN financial_years fy ON fy.id = payment.financial_year_id AND fy.organization_id = payment.organization_id
         WHERE payment.organization_id = ? AND payment.deleted_at IS NULL AND (fy.id IS NULL OR date(COALESCE(payment.payment_date, payment.created_at)) NOT BETWEEN date(fy.start_date) AND date(fy.end_date))
         UNION ALL
         SELECT entry.id FROM ledger_entries entry LEFT JOIN financial_years fy ON fy.id = entry.financial_year_id AND fy.organization_id = entry.organization_id
         WHERE entry.organization_id = ? AND entry.deleted_at IS NULL AND (fy.id IS NULL OR date(COALESCE(entry.entry_date, entry.created_at)) NOT BETWEEN date(fy.start_date) AND date(fy.end_date))
       ) LIMIT 20`,
      [organizationId, organizationId, organizationId, organizationId, organizationId]
    ),
    db.select<DataRow>(
      `SELECT id FROM sales_invoices WHERE organization_id = ? AND financial_year_id = ? AND deleted_at IS NULL
       AND (grand_total < 0 OR paid_amount < 0 OR outstanding_amount < 0 OR paid_amount - grand_total > 0.01
         OR ((paid_amount > 0 OR outstanding_amount > 0) AND ABS(outstanding_amount - MAX(0, grand_total - paid_amount)) > 0.01)) LIMIT 20`,
      [organizationId, financialYearIdValue]
    ),
    db.select<DataRow>(
      `SELECT party_type, party_id, COUNT(*) AS count FROM financial_year_opening_balances
       WHERE organization_id = ? GROUP BY financial_year_id, party_type, party_id, balance_type HAVING COUNT(*) > 1 LIMIT 20`,
      [organizationId]
    ),
    db.select<DataRow>(
      `SELECT inventory_key, COUNT(*) AS count FROM financial_year_inventory_openings
       WHERE organization_id = ? GROUP BY financial_year_id, inventory_key HAVING COUNT(*) > 1 LIMIT 20`,
      [organizationId]
    ),
    db.select<DataRow>(
      `SELECT current.id FROM financial_years current JOIN financial_years other
       ON other.organization_id = current.organization_id AND other.id <> current.id
       AND date(current.start_date) <= date(other.end_date) AND date(other.start_date) <= date(current.end_date)
       WHERE current.organization_id = ? LIMIT 20`,
      [organizationId]
    ),
    db.select<DataRow>("SELECT id FROM financial_years WHERE organization_id = ? AND is_active = 1", [organizationId]),
    db.select<DataRow>("SELECT COUNT(*) AS count FROM sales_invoices WHERE organization_id = ? AND financial_year_id = ? AND deleted_at IS NULL AND outstanding_amount > 0", [organizationId, financialYearIdValue]),
  ])
  const blockers: string[] = []
  if (!integrity.ok) blockers.push("SQLite quick check or foreign-key integrity failed.")
  if (negative.length) blockers.push(`${negative.length} product records have invalid negative stock.`)
  if (invalidAssignments.length) blockers.push(`${invalidAssignments.length} dated transactions have missing or incorrect financial-year assignments.`)
  if (invalidInvoiceCalculations.length) blockers.push(`${invalidInvoiceCalculations.length} invoices have unresolved total or outstanding calculations.`)
  if (duplicateOpenings.length) blockers.push("Duplicate financial-year opening balances were detected.")
  if (duplicateInventoryOpenings.length) blockers.push("Duplicate financial-year inventory openings were detected.")
  if (overlappingYears.length) blockers.push("Overlapping financial-year date ranges were detected.")
  if (activeRows.length > 1) blockers.push("More than one financial year is active for this business.")
  const warnings = numeric(unpaid[0], "count") > 0 ? [`${numeric(unpaid[0], "count")} unpaid or partially paid invoices remain.`] : []
  return { integrity, blockers, warnings }
}

export async function closeFinancialYear(organizationId: string, financialYearIdValue: string, confirmation: string) {
  const year = await getFinancialYear(organizationId, financialYearIdValue)
  if (!year) throw new Error("Financial year was not found.")
  if (year.status !== "OPEN") throw new Error(`${year.label} is already closed.`)
  if (confirmation.trim().toUpperCase() !== closeConfirmation(year)) throw new Error(`Type ${closeConfirmation(year)} to confirm.`)
  const checks = await financialYearClosingChecks(organizationId, financialYearIdValue)
  if (checks.blockers.length) throw new Error(`Financial year cannot be closed: ${checks.blockers[0]}`)
  const summary = await financialYearSummary(organizationId, financialYearIdValue)
  const backup = await invokeTauri<BackupResult | null>("desktop_database_backup", { reason: `pre-close-${year.label.replace(/[^0-9A-Za-z-]/g, "-")}` })
  if (!backup?.backupPath) throw new Error("A verified local safety backup could not be created. The financial year was not closed.")
  const closedAt = nowIso()
  await service.transaction(async (db) => {
    await db.execute(
      `UPDATE financial_years SET status = 'CLOSED', is_active = 0, close_summary_json = ?, close_backup_path = ?, closed_at = ?
       WHERE organization_id = ? AND id = ? AND status = 'OPEN'`,
      [JSON.stringify(summary), backup.backupPath, closedAt, organizationId, financialYearIdValue]
    )
    await db.execute(
      `INSERT INTO local_audit_logs (id, organization_id, action, entity_type, entity_id, description, created_at, updated_at, sync_status)
       VALUES (?, ?, 'financial_year.closed', 'financial_year', ?, ?, ?, ?, 'local')`,
      [createOfflineId("fy-audit"), organizationId, financialYearIdValue, `${year.label} closed after verified safety backup ${backup.checksumSha256}.`, closedAt, closedAt]
    )
  })
  return { year: await getFinancialYear(organizationId, financialYearIdValue), summary, checks, backup }
}

export async function reopenFinancialYear(organizationId: string, financialYearIdValue: string, confirmation: string, reason: string) {
  const year = await getFinancialYear(organizationId, financialYearIdValue)
  if (!year) throw new Error("Financial year was not found.")
  if (year.status !== "CLOSED") throw new Error(`${year.label} is not closed.`)
  if (confirmation.trim().toUpperCase() !== reopenConfirmation(year)) throw new Error(`Type ${reopenConfirmation(year)} to confirm.`)
  if (reason.trim().length < 10) throw new Error("Enter a clear reason of at least 10 characters for reopening.")
  const reopenedAt = nowIso()
  await service.transaction(async (db) => {
    await db.execute(
      "UPDATE financial_years SET status = 'OPEN', reopened_at = ?, reopen_reason = ? WHERE organization_id = ? AND id = ? AND status = 'CLOSED'",
      [reopenedAt, reason.trim(), organizationId, financialYearIdValue]
    )
    await db.execute(
      `INSERT INTO local_audit_logs (id, organization_id, action, entity_type, entity_id, description, created_at, updated_at, sync_status)
       VALUES (?, ?, 'financial_year.reopened', 'financial_year', ?, ?, ?, ?, 'local')`,
      [createOfflineId("fy-audit"), organizationId, financialYearIdValue, `${year.label} reopened. Reason: ${reason.trim()}`, reopenedAt, reopenedAt]
    )
  })
  return { year: await getFinancialYear(organizationId, financialYearIdValue) }
}

export async function setFinancialYearNumberingMode(organizationId: string, financialYearIdValue: string, mode: InvoiceNumberingMode) {
  if (!(["CONTINUE", "RESTART"] as const).includes(mode)) throw new Error("Invalid invoice numbering mode.")
  const year = await getFinancialYear(organizationId, financialYearIdValue)
  if (!year) throw new Error("Financial year was not found.")
  if (year.status !== "OPEN") throw new Error(`${year.label} is closed. Reopen it before changing its numbering configuration.`)
  const db = await service.requireConnection("read")
  const [invoice] = await db.select<DataRow>("SELECT COUNT(*) AS count FROM sales_invoices WHERE organization_id = ? AND financial_year_id = ? AND deleted_at IS NULL", [organizationId, financialYearIdValue])
  if (numeric(invoice, "count") > 0 && year.invoice_numbering_mode !== mode) {
    throw new Error("Invoice numbering cannot be changed after invoices exist in this financial year.")
  }
  const updatedAt = nowIso()
  await service.transaction(async (tx) => {
    await tx.execute("UPDATE financial_years SET invoice_numbering_mode = ? WHERE organization_id = ? AND id = ?", [mode, organizationId, financialYearIdValue])
    if (mode === "RESTART") {
      await tx.execute("UPDATE financial_year_invoice_sequences SET next_number = 1, updated_at = ? WHERE organization_id = ? AND financial_year_id = ?", [updatedAt, organizationId, financialYearIdValue])
    }
  })
  return { year: await getFinancialYear(organizationId, financialYearIdValue) }
}

export async function customerFinancialYearLedger(organizationId: string, customerId: string, financialYearIdValue?: string | null) {
  const db = await service.requireConnection("read")
  const yearClause = financialYearIdValue ? "AND financial_year_id = ?" : ""
  const values: SqlValue[] = financialYearIdValue ? [organizationId, customerId, financialYearIdValue] : [organizationId, customerId]
  const [customerRows, openingRows, entries, invoices, payments] = await Promise.all([
    db.select<DataRow>("SELECT * FROM customers WHERE organization_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1", [organizationId, customerId]),
    financialYearIdValue
      ? db.select<DataRow>("SELECT COALESCE(SUM(amount), 0) AS amount FROM financial_year_opening_balances WHERE organization_id = ? AND financial_year_id = ? AND party_type = 'customer' AND party_id = ? AND balance_type = 'RECEIVABLE'", [organizationId, financialYearIdValue, customerId])
      : Promise.resolve([{ amount: 0 }]),
    db.select<DataRow>(
      `SELECT * FROM ledger_entries WHERE organization_id = ? AND account_type = 'customer' AND account_id = ? AND deleted_at IS NULL ${yearClause}
       ORDER BY entry_date ASC, created_at ASC, id ASC`,
      values
    ),
    db.select<DataRow>(
      `SELECT id, COALESCE(invoice_date, date, created_at) AS entry_date, 'sales_invoice' AS document_type,
              COALESCE(display_invoice_number, invoice_number) AS description,
              COALESCE(grand_total, total_amount, total, 0) AS debit, 0 AS credit, created_at
       FROM sales_invoices WHERE organization_id = ? AND customer_id = ? AND deleted_at IS NULL AND invoice_type <> 'proforma' ${yearClause}
       ORDER BY entry_date ASC, created_at ASC, id ASC`,
      values
    ),
    db.select<DataRow>(
      `SELECT id, COALESCE(payment_date, created_at) AS entry_date, 'payment' AS document_type,
              COALESCE(reference_no, 'Customer payment') AS description,
              0 AS debit, amount AS credit, created_at
       FROM payments WHERE organization_id = ? AND party_type = 'customer' AND party_id = ? AND deleted_at IS NULL ${yearClause}
       ORDER BY entry_date ASC, created_at ASC, id ASC`,
      values
    ),
  ])
  const openingBalance = numeric(openingRows[0], "amount")
  let runningBalance = openingBalance
  const ledgerEntries = entries.length > 0 ? entries : [...invoices, ...payments].sort((left, right) => `${left.entry_date || ""}:${left.created_at || ""}:${left.id || ""}`.localeCompare(`${right.entry_date || ""}:${right.created_at || ""}:${right.id || ""}`))
  const normalizedEntries: DataRow[] = ledgerEntries.map((entry): DataRow => {
    runningBalance += Number(entry.debit || 0) - Number(entry.credit || 0)
    return { ...entry, running_balance: Math.round(runningBalance * 100) / 100 }
  })
  const invoiceTotal = invoices.reduce((sum, invoice) => sum + Number(invoice.debit || 0), 0)
  const paymentTotal = payments.length > 0
    ? payments.reduce((sum, payment) => sum + Number(payment.credit || 0), 0)
    : normalizedEntries.filter((entry) => Number(entry.credit || 0) > 0).reduce((sum, entry) => sum + Number(entry.credit || 0), 0)
  return {
    customer: customerRows[0] || null,
    financialYearId: financialYearIdValue || null,
    openingBalance,
    invoices: Math.round(invoiceTotal * 100) / 100,
    payments: Math.round(paymentTotal * 100) / 100,
    closingBalance: financialYearIdValue ? Math.round(runningBalance * 100) / 100 : Number(customerRows[0]?.current_balance || runningBalance),
    entries: normalizedEntries,
  }
}

export function selectedFinancialYearStorageKey(organizationId: string) {
  return `bezgrow:selected-financial-year:${organizationId}`
}
