import assert from "node:assert/strict"
import type { AccountingAccount } from "../lib/accounting/journal"
import {
  budgetVariance,
  buildAssetDisposalJournal,
  buildDepreciationJournal,
  buildTcsJournal,
  buildTdsJournal,
  calculateDepreciation,
  classifyGstReconciliation,
  formatVoucherNumber,
  schedulePeriods,
  taxAmountMinor,
  validateDimensionAllocations,
  validateEInvoicePreparation,
  validateEwayBillPreparation,
} from "../lib/accounting/phase3"

const types: Record<string, string> = {
  FIXED_ASSETS: "ASSET", ACCUMULATED_DEPRECIATION: "ASSET", DEPRECIATION_EXPENSE: "EXPENSE",
  CASH: "ASSET", ASSET_DISPOSAL_GAIN: "INCOME", ASSET_DISPOSAL_LOSS: "EXPENSE",
  ACCOUNTS_PAYABLE: "LIABILITY", TDS_PAYABLE: "LIABILITY", PROFESSIONAL_FEES: "EXPENSE",
  ACCOUNTS_RECEIVABLE: "ASSET", TCS_PAYABLE: "LIABILITY",
}
const account = (role: string): AccountingAccount => ({ id: `account:${role}`, accountCode: role, accountName: role, accountType: types[role], systemRole: role })
const draft = { id: "voucher:phase3", organizationId: "org:phase3", financialYearId: "fy:phase3", voucherNumber: "VCH/26-27/000001", voucherType: "adjustment", voucherDate: "2026-09-06", sourceType: "PHASE3_TEST", sourceId: "source:phase3", narration: "Phase 3 exact posting", systemGenerated: true }

assert.equal(formatVoucherNumber({ prefix: "INV", financialYearLabel: "FY 2026-27", nextNumber: 1, padding: 6 }), "INV/26-27/000001")
assert.equal(formatVoucherNumber({ prefix: "PAY/DOM", suffix: "A", financialYearLabel: "2026–2027", nextNumber: 42, padding: 4 }), "PAY/DOM/26-27/0042/A")
assert.throws(() => formatVoucherNumber({ prefix: "BAD PREFIX", nextNumber: 1 }), /unsupported/)
assert.equal(taxAmountMinor(123_45, 1_000), 1_235)

assert.equal(validateDimensionAllocations({ lineMinor: 50_000_00, dimensions: [{ type: "COST_CENTRE", allocations: [{ dimensionId: "digital", amountMinor: 30_000_00 }, { dimensionId: "offline", amountMinor: 20_000_00 }] }] }), true)
assert.throws(() => validateDimensionAllocations({ lineMinor: 50_000_00, dimensions: [{ type: "PROJECT", allocations: [{ dimensionId: "p1", amountMinor: 49_999_99 }] }] }), /exactly/)

const slm = calculateDepreciation({ originalCostMinor: 120_000_00, residualValueMinor: 0, accumulatedBeforeMinor: 0, method: "SLM", annualRateBasisPoints: 1_000, usefulLifeMonths: 120, capitalizationDate: "2026-01-15", periodStart: "2026-01-01", periodEnd: "2026-01-31" })
assert.equal(slm.days, 17)
assert.equal(slm.amountMinor, 55_890)
assert.equal(slm.closingWrittenDownValueMinor, 119_441_10)
const wdv = calculateDepreciation({ originalCostMinor: 100_000_00, residualValueMinor: 5_000_00, accumulatedBeforeMinor: 20_000_00, method: "WDV", annualRateBasisPoints: 2_000, usefulLifeMonths: 60, capitalizationDate: "2024-04-01", periodStart: "2026-04-01", periodEnd: "2026-04-30" })
assert.equal(wdv.amountMinor, 131_507)
assert.deepEqual(schedulePeriods("2024-02-28", "2024-04-01").map((period) => period.to), ["2024-02-29", "2024-03-31", "2024-04-01"])
assert.throws(() => calculateDepreciation({ originalCostMinor: 1, residualValueMinor: 2, accumulatedBeforeMinor: 0, method: "SLM", annualRateBasisPoints: 0, usefulLifeMonths: 12, capitalizationDate: "2026-03-31", periodStart: "2026-04-01", periodEnd: "2026-04-31" }), /Residual value|valid/)
assert.throws(() => calculateDepreciation({ originalCostMinor: 100, residualValueMinor: 0, accumulatedBeforeMinor: 0, method: "SLM", annualRateBasisPoints: 1_000, usefulLifeMonths: 12, capitalizationDate: "2026-03-31", periodStart: "2026-04-01", periodEnd: "2026-04-31" }), /valid/)

