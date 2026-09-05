import assert from "node:assert/strict"
import { buildExpenseJournal, type AccountingAccount } from "../lib/accounting/journal"
import {
  buildAdvanceApplicationJournal,
  buildPartySettlementJournal,
  buildPurchaseJournal,
  normalizePurchaseLines,
  purchaseTotals,
  validateGstinFormat,
} from "../lib/accounting/phase2"

const types: Record<string, AccountingAccount["accountType"]> = {
  INVENTORY: "ASSET", PURCHASES: "EXPENSE", FIXED_ASSETS: "ASSET", OTHER_CURRENT_ASSETS: "ASSET",
  FREIGHT_EXPENSE: "EXPENSE", INPUT_CGST: "ASSET", INPUT_SGST: "ASSET", INPUT_IGST: "ASSET", INPUT_CESS: "ASSET",
  OUTPUT_CGST: "LIABILITY", OUTPUT_SGST: "LIABILITY", OUTPUT_IGST: "LIABILITY", OUTPUT_CESS: "LIABILITY",
  ACCOUNTS_PAYABLE: "LIABILITY", ACCOUNTS_RECEIVABLE: "ASSET", SUPPLIER_ADVANCES: "ASSET",
  CUSTOMER_ADVANCES: "LIABILITY", ROUND_OFF: "EXPENSE", CASH: "ASSET", RENT_EXPENSE: "EXPENSE",
}
const account = (role: string): AccountingAccount => ({ id: `account:${role}`, accountCode: role, accountName: role.replaceAll("_", " "), accountType: types[role] || "ASSET", systemRole: role as AccountingAccount["systemRole"] })
const accounts = new Map(Object.keys(types).map((role) => [role, account(role)]))
const draft = { id: "voucher:phase2", organizationId: "org:phase2", financialYearId: "fy:phase2", voucherNumber: "PUR-1", voucherType: "purchase" as const, voucherDate: "2026-09-05", sourceType: "PURCHASE_INVOICE", sourceId: "purchase:1", referenceNo: "SUP-1", narration: "Exact purchase", systemGenerated: true }

const intra = normalizePurchaseLines([{ productId: "product:1", quantity: "3", unitCost: "33.33", discountPercent: "2.5", gstRate: "18", cess: "0", classification: "INVENTORY" }], "INTRA_STATE")
assert.equal(intra[0].grossMinor, 9999)
assert.equal(intra[0].discountMinor, 250)
assert.equal(intra[0].taxableMinor, 9749)
assert.equal(intra[0].cgstMinor, 877)
assert.equal(intra[0].sgstMinor, 878)
assert.equal(intra[0].igstMinor, 0)
assert.equal(intra[0].lineTotalMinor, 11504)

const totals = purchaseTotals(intra, "10.01", "-0.05")
assert.equal(totals.grandTotalMinor, 12500)
assert.equal(totals.settlementTotalMinor, 12500)
const posting = buildPurchaseJournal({ ...draft, accounts, supplierId: "supplier:1", lines: intra, totals, paidMinor: 2500, paymentAccount: account("CASH") })
assert.equal(posting.outstandingMinor, 10000)
assert.equal(posting.journal.totalDebitMinor, 12505)
assert.equal(posting.journal.totalCreditMinor, 12505)

const interstate = normalizePurchaseLines([{ quantity: "1", unitCost: "118", gstRate: "18", taxableValue: "118", igst: "21.24", classification: "EXPENSE" }], "INTER_STATE")
assert.equal(interstate[0].igstMinor, 2124)
assert.throws(() => normalizePurchaseLines([{ quantity: 1, unitCost: 100, gstRate: 18, cgst: 9, sgst: 8 }], "INTRA_STATE"), /do not match/)
assert.throws(() => normalizePurchaseLines([{ quantity: 1, unitCost: 100, gstRate: 18, cgst: 9, sgst: 9 }], "INTER_STATE"), /cannot contain/)
assert.throws(() => normalizePurchaseLines([{ quantity: 1, unitCost: 100, gstRate: 18, cgst: 9, sgst: 9 }], "INTRA_STATE", "EXEMPT"), /Non-taxable/)

