import { assertNonNegativeMinor, moneyToMinor, multiplyMoneyToMinor } from "@/lib/accounting/money"
import { validateJournal, type AccountingAccount, type JournalDraft, type JournalLine } from "@/lib/accounting/journal"

export type PurchaseClassification = "INVENTORY" | "EXPENSE" | "FIXED_ASSET" | "OTHER"
export type SupplyType = "INTRA_STATE" | "INTER_STATE"
export type TaxCategory = "TAXABLE" | "EXEMPT" | "NIL_RATED" | "NON_GST"

export type PurchaseLineInput = {
  id?: string
  productId?: string | null
  productName?: string | null
  description?: string | null
  hsnCode?: string | null
  quantity: unknown
  unit?: string | null
  unitCost: unknown
  discountPercent?: unknown
  discountValue?: unknown
  taxableValue?: unknown
  gstRate?: unknown
  cgst?: unknown
  sgst?: unknown
  igst?: unknown
  cess?: unknown
  lineTotal?: unknown
  classification?: PurchaseClassification
  purchaseAccountId?: string | null
  warehouseId?: string | null
  batchNo?: string | null
  expiryDate?: string | null
}

export type NormalizedPurchaseLine = PurchaseLineInput & {
  quantityNumber: number
  unitCostMinor: number
  grossMinor: number
  discountBasisPoints: number
  discountMinor: number
  taxableMinor: number
  gstRateBasisPoints: number
  cgstMinor: number
  sgstMinor: number
  igstMinor: number
  cessMinor: number
  lineTotalMinor: number
  classification: PurchaseClassification
}

export type PurchaseTotals = {
  grossMinor: number
  discountMinor: number
  taxableMinor: number
  cgstMinor: number
  sgstMinor: number
  igstMinor: number
  cessMinor: number
  otherChargesMinor: number
  roundOffMinor: number
  grandTotalMinor: number
  settlementTotalMinor: number
}

function decimalBasisPoints(value: unknown, label: string) {
  const minor = moneyToMinor(value ?? 0, label)
  if (minor < 0 || minor > 10_000) throw new Error(`${label} must be between 0 and 100.`)
  return minor
}

function roundedRatio(numerator: bigint, denominator: bigint) {
  if (denominator <= BigInt(0)) throw new Error("Invalid accounting ratio denominator.")
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  return Number(remainder * BigInt(2) >= denominator ? quotient + BigInt(1) : quotient)
}

function percentageOfMinor(valueMinor: number, basisPoints: number) {
  if (!Number.isSafeInteger(valueMinor) || !Number.isSafeInteger(basisPoints)) throw new Error("Invalid exact percentage calculation.")
  return roundedRatio(BigInt(valueMinor) * BigInt(basisPoints), BigInt(10_000))
}

function optionalMinor(value: unknown, label: string) {
  return value === null || value === undefined || value === "" ? null : moneyToMinor(value, label)
}

