import { assertNonNegativeMinor } from "@/lib/accounting/money"

export type AccountRole =
  | "CASH"
  | "BANK"
  | "ACCOUNTS_RECEIVABLE"
  | "INVENTORY"
  | "INPUT_CGST"
  | "INPUT_SGST"
  | "INPUT_IGST"
  | "ACCOUNTS_PAYABLE"
  | "OUTPUT_CGST"
  | "OUTPUT_SGST"
  | "OUTPUT_IGST"
  | "OPENING_EQUITY"
  | "SALES"
  | "COGS"
  | "SALES_DISCOUNT"
  | "ROUND_OFF"
  | string

export type AccountingAccount = {
  id: string
  accountCode: string
  accountName: string
  accountType: string
  systemRole: AccountRole | null
}

export type JournalLine = {
  accountId: string
  accountType: string
  debitMinor: number
  creditMinor: number
  description?: string | null
  partyType?: "customer" | "supplier" | null
  partyId?: string | null
  customerId?: string | null
  supplierId?: string | null
  reference?: string | null
}

export type JournalDraft = {
  id: string
  organizationId: string
  financialYearId: string
  voucherNumber: string
  voucherType: string
  voucherDate: string
  sourceType: string
  sourceId: string
  referenceNo?: string | null
  narration: string
  systemGenerated: boolean
  createdBy?: string | null
  reversalOfVoucherId?: string | null
  lines: JournalLine[]
}

export type ValidatedJournal = JournalDraft & {
  totalDebitMinor: number
  totalCreditMinor: number
}

export type GstSplit = { cgstMinor: number; sgstMinor: number; igstMinor: number; mode: "INTRA_STATE" | "INTER_STATE" }

function compactState(value?: string | null) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
}

export function splitOutputGst(totalTaxMinor: number, organizationState?: string | null, customerState?: string | null): GstSplit {
  assertNonNegativeMinor(totalTaxMinor, "GST")
  const organization = compactState(organizationState)
  const customer = compactState(customerState)
  if (organization && customer && organization !== customer) {
    return { cgstMinor: 0, sgstMinor: 0, igstMinor: totalTaxMinor, mode: "INTER_STATE" }
  }
  const cgstMinor = Math.floor(totalTaxMinor / 2)
  return { cgstMinor, sgstMinor: totalTaxMinor - cgstMinor, igstMinor: 0, mode: "INTRA_STATE" }
}

function requireAccount(accounts: Map<string, AccountingAccount>, role: AccountRole) {
  const account = accounts.get(role)
  if (!account) throw new Error(`Required accounting account ${role} is missing.`)
  return account
}

function line(
  account: AccountingAccount,
  debitMinor: number,
  creditMinor: number,
  details: Partial<Omit<JournalLine, "accountId" | "accountType" | "debitMinor" | "creditMinor">> = {}
): JournalLine {
  return { accountId: account.id, accountType: account.accountType, debitMinor, creditMinor, ...details }
}

export function validateJournal(draft: JournalDraft): ValidatedJournal {
  if (!draft.organizationId || !draft.financialYearId || !draft.id || !draft.sourceType || !draft.sourceId) {
    throw new Error("Journal identity, organization, financial year, and source are required.")
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.voucherDate)) throw new Error("Voucher date must use YYYY-MM-DD format.")
  if (draft.lines.length < 2) throw new Error("A journal must contain at least two lines.")
  let totalDebitMinor = 0
  let totalCreditMinor = 0
  for (const [index, item] of draft.lines.entries()) {
    if (!item.accountId) throw new Error(`Journal line ${index + 1} requires an account.`)
    if (!Number.isSafeInteger(item.debitMinor) || !Number.isSafeInteger(item.creditMinor)) {
      throw new Error(`Journal line ${index + 1} contains an invalid stored amount.`)
    }
    if (item.debitMinor < 0 || item.creditMinor < 0 || (item.debitMinor > 0) === (item.creditMinor > 0)) {
      throw new Error(`Journal line ${index + 1} must contain exactly one positive debit or credit.`)
    }
    totalDebitMinor += item.debitMinor
    totalCreditMinor += item.creditMinor
    if (!Number.isSafeInteger(totalDebitMinor) || !Number.isSafeInteger(totalCreditMinor)) {
      throw new Error("Journal total is outside the supported accounting range.")
    }
  }
  if (totalDebitMinor <= 0 || totalDebitMinor !== totalCreditMinor) {
    throw new Error(`Journal is not balanced: debit ${totalDebitMinor}, credit ${totalCreditMinor}.`)
  }
  return { ...draft, totalDebitMinor, totalCreditMinor }
}