const rcmTotals = purchaseTotals(intra, 0, 0, true)
const rcm = buildPurchaseJournal({ ...draft, id: "voucher:rcm", sourceId: "purchase:rcm", accounts, supplierId: "supplier:1", lines: intra, totals: rcmTotals, paidMinor: 0, reverseCharge: true })
assert.equal(rcm.journal.totalDebitMinor, rcm.journal.totalCreditMinor)
assert.equal(rcmTotals.settlementTotalMinor, intra[0].taxableMinor)
const rcmReturn = buildPurchaseJournal({ ...draft, id: "voucher:rcm-return", sourceId: "purchase-return:rcm", voucherType: "debit_note", accounts, supplierId: "supplier:1", lines: intra, totals: rcmTotals, paidMinor: 0, reverseCharge: true, isReturn: true, payableReductionMinor: rcmTotals.settlementTotalMinor })
assert.equal(rcmReturn.journal.totalDebitMinor, rcmReturn.journal.totalCreditMinor)
assert.equal(rcmReturn.supplierReceivableMinor, 0)

const supplierPayment = buildPartySettlementJournal({ ...draft, id: "voucher:payment", sourceId: "payment:1", voucherType: "payment", accounts, partyType: "supplier", partyId: "supplier:1", direction: "out", paymentAccount: account("CASH"), amountMinor: 15000, allocatedMinor: 10000 })
assert.equal(supplierPayment.advanceMinor, 5000)
assert.equal(supplierPayment.journal.totalDebitMinor, 15000)
const customerReceipt = buildPartySettlementJournal({ ...draft, id: "voucher:receipt", sourceId: "receipt:1", voucherType: "receipt", accounts, partyType: "customer", partyId: "customer:1", direction: "in", paymentAccount: account("CASH"), amountMinor: 12000, allocatedMinor: 9000 })
assert.equal(customerReceipt.advanceMinor, 3000)
assert.equal(customerReceipt.journal.totalDebitMinor, customerReceipt.journal.totalCreditMinor)

const supplierAdvance = buildAdvanceApplicationJournal({ ...draft, id: "voucher:advance", sourceId: "advance:1", voucherType: "journal", accounts, partyType: "supplier", partyId: "supplier:1", amountMinor: 1234 })
assert.equal(supplierAdvance.totalDebitMinor, supplierAdvance.totalCreditMinor)

const expenseEligible = buildExpenseJournal({ ...draft, id: "voucher:expense", sourceId: "expense:1", voucherType: "expense", expenseAccount: account("RENT_EXPENSE"), paymentAccount: account("CASH"), inputCgstAccount: account("INPUT_CGST"), inputSgstAccount: account("INPUT_SGST"), inputIgstAccount: account("INPUT_IGST"), inputCessAccount: account("INPUT_CESS"), amountMinor: 11800, cgstMinor: 900, sgstMinor: 900, igstMinor: 0, cessMinor: 0, itcEligible: true })
assert.equal(expenseEligible.taxableMinor, 10000)
assert.equal(expenseEligible.journal.totalDebitMinor, 11800)
const expenseIneligibleRcm = buildExpenseJournal({ ...draft, id: "voucher:expense-rcm", sourceId: "expense:rcm", voucherType: "expense", expenseAccount: account("RENT_EXPENSE"), paymentAccount: account("ACCOUNTS_PAYABLE"), inputCgstAccount: account("INPUT_CGST"), inputSgstAccount: account("INPUT_SGST"), inputIgstAccount: account("INPUT_IGST"), outputCgstAccount: account("OUTPUT_CGST"), outputSgstAccount: account("OUTPUT_SGST"), outputIgstAccount: account("OUTPUT_IGST"), amountMinor: 11800, cgstMinor: 900, sgstMinor: 900, igstMinor: 0, reverseCharge: true, itcEligible: false })
assert.equal(expenseIneligibleRcm.settlementMinor, 10000)
assert.equal(expenseIneligibleRcm.journal.totalDebitMinor, expenseIneligibleRcm.journal.totalCreditMinor)

assert.equal(validateGstinFormat("27AAPFU0939F1ZV").valid, true)
assert.match(validateGstinFormat("27AAPFU0939F1ZA").reason, /checksum/)
assert.match(validateGstinFormat("bad").reason, /format/)

console.log(JSON.stringify({ status: "ok", purchaseExactMinor: totals.grandTotalMinor, partialPayment: true, supplierAdvance: true, customerAdvance: true, reverseCharge: true, expenseItc: true, gstinChecksum: true }))
