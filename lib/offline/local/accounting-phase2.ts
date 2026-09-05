"use client"

import { createOfflineId } from "@/lib/offline/db"
import { minorToMoney, moneyToMinor } from "@/lib/accounting/money"
import {
  buildAdvanceApplicationJournal,
  buildPartySettlementJournal,
  buildPurchaseJournal,
  normalizePurchaseLines,
  purchaseTotals,
  validateGstinFormat,
  type NormalizedPurchaseLine,
  type PurchaseClassification,
  type PurchaseLineInput,
  type SupplyType,
  type TaxCategory,
} from "@/lib/accounting/phase2"
import { buildReversalJournal, validateJournal, type AccountingAccount, type JournalLine } from "@/lib/accounting/journal"
import { appendJournal } from "@/lib/offline/local/journal-posting"
import { accountingStatus, initializeAccounting, loadPostedJournal, systemAccountMap } from "@/lib/offline/local/accounting"
import { assertFinancialYearWriteAllowed, getFinancialYear } from "@/lib/offline/local/financial-years"
import { getLocalDatabaseService, type SqlExecutor, type SqlValue } from "@/lib/offline/local/service"

type DataRow = Record<string, unknown>
type AllocationInput = { document_id?: unknown; purchase_invoice_id?: unknown; invoice_id?: unknown; amount?: unknown; allocation_amount?: unknown }
type SettlementDocumentType = "purchase_invoice" | "sales_invoice" | "supplier_opening" | "customer_opening"

const service = getLocalDatabaseService()

function nowIso() { return new Date().toISOString() }
function localString(value: unknown, fallback = "") { return typeof value === "string" && value.trim() ? value.trim() : fallback }
function localNumber(value: unknown, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback }
function bool(value: unknown) { return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true" }
function date(value: unknown) { const result = localString(value, nowIso().slice(0, 10)).slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error("Date must use YYYY-MM-DD format."); return result }

function rowAccount(row: DataRow): AccountingAccount {
  return { id: String(row.id || ""), accountCode: String(row.account_code || ""), accountName: String(row.account_name || ""), accountType: String(row.account_type || ""), systemRole: row.system_role ? String(row.system_role) : null }
}

async function selectedAccountMap(organizationId: string, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) return new Map<string, AccountingAccount>()
  const db = await service.requireConnection("read")
  const rows = await db.select<DataRow>(
    `SELECT id, account_code, account_name, account_type, system_role FROM chart_of_accounts
     WHERE organization_id = ? AND deleted_at IS NULL AND is_active = 1 AND id IN (${unique.map(() => "?").join(",")})`,
    [organizationId, ...unique]
  )
  return new Map(rows.map((row) => [String(row.id), rowAccount(row)]))
}

async function assertPeriodUnlocked(organizationId: string, transactionDate: string) {
  const db = await service.requireConnection("read")
  const [lock] = await db.select<DataRow>(
    "SELECT locked_through FROM accounting_period_locks WHERE organization_id = ? AND unlocked_at IS NULL AND date(?) <= date(locked_through) ORDER BY locked_through DESC LIMIT 1",
    [organizationId, transactionDate]
  )
  if (lock) throw new Error(`Books are locked through ${String(lock.locked_through)}. An owner must unlock the period before posting this transaction.`)
}

async function audit(tx: SqlExecutor, organizationId: string, action: string, entityType: string, entityId: string, description: string, timestamp: string) {
  await tx.execute(
    `INSERT INTO local_audit_logs (id, organization_id, action, entity_type, entity_id, description, sync_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'local', ?, ?)`,
    [createOfflineId("audit"), organizationId, action, entityType, entityId, description, timestamp, timestamp]
  )
}

function classification(value: unknown): PurchaseClassification {
  const normalized = localString(value, "INVENTORY").toUpperCase()
  if (!["INVENTORY", "EXPENSE", "FIXED_ASSET", "OTHER"].includes(normalized)) throw new Error("Purchase classification is invalid.")
  return normalized as PurchaseClassification
}

function supplyType(value: unknown, organizationState: unknown, partyState: unknown): SupplyType {
  const explicit = localString(value).toUpperCase()
  if (explicit === "INTRA_STATE" || explicit === "INTER_STATE") return explicit
  const origin = localString(organizationState).toUpperCase().replace(/[^A-Z0-9]/g, "")
  const destination = localString(partyState).toUpperCase().replace(/[^A-Z0-9]/g, "")
  if (!origin || !destination) throw new Error("Place of supply and business state are required to classify GST.")
  return origin === destination ? "INTRA_STATE" : "INTER_STATE"
}

function taxCategory(value: unknown): TaxCategory {
  const normalized = localString(value, "TAXABLE").toUpperCase().replace(/-/g, "_")
  if (!["TAXABLE", "EXEMPT", "NIL_RATED", "NON_GST"].includes(normalized)) throw new Error("GST tax category is invalid.")
  return normalized as TaxCategory
}

function purchaseLineInput(input: DataRow, defaultClassification: PurchaseClassification): PurchaseLineInput {
  return {
    id: localString(input.id) || undefined,
    productId: localString(input.product_id) || null,
    productName: localString(input.product_name, localString(input.name)) || null,
    description: localString(input.description) || null,
    hsnCode: localString(input.hsn_code, localString(input.hsn)) || null,
    quantity: input.quantity,
    unit: localString(input.unit) || null,
    unitCost: input.purchase_rate ?? input.unit_cost ?? input.unit_price,
    discountPercent: input.discount_percent ?? input.discount_pct,
    discountValue: input.discount_value ?? input.discount_amount,
    taxableValue: input.taxable_value,
    gstRate: input.gst_rate ?? input.tax_percent ?? input.gst,
    cgst: input.cgst ?? input.cgst_amount,
    sgst: input.sgst ?? input.sgst_amount,
    igst: input.igst ?? input.igst_amount,
    cess: input.cess ?? input.cess_amount,
    lineTotal: input.line_total,
    classification: classification(input.purchase_classification || defaultClassification),
    purchaseAccountId: localString(input.purchase_account_id) || null,
    warehouseId: localString(input.warehouse_id) || null,
    batchNo: localString(input.batch_no, localString(input.batch_number)) || null,
    expiryDate: localString(input.expiry_date) || null,
  }
}

async function nextInternalPurchaseNumber(organizationId: string, kind: "purchase_invoice" | "purchase_return") {
  const db = await service.requireConnection("read")
  const prefix = kind === "purchase_return" ? "DN" : "PUR"
  const [row] = await db.select<DataRow>("SELECT COUNT(*) count FROM purchase_invoices WHERE organization_id = ? AND invoice_kind = ?", [organizationId, kind])
  return `${prefix}-${String(Number(row?.count || 0) + 1).padStart(6, "0")}`
}

async function purchaseContext(organizationId: string, input: DataRow, kind: "purchase_invoice" | "purchase_return") {
  const purchaseDate = date(input.purchase_date || input.bill_date || input.supplier_invoice_date)
  await assertPeriodUnlocked(organizationId, purchaseDate)
  await initializeAccounting(organizationId, purchaseDate)
  const year = await assertFinancialYearWriteAllowed(organizationId, purchaseDate, localString(input.financial_year_id) || null)
  const db = await service.requireConnection("read")
  const supplierId = localString(input.supplier_id)
  if (!supplierId) throw new Error("Supplier is required.")
  const [supplier] = await db.select<DataRow>("SELECT * FROM suppliers WHERE organization_id = ? AND id = ? AND deleted_at IS NULL AND is_active = 1 LIMIT 1", [organizationId, supplierId])
  if (!supplier) throw new Error("Supplier was not found or is inactive.")
  const [organization] = await db.select<DataRow>("SELECT id, state, gst_number FROM organizations WHERE id = ? AND deleted_at IS NULL LIMIT 1", [organizationId])
  const supplierInvoiceNumber = localString(input.supplier_invoice_number, localString(input.bill_number))
  if (!supplierInvoiceNumber) throw new Error(kind === "purchase_return" ? "Debit note number is required." : "Supplier invoice number is required.")
  const idempotencyKey = localString(input.idempotency_key, localString(input.offline_client_id))
  if (idempotencyKey) {
    const [existing] = await db.select<DataRow>("SELECT id, bill_number, accounting_voucher_id FROM purchase_invoices WHERE organization_id = ? AND idempotency_key = ? LIMIT 1", [organizationId, idempotencyKey])
    if (existing) return { existing }
  }
  if (kind === "purchase_invoice") {
    const [duplicate] = await db.select<DataRow>(
      `SELECT id, bill_number FROM purchase_invoices WHERE organization_id = ? AND supplier_id = ?
       AND financial_year_id = ? AND lower(trim(supplier_invoice_number)) = lower(trim(?))
       AND invoice_kind = 'purchase_invoice' AND document_status <> 'CANCELLED' AND deleted_at IS NULL LIMIT 1`,
      [organizationId, supplierId, year.id, supplierInvoiceNumber]
    )
    if (duplicate) throw new Error(`Supplier invoice ${supplierInvoiceNumber} already exists in this financial year.`)
  }
  const mode = supplyType(input.supply_type, organization?.state, input.place_of_supply || supplier.state)
  const category = taxCategory(input.tax_category)
  const defaultClassification = classification(input.purchase_classification)
  const rawLines = Array.isArray(input.items) ? input.items as DataRow[] : []
  const lines = normalizePurchaseLines(rawLines.map((line) => purchaseLineInput(line, defaultClassification)), mode, category)
  const totals = purchaseTotals(lines, input.other_charges ?? 0, input.round_off ?? 0, bool(input.reverse_charge))
  if (input.grand_total !== undefined && input.grand_total !== null && input.grand_total !== "" && moneyToMinor(input.grand_total, "Grand total") !== totals.grandTotalMinor) {
    throw new Error("Purchase grand total does not reconcile with its exact line taxes, charges, and round off.")
  }
  const productIds = [...new Set(lines.filter((line) => line.classification === "INVENTORY").map((line) => localString(line.productId)).filter(Boolean))]
  const products = productIds.length ? await db.select<DataRow>(`SELECT * FROM products WHERE organization_id = ? AND deleted_at IS NULL AND id IN (${productIds.map(() => "?").join(",")})`, [organizationId, ...productIds]) : []
  if (products.length !== productIds.length) throw new Error("Every inventory purchase line must reference an active local product.")
  const selectedAccounts = await selectedAccountMap(organizationId, lines.map((line) => localString(line.purchaseAccountId)).filter(Boolean))
  if (lines.some((line) => line.purchaseAccountId && !selectedAccounts.has(line.purchaseAccountId))) throw new Error("One or more selected purchase accounts are missing or inactive.")
  return { existing: null, purchaseDate, year, supplier, supplierId, supplierInvoiceNumber, idempotencyKey, mode, category, defaultClassification, lines, totals, products, selectedAccounts, organization, db }
}

function purchaseItemValues(organizationId: string, purchaseId: string, itemId: string, line: NormalizedPurchaseLine, stockBatchId: string | null, timestamp: string, returnAgainstItemId: string | null = null) {
  return [
    itemId, organizationId, purchaseId, line.productId || null, line.productName || null, line.description || null,
    line.hsnCode || null, line.warehouseId || null, line.batchNo || null, line.expiryDate || null,
    line.quantityNumber, minorToMoney(line.unitCostMinor), minorToMoney(line.cgstMinor + line.sgstMinor + line.igstMinor + line.cessMinor),
    line.gstRateBasisPoints / 100, minorToMoney(line.lineTotalMinor), line.unit || null, line.classification,
    line.purchaseAccountId || null, line.unitCostMinor, line.grossMinor, line.discountBasisPoints, line.discountMinor,
    line.taxableMinor, line.gstRateBasisPoints, line.cgstMinor, line.sgstMinor, line.igstMinor, line.cessMinor,
    line.lineTotalMinor, returnAgainstItemId, stockBatchId, timestamp, timestamp,
  ] as SqlValue[]
}

async function insertPurchaseLine(tx: SqlExecutor, values: SqlValue[]) {
  await tx.execute(
    `INSERT INTO purchase_invoice_items (
       id, organization_id, purchase_invoice_id, product_id, product_name, description, hsn_code,
       warehouse_id, batch_no, expiry_date, quantity, unit_cost, tax_amount, tax_percent, line_total,
       unit, purchase_classification, purchase_account_id, unit_cost_minor, gross_minor,
       discount_percent_basis_points, discount_minor, taxable_minor, gst_rate_basis_points,
       cgst_minor, sgst_minor, igst_minor, cess_minor, line_total_minor, return_against_item_id, stock_batch_id,
       sync_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?)`,
    values
  )
}

async function receiveInventoryLine(tx: SqlExecutor, organizationId: string, supplierId: string, purchaseId: string, internalNumber: string, purchaseDate: string, financialYearId: string, itemId: string, line: NormalizedPurchaseLine, product: DataRow, batchId: string, timestamp: string) {
  const netRateMinor = Math.max(0, Math.round(line.taxableMinor / line.quantityNumber))
  const previousStock = localNumber(product.stock)
  await tx.execute(
    `INSERT INTO stock_batches (
       id, organization_id, product_id, warehouse_id, batch_no, expiry_date, purchase_date, quantity,
       purchase_rate, supplier_id, source_type, source_id, source_line_id, purchase_rate_minor,
       original_quantity, sync_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PURCHASE_INVOICE', ?, ?, ?, ?, 'local', ?, ?)`,
    [batchId, organizationId, line.productId || null, line.warehouseId || (product.warehouse_id as SqlValue) || null, line.batchNo || null,
      line.expiryDate || null, purchaseDate, line.quantityNumber, minorToMoney(netRateMinor), supplierId, purchaseId,
      itemId, netRateMinor, line.quantityNumber, timestamp, timestamp]
  )
  await tx.execute(
    `UPDATE products SET stock = stock + ?, purchase_rate = ?, supplier_id = ?, warehouse_id = COALESCE(?, warehouse_id),
       batch_no = COALESCE(?, batch_no), expiry_date = COALESCE(?, expiry_date), purchase_date = ?, sync_status = 'pending_update', updated_at = ?
     WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`,
    [line.quantityNumber, minorToMoney(netRateMinor), supplierId, line.warehouseId || null, line.batchNo || null, line.expiryDate || null,
      purchaseDate, timestamp, organizationId, line.productId || null]
  )
  const inventoryId = `inventory:${organizationId}:${String(line.productId)}:${line.warehouseId || product.warehouse_id || "main"}:${batchId}`
  await tx.execute(
    `INSERT INTO inventory_items (id, organization_id, product_id, warehouse_id, batch_id, quantity, reserved_quantity, available_quantity, reorder_level, sync_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 'local', ?, ?)`,
    [inventoryId, organizationId, line.productId || null, line.warehouseId || (product.warehouse_id as SqlValue) || null, batchId, line.quantityNumber, line.quantityNumber, timestamp, timestamp]
  )
  await tx.execute(
    `INSERT INTO stock_movements (
       id, organization_id, product_id, product_name, warehouse_id, batch_id, type, quantity,
       previous_stock, new_stock, reason, reference_no, reference_type, reference_id, movement_date,
       financial_year_id, unit_cost_minor, total_cost_minor, cost_status, sync_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'purchase', ?, ?, ?, ?, ?, 'purchase_invoice', ?, ?, ?, ?, ?, 'RECORDED', 'local', ?, ?)`,
    [createOfflineId("stock-movement"), organizationId, line.productId || null, line.productName || (product.name as SqlValue) || "Product",
      line.warehouseId || (product.warehouse_id as SqlValue) || null, batchId, line.quantityNumber, previousStock, previousStock + line.quantityNumber,
      `Purchase ${internalNumber}`, internalNumber, purchaseId, purchaseDate, financialYearId, netRateMinor, line.taxableMinor, timestamp, timestamp]
  )
}