export function normalizePurchaseLines(lines: PurchaseLineInput[], supplyType: SupplyType, taxCategory: TaxCategory = "TAXABLE") {
  if (!lines.length) throw new Error("Purchase requires at least one line.")
  return lines.map((input, index): NormalizedPurchaseLine => {
    const quantityNumber = Number(input.quantity)
    if (!Number.isFinite(quantityNumber) || quantityNumber <= 0) throw new Error(`Purchase line ${index + 1} requires a positive quantity.`)
    const unitCostMinor = moneyToMinor(input.unitCost, `Purchase rate on line ${index + 1}`)
    assertNonNegativeMinor(unitCostMinor, `Purchase rate on line ${index + 1}`)
    const grossMinor = multiplyMoneyToMinor(input.quantity, input.unitCost, `Purchase gross on line ${index + 1}`)
    const discountBasisPoints = decimalBasisPoints(input.discountPercent ?? 0, `Discount percent on line ${index + 1}`)
    const explicitDiscount = optionalMinor(input.discountValue, `Discount value on line ${index + 1}`)
    const discountMinor = explicitDiscount ?? percentageOfMinor(grossMinor, discountBasisPoints)
    if (discountMinor < 0 || discountMinor > grossMinor) throw new Error(`Discount on line ${index + 1} cannot exceed its gross value.`)
    const calculatedTaxable = grossMinor - discountMinor
    const explicitTaxable = optionalMinor(input.taxableValue, `Taxable value on line ${index + 1}`)
    const taxableMinor = explicitTaxable ?? calculatedTaxable
    if (taxableMinor !== calculatedTaxable) throw new Error(`Taxable value on line ${index + 1} must equal gross less discount.`)
    const gstRateBasisPoints = decimalBasisPoints(input.gstRate ?? 0, `GST rate on line ${index + 1}`)
    const taxableForGst = taxCategory === "TAXABLE"
    const calculatedTax = taxableForGst ? percentageOfMinor(taxableMinor, gstRateBasisPoints) : 0
    let cgstMinor = optionalMinor(input.cgst, `CGST on line ${index + 1}`)
    let sgstMinor = optionalMinor(input.sgst, `SGST on line ${index + 1}`)
    let igstMinor = optionalMinor(input.igst, `IGST on line ${index + 1}`)
    const hasExplicitTax = cgstMinor !== null || sgstMinor !== null || igstMinor !== null
    if (!hasExplicitTax) {
      if (supplyType === "INTER_STATE") {
        cgstMinor = 0
        sgstMinor = 0
        igstMinor = calculatedTax
      } else {
        cgstMinor = Math.floor(calculatedTax / 2)
        sgstMinor = calculatedTax - cgstMinor
        igstMinor = 0
      }
    }
    cgstMinor ??= 0
    sgstMinor ??= 0
    igstMinor ??= 0
    const cessMinor = optionalMinor(input.cess, `Cess on line ${index + 1}`) ?? 0
    for (const [label, value] of [["CGST", cgstMinor], ["SGST", sgstMinor], ["IGST", igstMinor], ["Cess", cessMinor]] as const) {
      assertNonNegativeMinor(value, `${label} on line ${index + 1}`)
    }
    if (supplyType === "INTER_STATE" && (cgstMinor || sgstMinor)) throw new Error(`Interstate line ${index + 1} cannot contain CGST or SGST.`)
    if (supplyType === "INTRA_STATE" && igstMinor) throw new Error(`Intrastate line ${index + 1} cannot contain IGST.`)
    if (!taxableForGst && (cgstMinor || sgstMinor || igstMinor || cessMinor)) throw new Error(`Non-taxable line ${index + 1} cannot contain GST.`)
    if (hasExplicitTax && cgstMinor + sgstMinor + igstMinor !== calculatedTax) {
      throw new Error(`GST components on line ${index + 1} do not match its taxable value and rate.`)
    }
    const lineTotalMinor = taxableMinor + cgstMinor + sgstMinor + igstMinor + cessMinor
    const explicitTotal = optionalMinor(input.lineTotal, `Line total on line ${index + 1}`)
    if (explicitTotal !== null && explicitTotal !== lineTotalMinor) throw new Error(`Line total on line ${index + 1} does not reconcile.`)
    return {
      ...input,
      quantityNumber,
      unitCostMinor,
      grossMinor,
      discountBasisPoints,
      discountMinor,
      taxableMinor,
      gstRateBasisPoints,
      cgstMinor,
      sgstMinor,
      igstMinor,
      cessMinor,
      lineTotalMinor,
      classification: input.classification || "INVENTORY",
    }
  })
}