function addRoundOff(lines: JournalLine[], accounts: Map<string, AccountingAccount>) {
  const debit = lines.reduce((sum, item) => sum + item.debitMinor, 0)
  const credit = lines.reduce((sum, item) => sum + item.creditMinor, 0)
  const difference = credit - debit
  if (!difference) return
  const roundOff = requireAccount(accounts, "ROUND_OFF")
  lines.push(line(roundOff, Math.max(0, difference), Math.max(0, -difference), { description: "Invoice rounding adjustment" }))
}

export type SaleJournalInput = Omit<JournalDraft, "lines"> & {
  accounts: Map<string, AccountingAccount>
  customerId: string
  paymentAccountRole: "CASH" | "BANK"
  subtotalMinor: number
  discountMinor: number
  taxableMinor: number
  taxMinor: number
  totalMinor: number
  paidMinor: number
  organizationState?: string | null
  customerState?: string | null
  cogsMinor?: number
  gstSplit?: Pick<GstSplit, "cgstMinor" | "sgstMinor" | "igstMinor">
}

export function buildSaleJournal(input: SaleJournalInput) {
  for (const [label, value] of [
    ["Subtotal", input.subtotalMinor], ["Discount", input.discountMinor], ["Taxable amount", input.taxableMinor],
    ["Tax", input.taxMinor], ["Invoice total", input.totalMinor], ["Paid amount", input.paidMinor], ["COGS", input.cogsMinor || 0],
  ] as const) assertNonNegativeMinor(value, label)
  if (input.discountMinor > input.subtotalMinor) throw new Error("Invoice discount cannot exceed subtotal.")
  if (input.paidMinor > input.totalMinor) throw new Error("Paid amount cannot exceed invoice total.")
  if (input.taxableMinor !== input.subtotalMinor - input.discountMinor) throw new Error("Taxable amount must equal subtotal less discount.")

  const lines: JournalLine[] = []
  const customerDetails = { partyType: "customer" as const, partyId: input.customerId, customerId: input.customerId }
  if (input.paidMinor > 0) {
    lines.push(line(requireAccount(input.accounts, input.paymentAccountRole), input.paidMinor, 0, {
      description: "Invoice settlement", reference: input.referenceNo,
    }))
  }
  const outstandingMinor = input.totalMinor - input.paidMinor
  if (outstandingMinor > 0) {
    lines.push(line(requireAccount(input.accounts, "ACCOUNTS_RECEIVABLE"), outstandingMinor, 0, {
      ...customerDetails, description: "Customer receivable", reference: input.referenceNo,
    }))
  }
  if (input.discountMinor > 0) {
    lines.push(line(requireAccount(input.accounts, "SALES_DISCOUNT"), input.discountMinor, 0, { description: "Sales discount" }))
  }
  if (input.subtotalMinor > 0) lines.push(line(requireAccount(input.accounts, "SALES"), 0, input.subtotalMinor, { description: "Sales revenue" }))

  const inferredGst = splitOutputGst(input.taxMinor, input.organizationState, input.customerState)
  const gst = input.gstSplit
    ? { ...input.gstSplit, mode: input.gstSplit.igstMinor > 0 ? "INTER_STATE" as const : "INTRA_STATE" as const }
    : inferredGst
  if (gst.cgstMinor < 0 || gst.sgstMinor < 0 || gst.igstMinor < 0 || gst.cgstMinor + gst.sgstMinor + gst.igstMinor !== input.taxMinor) {
    throw new Error("Invoice GST components must be non-negative and equal the authoritative GST total.")
  }
  if (gst.cgstMinor) lines.push(line(requireAccount(input.accounts, "OUTPUT_CGST"), 0, gst.cgstMinor, { description: "Output CGST" }))
  if (gst.sgstMinor) lines.push(line(requireAccount(input.accounts, "OUTPUT_SGST"), 0, gst.sgstMinor, { description: "Output SGST" }))
  if (gst.igstMinor) lines.push(line(requireAccount(input.accounts, "OUTPUT_IGST"), 0, gst.igstMinor, { description: "Output IGST" }))
  if ((input.cogsMinor || 0) > 0) {
    lines.push(line(requireAccount(input.accounts, "COGS"), input.cogsMinor!, 0, { description: "Cost of goods sold" }))
    lines.push(line(requireAccount(input.accounts, "INVENTORY"), 0, input.cogsMinor!, { description: "Inventory issued at recorded cost" }))
  }
  addRoundOff(lines, input.accounts)
  return { journal: validateJournal({ ...input, lines }), gst, outstandingMinor }
}