export async function createPurchase(organizationId: string, input: DataRow, kind: "purchase_invoice" | "purchase_return" = "purchase_invoice") {
  if (kind === "purchase_return") return createPurchaseReturn(organizationId, input)
  const context = await purchaseContext(organizationId, input, kind)
  if (context.existing) return { purchase_id: context.existing.id, bill_number: context.existing.bill_number, idempotent: true }
  const { purchaseDate, year, supplier, supplierId, supplierInvoiceNumber, idempotencyKey, mode, category, defaultClassification, lines, totals, products, selectedAccounts } = context
  const accounts = await systemAccountMap(organizationId)
  const purchaseId = createOfflineId("purchase")
  const internalNumber = await nextInternalPurchaseNumber(organizationId, kind)
  const purchasePosting = buildPurchaseJournal({
    id: createOfflineId("purchase-voucher"), organizationId, financialYearId: year.id, voucherNumber: `PUR-${internalNumber}`,
    voucherType: "purchase", voucherDate: purchaseDate, sourceType: "PURCHASE_INVOICE", sourceId: purchaseId,
    referenceNo: supplierInvoiceNumber, narration: `Purchase invoice ${supplierInvoiceNumber}`, systemGenerated: true,
    accounts, supplierId, lines, totals, paidMinor: 0, selectedAccounts, reverseCharge: bool(input.reverse_charge),
  })
  const paidMinor = moneyToMinor(input.paid_amount ?? input.paid ?? 0, "Paid amount")
  if (paidMinor < 0 || paidMinor > totals.settlementTotalMinor) throw new Error("Paid amount cannot exceed the supplier settlement total.")
  const paymentAccountId = localString(input.payment_account_id)
  const paymentAccounts = await selectedAccountMap(organizationId, paidMinor ? [paymentAccountId] : [])
  const paymentAccount = paymentAccounts.get(paymentAccountId)
  if (paidMinor && (!paymentAccount || paymentAccount.accountType !== "ASSET")) throw new Error("Select an active cash or bank account for the paid amount.")
  const paymentId = paidMinor ? createOfflineId("supplier-payment") : ""
  const paymentPosting = paidMinor && paymentAccount ? buildPartySettlementJournal({
    id: createOfflineId("payment-voucher"), organizationId, financialYearId: year.id, voucherNumber: `PAY-${paymentId.slice(-8).toUpperCase()}`,
    voucherType: "payment", voucherDate: purchaseDate, sourceType: "SUPPLIER_PAYMENT", sourceId: paymentId,
    referenceNo: localString(input.payment_reference, supplierInvoiceNumber), narration: `Payment against ${supplierInvoiceNumber}`,
    systemGenerated: true, accounts, partyType: "supplier", partyId: supplierId, direction: "out", paymentAccount,
    amountMinor: paidMinor, allocatedMinor: paidMinor,
  }) : null
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO purchase_invoices (
         id, organization_id, supplier_id, supplier_name, invoice_kind, bill_number, bill_date, due_date,
         subtotal, discount_total, taxable_amount, tax_total, grand_total, paid_amount, outstanding_amount,
         status, notes, financial_year_id, supplier_invoice_number, supplier_invoice_date, purchase_date,
         payment_terms, reference_no, warehouse_id, place_of_supply, supplier_gstin, supplier_registration_type,
         transaction_type, supply_type, tax_category, reverse_charge, purchase_classification, purchase_account_id,
         payment_account_id, gross_minor, discount_minor, taxable_minor, cgst_minor, sgst_minor, igst_minor,
         cess_minor, other_charges_minor, round_off_minor, grand_total_minor, paid_minor, outstanding_minor,
         accounting_voucher_id, document_status, revision, itc_status, idempotency_key, received_status,
         sync_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'purchase_invoice', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 1, ?, ?, 'received', 'local', ?, ?)`,
      [purchaseId, organizationId, supplierId, (supplier.name as SqlValue) || "Supplier", internalNumber, purchaseDate,
        localString(input.due_date) || null, minorToMoney(totals.grossMinor), minorToMoney(totals.discountMinor),
        minorToMoney(totals.taxableMinor), minorToMoney(totals.cgstMinor + totals.sgstMinor + totals.igstMinor + totals.cessMinor),
        minorToMoney(totals.grandTotalMinor), minorToMoney(paidMinor), minorToMoney(totals.settlementTotalMinor - paidMinor),
        paidMinor === totals.settlementTotalMinor ? "paid" : paidMinor ? "partial" : "unpaid", localString(input.notes) || null,
        year.id, supplierInvoiceNumber, date(input.supplier_invoice_date || input.bill_date || purchaseDate), purchaseDate,
        localString(input.payment_terms, localString(supplier.payment_terms)) || null, localString(input.reference) || null,
        localString(input.warehouse_id) || null, localString(input.place_of_supply, localString(supplier.state)) || null,
        localString(input.gstin, localString(supplier.gstin, localString(supplier.gst_number))) || null,
        localString(input.supplier_registration_type, localString(supplier.gstin || supplier.gst_number) ? "REGISTERED" : "UNREGISTERED"),
        localString(input.transaction_type, "B2B"), mode, category, bool(input.reverse_charge) ? 1 : 0, defaultClassification,
        localString(input.purchase_account_id) || null, paymentAccountId || null, totals.grossMinor, totals.discountMinor,
        totals.taxableMinor, totals.cgstMinor, totals.sgstMinor, totals.igstMinor, totals.cessMinor, totals.otherChargesMinor,
        totals.roundOffMinor, totals.grandTotalMinor, paidMinor, totals.settlementTotalMinor - paidMinor,
        purchasePosting.journal.id, localString(input.itc_status, "REVIEW_REQUIRED"), idempotencyKey || null, timestamp, timestamp]
    )
    for (const line of lines) {
      const itemId = createOfflineId("purchase-item")
      const batchId = line.classification === "INVENTORY" ? createOfflineId("purchase-batch") : null
      await insertPurchaseLine(tx, purchaseItemValues(organizationId, purchaseId, itemId, line, batchId, timestamp))
      if (batchId) {
        const product = products.find((row) => row.id === line.productId)
        if (!product) throw new Error("Inventory product disappeared while posting the purchase.")
        await receiveInventoryLine(tx, organizationId, supplierId, purchaseId, internalNumber, purchaseDate, year.id, itemId, line, product, batchId, timestamp)
      }
    }
    await appendJournal(tx, purchasePosting.journal)
    if (paymentPosting) {
      await tx.execute(
        `INSERT INTO payments (id, organization_id, party_type, party_id, document_type, document_id, amount,
          amount_minor, direction, payment_method, payment_mode, reference_no, payment_date, financial_year_id,
          accounting_voucher_id, payment_account_id, unallocated_minor, notes, sync_status, created_at, updated_at)
         VALUES (?, ?, 'supplier', ?, 'purchase_invoice', ?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, 0, ?, 'local', ?, ?)`,
        [paymentId, organizationId, supplierId, purchaseId, minorToMoney(paidMinor), paidMinor,
          localString(input.payment_mode, "cash"), localString(input.payment_mode, "cash"), localString(input.payment_reference) || null,
          purchaseDate, year.id, paymentPosting.journal.id, paymentAccountId, localString(input.payment_notes) || null, timestamp, timestamp]
      )
      await tx.execute(
        `INSERT INTO payment_allocations (id, organization_id, financial_year_id, payment_id, party_type, party_id,
          document_type, document_id, allocation_minor, allocated_at) VALUES (?, ?, ?, ?, 'supplier', ?, 'purchase_invoice', ?, ?, ?)`,
        [createOfflineId("allocation"), organizationId, year.id, paymentId, supplierId, purchaseId, paidMinor, timestamp]
      )
      await appendJournal(tx, paymentPosting.journal)
    }
    await tx.execute("UPDATE purchase_invoices SET document_status = 'POSTED', updated_at = ? WHERE organization_id = ? AND id = ? AND document_status = 'DRAFT'", [timestamp, organizationId, purchaseId])
    await tx.execute("UPDATE suppliers SET current_balance = COALESCE(current_balance, 0) + ?, sync_status = 'pending_update', updated_at = ? WHERE organization_id = ? AND id = ?", [minorToMoney(totals.settlementTotalMinor - paidMinor), timestamp, organizationId, supplierId])
    await tx.execute(
      `INSERT INTO gst_transaction_classifications (id, organization_id, financial_year_id, source_type, source_id,
        registration_type, transaction_type, supply_type, tax_category, reverse_charge, itc_status, created_at, updated_at)
       VALUES (?, ?, ?, 'PURCHASE_INVOICE', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [createOfflineId("gst-classification"), organizationId, year.id, purchaseId,
        localString(input.supplier_registration_type, localString(supplier.gstin || supplier.gst_number) ? "REGISTERED" : "UNREGISTERED"),
        localString(input.transaction_type, "B2B"), mode, category, bool(input.reverse_charge) ? 1 : 0,
        localString(input.itc_status, "REVIEW_REQUIRED"), timestamp, timestamp]
    )
    await audit(tx, organizationId, "purchase.posted", "purchase_invoice", purchaseId, `Purchase ${supplierInvoiceNumber} posted with journal ${purchasePosting.journal.voucherNumber}.`, timestamp)
  })
  return { purchase_id: purchaseId, bill_number: internalNumber, supplier_invoice_number: supplierInvoiceNumber, accounting_voucher_id: purchasePosting.journal.id, payment_id: paymentId || null, outstanding_minor: totals.settlementTotalMinor - paidMinor }
}

async function returnInventoryLine(tx: SqlExecutor, organizationId: string, returnId: string, internalNumber: string, returnDate: string, financialYearId: string, line: NormalizedPurchaseLine, product: DataRow, sourceItem: DataRow, batch: DataRow, timestamp: string) {
  const quantity = line.quantityNumber
  if (localNumber(product.stock) + 0.000001 < quantity) throw new Error(`${String(product.name || "Product")} does not have enough stock for this purchase return.`)
  if (localNumber(batch.quantity) + 0.000001 < quantity) throw new Error(`${String(product.name || "Product")} no longer has enough quantity in the original purchase batch.`)
  const batchId = String(batch.id)
  await tx.execute("UPDATE stock_batches SET quantity = quantity - ?, sync_status = 'pending_update', updated_at = ? WHERE organization_id = ? AND id = ? AND quantity >= ?", [quantity, timestamp, organizationId, batchId, quantity])
  await tx.execute("UPDATE products SET stock = stock - ?, sync_status = 'pending_update', updated_at = ? WHERE organization_id = ? AND id = ? AND stock >= ?", [quantity, timestamp, organizationId, line.productId || null, quantity])
  await tx.execute("UPDATE inventory_items SET quantity = MAX(0, quantity - ?), available_quantity = MAX(0, available_quantity - ?), sync_status = 'pending_update', updated_at = ? WHERE organization_id = ? AND batch_id = ? AND product_id = ?", [quantity, quantity, timestamp, organizationId, batchId, line.productId || null])
  const previousStock = localNumber(product.stock)
  const unitCostMinor = Number(batch.purchase_rate_minor || sourceItem.unit_cost_minor || 0)
  await tx.execute(
    `INSERT INTO stock_movements (
       id, organization_id, product_id, product_name, warehouse_id, batch_id, type, quantity, previous_stock,
       new_stock, reason, reference_no, reference_type, reference_id, movement_date, financial_year_id,
       unit_cost_minor, total_cost_minor, cost_status, sync_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'purchase_return', ?, ?, ?, ?, ?, 'purchase_return', ?, ?, ?, ?, ?, 'RECORDED', 'local', ?, ?)`,
    [createOfflineId("stock-movement"), organizationId, line.productId || null, line.productName || (product.name as SqlValue) || "Product",
      (batch.warehouse_id as SqlValue) || (sourceItem.warehouse_id as SqlValue) || null, batchId, -quantity, previousStock, previousStock - quantity,
      `Purchase return ${internalNumber}`, internalNumber, returnId, returnDate, financialYearId,
      unitCostMinor, Math.round(unitCostMinor * quantity), timestamp, timestamp]
  )
}

export async function createPurchaseReturn(organizationId: string, input: DataRow) {
  const returnAgainstId = localString(input.return_against_id, localString(input.purchase_invoice_id))
  if (!returnAgainstId) throw new Error("Select the original purchase invoice for this debit note.")
  const context = await purchaseContext(organizationId, input, "purchase_return")
  if (context.existing) return { purchase_id: context.existing.id, bill_number: context.existing.bill_number, idempotent: true }
  const { purchaseDate, year, supplier, supplierId, supplierInvoiceNumber, idempotencyKey, mode, category, defaultClassification, lines, totals, products, db } = context
  const [original] = await db.select<DataRow>(
    "SELECT * FROM purchase_invoices WHERE organization_id = ? AND id = ? AND supplier_id = ? AND invoice_kind = 'purchase_invoice' AND document_status = 'POSTED' AND deleted_at IS NULL LIMIT 1",
    [organizationId, returnAgainstId, supplierId]
  )
  if (!original) throw new Error("The original posted purchase invoice was not found for this supplier.")
  const sourceItems = await db.select<DataRow>(`SELECT item.*,
      COALESCE((SELECT SUM(returned.quantity) FROM purchase_invoice_items returned
        JOIN purchase_invoices note ON note.id=returned.purchase_invoice_id
        WHERE returned.return_against_item_id=item.id AND note.document_status='POSTED' AND note.deleted_at IS NULL),0) returned_quantity
    FROM purchase_invoice_items item WHERE item.organization_id = ? AND item.purchase_invoice_id = ? AND item.deleted_at IS NULL`, [organizationId, returnAgainstId])
  const batchIds = sourceItems.map((row) => localString(row.stock_batch_id)).filter(Boolean)
  const batches = batchIds.length ? await db.select<DataRow>(`SELECT * FROM stock_batches WHERE organization_id = ? AND id IN (${batchIds.map(() => "?").join(",")}) AND deleted_at IS NULL`, [organizationId, ...batchIds]) : []
  const returnMappings = new Map<number, { sourceItem: DataRow; batch?: DataRow }>()
  const remainingByBatch = new Map(batches.map((batch) => [String(batch.id), localNumber(batch.quantity)]))
  const remainingByItem = new Map(sourceItems.map((item) => [String(item.id), Math.max(0, localNumber(item.quantity) - localNumber(item.returned_quantity))]))
  for (const [index, line] of lines.entries()) {
    const sourceItem = sourceItems.find((item) => item.product_id === line.productId && item.purchase_classification === line.classification && (remainingByItem.get(String(item.id)) || 0) + 0.000001 >= line.quantityNumber)
    if (!sourceItem) throw new Error(`Return line ${index + 1} exceeds the remaining quantity on the original purchase.`)
    line.purchaseAccountId = localString(sourceItem.purchase_account_id) || null
    remainingByItem.set(String(sourceItem.id), (remainingByItem.get(String(sourceItem.id)) || 0) - line.quantityNumber)
    if (line.classification === "INVENTORY") {
      const batch = batches.find((candidate) => candidate.id === sourceItem.stock_batch_id)
      if (!batch || (remainingByBatch.get(String(batch.id)) || 0) + 0.000001 < line.quantityNumber) throw new Error(`Return line ${index + 1} cannot be traced to available stock from the original purchase.`)
      remainingByBatch.set(String(batch.id), (remainingByBatch.get(String(batch.id)) || 0) - line.quantityNumber)
      returnMappings.set(index, { sourceItem, batch })
    } else returnMappings.set(index, { sourceItem })
  }
  const selectedAccounts = await selectedAccountMap(organizationId, lines.map((line) => localString(line.purchaseAccountId)).filter(Boolean))
  const payableReductionMinor = Math.min(totals.settlementTotalMinor, Number(original.outstanding_minor || moneyToMinor(original.outstanding_amount || 0)))
  const accounts = await systemAccountMap(organizationId)
  const returnId = createOfflineId("purchase-return")
  const internalNumber = await nextInternalPurchaseNumber(organizationId, "purchase_return")
  const posting = buildPurchaseJournal({
    id: createOfflineId("purchase-return-voucher"), organizationId, financialYearId: year.id, voucherNumber: `DN-${internalNumber}`,
    voucherType: "debit_note", voucherDate: purchaseDate, sourceType: "PURCHASE_RETURN", sourceId: returnId,
    referenceNo: supplierInvoiceNumber, narration: `Purchase return / debit note ${supplierInvoiceNumber}`,
    systemGenerated: true, accounts, supplierId, lines, totals, paidMinor: 0, selectedAccounts,
    reverseCharge: bool(input.reverse_charge), isReturn: true, payableReductionMinor,
  })
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO purchase_invoices (
         id, organization_id, supplier_id, supplier_name, invoice_kind, return_against_id, bill_number, bill_date,
         due_date, subtotal, discount_total, taxable_amount, tax_total, grand_total, paid_amount, outstanding_amount,
         status, notes, financial_year_id, supplier_invoice_number, supplier_invoice_date, purchase_date, reference_no,
         warehouse_id, place_of_supply, supplier_gstin, supplier_registration_type, transaction_type, supply_type,
         tax_category, reverse_charge, purchase_classification, gross_minor, discount_minor, taxable_minor, cgst_minor,
         sgst_minor, igst_minor, cess_minor, other_charges_minor, round_off_minor, grand_total_minor, paid_minor,
         outstanding_minor, accounting_voucher_id, document_status, revision, itc_status, idempotency_key,
         received_status, sync_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'purchase_return', ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, 'posted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DEBIT_NOTE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'DRAFT', 1, ?, ?, 'returned', 'local', ?, ?)`,
      [returnId, organizationId, supplierId, (supplier.name as SqlValue) || "Supplier", returnAgainstId, internalNumber, purchaseDate,
        minorToMoney(totals.grossMinor), minorToMoney(totals.discountMinor), minorToMoney(totals.taxableMinor),
        minorToMoney(totals.cgstMinor + totals.sgstMinor + totals.igstMinor + totals.cessMinor), minorToMoney(totals.grandTotalMinor),
        localString(input.notes, localString(input.reason)) || null, year.id, supplierInvoiceNumber,
        date(input.supplier_invoice_date || input.bill_date || purchaseDate), purchaseDate, localString(input.reference) || null,
        localString(input.warehouse_id) || null, localString(input.place_of_supply, localString(supplier.state)) || null,
        localString(input.gstin, localString(supplier.gstin, localString(supplier.gst_number))) || null,
        localString(input.supplier_registration_type, localString(supplier.gstin || supplier.gst_number) ? "REGISTERED" : "UNREGISTERED"),
        mode, category, bool(input.reverse_charge) ? 1 : 0, defaultClassification, totals.grossMinor,
        totals.discountMinor, totals.taxableMinor, totals.cgstMinor, totals.sgstMinor, totals.igstMinor, totals.cessMinor,
        totals.otherChargesMinor, totals.roundOffMinor, totals.grandTotalMinor, posting.journal.id,
        localString(input.itc_status, "REVIEW_REQUIRED"), idempotencyKey || null, timestamp, timestamp]
    )
    for (const [index, line] of lines.entries()) {
      const itemId = createOfflineId("purchase-return-item")
      const mapping = returnMappings.get(index)
      if (!mapping) throw new Error("Purchase return source mapping disappeared.")
      await insertPurchaseLine(tx, purchaseItemValues(organizationId, returnId, itemId, line, mapping.batch ? String(mapping.batch.id) : null, timestamp, String(mapping.sourceItem.id)))
      if (mapping.batch) {
        const product = products.find((row) => row.id === line.productId)
        if (!product) throw new Error("Inventory product disappeared while posting the return.")
        await returnInventoryLine(tx, organizationId, returnId, internalNumber, purchaseDate, year.id, line, product, mapping.sourceItem, mapping.batch, timestamp)
      }
    }
    await appendJournal(tx, posting.journal)
    await tx.execute("UPDATE purchase_invoices SET document_status = 'POSTED', updated_at = ? WHERE organization_id = ? AND id = ? AND document_status = 'DRAFT'", [timestamp, organizationId, returnId])
    await tx.execute(
      `UPDATE purchase_invoices SET outstanding_minor = MAX(0, outstanding_minor - ?), outstanding_amount = MAX(0, outstanding_amount - ?),
       status = CASE WHEN outstanding_minor - ? <= 0 THEN 'paid' ELSE status END, updated_at = ?
       WHERE organization_id = ? AND id = ?`,
      [payableReductionMinor, minorToMoney(payableReductionMinor), payableReductionMinor, timestamp, organizationId, returnAgainstId]
    )
    if (posting.supplierReceivableMinor) {
      await tx.execute(
        `INSERT INTO party_advances (id, organization_id, financial_year_id, party_type, party_id, source_type,
          source_id, advance_minor, applied_minor, status, created_at, updated_at)
         VALUES (?, ?, ?, 'supplier', ?, 'PURCHASE_RETURN', ?, ?, 0, 'OPEN', ?, ?)`,
        [createOfflineId("supplier-receivable"), organizationId, year.id, supplierId, returnId, posting.supplierReceivableMinor, timestamp, timestamp]
      )
    }
    await tx.execute("UPDATE suppliers SET current_balance = MAX(0, COALESCE(current_balance, 0) - ?), sync_status = 'pending_update', updated_at = ? WHERE organization_id = ? AND id = ?", [minorToMoney(payableReductionMinor), timestamp, organizationId, supplierId])
    await tx.execute(
      `INSERT INTO gst_transaction_classifications (id, organization_id, financial_year_id, source_type, source_id,
        registration_type, transaction_type, supply_type, tax_category, reverse_charge, itc_status, created_at, updated_at)
       VALUES (?, ?, ?, 'PURCHASE_RETURN', ?, ?, 'DEBIT_NOTE', ?, ?, ?, ?, ?, ?)`,
      [createOfflineId("gst-classification"), organizationId, year.id, returnId,
        localString(input.supplier_registration_type, localString(supplier.gstin || supplier.gst_number) ? "REGISTERED" : "UNREGISTERED"),
        mode, category, bool(input.reverse_charge) ? 1 : 0, localString(input.itc_status, "REVIEW_REQUIRED"), timestamp, timestamp]
    )
    await audit(tx, organizationId, "purchase_return.posted", "purchase_return", returnId, `Debit note ${supplierInvoiceNumber} posted against ${String(original.supplier_invoice_number || original.bill_number)}.`, timestamp)
  })
  return { purchase_return_id: returnId, bill_number: internalNumber, accounting_voucher_id: posting.journal.id, payable_reduction_minor: payableReductionMinor, supplier_receivable_minor: posting.supplierReceivableMinor || 0 }
}