export function purchaseTotals(lines: NormalizedPurchaseLine[], otherCharges: unknown = 0, roundOff: unknown = 0, reverseCharge = false): PurchaseTotals {
  const total = (key: keyof Pick<NormalizedPurchaseLine, "grossMinor" | "discountMinor" | "taxableMinor" | "cgstMinor" | "sgstMinor" | "igstMinor" | "cessMinor">) =>
    lines.reduce((sum, line) => sum + line[key], 0)
  const otherChargesMinor = moneyToMinor(otherCharges ?? 0, "Other charges")
  const roundOffMinor = moneyToMinor(roundOff ?? 0, "Round off")
  assertNonNegativeMinor(otherChargesMinor, "Other charges")
  const result = {
    grossMinor: total("grossMinor"),
    discountMinor: total("discountMinor"),
    taxableMinor: total("taxableMinor"),
    cgstMinor: total("cgstMinor"),
    sgstMinor: total("sgstMinor"),
    igstMinor: total("igstMinor"),
    cessMinor: total("cessMinor"),
    otherChargesMinor,
    roundOffMinor,
    grandTotalMinor: 0,
    settlementTotalMinor: 0,
  }
  const taxMinor = result.cgstMinor + result.sgstMinor + result.igstMinor + result.cessMinor
  result.grandTotalMinor = result.taxableMinor + taxMinor + otherChargesMinor + roundOffMinor
  result.settlementTotalMinor = reverseCharge ? result.grandTotalMinor - taxMinor : result.grandTotalMinor
  if (result.grandTotalMinor <= 0 || result.settlementTotalMinor <= 0) throw new Error("Purchase total must be greater than zero.")
  return result
}

function requireAccount(accounts: Map<string, AccountingAccount>, role: string) {
  const account = accounts.get(role)
  if (!account) throw new Error(`Required accounting account ${role} is missing.`)
  return account
}

function journalLine(account: AccountingAccount, debitMinor: number, creditMinor: number, details: Partial<JournalLine> = {}): JournalLine {
  return { accountId: account.id, accountType: account.accountType, debitMinor, creditMinor, ...details }
}

function purchaseDebitAccount(accounts: Map<string, AccountingAccount>, classification: PurchaseClassification, selected?: AccountingAccount | null) {
  if (selected) return selected
  if (classification === "INVENTORY") return requireAccount(accounts, "INVENTORY")
  if (classification === "EXPENSE") return requireAccount(accounts, "PURCHASES")
  if (classification === "FIXED_ASSET") return requireAccount(accounts, "FIXED_ASSETS")
  return requireAccount(accounts, "OTHER_CURRENT_ASSETS")
}

export type PurchaseJournalInput = Omit<JournalDraft, "lines"> & {
  accounts: Map<string, AccountingAccount>
  supplierId: string
  lines: NormalizedPurchaseLine[]
  totals: PurchaseTotals
  paidMinor: number
  paymentAccount?: AccountingAccount | null
  selectedAccounts?: Map<string, AccountingAccount>
  reverseCharge?: boolean
  isReturn?: boolean
  payableReductionMinor?: number
}

