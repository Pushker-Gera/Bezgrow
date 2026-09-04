import assert from "node:assert/strict"
import { buildExpenseJournal, buildReceiptJournal, buildReversalJournal, buildSaleJournal, splitOutputGst, validateJournal, type AccountingAccount } from "../lib/accounting/journal"
import { AccountingMoneyError, moneyToMinor, multiplyMoneyToMinor } from "../lib/accounting/money"

const account = (role: string, type: string): AccountingAccount => ({ id: `account:${role}`, accountCode: role, accountName: role, accountType: type, systemRole: role })
const accounts = new Map<string, AccountingAccount>([
  ["CASH", account("CASH", "ASSET")], ["BANK", account("BANK", "ASSET")],
  ["ACCOUNTS_RECEIVABLE", account("AR", "ASSET")], ["ACCOUNTS_PAYABLE", account("AP", "LIABILITY")],
  ["SALES", account("SALES", "INCOME")], ["SALES_DISCOUNT", account("DISCOUNT", "EXPENSE")],
  ["OUTPUT_CGST", account("OUTPUT_CGST", "LIABILITY")], ["OUTPUT_SGST", account("OUTPUT_SGST", "LIABILITY")],
  ["OUTPUT_IGST", account("OUTPUT_IGST", "LIABILITY")], ["COGS", account("COGS", "EXPENSE")],
  ["INVENTORY", account("INVENTORY", "ASSET")], ["ROUND_OFF", account("ROUND", "EXPENSE")],
])

const base = {
  id: "voucher:1", organizationId: "org:1", financialYearId: "fy:1", voucherNumber: "SALE-1", voucherType: "sale",
  voucherDate: "2026-09-03", sourceType: "SALES_INVOICE", sourceId: "invoice:1", narration: "Sale", systemGenerated: true,
}

assert.equal(moneyToMinor("1,23,456.789"), 12_345_679)
assert.equal(moneyToMinor(0.1 + 0.2), 30)
assert.equal(moneyToMinor("10.005"), 1001)
assert.equal(multiplyMoneyToMinor("2.5", "19.995"), 4999)
assert.throws(() => moneyToMinor("NaN"), AccountingMoneyError)
assert.throws(() => moneyToMinor(Number.POSITIVE_INFINITY), AccountingMoneyError)

assert.deepEqual(splitOutputGst(1801, "Maharashtra", "Maharashtra"), { cgstMinor: 900, sgstMinor: 901, igstMinor: 0, mode: "INTRA_STATE" })
assert.deepEqual(splitOutputGst(1801, "MH", "KA"), { cgstMinor: 0, sgstMinor: 0, igstMinor: 1801, mode: "INTER_STATE" })

const partial = buildSaleJournal({
  ...base, accounts, customerId: "customer:1", paymentAccountRole: "CASH", subtotalMinor: 10_000,
  discountMinor: 500, taxableMinor: 9_500, taxMinor: 1_710, totalMinor: 11_210, paidMinor: 4_000,
  organizationState: "MH", customerState: "MH", cogsMinor: 6_250,
})
assert.equal(partial.journal.totalDebitMinor, partial.journal.totalCreditMinor)
assert.equal(partial.outstandingMinor, 7_210)
assert.equal(partial.journal.lines.find((line) => line.customerId === "customer:1")?.debitMinor, 7_210)
assert.equal(partial.journal.lines.find((line) => line.accountId === "account:COGS")?.debitMinor, 6_250)
assert.equal(partial.gst.cgstMinor + partial.gst.sgstMinor, 1_710)

const fullInterstate = buildSaleJournal({
  ...base, id: "voucher:2", sourceId: "invoice:2", accounts, customerId: "customer:2", paymentAccountRole: "BANK",
  subtotalMinor: 20_000, discountMinor: 0, taxableMinor: 20_000, taxMinor: 3_600, totalMinor: 23_601, paidMinor: 23_601,
  organizationState: "MH", customerState: "GJ", cogsMinor: 0,
})
assert.equal(fullInterstate.gst.igstMinor, 3_600)
assert.equal(fullInterstate.journal.lines.some((line) => line.accountId === "account:AR"), false)
assert.equal(fullInterstate.journal.lines.find((line) => line.accountId === "account:ROUND")?.creditMinor, 1)

const receipt = buildReceiptJournal({
  ...base, id: "voucher:3", sourceType: "PAYMENT", sourceId: "payment:1", voucherType: "receipt",
  accounts, direction: "in", partyType: "customer", partyId: "customer:1", paymentAccountRole: "BANK", amountMinor: 7_210,
})
assert.equal(receipt.totalDebitMinor, 7_210)
assert.equal(receipt.lines.find((line) => line.customerId === "customer:1")?.creditMinor, 7_210)

const expensePosting = buildExpenseJournal({
  ...base, id: "voucher:4", sourceType: "EXPENSE", sourceId: "expense:1", voucherType: "payment",
  expenseAccount: account("RENT", "EXPENSE"), paymentAccount: account("CASH", "ASSET"),
  inputCgstAccount: account("INPUT_CGST", "ASSET"), inputSgstAccount: account("INPUT_SGST", "ASSET"), inputIgstAccount: account("INPUT_IGST", "ASSET"),
  amountMinor: 11_800, cgstMinor: 900, sgstMinor: 900, igstMinor: 0,
})
assert.equal(expensePosting.journal.totalDebitMinor, 11_800)
assert.equal(expensePosting.journal.totalCreditMinor, 11_800)

const reversal = buildReversalJournal(partial.journal, { id: "voucher:5", voucherNumber: "REV-1", voucherDate: "2026-09-03", financialYearId: "fy:1", sourceType: "SALES_INVOICE_REVERSAL", sourceId: "invoice:1", narration: "Cancelled", createdBy: null })
assert.equal(reversal.reversalOfVoucherId, partial.journal.id)
assert.deepEqual(reversal.lines.map((line) => [line.debitMinor, line.creditMinor]), partial.journal.lines.map((line) => [line.creditMinor, line.debitMinor]))
assert.throws(() => validateJournal({ ...base, lines: [{ accountId: "a", accountType: "ASSET", debitMinor: 100, creditMinor: 0 }, { accountId: "b", accountType: "INCOME", debitMinor: 0, creditMinor: 99 }] }), /not balanced/i)
assert.throws(() => buildSaleJournal({ ...base, accounts, customerId: "c", paymentAccountRole: "CASH", subtotalMinor: 100, discountMinor: 10, taxableMinor: 95, taxMinor: 0, totalMinor: 90, paidMinor: 0 }), /taxable amount/i)

console.log(JSON.stringify({ status: "ok", moneyCases: 6, gstCases: 2, journalCases: 6, exactMinorUnits: true }))