function allocationDocumentId(input: AllocationInput) {
  return localString(input.document_id, localString(input.purchase_invoice_id, localString(input.invoice_id)))
}

async function openingSettlementDocuments(
  db: SqlExecutor,
  organizationId: string,
  financialYearId: string,
  partyType: "supplier" | "customer",
  ids: string[] = []
) {
  const supplier = partyType === "supplier"
  const documentType: SettlementDocumentType = supplier ? "supplier_opening" : "customer_opening"
  const partyColumn = supplier ? "supplier_id" : "customer_id"
  const partyTable = supplier ? "suppliers" : "customers"
  const accountRole = supplier ? "ACCOUNTS_PAYABLE" : "ACCOUNTS_RECEIVABLE"
  const openingMinor = supplier ? "line.credit_minor-line.debit_minor" : "line.debit_minor-line.credit_minor"
  const idFilter = ids.length ? `AND line.id IN (${ids.map(() => "?").join(",")})` : ""
  return db.select<DataRow>(
    `SELECT * FROM (
       SELECT line.id, line.${partyColumn}, party.name party_name, '${documentType}' document_type,
         voucher.voucher_number, voucher.voucher_date,
         voucher.voucher_number supplier_invoice_number,
         voucher.voucher_number invoice_number,
         voucher.voucher_number display_invoice_number,
         voucher.voucher_date purchase_date, voucher.voucher_date invoice_date, voucher.voucher_date due_date,
         MAX(0, ${openingMinor}
           - COALESCE((SELECT SUM(allocation.allocation_minor) FROM payment_allocations allocation
             WHERE allocation.organization_id=line.organization_id AND allocation.document_type='${documentType}'
               AND allocation.document_id=line.id AND allocation.reversed_at IS NULL),0)
           - COALESCE((SELECT SUM(allocation.allocation_minor) FROM advance_allocations allocation
             WHERE allocation.organization_id=line.organization_id AND allocation.document_type='${documentType}'
               AND allocation.document_id=line.id),0)) outstanding_minor
       FROM accounting_voucher_entries line
       JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id AND voucher.organization_id=line.organization_id
       JOIN chart_of_accounts account ON account.id=line.account_id AND account.organization_id=line.organization_id
       JOIN ${partyTable} party ON party.id=line.${partyColumn} AND party.organization_id=line.organization_id
       WHERE line.organization_id=? AND voucher.financial_year_id=? AND voucher.status='posted'
         AND voucher.voucher_type='opening' AND line.party_type=? AND line.${partyColumn} IS NOT NULL
         AND account.system_role=? AND ${openingMinor}>0 ${idFilter}
     ) opening_document WHERE outstanding_minor>0
     ORDER BY voucher_date, id`,
    [organizationId, financialYearId, partyType, accountRole, ...ids]
  )
}

export async function createPartyPayment(organizationId: string, input: DataRow, partyType: "supplier" | "customer") {
  const paymentDate = date(input.payment_date || input.date)
  await assertPeriodUnlocked(organizationId, paymentDate)
  await initializeAccounting(organizationId, paymentDate)
  const year = await assertFinancialYearWriteAllowed(organizationId, paymentDate, localString(input.financial_year_id) || null)
  const partyId = localString(input.party_id, localString(partyType === "supplier" ? input.supplier_id : input.customer_id))
  if (!partyId) throw new Error(`${partyType === "supplier" ? "Supplier" : "Customer"} is required.`)
  const amountMinor = moneyToMinor(input.amount, "Payment amount")
  if (amountMinor <= 0) throw new Error("Payment amount must be greater than zero.")
  const paymentAccountId = localString(input.payment_account_id, localString(input.account_id))
  const selected = await selectedAccountMap(organizationId, [paymentAccountId])
  const paymentAccount = selected.get(paymentAccountId)
  if (!paymentAccount || paymentAccount.accountType !== "ASSET") throw new Error("Select an active cash or bank account.")
  const db = await service.requireConnection("read")
  const partyTable = partyType === "supplier" ? "suppliers" : "customers"
  const [party] = await db.select<DataRow>(`SELECT * FROM ${partyTable} WHERE organization_id = ? AND id = ? AND deleted_at IS NULL AND is_active = 1 LIMIT 1`, [organizationId, partyId])
  if (!party) throw new Error(`${partyType === "supplier" ? "Supplier" : "Customer"} was not found or is inactive.`)
  const idempotencyKey = localString(input.idempotency_key)
  if (idempotencyKey) {
    const [existing] = await db.select<DataRow>("SELECT id, accounting_voucher_id FROM payments WHERE organization_id = ? AND idempotency_key = ? AND deleted_at IS NULL LIMIT 1", [organizationId, idempotencyKey])
    if (existing) return { payment_id: existing.id, accounting_voucher_id: existing.accounting_voucher_id, idempotent: true }
  }
  const rawAllocations = Array.isArray(input.allocations) ? input.allocations as AllocationInput[] : []
  const normalizedAllocations = rawAllocations.filter((row) => allocationDocumentId(row)).map((row) => ({
    documentId: allocationDocumentId(row),
    amountMinor: moneyToMinor(row.allocation_amount ?? row.amount, "Allocation amount"),
  }))
  const duplicateDocument = normalizedAllocations.find((candidate, index) => normalizedAllocations.findIndex((row) => row.documentId === candidate.documentId) !== index)
  if (duplicateDocument) throw new Error("A document can only appear once in a payment allocation.")
  const documentTable = partyType === "supplier" ? "purchase_invoices" : "sales_invoices"
  const partyColumn = partyType === "supplier" ? "supplier_id" : "customer_id"
  const invoiceDocumentType: SettlementDocumentType = partyType === "supplier" ? "purchase_invoice" : "sales_invoice"
  const ids = normalizedAllocations.map((row) => row.documentId)
  const invoiceDocuments = ids.length ? await db.select<DataRow>(
    `SELECT * FROM ${documentTable} WHERE organization_id = ? AND ${partyColumn} = ? AND id IN (${ids.map(() => "?").join(",")}) AND deleted_at IS NULL`,
    [organizationId, partyId, ...ids]
  ) : []
  const invoiceIds = new Set(invoiceDocuments.map((row) => String(row.id)))
  const openingDocuments = await openingSettlementDocuments(db, organizationId, year.id, partyType, ids.filter((id) => !invoiceIds.has(id)))
  const documents: DataRow[] = [
    ...invoiceDocuments.map((row): DataRow => ({ ...row, document_type: invoiceDocumentType })),
    ...openingDocuments,
  ]
  if (documents.length !== ids.length) throw new Error("One or more allocated documents were not found for this party.")
  const resolvedAllocations = normalizedAllocations.map((allocation) => {
    const document = documents.find((row) => row.id === allocation.documentId)
    const outstandingMinor = Number(document?.outstanding_minor || moneyToMinor(document?.outstanding_amount || 0))
    if (allocation.amountMinor <= 0 || allocation.amountMinor > outstandingMinor) throw new Error("An allocation must be positive and cannot exceed the document outstanding amount.")
    return { ...allocation, documentType: String(document?.document_type || invoiceDocumentType) as SettlementDocumentType }
  })
  const allocatedMinor = resolvedAllocations.reduce((sum, row) => sum + row.amountMinor, 0)
  if (allocatedMinor > amountMinor) throw new Error("Invoice allocations cannot exceed the payment amount.")
  const accounts = await systemAccountMap(organizationId)
  const paymentId = createOfflineId(partyType === "supplier" ? "supplier-payment" : "customer-receipt")
  const posting = buildPartySettlementJournal({
    id: createOfflineId("payment-voucher"), organizationId, financialYearId: year.id,
    voucherNumber: `${partyType === "supplier" ? "PAY" : "REC"}-${paymentId.slice(-8).toUpperCase()}`,
    voucherType: partyType === "supplier" ? "payment" : "receipt", voucherDate: paymentDate,
    sourceType: partyType === "supplier" ? "SUPPLIER_PAYMENT" : "CUSTOMER_RECEIPT", sourceId: paymentId,
    referenceNo: localString(input.reference_no) || null,
    narration: localString(input.notes, `${partyType === "supplier" ? "Supplier payment" : "Customer receipt"} · ${String(party.name || "Party")}`),
    systemGenerated: true, accounts, partyType, partyId, direction: partyType === "supplier" ? "out" : "in",
    paymentAccount, amountMinor, allocatedMinor,
  })
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO payments (
         id, organization_id, party_type, party_id, document_type, document_id, amount, amount_minor, direction,
         payment_method, payment_mode, reference_no, payment_date, notes, financial_year_id, accounting_voucher_id,
         payment_account_id, unallocated_minor, idempotency_key, sync_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?)`,
      [paymentId, organizationId, partyType, partyId, resolvedAllocations.length > 1 ? "multiple" : resolvedAllocations[0]?.documentType || invoiceDocumentType,
        minorToMoney(amountMinor), amountMinor, partyType === "supplier" ? "out" : "in",
        localString(input.payment_mode, localString(input.payment_method, "cash")),
        localString(input.payment_mode, localString(input.payment_method, "cash")), localString(input.reference_no) || null,
        paymentDate, localString(input.notes) || null, year.id, posting.journal.id, paymentAccountId,
        posting.advanceMinor, idempotencyKey || null, timestamp, timestamp]
    )
    for (const allocation of resolvedAllocations) {
      await tx.execute(
        `INSERT INTO payment_allocations (id, organization_id, financial_year_id, payment_id, party_type, party_id,
          document_type, document_id, allocation_minor, allocated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [createOfflineId("allocation"), organizationId, year.id, paymentId, partyType, partyId, allocation.documentType, allocation.documentId, allocation.amountMinor, timestamp]
      )
      if (allocation.documentType === "purchase_invoice") {
        await tx.execute(
          `UPDATE purchase_invoices SET paid_minor = paid_minor + ?, outstanding_minor = MAX(0, outstanding_minor - ?),
           paid_amount = paid_amount + ?, outstanding_amount = MAX(0, outstanding_amount - ?),
           status = CASE WHEN outstanding_minor - ? <= 0 THEN 'paid' ELSE 'partial' END, updated_at = ?
           WHERE organization_id = ? AND id = ?`,
          [allocation.amountMinor, allocation.amountMinor, minorToMoney(allocation.amountMinor), minorToMoney(allocation.amountMinor), allocation.amountMinor, timestamp, organizationId, allocation.documentId]
        )
      } else if (allocation.documentType === "sales_invoice") {
        await tx.execute(
          `UPDATE sales_invoices SET paid_minor = paid_minor + ?, outstanding_minor = MAX(0, outstanding_minor - ?),
           paid_amount = paid_amount + ?, outstanding_amount = MAX(0, outstanding_amount - ?),
           payment_status = CASE WHEN outstanding_minor - ? <= 0 THEN 'paid' ELSE 'partial' END,
           status = CASE WHEN outstanding_minor - ? <= 0 THEN 'paid' ELSE 'partial' END, updated_at = ?
           WHERE organization_id = ? AND id = ?`,
          [allocation.amountMinor, allocation.amountMinor, minorToMoney(allocation.amountMinor), minorToMoney(allocation.amountMinor),
            allocation.amountMinor, allocation.amountMinor, timestamp, organizationId, allocation.documentId]
        )
      }
    }
    if (posting.advanceMinor) {
      await tx.execute(
        `INSERT INTO party_advances (id, organization_id, financial_year_id, party_type, party_id, payment_id,
          source_type, source_id, advance_minor, applied_minor, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'OPEN', ?, ?)`,
        [createOfflineId("party-advance"), organizationId, year.id, partyType, partyId, paymentId,
          partyType === "supplier" ? "SUPPLIER_PAYMENT" : "CUSTOMER_RECEIPT", paymentId, posting.advanceMinor, timestamp, timestamp]
      )
    }
    await appendJournal(tx, posting.journal)
    const balanceDelta = partyType === "supplier" ? -allocatedMinor : -allocatedMinor
    await tx.execute(`UPDATE ${partyTable} SET current_balance = MAX(0, COALESCE(current_balance, 0) + ?), sync_status = 'pending_update', updated_at = ? WHERE organization_id = ? AND id = ?`, [minorToMoney(balanceDelta), timestamp, organizationId, partyId])
    await audit(tx, organizationId, partyType === "supplier" ? "supplier_payment.posted" : "customer_receipt.posted", "payment", paymentId, `${String(party.name || "Party")} · ${resolvedAllocations.length} document allocation(s) · advance ${posting.advanceMinor} minor units.`, timestamp)
  })
  return { payment_id: paymentId, accounting_voucher_id: posting.journal.id, allocated_minor: allocatedMinor, advance_minor: posting.advanceMinor }
}