export function buildPurchaseJournal(input: PurchaseJournalInput) {
  assertNonNegativeMinor(input.paidMinor, "Paid amount")
  if (input.paidMinor > input.totals.settlementTotalMinor) throw new Error("Paid amount cannot exceed the supplier settlement total.")
  const lines: JournalLine[] = []
  const byAccount = new Map<string, { account: AccountingAccount; amount: number }>()
  for (const purchaseLine of input.lines) {
    const selected = purchaseLine.purchaseAccountId ? input.selectedAccounts?.get(purchaseLine.purchaseAccountId) : null
    const account = purchaseDebitAccount(input.accounts, purchaseLine.classification, selected)
    const current = byAccount.get(account.id) || { account, amount: 0 }
    current.amount += purchaseLine.taxableMinor
    byAccount.set(account.id, current)
  }
  if (input.totals.otherChargesMinor) {
    const account = requireAccount(input.accounts, "FREIGHT_EXPENSE")
    const current = byAccount.get(account.id) || { account, amount: 0 }
    current.amount += input.totals.otherChargesMinor
    byAccount.set(account.id, current)
  }
  const supplier = { partyType: "supplier" as const, partyId: input.supplierId, supplierId: input.supplierId, reference: input.referenceNo }
  const taxLines = [
    ["INPUT_CGST", input.totals.cgstMinor, "Input CGST"],
    ["INPUT_SGST", input.totals.sgstMinor, "Input SGST"],
    ["INPUT_IGST", input.totals.igstMinor, "Input IGST"],
    ["INPUT_CESS", input.totals.cessMinor, "Input Cess"],
  ] as const
  if (!input.isReturn) {
    for (const entry of byAccount.values()) if (entry.amount) lines.push(journalLine(entry.account, entry.amount, 0, { description: "Purchase value" }))
    for (const [role, amount, description] of taxLines) if (amount) lines.push(journalLine(requireAccount(input.accounts, role), amount, 0, { description }))
    if (input.totals.roundOffMinor > 0) lines.push(journalLine(requireAccount(input.accounts, "ROUND_OFF"), input.totals.roundOffMinor, 0, { description: "Purchase round off" }))
    if (input.totals.roundOffMinor < 0) lines.push(journalLine(requireAccount(input.accounts, "ROUND_OFF"), 0, -input.totals.roundOffMinor, { description: "Purchase round off" }))
    if (input.reverseCharge) {
      for (const [role, amount, description] of [
        ["OUTPUT_CGST", input.totals.cgstMinor, "Reverse-charge CGST"],
        ["OUTPUT_SGST", input.totals.sgstMinor, "Reverse-charge SGST"],
        ["OUTPUT_IGST", input.totals.igstMinor, "Reverse-charge IGST"],
        ["OUTPUT_CESS", input.totals.cessMinor, "Reverse-charge Cess"],
      ] as const) if (amount) lines.push(journalLine(requireAccount(input.accounts, role), 0, amount, { description }))
    }
    if (input.paidMinor) {
      if (!input.paymentAccount) throw new Error("Select the cash or bank account used for the purchase payment.")
      lines.push(journalLine(input.paymentAccount, 0, input.paidMinor, { description: "Purchase paid" }))
    }
    const outstandingMinor = input.totals.settlementTotalMinor - input.paidMinor
    if (outstandingMinor) lines.push(journalLine(requireAccount(input.accounts, "ACCOUNTS_PAYABLE"), 0, outstandingMinor, { ...supplier, description: "Supplier payable" }))
    return { journal: validateJournal({ ...input, lines }), outstandingMinor }
  }

  for (const entry of byAccount.values()) if (entry.amount) lines.push(journalLine(entry.account, 0, entry.amount, { description: "Purchase return value" }))
  for (const [role, amount, description] of taxLines) if (amount) lines.push(journalLine(requireAccount(input.accounts, role), 0, amount, { description: `${description} reversal` }))
  if (input.reverseCharge) {
    for (const [role, amount, description] of [
      ["OUTPUT_CGST", input.totals.cgstMinor, "Reverse-charge CGST reversed"],
      ["OUTPUT_SGST", input.totals.sgstMinor, "Reverse-charge SGST reversed"],
      ["OUTPUT_IGST", input.totals.igstMinor, "Reverse-charge IGST reversed"],
      ["OUTPUT_CESS", input.totals.cessMinor, "Reverse-charge Cess reversed"],
    ] as const) if (amount) lines.push(journalLine(requireAccount(input.accounts, role), amount, 0, { description }))
  }
  if (input.totals.roundOffMinor > 0) lines.push(journalLine(requireAccount(input.accounts, "ROUND_OFF"), 0, input.totals.roundOffMinor, { description: "Return round off reversal" }))
  if (input.totals.roundOffMinor < 0) lines.push(journalLine(requireAccount(input.accounts, "ROUND_OFF"), -input.totals.roundOffMinor, 0, { description: "Return round off reversal" }))
  const payableReductionMinor = Math.min(input.totals.settlementTotalMinor, Math.max(0, input.payableReductionMinor ?? input.totals.settlementTotalMinor))
  if (payableReductionMinor) lines.push(journalLine(requireAccount(input.accounts, "ACCOUNTS_PAYABLE"), payableReductionMinor, 0, { ...supplier, description: "Supplier payable reduced" }))
  const supplierReceivableMinor = input.totals.settlementTotalMinor - payableReductionMinor
  if (supplierReceivableMinor) lines.push(journalLine(requireAccount(input.accounts, "SUPPLIER_ADVANCES"), supplierReceivableMinor, 0, { ...supplier, description: "Amount recoverable from supplier" }))
  return { journal: validateJournal({ ...input, lines }), outstandingMinor: 0, supplierReceivableMinor }
}