export type ReceiptJournalInput = Omit<JournalDraft, "lines"> & {
  accounts: Map<string, AccountingAccount>
  direction: "in" | "out"
  partyType: "customer" | "supplier"
  partyId: string
  paymentAccountRole: "CASH" | "BANK"
  amountMinor: number
}

export function buildReceiptJournal(input: ReceiptJournalInput) {
  assertNonNegativeMinor(input.amountMinor, "Receipt amount")
  if (!input.amountMinor) throw new Error("Receipt amount must be greater than zero.")
  const payment = requireAccount(input.accounts, input.paymentAccountRole)
  const partyRole = input.partyType === "customer" ? "ACCOUNTS_RECEIVABLE" : "ACCOUNTS_PAYABLE"
  const party = requireAccount(input.accounts, partyRole)
  const details = input.partyType === "customer"
    ? { partyType: "customer" as const, partyId: input.partyId, customerId: input.partyId }
    : { partyType: "supplier" as const, partyId: input.partyId, supplierId: input.partyId }
  const lines = input.direction === "in"
    ? [line(payment, input.amountMinor, 0, { description: "Amount received" }), line(party, 0, input.amountMinor, details)]
    : [line(party, input.amountMinor, 0, details), line(payment, 0, input.amountMinor, { description: "Amount paid" })]
  return validateJournal({ ...input, lines })
}

export type ExpenseJournalInput = Omit<JournalDraft, "lines"> & {
  expenseAccount: AccountingAccount
  paymentAccount: AccountingAccount
  inputCgstAccount: AccountingAccount
  inputSgstAccount: AccountingAccount
  inputIgstAccount: AccountingAccount
  amountMinor: number
  cgstMinor: number
  sgstMinor: number
  igstMinor: number
}

export function buildExpenseJournal(input: ExpenseJournalInput) {
  for (const [label, amount] of [["Expense", input.amountMinor], ["CGST", input.cgstMinor], ["SGST", input.sgstMinor], ["IGST", input.igstMinor]] as const) {
    assertNonNegativeMinor(amount, label)
  }
  if (!input.amountMinor) throw new Error("Expense amount must be greater than zero.")
  const taxMinor = input.cgstMinor + input.sgstMinor + input.igstMinor
  if (taxMinor > input.amountMinor) throw new Error("Input GST cannot exceed the total expense amount.")
  const lines = [line(input.expenseAccount, input.amountMinor - taxMinor, 0, { description: input.narration })]
  if (input.cgstMinor) lines.push(line(input.inputCgstAccount, input.cgstMinor, 0, { description: "Input CGST" }))
  if (input.sgstMinor) lines.push(line(input.inputSgstAccount, input.sgstMinor, 0, { description: "Input SGST" }))
  if (input.igstMinor) lines.push(line(input.inputIgstAccount, input.igstMinor, 0, { description: "Input IGST" }))
  lines.push(line(input.paymentAccount, 0, input.amountMinor, { description: "Expense payment" }))
  return {
    journal: validateJournal({ ...input, lines }),
    amountMinor: input.amountMinor,
    cgstMinor: input.cgstMinor,
    sgstMinor: input.sgstMinor,
    igstMinor: input.igstMinor,
  }
}

export function buildReversalJournal(original: ValidatedJournal, input: Pick<JournalDraft, "id" | "voucherNumber" | "voucherDate" | "sourceType" | "sourceId" | "narration" | "financialYearId" | "createdBy">) {
  return validateJournal({
    ...original,
    ...input,
    voucherType: "reversal",
    systemGenerated: true,
    reversalOfVoucherId: original.id,
    referenceNo: original.voucherNumber,
    lines: original.lines.map((item) => ({ ...item, debitMinor: item.creditMinor, creditMinor: item.debitMinor })),
  })
}