export async function applyPartyAdvance(organizationId: string, input: DataRow, partyType: "supplier" | "customer") {
  const allocationDate = date(input.allocation_date || input.date)
  await assertPeriodUnlocked(organizationId, allocationDate)
  await initializeAccounting(organizationId, allocationDate)
  const year = await assertFinancialYearWriteAllowed(organizationId, allocationDate, localString(input.financial_year_id) || null)
  const advanceId = localString(input.advance_id)
  const documentId = localString(input.document_id, localString(partyType === "supplier" ? input.purchase_invoice_id : input.invoice_id))
  if (!advanceId || !documentId) throw new Error("Advance and target document are required.")
  const amountMinor = moneyToMinor(input.amount, "Advance allocation")
  const db = await service.requireConnection("read")
  const [advance] = await db.select<DataRow>("SELECT * FROM party_advances WHERE organization_id = ? AND id = ? AND party_type = ? AND status = 'OPEN' LIMIT 1", [organizationId, advanceId, partyType])
  if (!advance) throw new Error("Open party advance was not found.")
  const availableMinor = Number(advance.advance_minor || 0) - Number(advance.applied_minor || 0)
  if (amountMinor <= 0 || amountMinor > availableMinor) throw new Error("Advance allocation exceeds the available advance.")
  const table = partyType === "supplier" ? "purchase_invoices" : "sales_invoices"
  const partyColumn = partyType === "supplier" ? "supplier_id" : "customer_id"
  const invoiceDocumentType: SettlementDocumentType = partyType === "supplier" ? "purchase_invoice" : "sales_invoice"
  const openingDocumentType: SettlementDocumentType = partyType === "supplier" ? "supplier_opening" : "customer_opening"
  const [invoiceDocument] = await db.select<DataRow>(`SELECT * FROM ${table} WHERE organization_id = ? AND id = ? AND ${partyColumn} = ? AND deleted_at IS NULL LIMIT 1`, [organizationId, documentId, advance.party_id as SqlValue])
  const [openingDocument] = invoiceDocument ? [] : await openingSettlementDocuments(db, organizationId, year.id, partyType, [documentId])
  const document = invoiceDocument || openingDocument
  const documentType = invoiceDocument ? invoiceDocumentType : openingDocumentType
  const outstandingMinor = Number(document?.outstanding_minor || moneyToMinor(document?.outstanding_amount || 0))
  if (!document || amountMinor > outstandingMinor) throw new Error("Advance allocation exceeds the target document outstanding amount.")
  const accounts = await systemAccountMap(organizationId)
  const allocationId = createOfflineId("advance-allocation")
  const posting = buildAdvanceApplicationJournal({
    id: createOfflineId("advance-voucher"), organizationId, financialYearId: year.id,
    voucherNumber: `ADV-${allocationId.slice(-8).toUpperCase()}`, voucherType: "journal", voucherDate: allocationDate,
    sourceType: partyType === "supplier" ? "SUPPLIER_ADVANCE_APPLICATION" : "CUSTOMER_ADVANCE_APPLICATION",
    sourceId: allocationId, referenceNo: localString(input.reference_no) || null,
    narration: localString(input.notes, "Party advance applied to invoice"), systemGenerated: true,
    accounts, partyType, partyId: String(advance.party_id), amountMinor,
  })
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await appendJournal(tx, posting)
    await tx.execute(
      `INSERT INTO advance_allocations (id, organization_id, financial_year_id, advance_id, document_type,
       document_id, allocation_minor, accounting_voucher_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [allocationId, organizationId, year.id, advanceId, documentType, documentId, amountMinor, posting.id, timestamp]
    )
    await tx.execute("UPDATE party_advances SET applied_minor = applied_minor + ?, status = CASE WHEN applied_minor + ? >= advance_minor THEN 'APPLIED' ELSE 'OPEN' END, updated_at = ? WHERE organization_id = ? AND id = ?", [amountMinor, amountMinor, timestamp, organizationId, advanceId])
    if (documentType === "purchase_invoice") {
      await tx.execute("UPDATE purchase_invoices SET paid_minor = paid_minor + ?, outstanding_minor = MAX(0, outstanding_minor - ?), paid_amount = paid_amount + ?, outstanding_amount = MAX(0, outstanding_amount - ?), status = CASE WHEN outstanding_minor - ? <= 0 THEN 'paid' ELSE 'partial' END, updated_at = ? WHERE organization_id = ? AND id = ?", [amountMinor, amountMinor, minorToMoney(amountMinor), minorToMoney(amountMinor), amountMinor, timestamp, organizationId, documentId])
    } else if (documentType === "sales_invoice") {
      await tx.execute("UPDATE sales_invoices SET paid_minor = paid_minor + ?, outstanding_minor = MAX(0, outstanding_minor - ?), paid_amount = paid_amount + ?, outstanding_amount = MAX(0, outstanding_amount - ?), payment_status = CASE WHEN outstanding_minor - ? <= 0 THEN 'paid' ELSE 'partial' END, status = CASE WHEN outstanding_minor - ? <= 0 THEN 'paid' ELSE 'partial' END, updated_at = ? WHERE organization_id = ? AND id = ?", [amountMinor, amountMinor, minorToMoney(amountMinor), minorToMoney(amountMinor), amountMinor, amountMinor, timestamp, organizationId, documentId])
    }
    await tx.execute(
      `UPDATE ${partyType === "supplier" ? "suppliers" : "customers"}
       SET current_balance = MAX(0, COALESCE(current_balance, 0) - ?), sync_status = 'pending_update', updated_at = ?
       WHERE organization_id = ? AND id = ?`,
      [minorToMoney(amountMinor), timestamp, organizationId, advance.party_id as SqlValue]
    )
    await audit(tx, organizationId, "party_advance.applied", "party_advance", advanceId, `${amountMinor} minor units applied to ${documentId}.`, timestamp)
  })
  return { advance_id: advanceId, allocation_id: allocationId, accounting_voucher_id: posting.id, applied_minor: amountMinor }
}

export async function saveSupplier(organizationId: string, input: DataRow) {
  const name = localString(input.name, localString(input.supplier_name))
  if (!name) throw new Error("Supplier name is required.")
  const gstin = localString(input.gstin, localString(input.gst_number)).toUpperCase()
  if (gstin) {
    const validation = validateGstinFormat(gstin)
    if (!validation.valid) throw new Error(validation.reason)
  }
  const db = await service.requireConnection("read")
  const id = localString(input.id) || createOfflineId("supplier")
  const [existing] = await db.select<DataRow>("SELECT * FROM suppliers WHERE organization_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1", [organizationId, id])
  const openingMinor = moneyToMinor(input.opening_balance ?? 0, "Supplier opening balance")
  const openingType = localString(input.opening_balance_type, "payable").toLowerCase()
  if (!["payable", "advance"].includes(openingType)) throw new Error("Supplier opening balance type must be payable or advance.")
  if (existing && (openingMinor !== Number(existing.opening_balance_minor || 0) || openingType !== String(existing.opening_balance_type || "payable"))) {
    throw new Error("Supplier opening balance is posted history and cannot be edited. Use an accounting correction instead.")
  }
  const openingDate = date(input.opening_date)
  let openingJournal: ReturnType<typeof validateJournal> | null = null
  if (!existing && openingMinor > 0) {
    await assertPeriodUnlocked(organizationId, openingDate)
    await initializeAccounting(organizationId, openingDate)
    const year = await assertFinancialYearWriteAllowed(organizationId, openingDate)
    const accounts = await systemAccountMap(organizationId)
    const partyDetails = { partyType: "supplier" as const, partyId: id, supplierId: id }
    const account = openingType === "payable" ? accounts.get("ACCOUNTS_PAYABLE") : accounts.get("SUPPLIER_ADVANCES")
    const equity = accounts.get("OPENING_EQUITY")
    if (!account || !equity) throw new Error("Supplier opening accounts are missing.")
    const lines: JournalLine[] = openingType === "payable"
      ? [{ accountId: equity.id, accountType: equity.accountType, debitMinor: openingMinor, creditMinor: 0 }, { accountId: account.id, accountType: account.accountType, debitMinor: 0, creditMinor: openingMinor, ...partyDetails }]
      : [{ accountId: account.id, accountType: account.accountType, debitMinor: openingMinor, creditMinor: 0, ...partyDetails }, { accountId: equity.id, accountType: equity.accountType, debitMinor: 0, creditMinor: openingMinor }]
    openingJournal = validateJournal({ id: createOfflineId("supplier-opening-voucher"), organizationId, financialYearId: year.id, voucherNumber: `SUP-OPEN-${id.slice(-8).toUpperCase()}`, voucherType: "opening", voucherDate: openingDate, sourceType: "SUPPLIER_OPENING", sourceId: id, narration: `Supplier opening ${openingType} · ${name}`, systemGenerated: true, lines })
  }
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO suppliers (
         id, organization_id, name, contact_person, email, phone, gstin, gst_number, tax_id, billing_address,
         address, city, state, country, pin_code, pan, payment_terms, credit_days, opening_balance,
         opening_balance_minor, opening_balance_type, current_balance, notes, is_active, sync_status,
         created_at, updated_at, deleted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, contact_person = excluded.contact_person,
         email = excluded.email, phone = excluded.phone, gstin = excluded.gstin, gst_number = excluded.gst_number,
         billing_address = excluded.billing_address, address = excluded.address, city = excluded.city,
         state = excluded.state, country = excluded.country, pin_code = excluded.pin_code, pan = excluded.pan,
         payment_terms = excluded.payment_terms, credit_days = excluded.credit_days, notes = excluded.notes,
         is_active = excluded.is_active, updated_at = excluded.updated_at`,
      [id, organizationId, name, localString(input.contact_person) || null, localString(input.email) || null,
        localString(input.phone) || null, gstin || null, gstin || null, localString(input.pan) || null,
        localString(input.billing_address, localString(input.address)) || null, localString(input.address, localString(input.billing_address)) || null,
        localString(input.city) || null, localString(input.state) || null, localString(input.country, "India"),
        localString(input.pin_code) || null, localString(input.pan) || null, localString(input.payment_terms) || null,
        Math.max(0, Math.trunc(localNumber(input.credit_days))), minorToMoney(openingMinor), openingMinor, openingType,
        openingType === "payable" ? minorToMoney(openingMinor) : 0, localString(input.notes) || null,
        input.is_active === undefined ? 1 : bool(input.is_active) ? 1 : 0, existing?.created_at as SqlValue || timestamp, timestamp]
    )
    if (openingJournal) {
      await appendJournal(tx, openingJournal)
      if (openingType === "advance") {
        await tx.execute(
          `INSERT INTO party_advances (id, organization_id, financial_year_id, party_type, party_id, payment_id,
            source_type, source_id, advance_minor, applied_minor, status, created_at, updated_at)
           VALUES (?, ?, ?, 'supplier', ?, NULL, 'SUPPLIER_OPENING', ?, ?, 0, 'OPEN', ?, ?)`,
          [`supplier-opening-advance:${id}`, organizationId, openingJournal.financialYearId, id, id, openingMinor, timestamp, timestamp]
        )
      }
    }
    await audit(tx, organizationId, existing ? "supplier.updated" : "supplier.created", "supplier", id, `${name} supplier master ${existing ? "updated" : "created"}.`, timestamp)
  })
  return { supplier_id: id, opening_voucher_id: openingJournal?.id || null, gstin_validation: gstin ? validateGstinFormat(gstin) : null }
}

export async function reversePurchase(organizationId: string, input: DataRow) {
  const purchaseId = localString(input.purchase_id, localString(input.id))
  const reversalDate = date(input.reversal_date || input.date)
  const reason = localString(input.reason)
  if (!purchaseId || !reason) throw new Error("Purchase and reversal reason are required.")
  await assertPeriodUnlocked(organizationId, reversalDate)
  const year = await assertFinancialYearWriteAllowed(organizationId, reversalDate)
  const db = await service.requireConnection("read")
  const [purchase] = await db.select<DataRow>("SELECT * FROM purchase_invoices WHERE organization_id = ? AND id = ? AND invoice_kind = 'purchase_invoice' AND document_status = 'POSTED' AND reversed_at IS NULL AND deleted_at IS NULL LIMIT 1", [organizationId, purchaseId])
  if (!purchase) throw new Error("Posted purchase was not found or has already been reversed.")
  const [settlement] = await db.select<DataRow>(
    `SELECT
       EXISTS(SELECT 1 FROM payment_allocations allocation WHERE allocation.organization_id=? AND allocation.document_type='purchase_invoice' AND allocation.document_id=? AND allocation.reversed_at IS NULL) has_allocations,
       EXISTS(SELECT 1 FROM purchase_invoices note WHERE note.organization_id=? AND note.return_against_id=? AND note.invoice_kind='purchase_return' AND note.document_status='POSTED' AND note.deleted_at IS NULL) has_returns`,
    [organizationId, purchaseId, organizationId, purchaseId]
  )
  if (Number(purchase.paid_minor || 0) > 0 || Number(settlement?.has_allocations || 0) > 0 || Number(settlement?.has_returns || 0) > 0) {
    throw new Error("This purchase has settlements or debit notes. Preserve their audit history and use a linked purchase return/correction instead of reversing the original invoice.")
  }
  const originalJournal = await loadPostedJournal(organizationId, String(purchase.accounting_voucher_id || ""))
  if (!originalJournal) throw new Error("The authoritative purchase journal was not found.")
  const items = await db.select<DataRow>("SELECT * FROM purchase_invoice_items WHERE organization_id = ? AND purchase_invoice_id = ? AND deleted_at IS NULL", [organizationId, purchaseId])
  const stockItems = items.filter((item) => item.purchase_classification === "INVENTORY" && item.stock_batch_id)
  const batchIds = stockItems.map((item) => String(item.stock_batch_id))
  const batches = batchIds.length ? await db.select<DataRow>(`SELECT * FROM stock_batches WHERE organization_id = ? AND id IN (${batchIds.map(() => "?").join(",")})`, [organizationId, ...batchIds]) : []
  for (const item of stockItems) {
    const batch = batches.find((row) => row.id === item.stock_batch_id)
    if (!batch || localNumber(batch.quantity) + 0.000001 < localNumber(item.quantity)) throw new Error("This purchase stock has been partly consumed. Use a purchase return for the quantity still available instead of cancelling the original document.")
  }
  const reversal = buildReversalJournal(originalJournal, {
    id: createOfflineId("purchase-reversal"), voucherNumber: `REV-${originalJournal.voucherNumber}`,
    voucherDate: reversalDate, financialYearId: year.id, sourceType: "PURCHASE_REVERSAL", sourceId: purchaseId,
    narration: `Purchase reversed: ${reason}`, createdBy: localString(input.created_by) || null,
  })
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await appendJournal(tx, reversal)
    for (const item of stockItems) {
      const quantity = localNumber(item.quantity)
      await tx.execute("UPDATE stock_batches SET quantity = quantity - ?, sync_status = 'pending_update', updated_at = ? WHERE organization_id = ? AND id = ?", [quantity, timestamp, organizationId, item.stock_batch_id as SqlValue])
      await tx.execute("UPDATE products SET stock = stock - ?, sync_status = 'pending_update', updated_at = ? WHERE organization_id = ? AND id = ?", [quantity, timestamp, organizationId, item.product_id as SqlValue])
      await tx.execute("UPDATE inventory_items SET quantity = MAX(0, quantity - ?), available_quantity = MAX(0, available_quantity - ?), updated_at = ? WHERE organization_id = ? AND batch_id = ?", [quantity, quantity, timestamp, organizationId, item.stock_batch_id as SqlValue])
      await tx.execute(
        `INSERT INTO stock_movements (id, organization_id, product_id, product_name, warehouse_id, batch_id, type,
          quantity, reason, reference_no, reference_type, reference_id, movement_date, financial_year_id,
          unit_cost_minor, total_cost_minor, cost_status, sync_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'purchase_reversal', ?, ?, ?, 'purchase_reversal', ?, ?, ?, ?, ?, 'RECORDED', 'local', ?, ?)`,
        [createOfflineId("stock-movement"), organizationId, item.product_id as SqlValue, item.product_name as SqlValue,
          item.warehouse_id as SqlValue, item.stock_batch_id as SqlValue, -quantity, reason, purchase.bill_number as SqlValue,
          purchaseId, reversalDate, year.id, Number(item.unit_cost_minor || 0), -Number(item.taxable_minor || 0), timestamp, timestamp]
      )
    }
    await tx.execute("UPDATE purchase_invoices SET document_status = 'CANCELLED', status = 'cancelled', reversed_at = ?, reversal_voucher_id = ?, cancellation_reason = ?, outstanding_minor = 0, outstanding_amount = 0, updated_at = ? WHERE organization_id = ? AND id = ?", [timestamp, reversal.id, reason, timestamp, organizationId, purchaseId])
    await tx.execute("UPDATE suppliers SET current_balance = MAX(0, COALESCE(current_balance, 0) - ?), updated_at = ? WHERE organization_id = ? AND id = ?", [minorToMoney(Number(purchase.outstanding_minor || 0)), timestamp, organizationId, purchase.supplier_id as SqlValue])
    await audit(tx, organizationId, "purchase.reversed", "purchase_invoice", purchaseId, `Purchase reversed through ${reversal.voucherNumber}: ${reason}`, timestamp)
  })
  return { purchase_id: purchaseId, reversal_voucher_id: reversal.id }
}

export async function savePurchaseAttachment(organizationId: string, input: DataRow) {
  const purchaseId = localString(input.purchase_id)
  const relativePath = localString(input.relative_path, localString(input.relativePath))
  const fileName = localString(input.file_name, localString(input.fileName))
  const mediaType = localString(input.media_type, localString(input.mediaType))
  const sizeBytes = Math.trunc(localNumber(input.size_bytes ?? input.bytes))
  const sha256 = localString(input.sha256).toLowerCase()
  if (!purchaseId || !relativePath.startsWith("business-assets/purchase-attachments/") || !fileName || !["application/pdf", "image/png", "image/jpeg", "image/webp"].includes(mediaType) || sizeBytes <= 0 || sizeBytes > 20 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("The local supplier invoice attachment metadata is invalid.")
  }
  const db = await service.requireConnection("read")
  const [purchase] = await db.select<DataRow>("SELECT id FROM purchase_invoices WHERE organization_id=? AND id=? AND deleted_at IS NULL LIMIT 1", [organizationId, purchaseId])
  if (!purchase) throw new Error("The purchase invoice for this attachment was not found.")
  const [existing] = await db.select<DataRow>("SELECT id FROM purchase_attachments WHERE organization_id=? AND local_relative_path=? LIMIT 1", [organizationId, relativePath])
  if (existing) return { attachment_id: existing.id, idempotent: true }
  const id = createOfflineId("purchase-attachment")
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await tx.execute("INSERT INTO purchase_attachments (id,organization_id,purchase_invoice_id,local_relative_path,file_name,media_type,size_bytes,sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?)", [id, organizationId, purchaseId, relativePath, fileName, mediaType, sizeBytes, sha256, timestamp])
    await audit(tx, organizationId, "purchase.attachment_added", "purchase_invoice", purchaseId, `Local supplier invoice attachment added: ${fileName}.`, timestamp)
  })
  return { attachment_id: id, purchase_id: purchaseId, file_name: fileName }
}

function accountLine(account: AccountingAccount, debitMinor: number, creditMinor: number, details: Partial<JournalLine> = {}): JournalLine {
  return { accountId: account.id, accountType: account.accountType, debitMinor, creditMinor, ...details }
}