export function buildPartySettlementJournal(input: Omit<JournalDraft, "lines"> & {
  accounts: Map<string, AccountingAccount>
  partyType: "supplier" | "customer"
  partyId: string
  direction: "in" | "out"
  paymentAccount: AccountingAccount
  amountMinor: number
  allocatedMinor: number
}) {
  assertNonNegativeMinor(input.amountMinor, "Payment amount")
  assertNonNegativeMinor(input.allocatedMinor, "Allocated amount")
  if (!input.amountMinor || input.allocatedMinor > input.amountMinor) throw new Error("Payment allocations cannot exceed the payment amount.")
  const advanceMinor = input.amountMinor - input.allocatedMinor
  const details = input.partyType === "supplier"
    ? { partyType: "supplier" as const, partyId: input.partyId, supplierId: input.partyId }
    : { partyType: "customer" as const, partyId: input.partyId, customerId: input.partyId }
  const lines: JournalLine[] = []
  if (input.partyType === "supplier" && input.direction === "out") {
    if (input.allocatedMinor) lines.push(journalLine(requireAccount(input.accounts, "ACCOUNTS_PAYABLE"), input.allocatedMinor, 0, { ...details, description: "Supplier bills settled" }))
    if (advanceMinor) lines.push(journalLine(requireAccount(input.accounts, "SUPPLIER_ADVANCES"), advanceMinor, 0, { ...details, description: "Advance to supplier" }))
    lines.push(journalLine(input.paymentAccount, 0, input.amountMinor, { description: "Supplier payment" }))
  } else if (input.partyType === "customer" && input.direction === "in") {
    lines.push(journalLine(input.paymentAccount, input.amountMinor, 0, { description: "Customer receipt" }))
    if (input.allocatedMinor) lines.push(journalLine(requireAccount(input.accounts, "ACCOUNTS_RECEIVABLE"), 0, input.allocatedMinor, { ...details, description: "Customer invoices settled" }))
    if (advanceMinor) lines.push(journalLine(requireAccount(input.accounts, "CUSTOMER_ADVANCES"), 0, advanceMinor, { ...details, description: "Advance from customer" }))
  } else {
    throw new Error("Unsupported party settlement direction.")
  }
  return { journal: validateJournal({ ...input, lines }), advanceMinor }
}

export function buildAdvanceApplicationJournal(input: Omit<JournalDraft, "lines"> & {
  accounts: Map<string, AccountingAccount>
  partyType: "supplier" | "customer"
  partyId: string
  amountMinor: number
}) {
  assertNonNegativeMinor(input.amountMinor, "Advance allocation")
  if (!input.amountMinor) throw new Error("Advance allocation must be greater than zero.")
  const details = input.partyType === "supplier"
    ? { partyType: "supplier" as const, partyId: input.partyId, supplierId: input.partyId }
    : { partyType: "customer" as const, partyId: input.partyId, customerId: input.partyId }
  const lines = input.partyType === "supplier"
    ? [
        journalLine(requireAccount(input.accounts, "ACCOUNTS_PAYABLE"), input.amountMinor, 0, details),
        journalLine(requireAccount(input.accounts, "SUPPLIER_ADVANCES"), 0, input.amountMinor, details),
      ]
    : [
        journalLine(requireAccount(input.accounts, "CUSTOMER_ADVANCES"), input.amountMinor, 0, details),
        journalLine(requireAccount(input.accounts, "ACCOUNTS_RECEIVABLE"), 0, input.amountMinor, details),
      ]
  return validateJournal({ ...input, lines })
}

const GSTIN_WEIGHTS = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2]
const GSTIN_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"

export function validateGstinFormat(value: string | null | undefined) {
  const gstin = String(value || "").trim().toUpperCase()
  if (!gstin) return { value: gstin, valid: false, reason: "GSTIN is missing." }
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) return { value: gstin, valid: false, reason: "GSTIN format is invalid." }
  let sum = 0
  for (let index = 0; index < 14; index += 1) {
    const codePoint = GSTIN_ALPHABET.indexOf(gstin[index])
    const product = codePoint * GSTIN_WEIGHTS[index]
    sum += Math.floor(product / 36) + (product % 36)
  }
  const check = GSTIN_ALPHABET[(36 - (sum % 36)) % 36]
  return check === gstin[14]
    ? { value: gstin, valid: true, reason: "Format valid (registration status not checked)." }
    : { value: gstin, valid: false, reason: "GSTIN checksum is invalid." }
}