const depreciation = buildDepreciationJournal({ ...draft, amountMinor: slm.amountMinor, depreciationExpenseAccount: account("DEPRECIATION_EXPENSE"), accumulatedDepreciationAccount: account("ACCUMULATED_DEPRECIATION") })
assert.equal(depreciation.totalDebitMinor, depreciation.totalCreditMinor)
const disposal = buildAssetDisposalJournal({ ...draft, id: "voucher:disposal", sourceId: "asset:1", originalCostMinor: 100_000_00, accumulatedDepreciationMinor: 25_000_00, proceedsMinor: 80_000_00, assetAccount: account("FIXED_ASSETS"), accumulatedDepreciationAccount: account("ACCUMULATED_DEPRECIATION"), settlementAccount: account("CASH"), gainAccount: account("ASSET_DISPOSAL_GAIN"), lossAccount: account("ASSET_DISPOSAL_LOSS") })
assert.equal(disposal.gainMinor, 5_000_00)
assert.equal(disposal.lossMinor, 0)
assert.equal(disposal.journal.totalDebitMinor, disposal.journal.totalCreditMinor)

const tds = buildTdsJournal({ ...draft, id: "voucher:tds", sourceId: "tds:1", mode: "EXPENSE_ACCRUAL", taxableMinor: 100_000_00, rateBasisPoints: 1_000, supplierId: "supplier:1", expenseAccount: account("PROFESSIONAL_FEES"), accountsPayableAccount: account("ACCOUNTS_PAYABLE"), tdsPayableAccount: account("TDS_PAYABLE") })
assert.equal(tds.tdsMinor, 10_000_00)
assert.equal(tds.netPartyMinor, 90_000_00)
assert.equal(tds.journal.totalDebitMinor, tds.journal.totalCreditMinor)
const paymentTds = buildTdsJournal({ ...draft, id: "voucher:tds-payment", sourceId: "tds:2", mode: "PAYMENT_DEDUCTION", taxableMinor: 50_000_00, rateBasisPoints: 200, supplierId: "supplier:1", expenseAccount: account("PROFESSIONAL_FEES"), accountsPayableAccount: account("ACCOUNTS_PAYABLE"), tdsPayableAccount: account("TDS_PAYABLE"), settlementAccount: account("CASH") })
assert.equal(paymentTds.tdsMinor, 1_000_00)
const tcs = buildTcsJournal({ ...draft, id: "voucher:tcs", sourceId: "tcs:1", taxableMinor: 200_000_00, rateBasisPoints: 10, customerId: "customer:1", receivableAccount: account("ACCOUNTS_RECEIVABLE"), tcsPayableAccount: account("TCS_PAYABLE") })
assert.equal(tcs.tcsMinor, 200_00)
assert.equal(tcs.journal.totalDebitMinor, tcs.journal.totalCreditMinor)