export async function createSalesCreditNote(organizationId: string, input: DataRow) {
  const invoiceId = localString(input.invoice_id)
  const noteDate = date(input.note_date || input.date)
  if (!invoiceId) throw new Error("Original sales invoice is required.")
  await assertPeriodUnlocked(organizationId, noteDate)
  await initializeAccounting(organizationId, noteDate)
  const year = await assertFinancialYearWriteAllowed(organizationId, noteDate, localString(input.financial_year_id) || null)
  const db = await service.requireConnection("read")
  const [invoice] = await db.select<DataRow>("SELECT * FROM sales_invoices WHERE organization_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1", [organizationId, invoiceId])
  if (!invoice) throw new Error("Original sales invoice was not found.")
  const customerId = String(invoice.customer_id || "")
  if (!customerId) throw new Error("Original sales invoice has no customer for a credit note.")
  const sourceItems = await db.select<DataRow>(`SELECT item.*,
      COALESCE((SELECT SUM(returned.quantity) FROM credit_note_items returned
        JOIN credit_notes note ON note.id=returned.credit_note_id
        WHERE returned.sales_invoice_item_id=item.id AND note.document_status='POSTED' AND note.deleted_at IS NULL),0) returned_quantity
    FROM sales_invoice_items item WHERE item.organization_id = ? AND item.invoice_id = ? AND item.deleted_at IS NULL`, [organizationId, invoiceId])
  const requested = Array.isArray(input.items) ? input.items as DataRow[] : []
  if (!requested.length) throw new Error("Credit note requires at least one returned line.")
  const remainingByItem = new Map(sourceItems.map((item) => [String(item.id), Math.max(0, localNumber(item.quantity) - localNumber(item.returned_quantity))]))
  const normalized = requested.map((row, index) => {
    const quantity = localNumber(row.quantity)
    const source = sourceItems.find((item) => (item.id === row.invoice_item_id || item.product_id === row.product_id) && (remainingByItem.get(String(item.id)) || 0) + 0.000001 >= quantity)
    if (!source) throw new Error(`Credit note line ${index + 1} does not match the original invoice.`)
    if (quantity <= 0) throw new Error(`Credit note line ${index + 1} requires a positive return quantity.`)
    remainingByItem.set(String(source.id), (remainingByItem.get(String(source.id)) || 0) - quantity)
    const ratio = quantity / localNumber(source.quantity)
    const taxableMinor = row.taxable_value !== undefined ? moneyToMinor(row.taxable_value, "Credit note taxable value") : Math.round(Number(source.taxable_minor || moneyToMinor(Math.max(0, localNumber(source.line_total) - localNumber(source.gst_amount)), "Original taxable value")) * ratio)
    const component = (minorKey: string, moneyKey: string) => row[moneyKey] !== undefined ? moneyToMinor(row[moneyKey], moneyKey) : Math.round(Number(source[minorKey] || moneyToMinor(source[moneyKey] || 0, moneyKey)) * ratio)
    const cgstMinor = component("cgst_minor", "cgst_amount")
    const sgstMinor = component("sgst_minor", "sgst_amount")
    const igstMinor = component("igst_minor", "igst_amount")
    const costAmountMinor = Math.round(Number(source.cost_amount_minor || 0) * ratio)
    return { row, source, quantity, taxableMinor, cgstMinor, sgstMinor, igstMinor, costAmountMinor, totalMinor: taxableMinor + cgstMinor + sgstMinor + igstMinor }
  })
  const totals = normalized.reduce((sum, row) => ({ taxable: sum.taxable + row.taxableMinor, cgst: sum.cgst + row.cgstMinor, sgst: sum.sgst + row.sgstMinor, igst: sum.igst + row.igstMinor, cost: sum.cost + row.costAmountMinor, grand: sum.grand + row.totalMinor }), { taxable: 0, cgst: 0, sgst: 0, igst: 0, cost: 0, grand: 0 })
  const outstandingMinor = Number(invoice.outstanding_minor || moneyToMinor(invoice.outstanding_amount || 0))
  const receivableReductionMinor = Math.min(outstandingMinor, totals.grand)
  const customerAdvanceMinor = totals.grand - receivableReductionMinor
  const accounts = await systemAccountMap(organizationId)
  const requireRole = (role: string) => { const account = accounts.get(role); if (!account) throw new Error(`Required accounting account ${role} is missing.`); return account }
  const party = { partyType: "customer" as const, partyId: customerId, customerId }
  const lines: JournalLine[] = [accountLine(requireRole("SALES"), totals.taxable, 0, { description: "Sales return" })]
  if (totals.cgst) lines.push(accountLine(requireRole("OUTPUT_CGST"), totals.cgst, 0, { description: "Output CGST reversed" }))
  if (totals.sgst) lines.push(accountLine(requireRole("OUTPUT_SGST"), totals.sgst, 0, { description: "Output SGST reversed" }))
  if (totals.igst) lines.push(accountLine(requireRole("OUTPUT_IGST"), totals.igst, 0, { description: "Output IGST reversed" }))
  if (receivableReductionMinor) lines.push(accountLine(requireRole("ACCOUNTS_RECEIVABLE"), 0, receivableReductionMinor, { ...party, description: "Customer receivable reduced" }))
  if (customerAdvanceMinor) lines.push(accountLine(requireRole("CUSTOMER_ADVANCES"), 0, customerAdvanceMinor, { ...party, description: "Amount payable/advance to customer" }))
  if (totals.cost) {
    lines.push(accountLine(requireRole("INVENTORY"), totals.cost, 0, { description: "Returned inventory restored" }))
    lines.push(accountLine(requireRole("COGS"), 0, totals.cost, { description: "COGS reversed" }))
  }
  const noteId = createOfflineId("credit-note")
  const noteNumber = localString(input.note_number, `CN-${noteId.slice(-8).toUpperCase()}`)
  const journal = validateJournal({ id: createOfflineId("credit-note-voucher"), organizationId, financialYearId: year.id, voucherNumber: noteNumber, voucherType: "credit_note", voucherDate: noteDate, sourceType: "SALES_CREDIT_NOTE", sourceId: noteId, referenceNo: String(invoice.display_invoice_number || invoice.invoice_number || ""), narration: localString(input.reason, `Sales credit note against ${String(invoice.invoice_number || invoiceId)}`), systemGenerated: true, lines })
  const movements = await db.select<DataRow>("SELECT * FROM stock_movements WHERE organization_id = ? AND reference_id = ? AND reference_type = 'invoice' AND quantity < 0 AND deleted_at IS NULL ORDER BY created_at, id", [organizationId, invoiceId])
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO credit_notes (id, organization_id, invoice_id, customer_id, note_number, note_date, reason,
        subtotal, tax_total, grand_total, status, financial_year_id, accounting_voucher_id, subtotal_minor,
        cgst_minor, sgst_minor, igst_minor, grand_total_minor, document_status, sync_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, 'POSTED', 'local', ?, ?)`,
      [noteId, organizationId, invoiceId, customerId, noteNumber, noteDate, localString(input.reason) || null,
        minorToMoney(totals.taxable), minorToMoney(totals.cgst + totals.sgst + totals.igst), minorToMoney(totals.grand),
        year.id, journal.id, totals.taxable, totals.cgst, totals.sgst, totals.igst, totals.grand, timestamp, timestamp]
    )
    for (const item of normalized) {
      const movement = movements.find((row) => row.product_id === item.source.product_id && localNumber(row.quantity) * -1 + 0.000001 >= item.quantity)
      const batchId = localString(movement?.batch_id) || null
      const itemId = createOfflineId("credit-note-item")
      await tx.execute(
        `INSERT INTO credit_note_items (id, organization_id, credit_note_id, product_id, quantity, unit_price,
          tax_amount, line_total, taxable_minor, cgst_minor, sgst_minor, igst_minor, cost_amount_minor,
          stock_batch_id, hsn_code, gst_rate_basis_points, sales_invoice_item_id, sync_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?)`,
        [itemId, organizationId, noteId, item.source.product_id as SqlValue, item.quantity,
          localNumber(item.source.unit_price), minorToMoney(item.cgstMinor + item.sgstMinor + item.igstMinor),
          minorToMoney(item.totalMinor), item.taxableMinor, item.cgstMinor, item.sgstMinor, item.igstMinor,
          item.costAmountMinor, batchId, item.source.hsn_code as SqlValue, Number(item.source.gst_rate_basis_points || Math.round(localNumber(item.source.tax_percent) * 100)), item.source.id as SqlValue, timestamp, timestamp]
      )
      if (item.source.product_id) {
        await tx.execute("UPDATE products SET stock = stock + ?, updated_at = ? WHERE organization_id = ? AND id = ?", [item.quantity, timestamp, organizationId, item.source.product_id as SqlValue])
        if (batchId) {
          await tx.execute("UPDATE stock_batches SET quantity = quantity + ?, updated_at = ? WHERE organization_id = ? AND id = ?", [item.quantity, timestamp, organizationId, batchId])
          await tx.execute("UPDATE inventory_items SET quantity = quantity + ?, available_quantity = available_quantity + ?, updated_at = ? WHERE organization_id = ? AND batch_id = ?", [item.quantity, item.quantity, timestamp, organizationId, batchId])
        }
        await tx.execute(
          `INSERT INTO stock_movements (id, organization_id, product_id, product_name, warehouse_id, batch_id,
            type, quantity, reason, reference_no, reference_type, reference_id, movement_date, financial_year_id,
            unit_cost_minor, total_cost_minor, cost_status, sync_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'sales_return', ?, ?, ?, 'credit_note', ?, ?, ?, ?, ?, 'RECORDED', 'local', ?, ?)`,
          [createOfflineId("stock-movement"), organizationId, item.source.product_id as SqlValue, item.source.product_name as SqlValue,
            movement?.warehouse_id as SqlValue || null, batchId, item.quantity, localString(input.reason, "Sales return"), noteNumber,
            noteId, noteDate, year.id, item.quantity ? Math.round(item.costAmountMinor / item.quantity) : 0, item.costAmountMinor, timestamp, timestamp]
        )
      }
    }
    await appendJournal(tx, journal)
    await tx.execute("UPDATE sales_invoices SET outstanding_minor = MAX(0, outstanding_minor - ?), outstanding_amount = MAX(0, outstanding_amount - ?), updated_at = ? WHERE organization_id = ? AND id = ?", [receivableReductionMinor, minorToMoney(receivableReductionMinor), timestamp, organizationId, invoiceId])
    await tx.execute("UPDATE customers SET current_balance = MAX(0, COALESCE(current_balance, 0) - ?), updated_at = ? WHERE organization_id = ? AND id = ?", [minorToMoney(receivableReductionMinor), timestamp, organizationId, customerId])
    if (customerAdvanceMinor) await tx.execute(
      `INSERT INTO party_advances (id, organization_id, financial_year_id, party_type, party_id, source_type,
        source_id, advance_minor, applied_minor, status, created_at, updated_at)
       VALUES (?, ?, ?, 'customer', ?, 'SALES_CREDIT_NOTE', ?, ?, 0, 'OPEN', ?, ?)`,
      [createOfflineId("customer-credit"), organizationId, year.id, customerId, noteId, customerAdvanceMinor, timestamp, timestamp]
    )
    await audit(tx, organizationId, "sales_credit_note.posted", "credit_note", noteId, `Credit note ${noteNumber} posted against ${String(invoice.invoice_number || invoiceId)}.`, timestamp)
  })
  return { credit_note_id: noteId, note_number: noteNumber, accounting_voucher_id: journal.id, receivable_reduction_minor: receivableReductionMinor, customer_advance_minor: customerAdvanceMinor }
}

function maskAccountNumber(value: string) {
  const compact = value.replace(/\s+/g, "")
  if (!compact) return ""
  return compact.length <= 4 ? compact : `${"•".repeat(Math.min(8, compact.length - 4))}${compact.slice(-4)}`
}

export async function saveBankAccount(organizationId: string, input: DataRow) {
  const bankName = localString(input.bank_name)
  const displayName = localString(input.display_name, localString(input.name, bankName))
  if (!displayName || !bankName) throw new Error("Account display name and bank name are required.")
  const db = await service.requireConnection("read")
  const id = localString(input.id) || createOfflineId("bank-account")
  const [existing] = await db.select<DataRow>("SELECT * FROM bank_accounts WHERE organization_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1", [organizationId, id])
  const accountNumber = localString(input.account_number)
  const openingType = localString(input.opening_balance_type, "debit").toLowerCase()
  if (!["debit", "credit"].includes(openingType)) throw new Error("Bank opening balance type must be debit or credit.")
  const enteredOpeningMinor = moneyToMinor(input.opening_balance ?? 0, "Bank opening balance")
  const openingMinor = openingType === "credit" ? -Math.abs(enteredOpeningMinor) : enteredOpeningMinor
  const openingDate = date(input.opening_date)
  let accountId = localString(existing?.account_id)
  let openingJournal: ReturnType<typeof validateJournal> | null = null
  if (!existing) {
    await assertPeriodUnlocked(organizationId, openingDate)
    await initializeAccounting(organizationId, openingDate)
    const year = await assertFinancialYearWriteAllowed(organizationId, openingDate)
    accountId = createOfflineId("bank-ledger")
    if (openingMinor) {
      const accounts = await systemAccountMap(organizationId)
      const equity = accounts.get("OPENING_EQUITY")
      if (!equity) throw new Error("Opening equity account is missing.")
      const bank: AccountingAccount = { id: accountId, accountCode: `BANK-${id.slice(-6).toUpperCase()}`, accountName: displayName, accountType: "ASSET", systemRole: null }
      const absolute = Math.abs(openingMinor)
      openingJournal = validateJournal({
        id: createOfflineId("bank-opening-voucher"), organizationId, financialYearId: year.id,
        voucherNumber: `BANK-OPEN-${id.slice(-8).toUpperCase()}`, voucherType: "opening", voucherDate: openingDate,
        sourceType: "BANK_ACCOUNT_OPENING", sourceId: id, narration: `Opening balance · ${displayName}`, systemGenerated: true,
        lines: openingMinor > 0
          ? [accountLine(bank, absolute, 0), accountLine(equity, 0, absolute)]
          : [accountLine(equity, absolute, 0), accountLine(bank, 0, absolute)],
      })
    }
  } else if (openingMinor !== Number(existing.opening_balance_minor || 0) || openingDate !== String(existing.opening_date || openingDate)) {
    throw new Error("Bank opening balance is posted history and cannot be edited. Use a journal correction instead.")
  }
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    if (!existing) {
      await tx.execute(
        `INSERT INTO chart_of_accounts (id, organization_id, account_code, account_name, account_type, account_group,
          normal_balance, opening_balance, current_balance, is_system, is_cash_account, is_bank_account, is_active,
          notes, sync_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'ASSET', 'BANK', 'debit', 0, 0, 0, 0, 1, 1, ?, 'local', ?, ?)`,
        [accountId, organizationId, `BANK-${id.slice(-6).toUpperCase()}`, displayName, `Linked bank account: ${bankName}`, timestamp, timestamp]
      )
    } else {
      await tx.execute("UPDATE chart_of_accounts SET account_name = ?, is_active = ?, notes = ?, updated_at = ? WHERE organization_id = ? AND id = ?", [displayName, input.is_active === false ? 0 : 1, `Linked bank account: ${bankName}`, timestamp, organizationId, accountId])
    }
    await tx.execute(
      `INSERT INTO bank_accounts (id, organization_id, account_id, bank_name, branch_name, account_number, ifsc_code,
        account_holder, opening_balance, current_balance, is_active, notes, display_name, account_type,
        masked_identifier, opening_balance_minor, opening_date, opening_voucher_id, sync_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?)
       ON CONFLICT(id) DO UPDATE SET bank_name = excluded.bank_name, branch_name = excluded.branch_name,
        account_number = excluded.account_number, ifsc_code = excluded.ifsc_code, account_holder = excluded.account_holder,
        is_active = excluded.is_active, notes = excluded.notes, display_name = excluded.display_name,
        account_type = excluded.account_type, masked_identifier = excluded.masked_identifier, updated_at = excluded.updated_at`,
      [id, organizationId, accountId, bankName, localString(input.branch, localString(input.branch_name)) || null,
        accountNumber || null, localString(input.ifsc, localString(input.ifsc_code)).toUpperCase() || null,
        localString(input.account_holder) || null, minorToMoney(openingMinor), minorToMoney(openingMinor),
        input.is_active === false ? 0 : 1, localString(input.notes) || null, displayName,
        localString(input.account_type, "CURRENT").toUpperCase(), maskAccountNumber(accountNumber), openingMinor,
        openingDate, openingJournal?.id || (existing?.opening_voucher_id as SqlValue) || null, (existing?.created_at as SqlValue) || timestamp, timestamp]
    )
    if (openingJournal) await appendJournal(tx, openingJournal)
    await audit(tx, organizationId, existing ? "bank_account.updated" : "bank_account.created", "bank_account", id, `${displayName} ${existing ? "updated" : "created"}.`, timestamp)
  })
  return { bank_account_id: id, account_id: accountId, masked_identifier: maskAccountNumber(accountNumber), opening_voucher_id: openingJournal?.id || existing?.opening_voucher_id || null }
}

export async function updateBankReconciliation(organizationId: string, input: DataRow) {
  const bankAccountId = localString(input.bank_account_id)
  const voucherEntryId = localString(input.voucher_entry_id)
  const status = localString(input.status, "UNRECONCILED").toUpperCase() === "DIFFERENCE" ? "REVIEW" : localString(input.status, "UNRECONCILED").toUpperCase()
  if (!bankAccountId || !voucherEntryId || !["UNRECONCILED", "CLEARED", "REVIEW"].includes(status)) throw new Error("Bank account, ledger entry, and valid reconciliation status are required.")
  const db = await service.requireConnection("read")
  const [entry] = await db.select<DataRow>(
    `SELECT line.id FROM accounting_voucher_entries line JOIN bank_accounts bank ON bank.account_id = line.account_id
     JOIN accounting_vouchers voucher ON voucher.id = line.voucher_id
     WHERE line.organization_id = ? AND line.id = ? AND bank.id = ? AND voucher.status = 'posted' LIMIT 1`,
    [organizationId, voucherEntryId, bankAccountId]
  )
  if (!entry) throw new Error("The selected posted entry does not belong to this bank account.")
  const clearedDate = status === "CLEARED" ? date(input.cleared_date) : null
  const timestamp = nowIso()
  const id = `bank-reconciliation:${organizationId}:${bankAccountId}:${voucherEntryId}`
  await service.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO bank_reconciliations (id, organization_id, bank_account_id, voucher_entry_id, status,
        cleared_date, bank_reference, notes, reconciled_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, bank_account_id, voucher_entry_id) DO UPDATE SET status = excluded.status,
        cleared_date = excluded.cleared_date, bank_reference = excluded.bank_reference, notes = excluded.notes,
        reconciled_by = excluded.reconciled_by, updated_at = excluded.updated_at`,
      [id, organizationId, bankAccountId, voucherEntryId, status, clearedDate, localString(input.bank_reference) || null,
        localString(input.notes) || null, localString(input.reconciled_by) || null, timestamp, timestamp]
    )
    await audit(tx, organizationId, "bank_reconciliation.updated", "bank_reconciliation", id, `Bank entry marked ${status}. Journal amount was not changed.`, timestamp)
  })
  return { reconciliation_id: id, status, cleared_date: clearedDate }
}

export async function lockAccountingPeriod(organizationId: string, input: DataRow) {
  const lockedThrough = date(input.locked_through)
  if (localString(input.confirmation).toUpperCase() !== "LOCK BOOKS") throw new Error("Type LOCK BOOKS to confirm period locking.")
  const db = await service.requireConnection("read")
  const [active] = await db.select<DataRow>("SELECT id, locked_through FROM accounting_period_locks WHERE organization_id = ? AND unlocked_at IS NULL ORDER BY locked_through DESC LIMIT 1", [organizationId])
  if (active && String(active.locked_through) >= lockedThrough) return { lock_id: active.id, locked_through: active.locked_through, idempotent: true }
  const id = createOfflineId("period-lock")
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    if (active) await tx.execute("UPDATE accounting_period_locks SET unlocked_at = ?, unlocked_by = ?, unlock_reason = 'Superseded by later lock', updated_at = ? WHERE organization_id = ? AND id = ?", [timestamp, localString(input.locked_by) || null, timestamp, organizationId, active.id as SqlValue])
    await tx.execute("INSERT INTO accounting_period_locks (id, organization_id, locked_through, reason, locked_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, organizationId, lockedThrough, localString(input.reason) || null, localString(input.locked_by) || null, timestamp, timestamp])
    await audit(tx, organizationId, "accounting_period.locked", "accounting_period_lock", id, `Books locked through ${lockedThrough}.`, timestamp)
  })
  return { lock_id: id, locked_through: lockedThrough }
}

export async function unlockAccountingPeriod(organizationId: string, input: DataRow) {
  const lockId = localString(input.lock_id)
  const reason = localString(input.reason)
  if (!lockId || !reason || localString(input.confirmation).toUpperCase() !== "UNLOCK BOOKS") throw new Error("Lock, reason, and UNLOCK BOOKS confirmation are required.")
  const db = await service.requireConnection("read")
  const [active] = await db.select<DataRow>("SELECT id, locked_through FROM accounting_period_locks WHERE organization_id = ? AND id = ? AND unlocked_at IS NULL LIMIT 1", [organizationId, lockId])
  if (!active) throw new Error("Active accounting period lock was not found.")
  const timestamp = nowIso()
  await service.transaction(async (tx) => {
    await tx.execute("UPDATE accounting_period_locks SET unlocked_at = ?, unlocked_by = ?, unlock_reason = ?, updated_at = ? WHERE organization_id = ? AND id = ? AND unlocked_at IS NULL", [timestamp, localString(input.unlocked_by) || null, reason, timestamp, organizationId, lockId])
    await audit(tx, organizationId, "accounting_period.unlocked", "accounting_period_lock", lockId, `Books unlocked after ${String(active.locked_through)}: ${reason}`, timestamp)
  })
  return { lock_id: lockId, unlocked_at: timestamp }
}

export async function phaseTwoReferenceData(organizationId: string, financialYearId: string) {
  const db = await service.requireConnection("read")
  const [suppliers, customers, products, warehouses, accounts, bankAccounts, purchases, purchaseItems, salesInvoices, salesItems, advances, locks, status, supplierOpenings, customerOpenings] = await Promise.all([
    db.select<DataRow>("SELECT id, name, state, gstin, gst_number, payment_terms, credit_days FROM suppliers WHERE organization_id = ? AND deleted_at IS NULL AND is_active = 1 ORDER BY name COLLATE NOCASE LIMIT 2500", [organizationId]),
    db.select<DataRow>("SELECT id, name, state, gst_number FROM customers WHERE organization_id = ? AND deleted_at IS NULL AND is_active = 1 ORDER BY name COLLATE NOCASE LIMIT 5500", [organizationId]),
    db.select<DataRow>("SELECT id, name, hsn_code, unit, purchase_rate, gst, stock, warehouse_id FROM products WHERE organization_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE LIMIT 2500", [organizationId]),
    db.select<DataRow>("SELECT id, name, code FROM warehouses WHERE organization_id = ? AND deleted_at IS NULL AND is_active = 1 ORDER BY name COLLATE NOCASE", [organizationId]),
    db.select<DataRow>("SELECT id, account_code, account_name, account_type, account_group, system_role, is_cash_account, is_bank_account FROM chart_of_accounts WHERE organization_id = ? AND deleted_at IS NULL AND is_active = 1 ORDER BY account_code", [organizationId]),
    db.select<DataRow>("SELECT id, account_id, display_name, bank_name, masked_identifier FROM bank_accounts WHERE organization_id = ? AND deleted_at IS NULL AND is_active = 1 ORDER BY display_name", [organizationId]),
    db.select<DataRow>("SELECT id, supplier_id, supplier_invoice_number, bill_number, purchase_date, due_date, outstanding_minor, itc_status FROM purchase_invoices WHERE organization_id = ? AND financial_year_id = ? AND invoice_kind = 'purchase_invoice' AND document_status = 'POSTED' AND deleted_at IS NULL ORDER BY purchase_date DESC LIMIT 5000", [organizationId, financialYearId]),
    db.select<DataRow>("SELECT item.id, item.purchase_invoice_id, item.product_id, item.product_name, item.quantity, item.unit, item.hsn_code, item.unit_cost_minor, item.gst_rate_basis_points, item.purchase_classification, item.purchase_account_id, item.stock_batch_id, batch.quantity available_batch_quantity, COALESCE((SELECT SUM(returned.quantity) FROM purchase_invoice_items returned JOIN purchase_invoices note ON note.id=returned.purchase_invoice_id WHERE returned.return_against_item_id=item.id AND note.document_status='POSTED' AND note.deleted_at IS NULL),0) returned_quantity FROM purchase_invoice_items item JOIN purchase_invoices purchase ON purchase.id=item.purchase_invoice_id LEFT JOIN stock_batches batch ON batch.id=item.stock_batch_id WHERE purchase.organization_id=? AND purchase.financial_year_id=? AND purchase.invoice_kind='purchase_invoice' AND purchase.document_status='POSTED' AND item.deleted_at IS NULL ORDER BY purchase.purchase_date DESC,item.created_at,item.id LIMIT 10000", [organizationId, financialYearId]),
    db.select<DataRow>("SELECT id, customer_id, display_invoice_number, invoice_number, invoice_date, due_date, outstanding_minor FROM sales_invoices WHERE organization_id = ? AND financial_year_id = ? AND deleted_at IS NULL ORDER BY invoice_date DESC LIMIT 5000", [organizationId, financialYearId]),
    db.select<DataRow>("SELECT item.id, item.invoice_id, item.product_id, item.product_name, item.description, item.quantity, item.unit, item.hsn_code, item.taxable_minor, item.cgst_minor, item.sgst_minor, item.igst_minor, item.gst_rate_basis_points, item.cost_rate_minor, item.cost_amount_minor, COALESCE((SELECT SUM(returned.quantity) FROM credit_note_items returned JOIN credit_notes note ON note.id=returned.credit_note_id WHERE returned.sales_invoice_item_id=item.id AND note.document_status='POSTED' AND note.deleted_at IS NULL),0) returned_quantity FROM sales_invoice_items item JOIN sales_invoices invoice ON invoice.id=item.invoice_id WHERE invoice.organization_id=? AND invoice.financial_year_id=? AND invoice.deleted_at IS NULL AND item.deleted_at IS NULL ORDER BY invoice.invoice_date DESC,item.created_at LIMIT 10000", [organizationId, financialYearId]),
    db.select<DataRow>("SELECT id, party_type, party_id, advance_minor, applied_minor, source_type, created_at FROM party_advances WHERE organization_id = ? AND status = 'OPEN' AND advance_minor > applied_minor ORDER BY created_at", [organizationId]),
    db.select<DataRow>("SELECT * FROM accounting_period_locks WHERE organization_id = ? ORDER BY created_at DESC", [organizationId]),
    accountingStatus(organizationId),
    openingSettlementDocuments(db, organizationId, financialYearId, "supplier"),
    openingSettlementDocuments(db, organizationId, financialYearId, "customer"),
  ])
  return {
    suppliers, customers, products, warehouses, accounts, bankAccounts,
    purchases: [...supplierOpenings, ...purchases], purchaseItems,
    salesInvoices: [...customerOpenings, ...salesInvoices], salesItems,
    advances, locks, status,
  }
}

function reportRange(year: DataRow, input: PhaseTwoReportInput) {
  const from = input.from || String(year.start_date)
  const to = input.to || String(year.end_date)
  if (from < String(year.start_date) || to > String(year.end_date) || from > to) throw new Error("Report dates must be within the selected financial year.")
  return { from, to }
}

function page(input: PhaseTwoReportInput) {
  const current = Math.max(1, Math.trunc(input.page || 1))
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit || 50)))
  return { page: current, limit, offset: (current - 1) * limit }
}

export type PhaseTwoReportInput = {
  organizationId: string
  financialYearId: string
  report: string
  from?: string
  to?: string
  page?: number
  limit?: number
  search?: string
  accountId?: string
  partyId?: string
  status?: string
}

async function paged(db: SqlExecutor, countSql: string, rowsSql: string, values: SqlValue[], input: PhaseTwoReportInput) {
  const pagination = page(input)
  const [count] = await db.select<DataRow>(countSql, values)
  const rows = await db.select<DataRow>(rowsSql, [...values, pagination.limit, pagination.offset])
  return { rows, total: Number(count?.count || 0), page: pagination.page, limit: pagination.limit }
}