const book = { id: "book", gstin: "27AAPFU0939F1ZV", invoiceNumber: "SUP/2026-001", invoiceDate: "2026-09-06", taxableMinor: 100_00, cgstMinor: 9_00, sgstMinor: 9_00, igstMinor: 0 }
assert.equal(classifyGstReconciliation(book, { ...book, id: "import", invoiceNumber: "SUP 2026 001" }).classification, "EXACT_MATCH")
assert.equal(classifyGstReconciliation(book, { ...book, id: "import", taxableMinor: 101_00 }).classification, "VALUE_MISMATCH")
assert.equal(classifyGstReconciliation(null, { ...book, id: "import" }).classification, "MISSING_IN_BOOKS")

const einvoice = validateEInvoicePreparation({ supplier_gstin: "27AAPFU0939F1ZV", recipient_gstin: "27AAPFU0939F1ZV", document_number: "INV-1", document_date: "2026-09-06", document_type: "INV", place_of_supply: "27", lines: [{ hsn: "8471", quantity: 1, unit: "NOS", taxable_minor: 100_00, cgst_minor: 9_00, sgst_minor: 9_00, igst_minor: 0 }] })
assert.equal(einvoice.valid, true)
assert.equal(einvoice.integrationStatus, "NOT_CONFIGURED")
assert.equal(validateEInvoicePreparation({}).valid, false)
assert.equal(validateEwayBillPreparation({ document_reference: "INV-1", transaction_type: "OUTWARD", transport_mode: "ROAD", vehicle_number: "MH12AB1234", distance_km: 120, origin: "Pune", destination: "Mumbai" }).valid, true)
assert.equal(validateEwayBillPreparation({ transport_mode: "ROAD", distance_km: 0 }).valid, false)
assert.deepEqual(budgetVariance(100_000, 120_000), { budgetMinor: 100_000, actualMinor: 120_000, varianceMinor: -20_000, varianceBasisPoints: -2_000 })
assert.equal(budgetVariance(0, 10).varianceBasisPoints, null)

for (let index = 1; index <= 250; index += 1) {
  const taxableMinor = ((index * 7_919) % 90_000_000) + 10_000
  const rateBasisPoints = ((index * 137) % 10_000) + 1
  const expectedTax = taxAmountMinor(taxableMinor, rateBasisPoints)
  assert.ok(Number.isSafeInteger(expectedTax) && expectedTax >= 0)
  const invariantTds = buildTdsJournal({ ...draft, id: `property:tds:${index}`, sourceId: `property:tds:${index}`, mode: "EXPENSE_ACCRUAL", taxableMinor, rateBasisPoints, supplierId: "supplier:1", expenseAccount: account("PROFESSIONAL_FEES"), accountsPayableAccount: account("ACCOUNTS_PAYABLE"), tdsPayableAccount: account("TDS_PAYABLE") })
  const invariantTcs = buildTcsJournal({ ...draft, id: `property:tcs:${index}`, sourceId: `property:tcs:${index}`, taxableMinor, rateBasisPoints, customerId: "customer:1", receivableAccount: account("ACCOUNTS_RECEIVABLE"), tcsPayableAccount: account("TCS_PAYABLE") })
  assert.equal(invariantTds.journal.totalDebitMinor, invariantTds.journal.totalCreditMinor)
  assert.equal(invariantTcs.journal.totalDebitMinor, invariantTcs.journal.totalCreditMinor)
  assert.equal(invariantTds.tdsMinor, expectedTax)
  assert.equal(invariantTcs.tcsMinor, expectedTax)
  assert.equal(JSON.stringify([invariantTds, invariantTcs]).includes("NaN"), false)
  assert.equal(JSON.stringify([invariantTds, invariantTcs]).includes("Infinity"), false)
}

console.log(JSON.stringify({ status: "ok", exactMinorUnits: true, voucherSeries: true, dimensions: true, depreciation: { slmMinor: slm.amountMinor, wdvMinor: wdv.amountMinor }, assetDisposal: true, tds: true, tcs: true, gstReconciliation: true, statutoryPreflight: true, dateBoundaries: true, budgets: true, invariantCases: 250 }))