export async function phaseTwoAccountingReport(input: PhaseTwoReportInput) {
  const db = await service.requireConnection("read")
  const year = await getFinancialYear(input.organizationId, input.financialYearId)
  if (!year) throw new Error("Financial year was not found.")
  const { from, to } = reportRange(year as unknown as DataRow, input)
  const search = localString(input.search)
  const term = `%${search}%`
  const base = [input.organizationId, input.financialYearId, from, to] as SqlValue[]

  if (input.report === "purchases" || input.report === "purchase-returns") {
    const kind = input.report === "purchase-returns" ? "purchase_return" : "purchase_invoice"
    const values = [...base, kind, ...(search ? [term, term, term] : [])]
    const where = `organization_id = ? AND financial_year_id = ? AND purchase_date BETWEEN ? AND ? AND invoice_kind = ? AND deleted_at IS NULL ${search ? "AND (supplier_invoice_number LIKE ? OR supplier_name LIKE ? OR reference_no LIKE ?)" : ""}`
    return { report: input.report, year, from, to, ...(await paged(db, `SELECT COUNT(*) count FROM purchase_invoices WHERE ${where}`, `SELECT * FROM purchase_invoices WHERE ${where} ORDER BY purchase_date DESC, created_at DESC LIMIT ? OFFSET ?`, values, input)) }
  }

  if (input.report === "suppliers") {
    const query = `WITH purchase_metrics AS (
        SELECT supplier_id, SUM(CASE WHEN invoice_kind='purchase_invoice' AND document_status='POSTED' THEN grand_total_minor ELSE 0 END) total_purchases_minor,
          SUM(CASE WHEN invoice_kind='purchase_return' AND document_status='POSTED' THEN grand_total_minor ELSE 0 END) total_returns_minor,
          SUM(CASE WHEN invoice_kind='purchase_invoice' AND document_status='POSTED' THEN outstanding_minor ELSE 0 END) payable_minor,
          SUM(CASE WHEN invoice_kind='purchase_invoice' AND document_status='POSTED' AND due_date < ? THEN outstanding_minor ELSE 0 END) overdue_minor,
          MAX(CASE WHEN invoice_kind='purchase_invoice' THEN purchase_date END) last_purchase,
          SUM(CASE WHEN invoice_kind='purchase_invoice' AND document_status='POSTED' THEN 1 ELSE 0 END) purchase_count
        FROM purchase_invoices WHERE organization_id=? AND financial_year_id=? AND deleted_at IS NULL GROUP BY supplier_id
      ), payment_metrics AS (
        SELECT party_id supplier_id, SUM(amount_minor) total_paid_minor FROM payments
        WHERE organization_id=? AND party_type='supplier' AND direction='out' AND reversed_at IS NULL AND deleted_at IS NULL GROUP BY party_id
      ) SELECT supplier.*, COALESCE(p.total_purchases_minor,0) total_purchases_minor, COALESCE(pay.total_paid_minor,0) total_paid_minor,
        MAX(0,CAST(ROUND(COALESCE(supplier.current_balance,0)*100) AS INTEGER)) current_payable_minor,
        COALESCE(p.overdue_minor,0) + MAX(0,CAST(ROUND(COALESCE(supplier.current_balance,0)*100) AS INTEGER)-COALESCE(p.payable_minor,0)) overdue_payable_minor,
        p.last_purchase, COALESCE(p.purchase_count,0) purchase_count
      FROM suppliers supplier LEFT JOIN purchase_metrics p ON p.supplier_id=supplier.id LEFT JOIN payment_metrics pay ON pay.supplier_id=supplier.id
      WHERE supplier.organization_id=? AND supplier.deleted_at IS NULL ${search ? "AND (supplier.name LIKE ? OR supplier.gstin LIKE ? OR supplier.phone LIKE ?)" : ""}`
    const countValues: SqlValue[] = [input.organizationId, ...(search ? [term, term, term] : [])]
    const rowValues: SqlValue[] = [to, input.organizationId, input.financialYearId, input.organizationId, input.organizationId, ...(search ? [term, term, term] : [])]
    const pagination = page(input)
    const [count] = await db.select<DataRow>(`SELECT COUNT(*) count FROM suppliers supplier WHERE supplier.organization_id=? AND supplier.deleted_at IS NULL ${search ? "AND (supplier.name LIKE ? OR supplier.gstin LIKE ? OR supplier.phone LIKE ?)" : ""}`, countValues)
    const rows = await db.select<DataRow>(query + " ORDER BY supplier.name COLLATE NOCASE LIMIT ? OFFSET ?", [...rowValues, pagination.limit, pagination.offset])
    return { report: input.report, year, from, to, rows, total: Number(count?.count || 0), page: pagination.page, limit: pagination.limit }
  }

  if (input.report === "payables-aging" || input.report === "receivables-aging") {
    const supplier = input.report === "payables-aging"
    const table = supplier ? "purchase_invoices" : "sales_invoices"
    const partyTable = supplier ? "suppliers" : "customers"
    const partyColumn = supplier ? "supplier_id" : "customer_id"
    const dateColumn = supplier ? "purchase_date" : "invoice_date"
    const extra = supplier ? "AND invoice_kind='purchase_invoice' AND document_status='POSTED'" : ""
    const invoiceRows = await db.select<DataRow>(`SELECT party.id party_id, party.name party_name,
        SUM(invoice.outstanding_minor) outstanding_minor,
        SUM(CASE WHEN COALESCE(invoice.due_date, invoice.${dateColumn}) < ? THEN invoice.outstanding_minor ELSE 0 END) overdue_minor,
        MIN(invoice.${dateColumn}) oldest_invoice,
        SUM(CASE WHEN julianday(?) - julianday(COALESCE(invoice.due_date, invoice.${dateColumn})) <= 0 THEN invoice.outstanding_minor ELSE 0 END) current_minor,
        SUM(CASE WHEN julianday(?) - julianday(COALESCE(invoice.due_date, invoice.${dateColumn})) BETWEEN 1 AND 30 THEN invoice.outstanding_minor ELSE 0 END) bucket_1_30_minor,
        SUM(CASE WHEN julianday(?) - julianday(COALESCE(invoice.due_date, invoice.${dateColumn})) BETWEEN 31 AND 60 THEN invoice.outstanding_minor ELSE 0 END) bucket_31_60_minor,
        SUM(CASE WHEN julianday(?) - julianday(COALESCE(invoice.due_date, invoice.${dateColumn})) BETWEEN 61 AND 90 THEN invoice.outstanding_minor ELSE 0 END) bucket_61_90_minor,
        SUM(CASE WHEN julianday(?) - julianday(COALESCE(invoice.due_date, invoice.${dateColumn})) > 90 THEN invoice.outstanding_minor ELSE 0 END) bucket_90_plus_minor
      FROM ${table} invoice JOIN ${partyTable} party ON party.id=invoice.${partyColumn} AND party.organization_id=invoice.organization_id
      WHERE invoice.organization_id=? AND invoice.financial_year_id=? AND invoice.${dateColumn} BETWEEN ? AND ?
        AND invoice.outstanding_minor>0 AND invoice.deleted_at IS NULL ${extra}
      GROUP BY party.id, party.name ORDER BY overdue_minor DESC, party.name`, [to, to, to, to, to, to, input.organizationId, input.financialYearId, from, to])
    const openingRows = (await openingSettlementDocuments(db, input.organizationId, input.financialYearId, supplier ? "supplier" : "customer"))
      .filter((row) => String(row.voucher_date) >= from && String(row.voucher_date) <= to)
    const byParty = new Map(invoiceRows.map((row) => [String(row.party_id), { ...row }]))
    for (const opening of openingRows) {
      const partyId = String(opening[partyColumn] || "")
      const amount = Number(opening.outstanding_minor || 0)
      const dueDate = String(opening.due_date || opening.voucher_date)
      const age = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000)
      const row = byParty.get(partyId) || {
        party_id: partyId,
        party_name: opening.party_name,
        outstanding_minor: 0,
        overdue_minor: 0,
        oldest_invoice: dueDate,
        current_minor: 0,
        bucket_1_30_minor: 0,
        bucket_31_60_minor: 0,
        bucket_61_90_minor: 0,
        bucket_90_plus_minor: 0,
      }
      row.outstanding_minor = Number(row.outstanding_minor || 0) + amount
      if (age > 0) row.overdue_minor = Number(row.overdue_minor || 0) + amount
      if (!row.oldest_invoice || dueDate < String(row.oldest_invoice)) row.oldest_invoice = dueDate
      const bucket = age <= 0 ? "current_minor" : age <= 30 ? "bucket_1_30_minor" : age <= 60 ? "bucket_31_60_minor" : age <= 90 ? "bucket_61_90_minor" : "bucket_90_plus_minor"
      row[bucket] = Number(row[bucket] || 0) + amount
      byParty.set(partyId, row)
    }
    const rows = [...byParty.values()].sort((left, right) => Number(right.overdue_minor || 0) - Number(left.overdue_minor || 0) || String(left.party_name).localeCompare(String(right.party_name)))
    return { report: input.report, year, from, to, rows, total: rows.length, page: 1, limit: rows.length || 1 }
  }

  if (input.report === "purchase-register" || input.report === "gst-purchase-register") {
    const where = "purchase.organization_id=? AND purchase.financial_year_id=? AND purchase.purchase_date BETWEEN ? AND ? AND purchase.document_status='POSTED' AND purchase.deleted_at IS NULL"
    const result = input.report === "gst-purchase-register"
      ? await paged(
          db,
          `SELECT COUNT(*) count FROM (
             SELECT purchase.id FROM purchase_invoices purchase WHERE ${where}
             UNION ALL
             SELECT expense.id FROM expenses expense WHERE expense.organization_id=? AND expense.financial_year_id=? AND expense.expense_date BETWEEN ? AND ? AND expense.reversed_at IS NULL AND expense.deleted_at IS NULL
           )`,
          `SELECT * FROM (
             SELECT purchase.id, purchase.supplier_invoice_number, purchase.bill_number, purchase.purchase_date,
               purchase.supplier_name, purchase.supplier_gstin gstin, purchase.place_of_supply state,
               purchase.transaction_type, purchase.invoice_kind, purchase.purchase_classification,
               purchase.taxable_minor, purchase.cgst_minor, purchase.sgst_minor, purchase.igst_minor,
               purchase.cess_minor, purchase.grand_total_minor, purchase.itc_status, purchase.status,
               purchase.created_at
             FROM purchase_invoices purchase WHERE ${where}
             UNION ALL
             SELECT expense.id, expense.supplier_invoice_number, expense.reference_no bill_number,
               expense.expense_date purchase_date, expense.vendor_name supplier_name, expense.party_gstin gstin,
               expense.place_of_supply state, 'B2B' transaction_type, 'expense' invoice_kind,
               'EXPENSE' purchase_classification, expense.taxable_minor, expense.cgst_minor,
               expense.sgst_minor, expense.igst_minor, expense.cess_minor,
               expense.amount_minor grand_total_minor, expense.itc_status, expense.payment_status status,
               expense.created_at
             FROM expenses expense WHERE expense.organization_id=? AND expense.financial_year_id=?
               AND expense.expense_date BETWEEN ? AND ? AND expense.reversed_at IS NULL AND expense.deleted_at IS NULL
           ) register ORDER BY purchase_date DESC, created_at DESC LIMIT ? OFFSET ?`,
          [...base, ...base], input
        )
      : await paged(db, `SELECT COUNT(*) count FROM purchase_invoices purchase WHERE ${where}`, `SELECT purchase.id, purchase.supplier_invoice_number, purchase.bill_number, purchase.purchase_date, purchase.supplier_name, purchase.supplier_gstin gstin, purchase.place_of_supply state, purchase.transaction_type, purchase.invoice_kind, purchase.taxable_minor, purchase.cgst_minor, purchase.sgst_minor, purchase.igst_minor, purchase.cess_minor, purchase.grand_total_minor, purchase.itc_status, purchase.status FROM purchase_invoices purchase WHERE ${where} ORDER BY purchase.purchase_date DESC, purchase.created_at DESC LIMIT ? OFFSET ?`, base, input)
    const [bySupplier, byProduct, byRate] = await Promise.all([
      db.select<DataRow>(`SELECT supplier_id, supplier_name, SUM(CASE WHEN invoice_kind='purchase_return' THEN -grand_total_minor ELSE grand_total_minor END) amount_minor, COUNT(*) document_count FROM purchase_invoices WHERE organization_id=? AND financial_year_id=? AND purchase_date BETWEEN ? AND ? AND document_status='POSTED' AND deleted_at IS NULL GROUP BY supplier_id, supplier_name ORDER BY amount_minor DESC LIMIT 100`, base),
      db.select<DataRow>(`SELECT item.product_id, item.product_name, SUM(CASE WHEN purchase.invoice_kind='purchase_return' THEN -item.quantity ELSE item.quantity END) quantity, SUM(CASE WHEN purchase.invoice_kind='purchase_return' THEN -item.taxable_minor ELSE item.taxable_minor END) taxable_minor FROM purchase_invoice_items item JOIN purchase_invoices purchase ON purchase.id=item.purchase_invoice_id WHERE purchase.organization_id=? AND purchase.financial_year_id=? AND purchase.purchase_date BETWEEN ? AND ? AND purchase.document_status='POSTED' AND item.deleted_at IS NULL GROUP BY item.product_id,item.product_name ORDER BY taxable_minor DESC LIMIT 100`, base),
      db.select<DataRow>(`SELECT item.gst_rate_basis_points, SUM(CASE WHEN purchase.invoice_kind='purchase_return' THEN -item.taxable_minor ELSE item.taxable_minor END) taxable_minor, SUM(CASE WHEN purchase.invoice_kind='purchase_return' THEN -(item.cgst_minor+item.sgst_minor+item.igst_minor+item.cess_minor) ELSE item.cgst_minor+item.sgst_minor+item.igst_minor+item.cess_minor END) tax_minor FROM purchase_invoice_items item JOIN purchase_invoices purchase ON purchase.id=item.purchase_invoice_id WHERE purchase.organization_id=? AND purchase.financial_year_id=? AND purchase.purchase_date BETWEEN ? AND ? AND purchase.document_status='POSTED' AND item.deleted_at IS NULL GROUP BY item.gst_rate_basis_points ORDER BY item.gst_rate_basis_points`, base),
    ])
    return { report: input.report, year, from, to, ...result, bySupplier, byProduct, byRate }
  }

  if (input.report === "supplier-payments" || input.report === "customer-receipts") {
    const partyType = input.report === "supplier-payments" ? "supplier" : "customer"
    const direction = partyType === "supplier" ? "out" : "in"
    const partyTable = partyType === "supplier" ? "suppliers" : "customers"
    const values = [...base, partyType, direction]
    const where = "payment.organization_id=? AND payment.financial_year_id=? AND payment.payment_date BETWEEN ? AND ? AND payment.party_type=? AND payment.direction=? AND payment.deleted_at IS NULL"
    return { report: input.report, year, from, to, ...(await paged(db, `SELECT COUNT(*) count FROM payments payment WHERE ${where}`, `SELECT payment.*, party.name party_name, COALESCE((SELECT SUM(allocation_minor) FROM payment_allocations allocation WHERE allocation.payment_id=payment.id AND allocation.reversed_at IS NULL),0) allocated_minor, (SELECT COUNT(*) FROM payment_allocations allocation WHERE allocation.payment_id=payment.id AND allocation.reversed_at IS NULL) allocation_count FROM payments payment LEFT JOIN ${partyTable} party ON party.id=payment.party_id WHERE ${where} ORDER BY payment.payment_date DESC,payment.created_at DESC LIMIT ? OFFSET ?`, values, input)) }
  }

  if (["cash-book", "bank-book"].includes(input.report)) {
    const cash = input.report === "cash-book"
    const accountFilter = input.accountId ? "AND account.id=?" : cash ? "AND account.system_role='CASH'" : "AND (account.system_role='BANK' OR EXISTS (SELECT 1 FROM bank_accounts bank WHERE bank.account_id=account.id AND bank.deleted_at IS NULL))"
    const values: SqlValue[] = [input.organizationId, input.financialYearId, from, to, ...(input.accountId ? [input.accountId] : [])]
    const pagination = page(input)
    const [count] = await db.select<DataRow>(`SELECT COUNT(*) count FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN chart_of_accounts account ON account.id=line.account_id WHERE voucher.organization_id=? AND voucher.financial_year_id=? AND voucher.voucher_date BETWEEN ? AND ? AND voucher.status='posted' ${accountFilter}`, values)
    const rows = await db.select<DataRow>(`WITH book AS (
        SELECT line.id, account.id account_id, account.account_name, voucher.voucher_date, voucher.voucher_number,
          voucher.voucher_type, voucher.reference_no, voucher.narration party, line.description,
          line.debit_minor, line.credit_minor, SUM(line.debit_minor-line.credit_minor) OVER (PARTITION BY account.id ORDER BY voucher.voucher_date,voucher.created_at,line.line_no,line.id) running_balance_minor
        FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id
        JOIN chart_of_accounts account ON account.id=line.account_id
        WHERE voucher.organization_id=? AND voucher.financial_year_id=? AND voucher.voucher_date BETWEEN ? AND ? AND voucher.status='posted' ${accountFilter}
      ) SELECT * FROM book ORDER BY voucher_date DESC,id DESC LIMIT ? OFFSET ?`, [...values, pagination.limit, pagination.offset])
    return { report: input.report, year, from, to, rows, total: Number(count?.count || 0), page: pagination.page, limit: pagination.limit }
  }

  if (input.report === "bank-accounts") {
    const rows = await db.select<DataRow>(`SELECT bank.id, bank.account_id, bank.display_name, bank.bank_name, bank.masked_identifier,
        bank.account_type, bank.branch_name, bank.ifsc_code, bank.opening_date, bank.is_active,
        COALESCE(SUM(CASE WHEN voucher.status='posted' THEN line.debit_minor-line.credit_minor ELSE 0 END),0) current_balance_minor
      FROM bank_accounts bank LEFT JOIN accounting_voucher_entries line ON line.account_id=bank.account_id
      LEFT JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id AND voucher.financial_year_id=?
      WHERE bank.organization_id=? AND bank.deleted_at IS NULL GROUP BY bank.id ORDER BY bank.display_name`, [input.financialYearId, input.organizationId])
    return { report: input.report, year, from, to, rows, total: rows.length, page: 1, limit: rows.length || 1 }
  }

  if (input.report === "bank-reconciliation") {
    const bankId = input.partyId || ""
    const values: SqlValue[] = [input.organizationId, input.financialYearId, from, to, ...(bankId ? [bankId] : [])]
    const filter = bankId ? "AND bank.id=?" : ""
    return { report: input.report, year, from, to, ...(await paged(db,
      `SELECT COUNT(*) count FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id JOIN bank_accounts bank ON bank.account_id=line.account_id WHERE voucher.organization_id=? AND voucher.financial_year_id=? AND voucher.voucher_date BETWEEN ? AND ? AND voucher.status='posted' ${filter}`,
      `SELECT line.id voucher_entry_id, bank.id bank_account_id, bank.display_name, voucher.voucher_date transaction_date,
        voucher.voucher_number voucher, COALESCE(line.description,voucher.narration) description, line.debit_minor,
        line.credit_minor, line.debit_minor-line.credit_minor book_amount_minor,
        COALESCE(reconciliation.status,'UNRECONCILED') reconciliation_status, reconciliation.cleared_date,
        reconciliation.bank_reference FROM accounting_voucher_entries line JOIN accounting_vouchers voucher ON voucher.id=line.voucher_id
        JOIN bank_accounts bank ON bank.account_id=line.account_id LEFT JOIN bank_reconciliations reconciliation
          ON reconciliation.voucher_entry_id=line.id AND reconciliation.bank_account_id=bank.id
        WHERE voucher.organization_id=? AND voucher.financial_year_id=? AND voucher.voucher_date BETWEEN ? AND ? AND voucher.status='posted' ${filter}
        ORDER BY voucher.voucher_date DESC,line.id DESC LIMIT ? OFFSET ?`, values, input)) }
  }

  if (input.report === "sales-register" || input.report === "gst-sales-register") {
    const where = "invoice.organization_id=? AND invoice.financial_year_id=? AND invoice.invoice_date BETWEEN ? AND ? AND invoice.deleted_at IS NULL AND invoice.invoice_type<>'proforma'"
    return { report: input.report, year, from, to, ...(await paged(db, `SELECT COUNT(*) count FROM sales_invoices invoice WHERE ${where}`, `SELECT invoice.id, COALESCE(invoice.display_invoice_number,invoice.invoice_number) invoice_number, invoice.invoice_date, invoice.customer_name customer, COALESCE(invoice.customer_gstin,customer.gst_number) gstin, COALESCE(invoice.place_of_supply,customer.state) state, COALESCE(invoice.transaction_type,CASE WHEN COALESCE(invoice.customer_gstin,customer.gst_number) IS NULL THEN 'B2C' ELSE 'B2B' END) transaction_type, invoice.taxable_minor, invoice.cgst_minor, invoice.sgst_minor, invoice.igst_minor, invoice.grand_total_minor, invoice.status FROM sales_invoices invoice LEFT JOIN customers customer ON customer.id=invoice.customer_id WHERE ${where} ORDER BY invoice.invoice_date DESC,invoice.created_at DESC LIMIT ? OFFSET ?`, base, input)) }
  }

  if (input.report === "credit-notes") {
    const where = "note.organization_id=? AND note.financial_year_id=? AND note.note_date BETWEEN ? AND ? AND note.deleted_at IS NULL"
    return { report: input.report, year, from, to, ...(await paged(db, `SELECT COUNT(*) count FROM credit_notes note WHERE ${where}`, `SELECT note.*, customer.name customer_name FROM credit_notes note LEFT JOIN customers customer ON customer.id=note.customer_id WHERE ${where} ORDER BY note.note_date DESC,note.created_at DESC LIMIT ? OFFSET ?`, base, input)) }
  }

  if (["gst-overview", "gstr-3b"].includes(input.report)) {
    const [sales, purchases, creditNotes, purchaseReturns, expenses] = await Promise.all([
      db.select<DataRow>("SELECT COALESCE(SUM(CASE WHEN tax_category='TAXABLE' OR tax_category IS NULL THEN taxable_minor ELSE 0 END),0) taxable_minor,COALESCE(SUM(cgst_minor),0) cgst_minor,COALESCE(SUM(sgst_minor),0) sgst_minor,COALESCE(SUM(igst_minor),0) igst_minor,COUNT(*) count,SUM(CASE WHEN transaction_type='B2B' THEN 1 ELSE 0 END) b2b_count,SUM(CASE WHEN transaction_type='B2C' OR transaction_type IS NULL THEN 1 ELSE 0 END) b2c_count FROM sales_invoices WHERE organization_id=? AND financial_year_id=? AND invoice_date BETWEEN ? AND ? AND deleted_at IS NULL AND invoice_type<>'proforma'", base),
      db.select<DataRow>("SELECT COALESCE(SUM(CASE WHEN tax_category='TAXABLE' THEN taxable_minor ELSE 0 END),0) taxable_minor,COALESCE(SUM(CASE WHEN itc_status='ELIGIBLE' THEN cgst_minor ELSE 0 END),0) eligible_cgst_minor,COALESCE(SUM(CASE WHEN itc_status='ELIGIBLE' THEN sgst_minor ELSE 0 END),0) eligible_sgst_minor,COALESCE(SUM(CASE WHEN itc_status='ELIGIBLE' THEN igst_minor ELSE 0 END),0) eligible_igst_minor,COALESCE(SUM(CASE WHEN reverse_charge=1 THEN cgst_minor ELSE 0 END),0) rcm_cgst_minor,COALESCE(SUM(CASE WHEN reverse_charge=1 THEN sgst_minor ELSE 0 END),0) rcm_sgst_minor,COALESCE(SUM(CASE WHEN reverse_charge=1 THEN igst_minor ELSE 0 END),0) rcm_igst_minor,COUNT(*) count,COALESCE(SUM(CASE WHEN reverse_charge=1 THEN grand_total_minor ELSE 0 END),0) reverse_charge_minor FROM purchase_invoices WHERE organization_id=? AND financial_year_id=? AND purchase_date BETWEEN ? AND ? AND invoice_kind='purchase_invoice' AND document_status='POSTED' AND deleted_at IS NULL", base),
      db.select<DataRow>("SELECT COALESCE(SUM(subtotal_minor),0) taxable_minor,COALESCE(SUM(cgst_minor),0) cgst_minor,COALESCE(SUM(sgst_minor),0) sgst_minor,COALESCE(SUM(igst_minor),0) igst_minor,COUNT(*) count FROM credit_notes WHERE organization_id=? AND financial_year_id=? AND note_date BETWEEN ? AND ? AND document_status='POSTED' AND deleted_at IS NULL", base),
      db.select<DataRow>("SELECT COALESCE(SUM(CASE WHEN tax_category='TAXABLE' THEN taxable_minor ELSE 0 END),0) taxable_minor,COALESCE(SUM(CASE WHEN itc_status='ELIGIBLE' THEN cgst_minor ELSE 0 END),0) eligible_cgst_minor,COALESCE(SUM(CASE WHEN itc_status='ELIGIBLE' THEN sgst_minor ELSE 0 END),0) eligible_sgst_minor,COALESCE(SUM(CASE WHEN itc_status='ELIGIBLE' THEN igst_minor ELSE 0 END),0) eligible_igst_minor,COUNT(*) count FROM purchase_invoices WHERE organization_id=? AND financial_year_id=? AND purchase_date BETWEEN ? AND ? AND invoice_kind='purchase_return' AND document_status='POSTED' AND deleted_at IS NULL", base),
      db.select<DataRow>("SELECT COALESCE(SUM(CASE WHEN tax_category='TAXABLE' THEN taxable_minor ELSE 0 END),0) taxable_minor,COALESCE(SUM(CASE WHEN itc_status='ELIGIBLE' THEN cgst_minor ELSE 0 END),0) eligible_cgst_minor,COALESCE(SUM(CASE WHEN itc_status='ELIGIBLE' THEN sgst_minor ELSE 0 END),0) eligible_sgst_minor,COALESCE(SUM(CASE WHEN itc_status='ELIGIBLE' THEN igst_minor ELSE 0 END),0) eligible_igst_minor,COALESCE(SUM(CASE WHEN reverse_charge=1 THEN cgst_minor ELSE 0 END),0) rcm_cgst_minor,COALESCE(SUM(CASE WHEN reverse_charge=1 THEN sgst_minor ELSE 0 END),0) rcm_sgst_minor,COALESCE(SUM(CASE WHEN reverse_charge=1 THEN igst_minor ELSE 0 END),0) rcm_igst_minor,COALESCE(SUM(CASE WHEN reverse_charge=1 THEN amount_minor ELSE 0 END),0) reverse_charge_minor,COUNT(*) count FROM expenses WHERE organization_id=? AND financial_year_id=? AND expense_date BETWEEN ? AND ? AND reversed_at IS NULL AND deleted_at IS NULL", base),
    ])
    const sale = sales[0] || {}; const purchase = purchases[0] || {}; const credit = creditNotes[0] || {}; const returned = purchaseReturns[0] || {}; const expense = expenses[0] || {}
    const outputCgstMinor = Number(sale.cgst_minor || 0) - Number(credit.cgst_minor || 0) + Number(purchase.rcm_cgst_minor || 0) + Number(expense.rcm_cgst_minor || 0)
    const outputSgstMinor = Number(sale.sgst_minor || 0) - Number(credit.sgst_minor || 0) + Number(purchase.rcm_sgst_minor || 0) + Number(expense.rcm_sgst_minor || 0)
    const outputIgstMinor = Number(sale.igst_minor || 0) - Number(credit.igst_minor || 0) + Number(purchase.rcm_igst_minor || 0) + Number(expense.rcm_igst_minor || 0)
    const inputCgstMinor = Number(purchase.eligible_cgst_minor || 0) - Number(returned.eligible_cgst_minor || 0) + Number(expense.eligible_cgst_minor || 0)
    const inputSgstMinor = Number(purchase.eligible_sgst_minor || 0) - Number(returned.eligible_sgst_minor || 0) + Number(expense.eligible_sgst_minor || 0)
    const inputIgstMinor = Number(purchase.eligible_igst_minor || 0) - Number(returned.eligible_igst_minor || 0) + Number(expense.eligible_igst_minor || 0)
    return { report: input.report, year, from, to, taxableOutwardMinor: Number(sale.taxable_minor || 0) - Number(credit.taxable_minor || 0), outputCgstMinor, outputSgstMinor, outputIgstMinor, taxablePurchasesMinor: Number(purchase.taxable_minor || 0) - Number(returned.taxable_minor || 0) + Number(expense.taxable_minor || 0), inputCgstMinor, inputSgstMinor, inputIgstMinor, netGstMinor: outputCgstMinor + outputSgstMinor + outputIgstMinor - inputCgstMinor - inputSgstMinor - inputIgstMinor, b2bSales: Number(sale.b2b_count || 0), b2cSales: Number(sale.b2c_count || 0), purchaseInvoices: Number(purchase.count || 0), expensePurchases: Number(expense.count || 0), creditNotes: Number(credit.count || 0), debitNotes: Number(returned.count || 0), reverseChargeMinor: Number(purchase.reverse_charge_minor || 0) + Number(expense.reverse_charge_minor || 0), label: "GST Return Preparation" }
  }

  if (input.report === "gstr-1") {
    const b2b = await db.select<DataRow>("SELECT COALESCE(customer_gstin,customer.gst_number) gstin,COUNT(*) invoice_count,SUM(invoice.taxable_minor) taxable_minor,SUM(invoice.cgst_minor) cgst_minor,SUM(invoice.sgst_minor) sgst_minor,SUM(invoice.igst_minor) igst_minor FROM sales_invoices invoice LEFT JOIN customers customer ON customer.id=invoice.customer_id WHERE invoice.organization_id=? AND invoice.financial_year_id=? AND invoice.invoice_date BETWEEN ? AND ? AND invoice.deleted_at IS NULL AND COALESCE(invoice.customer_gstin,customer.gst_number) IS NOT NULL GROUP BY COALESCE(invoice.customer_gstin,customer.gst_number)", base)
    const b2c = await db.select<DataRow>("SELECT COALESCE(place_of_supply,customer.state,'Unclassified') place_of_supply,COUNT(*) invoice_count,SUM(invoice.taxable_minor) taxable_minor,SUM(invoice.cgst_minor) cgst_minor,SUM(invoice.sgst_minor) sgst_minor,SUM(invoice.igst_minor) igst_minor FROM sales_invoices invoice LEFT JOIN customers customer ON customer.id=invoice.customer_id WHERE invoice.organization_id=? AND invoice.financial_year_id=? AND invoice.invoice_date BETWEEN ? AND ? AND invoice.deleted_at IS NULL AND COALESCE(invoice.customer_gstin,customer.gst_number) IS NULL GROUP BY COALESCE(place_of_supply,customer.state,'Unclassified')", base)
    const notes = await db.select<DataRow>("SELECT note_number,note_date,subtotal_minor taxable_minor,cgst_minor,sgst_minor,igst_minor,grand_total_minor FROM credit_notes WHERE organization_id=? AND financial_year_id=? AND note_date BETWEEN ? AND ? AND document_status='POSTED' AND deleted_at IS NULL ORDER BY note_date", base)
    const rates = await db.select<DataRow>("SELECT gst_rate_basis_points,SUM(taxable_minor) taxable_minor,SUM(cgst_minor) cgst_minor,SUM(sgst_minor) sgst_minor,SUM(igst_minor) igst_minor FROM sales_invoice_items item JOIN sales_invoices invoice ON invoice.id=item.invoice_id WHERE invoice.organization_id=? AND invoice.financial_year_id=? AND invoice.invoice_date BETWEEN ? AND ? AND invoice.deleted_at IS NULL AND item.deleted_at IS NULL GROUP BY gst_rate_basis_points ORDER BY gst_rate_basis_points", base)
    return { report: input.report, year, from, to, label: "GST Return Preparation", directlyUploadable: false, sections: { b2b, b2c, creditDebitNotes: notes, taxRateSummary: rates }, rows: b2b, total: b2b.length, page: 1, limit: b2b.length || 1 }
  }

  if (input.report === "hsn-summary") {
    const rows = await db.select<DataRow>(`SELECT source,hsn_code,description,gst_rate_basis_points,SUM(quantity) quantity,SUM(taxable_minor) taxable_minor,SUM(cgst_minor) cgst_minor,SUM(sgst_minor) sgst_minor,SUM(igst_minor) igst_minor,SUM(total_minor) total_minor FROM (
        SELECT 'SALE' source,COALESCE(item.hsn_code,'MISSING') hsn_code,COALESCE(item.description,item.product_name) description,item.gst_rate_basis_points,item.quantity,item.taxable_minor,item.cgst_minor,item.sgst_minor,item.igst_minor,item.taxable_minor+item.cgst_minor+item.sgst_minor+item.igst_minor total_minor FROM sales_invoice_items item JOIN sales_invoices invoice ON invoice.id=item.invoice_id WHERE invoice.organization_id=? AND invoice.financial_year_id=? AND invoice.invoice_date BETWEEN ? AND ? AND invoice.deleted_at IS NULL AND item.deleted_at IS NULL
        UNION ALL SELECT CASE WHEN purchase.invoice_kind='purchase_return' THEN 'PURCHASE_RETURN' ELSE 'PURCHASE' END,COALESCE(item.hsn_code,'MISSING'),COALESCE(item.description,item.product_name),item.gst_rate_basis_points,CASE WHEN purchase.invoice_kind='purchase_return' THEN -item.quantity ELSE item.quantity END,CASE WHEN purchase.invoice_kind='purchase_return' THEN -item.taxable_minor ELSE item.taxable_minor END,CASE WHEN purchase.invoice_kind='purchase_return' THEN -item.cgst_minor ELSE item.cgst_minor END,CASE WHEN purchase.invoice_kind='purchase_return' THEN -item.sgst_minor ELSE item.sgst_minor END,CASE WHEN purchase.invoice_kind='purchase_return' THEN -item.igst_minor ELSE item.igst_minor END,CASE WHEN purchase.invoice_kind='purchase_return' THEN -item.line_total_minor ELSE item.line_total_minor END FROM purchase_invoice_items item JOIN purchase_invoices purchase ON purchase.id=item.purchase_invoice_id WHERE purchase.organization_id=? AND purchase.financial_year_id=? AND purchase.purchase_date BETWEEN ? AND ? AND purchase.document_status='POSTED' AND item.deleted_at IS NULL
        UNION ALL SELECT 'EXPENSE',COALESCE(hsn_code,'MISSING'),description,gst_rate_basis_points,1,taxable_minor,cgst_minor,sgst_minor,igst_minor,amount_minor FROM expenses WHERE organization_id=? AND financial_year_id=? AND expense_date BETWEEN ? AND ? AND reversed_at IS NULL AND deleted_at IS NULL
      ) GROUP BY source,hsn_code,description,gst_rate_basis_points ORDER BY hsn_code,source`, [...base, ...base, ...base])
    return { report: input.report, year, from, to, rows, total: rows.length, page: 1, limit: rows.length || 1 }
  }

  if (input.report === "gst-validation") {
    const [purchases, sales, expenses, purchaseLines, salesLines, duplicatePurchases] = await Promise.all([
      db.select<DataRow>("SELECT id,supplier_invoice_number source_number,purchase_date source_date,supplier_gstin gstin,place_of_supply state,supply_type,transaction_type,tax_category,cgst_minor,sgst_minor,igst_minor,taxable_minor,grand_total_minor,CASE WHEN invoice_kind='purchase_return' THEN 'PURCHASE_RETURN' ELSE 'PURCHASE' END source_type FROM purchase_invoices WHERE organization_id=? AND financial_year_id=? AND purchase_date BETWEEN ? AND ? AND document_status='POSTED' AND deleted_at IS NULL", base),
      db.select<DataRow>("SELECT invoice.id,COALESCE(display_invoice_number,invoice_number) source_number,invoice_date source_date,COALESCE(customer_gstin,customer.gst_number) gstin,COALESCE(place_of_supply,customer.state) state,supply_type,transaction_type,tax_category,cgst_minor,sgst_minor,igst_minor,taxable_minor,grand_total_minor,'SALE' source_type FROM sales_invoices invoice LEFT JOIN customers customer ON customer.id=invoice.customer_id WHERE invoice.organization_id=? AND invoice.financial_year_id=? AND invoice.invoice_date BETWEEN ? AND ? AND invoice.deleted_at IS NULL", base),
      db.select<DataRow>("SELECT id,COALESCE(supplier_invoice_number,reference_no) source_number,expense_date source_date,party_gstin gstin,place_of_supply state,supply_type,'B2B' transaction_type,tax_category,cgst_minor,sgst_minor,igst_minor,taxable_minor,amount_minor grand_total_minor,'EXPENSE' source_type,hsn_code,gst_rate_basis_points FROM expenses WHERE organization_id=? AND financial_year_id=? AND expense_date BETWEEN ? AND ? AND reversed_at IS NULL AND deleted_at IS NULL", base),
      db.select<DataRow>("SELECT item.id,item.purchase_invoice_id source_id,item.hsn_code,item.gst_rate_basis_points,item.taxable_minor,item.cgst_minor,item.sgst_minor,item.igst_minor FROM purchase_invoice_items item JOIN purchase_invoices purchase ON purchase.id=item.purchase_invoice_id WHERE purchase.organization_id=? AND purchase.financial_year_id=? AND purchase.purchase_date BETWEEN ? AND ? AND purchase.document_status='POSTED' AND item.deleted_at IS NULL", base),
      db.select<DataRow>("SELECT item.id,item.invoice_id source_id,item.hsn_code,item.gst_rate_basis_points,item.taxable_minor,item.cgst_minor,item.sgst_minor,item.igst_minor FROM sales_invoice_items item JOIN sales_invoices invoice ON invoice.id=item.invoice_id WHERE invoice.organization_id=? AND invoice.financial_year_id=? AND invoice.invoice_date BETWEEN ? AND ? AND invoice.deleted_at IS NULL AND item.deleted_at IS NULL", base),
      db.select<DataRow>(`SELECT supplier_id,supplier_invoice_number,COUNT(*) duplicate_count,MIN(id) source_id
        FROM purchase_invoices WHERE organization_id=? AND financial_year_id=? AND purchase_date BETWEEN ? AND ?
          AND invoice_kind='purchase_invoice' AND document_status<>'CANCELLED' AND deleted_at IS NULL
          AND supplier_invoice_number IS NOT NULL
        GROUP BY supplier_id,lower(trim(supplier_invoice_number)) HAVING COUNT(*)>1`, base),
    ])
    const warnings: DataRow[] = []
    for (const row of [...purchases, ...sales, ...expenses]) {
      const gstin = localString(row.gstin)
      if (gstin && !validateGstinFormat(gstin).valid) warnings.push({ id: `${row.source_type}:${row.id}:gstin`, source_type: row.source_type, source_id: row.id, source_number: row.source_number, warning: validateGstinFormat(gstin).reason })
      if (!gstin && row.transaction_type === "B2B") warnings.push({ id: `${row.source_type}:${row.id}:missing-gstin`, source_type: row.source_type, source_id: row.id, source_number: row.source_number, warning: "B2B/GST transaction is missing the party GSTIN." })
      if (!row.state) warnings.push({ id: `${row.source_type}:${row.id}:state`, source_type: row.source_type, source_id: row.id, source_number: row.source_number, warning: "Missing place of supply/state." })
      if (!row.supply_type || !["INTRA_STATE", "INTER_STATE"].includes(String(row.supply_type))) warnings.push({ id: `${row.source_type}:${row.id}:classification`, source_type: row.source_type, source_id: row.id, source_number: row.source_number, warning: "GST supply classification is missing or invalid." })
      if (row.supply_type === "INTER_STATE" && (Number(row.cgst_minor || 0) || Number(row.sgst_minor || 0))) warnings.push({ id: `${row.source_type}:${row.id}:interstate`, source_type: row.source_type, source_id: row.id, source_number: row.source_number, warning: "Interstate transaction contains CGST/SGST." })
      if (row.supply_type === "INTRA_STATE" && Number(row.igst_minor || 0)) warnings.push({ id: `${row.source_type}:${row.id}:intrastate`, source_type: row.source_type, source_id: row.id, source_number: row.source_number, warning: "Intrastate transaction contains IGST." })
    }
    for (const duplicate of duplicatePurchases) warnings.push({ id: `PURCHASE:${duplicate.source_id}:duplicate`, source_type: "PURCHASE", source_id: duplicate.source_id, source_number: duplicate.supplier_invoice_number, warning: `Duplicate supplier invoice reference (${Number(duplicate.duplicate_count || 0)} records).` })
    const validationLines: DataRow[] = [
      ...purchaseLines.map((item) => ({ ...item, source_type: "PURCHASE" })),
      ...salesLines.map((item) => ({ ...item, source_type: "SALE" })),
      ...expenses.map((item) => ({ ...item, source_id: item.id, source_type: "EXPENSE" })),
    ]
    for (const row of validationLines) {
      if (!row.hsn_code) warnings.push({ id: `${row.source_type}:${row.id}:hsn`, source_type: row.source_type, source_id: row.source_id, warning: "Missing HSN/SAC." })
      const expected = Math.round(Number(row.taxable_minor || 0) * Number(row.gst_rate_basis_points || 0) / 10_000)
      const actual = Number(row.cgst_minor || 0) + Number(row.sgst_minor || 0) + Number(row.igst_minor || 0)
      if (Math.abs(expected - actual) > 1) warnings.push({ id: `${row.source_type}:${row.id}:tax`, source_type: row.source_type, source_id: row.source_id, warning: "Tax amount does not match taxable value and GST rate." })
    }
    const pagination = page(input)
    return { report: input.report, year, from, to, rows: warnings.slice(pagination.offset, pagination.offset + pagination.limit), total: warnings.length, page: pagination.page, limit: pagination.limit }
  }

  if (input.report === "period-locking") {
    const rows = await db.select<DataRow>("SELECT * FROM accounting_period_locks WHERE organization_id=? ORDER BY created_at DESC", [input.organizationId])
    return { report: input.report, year, from, to, rows, activeLock: rows.find((row) => !row.unlocked_at) || null, total: rows.length, page: 1, limit: rows.length || 1 }
  }

  throw new Error("Unknown Phase 2 accounting report.")
}
