import { assertNonNegativeMinor } from "@/lib/accounting/money"
import { validateJournal, type AccountingAccount, type JournalDraft, type JournalLine, type ValidatedJournal } from "@/lib/accounting/journal"
import { validateGstinFormat } from "@/lib/accounting/phase2"

export type DepreciationMethod = "SLM" | "WDV"
export type TaxPostingMode = "EXPENSE_ACCRUAL" | "PAYMENT_DEDUCTION"
export type DimensionType = "COST_CENTRE" | "DEPARTMENT" | "PROJECT"

const DAY_MS = 86_400_000

function strictDate(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD format.`)
  const [year, month, day] = value.split("-").map(Number)
  const stamp = Date.UTC(year, month - 1, day)
  const parsed = new Date(stamp)
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error(`${label} is not a valid business date.`)
  }
  return stamp
}

function isoDate(stamp: number) {
  return new Date(stamp).toISOString().slice(0, 10)
}

function daysInclusive(from: string, to: string) {
  const start = strictDate(from, "Period start")
  const end = strictDate(to, "Period end")
  if (end < start) throw new Error("Period end cannot be before period start.")
  return Math.trunc((end - start) / DAY_MS) + 1
}

function percentageMinor(baseMinor: number, rateBasisPoints: number, denominator = 10_000) {
  assertNonNegativeMinor(baseMinor, "Taxable amount")
  if (!Number.isSafeInteger(rateBasisPoints) || rateBasisPoints < 0) throw new Error("Rate must be a non-negative integer basis-point value.")
  const numerator = BigInt(baseMinor) * BigInt(rateBasisPoints)
  const divisor = BigInt(denominator)
  const rounded = (numerator + divisor / BigInt(2)) / divisor
  const value = Number(rounded)
  if (!Number.isSafeInteger(value)) throw new Error("Calculated amount is outside the supported accounting range.")
  return value
}

function accountLine(account: AccountingAccount, debitMinor: number, creditMinor: number, description: string, party?: { type: "customer" | "supplier"; id: string }): JournalLine {
  return {
    accountId: account.id,
    accountType: account.accountType,
    debitMinor,
    creditMinor,
    description,
    partyType: party?.type || null,
    partyId: party?.id || null,
    customerId: party?.type === "customer" ? party.id : null,
    supplierId: party?.type === "supplier" ? party.id : null,
  }
}

export function taxAmountMinor(taxableMinor: number, rateBasisPoints: number) {
  return percentageMinor(taxableMinor, rateBasisPoints)
}

export function formatVoucherNumber(input: {
  prefix: string
  suffix?: string | null
  nextNumber: number
  padding?: number
  financialYearLabel?: string | null
}) {
  const prefix = input.prefix.trim().replace(/\/+$/g, "")
  const suffix = String(input.suffix || "").trim().replace(/^\/+|\/+$/g, "")
  if (!prefix || !/^[A-Z0-9][A-Z0-9/_-]*$/i.test(prefix)) throw new Error("Voucher prefix contains unsupported characters.")
  if (suffix && !/^[A-Z0-9][A-Z0-9/_-]*$/i.test(suffix)) throw new Error("Voucher suffix contains unsupported characters.")
  if (!Number.isSafeInteger(input.nextNumber) || input.nextNumber < 1) throw new Error("Voucher sequence must be a positive integer.")
  const padding = Math.min(12, Math.max(1, Math.trunc(input.padding || 6)))
  const year = String(input.financialYearLabel || "")
    .match(/(\d{4})\D+(\d{2,4})/)?.slice(1)
    .map((part) => part.slice(-2))
    .join("-")
  return [prefix, year || null, String(input.nextNumber).padStart(padding, "0"), suffix || null].filter(Boolean).join("/")
}

export function validateDimensionAllocations(input: {
  lineMinor: number
  dimensions: Array<{ type: DimensionType; allocations: Array<{ dimensionId: string; amountMinor: number }> }>
}) {
  assertNonNegativeMinor(input.lineMinor, "Journal line allocation amount")
  const seen = new Set<string>()
  for (const group of input.dimensions) {
    if (seen.has(group.type)) throw new Error(`${group.type.replaceAll("_", " ")} allocations were supplied more than once.`)
    seen.add(group.type)
    if (!group.allocations.length) continue
    const allocated = group.allocations.reduce((sum, allocation, index) => {
      if (!allocation.dimensionId) throw new Error(`${group.type.replaceAll("_", " ")} allocation ${index + 1} requires a dimension.`)
      assertNonNegativeMinor(allocation.amountMinor, `${group.type.replaceAll("_", " ")} allocation`)
      if (allocation.amountMinor === 0) throw new Error("Dimension allocations must be greater than zero.")
      const next = sum + allocation.amountMinor
      if (!Number.isSafeInteger(next)) throw new Error("Dimension allocation total is outside the supported accounting range.")
      return next
    }, 0)
    if (allocated !== input.lineMinor) {
      throw new Error(`${group.type.replaceAll("_", " ")} allocations must equal the journal line amount exactly.`)
    }
  }
  return true
}

export function calculateDepreciation(input: {
  originalCostMinor: number
  residualValueMinor: number
  accumulatedBeforeMinor: number
  method: DepreciationMethod
  annualRateBasisPoints: number
  usefulLifeMonths: number
  capitalizationDate: string
  periodStart: string
  periodEnd: string
}) {
  for (const [label, amount] of [
    ["Original cost", input.originalCostMinor],
    ["Residual value", input.residualValueMinor],
    ["Accumulated depreciation", input.accumulatedBeforeMinor],
  ] as const) assertNonNegativeMinor(amount, label)
  if (input.residualValueMinor > input.originalCostMinor) throw new Error("Residual value cannot exceed original cost.")
  if (input.accumulatedBeforeMinor > input.originalCostMinor - input.residualValueMinor) throw new Error("Accumulated depreciation exceeds the depreciable amount.")
  if (!Number.isSafeInteger(input.usefulLifeMonths) || input.usefulLifeMonths <= 0) throw new Error("Useful life must be a positive whole number of months.")
  strictDate(input.capitalizationDate, "Capitalization date")
  strictDate(input.periodStart, "Period start")
  strictDate(input.periodEnd, "Period end")
  const effectiveStart = input.periodStart > input.capitalizationDate ? input.periodStart : input.capitalizationDate
  if (effectiveStart > input.periodEnd) return { amountMinor: 0, effectiveStart, effectiveEnd: input.periodEnd, days: 0, closingWrittenDownValueMinor: input.originalCostMinor - input.accumulatedBeforeMinor }
  const days = daysInclusive(effectiveStart, input.periodEnd)
  const remainingDepreciable = input.originalCostMinor - input.residualValueMinor - input.accumulatedBeforeMinor
  if (remainingDepreciable <= 0) return { amountMinor: 0, effectiveStart, effectiveEnd: input.periodEnd, days, closingWrittenDownValueMinor: input.residualValueMinor }
  let amountMinor: number
  if (input.method === "SLM") {
    const totalLifeDays = Math.max(1, Math.round(input.usefulLifeMonths * 365.2425 / 12))
    const annualByLifeBasisPoints = Math.round(120_000 / input.usefulLifeMonths)
    const configuredAnnual = input.annualRateBasisPoints > 0 ? input.annualRateBasisPoints : annualByLifeBasisPoints
    const annualMinor = percentageMinor(input.originalCostMinor - input.residualValueMinor, configuredAnnual)
    amountMinor = Number((BigInt(annualMinor) * BigInt(days) + BigInt(183)) / BigInt(365))
    if (days >= totalLifeDays) amountMinor = remainingDepreciable
  } else {
    if (!Number.isSafeInteger(input.annualRateBasisPoints) || input.annualRateBasisPoints <= 0 || input.annualRateBasisPoints > 10_000) {
      throw new Error("WDV depreciation requires an annual rate between 0% and 100%.")
    }
    const openingWrittenDown = input.originalCostMinor - input.accumulatedBeforeMinor
    const annualMinor = percentageMinor(openingWrittenDown, input.annualRateBasisPoints)
    amountMinor = Number((BigInt(annualMinor) * BigInt(days) + BigInt(183)) / BigInt(365))
  }
  amountMinor = Math.min(remainingDepreciable, Math.max(0, amountMinor))
  return {
    amountMinor,
    effectiveStart,
    effectiveEnd: input.periodEnd,
    days,
    closingWrittenDownValueMinor: input.originalCostMinor - input.accumulatedBeforeMinor - amountMinor,
  }
}

export function buildDepreciationJournal(input: Omit<JournalDraft, "lines"> & {
  amountMinor: number
  depreciationExpenseAccount: AccountingAccount
  accumulatedDepreciationAccount: AccountingAccount
}) {
  assertNonNegativeMinor(input.amountMinor, "Depreciation")
  if (input.amountMinor === 0) throw new Error("Depreciation amount must be greater than zero.")
  return validateJournal({
    ...input,
    lines: [
      accountLine(input.depreciationExpenseAccount, input.amountMinor, 0, "Depreciation expense"),
      accountLine(input.accumulatedDepreciationAccount, 0, input.amountMinor, "Accumulated depreciation"),
    ],
  })
}

export function buildAssetDisposalJournal(input: Omit<JournalDraft, "lines"> & {
  originalCostMinor: number
  accumulatedDepreciationMinor: number
  proceedsMinor: number
  assetAccount: AccountingAccount
  accumulatedDepreciationAccount: AccountingAccount
  settlementAccount: AccountingAccount
  gainAccount: AccountingAccount
  lossAccount: AccountingAccount
}) {
  for (const [label, value] of [["Original cost", input.originalCostMinor], ["Accumulated depreciation", input.accumulatedDepreciationMinor], ["Disposal proceeds", input.proceedsMinor]] as const) assertNonNegativeMinor(value, label)
  if (input.originalCostMinor <= 0) throw new Error("Asset original cost must be greater than zero.")
  if (input.accumulatedDepreciationMinor > input.originalCostMinor) throw new Error("Accumulated depreciation cannot exceed asset cost.")
  const writtenDownValueMinor = input.originalCostMinor - input.accumulatedDepreciationMinor
  const gainMinor = Math.max(0, input.proceedsMinor - writtenDownValueMinor)
  const lossMinor = Math.max(0, writtenDownValueMinor - input.proceedsMinor)
  const lines: JournalLine[] = []
  if (input.proceedsMinor) lines.push(accountLine(input.settlementAccount, input.proceedsMinor, 0, "Asset disposal proceeds"))
  if (input.accumulatedDepreciationMinor) lines.push(accountLine(input.accumulatedDepreciationAccount, input.accumulatedDepreciationMinor, 0, "Accumulated depreciation removed"))
  if (lossMinor) lines.push(accountLine(input.lossAccount, lossMinor, 0, "Loss on asset disposal"))
  lines.push(accountLine(input.assetAccount, 0, input.originalCostMinor, "Asset cost removed"))
  if (gainMinor) lines.push(accountLine(input.gainAccount, 0, gainMinor, "Gain on asset disposal"))
  return { journal: validateJournal({ ...input, lines }), writtenDownValueMinor, gainMinor, lossMinor }
}

export function buildTdsJournal(input: Omit<JournalDraft, "lines"> & {
  mode: TaxPostingMode
  taxableMinor: number
  rateBasisPoints: number
  tdsMinor?: number
  supplierId: string
  expenseAccount: AccountingAccount
  accountsPayableAccount: AccountingAccount
  tdsPayableAccount: AccountingAccount
  settlementAccount?: AccountingAccount
}) {
  const calculatedMinor = taxAmountMinor(input.taxableMinor, input.rateBasisPoints)
  const tdsMinor = input.tdsMinor === undefined ? calculatedMinor : input.tdsMinor
  assertNonNegativeMinor(tdsMinor, "TDS")
  if (!tdsMinor || tdsMinor > input.taxableMinor) throw new Error("TDS must be greater than zero and cannot exceed the taxable amount.")
  if (Math.abs(calculatedMinor - tdsMinor) > 1) throw new Error("TDS amount does not match the configured rate and taxable basis.")
  const party = { type: "supplier" as const, id: input.supplierId }
  const lines = input.mode === "EXPENSE_ACCRUAL"
    ? [
        accountLine(input.expenseAccount, input.taxableMinor, 0, "Expense subject to TDS", party),
        accountLine(input.accountsPayableAccount, 0, input.taxableMinor - tdsMinor, "Net supplier payable", party),
        accountLine(input.tdsPayableAccount, 0, tdsMinor, "TDS payable"),
      ]
    : [
        accountLine(input.accountsPayableAccount, input.taxableMinor, 0, "Supplier liability settled with TDS", party),
        accountLine(input.settlementAccount || input.accountsPayableAccount, 0, input.taxableMinor - tdsMinor, "Net payment to supplier", party),
        accountLine(input.tdsPayableAccount, 0, tdsMinor, "TDS payable"),
      ]
  return { journal: validateJournal({ ...input, lines }), calculatedMinor, tdsMinor, netPartyMinor: input.taxableMinor - tdsMinor }
}

export function buildTcsJournal(input: Omit<JournalDraft, "lines"> & {
  taxableMinor: number
  rateBasisPoints: number
  tcsMinor?: number
  customerId: string
  receivableAccount: AccountingAccount
  tcsPayableAccount: AccountingAccount
}) {
  const calculatedMinor = taxAmountMinor(input.taxableMinor, input.rateBasisPoints)
  const tcsMinor = input.tcsMinor === undefined ? calculatedMinor : input.tcsMinor
  assertNonNegativeMinor(tcsMinor, "TCS")
  if (!tcsMinor) throw new Error("TCS amount must be greater than zero.")
  if (Math.abs(calculatedMinor - tcsMinor) > 1) throw new Error("TCS amount does not match the configured rate and taxable basis.")
  const party = { type: "customer" as const, id: input.customerId }
  return {
    journal: validateJournal({
      ...input,
      lines: [
        accountLine(input.receivableAccount, tcsMinor, 0, "TCS receivable from customer", party),
        accountLine(input.tcsPayableAccount, 0, tcsMinor, "TCS payable to government"),
      ],
    }),
    calculatedMinor,
    tcsMinor,
  }
}

export type ImportedGstRecord = {
  id: string
  gstin: string
  invoiceNumber: string
  invoiceDate: string
  taxableMinor: number
  cgstMinor: number
  sgstMinor: number
  igstMinor: number
  cessMinor?: number
}

export function normalizeInvoiceReference(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
}

export function classifyGstReconciliation(book: ImportedGstRecord | null, imported: ImportedGstRecord | null) {
  if (!book) return { classification: "MISSING_IN_BOOKS" as const, score: 0 }
  if (!imported) return { classification: "MISSING_IN_IMPORTED_DATA" as const, score: 0 }
  const invoiceMatch = normalizeInvoiceReference(book.invoiceNumber) === normalizeInvoiceReference(imported.invoiceNumber)
  const gstinMatch = book.gstin.trim().toUpperCase() === imported.gstin.trim().toUpperCase()
  const dateMatch = book.invoiceDate === imported.invoiceDate
  const valueMatch = book.taxableMinor === imported.taxableMinor
  const taxMatch = book.cgstMinor === imported.cgstMinor && book.sgstMinor === imported.sgstMinor && book.igstMinor === imported.igstMinor && (book.cessMinor || 0) === (imported.cessMinor || 0)
  const score = [invoiceMatch, gstinMatch, dateMatch, valueMatch, taxMatch].filter(Boolean).length
  if (score === 5) return { classification: "EXACT_MATCH" as const, score }
  if (!valueMatch) return { classification: "VALUE_MISMATCH" as const, score }
  if (!taxMatch) return { classification: "TAX_MISMATCH" as const, score }
  if (!dateMatch) return { classification: "DATE_MISMATCH" as const, score }
  if (invoiceMatch && gstinMatch) return { classification: "PROBABLE_MATCH" as const, score }
  return { classification: "NEEDS_REVIEW" as const, score }
}

export function validateEInvoicePreparation(input: Record<string, unknown>) {
  const errors: Array<{ field: string; message: string }> = []
  const required = ["supplier_gstin", "recipient_gstin", "document_number", "document_date", "document_type", "place_of_supply"]
  for (const field of required) if (!String(input[field] || "").trim()) errors.push({ field, message: `${field.replaceAll("_", " ")} is required.` })
  for (const field of ["supplier_gstin", "recipient_gstin"]) {
    const value = String(input[field] || "")
    if (value && !validateGstinFormat(value).valid) errors.push({ field, message: validateGstinFormat(value).reason })
  }
  if (input.document_date) {
    try { strictDate(String(input.document_date), "Document date") } catch (error) { errors.push({ field: "document_date", message: error instanceof Error ? error.message : "Document date is invalid." }) }
  }
  const lines = Array.isArray(input.lines) ? input.lines as Array<Record<string, unknown>> : []
  if (!lines.length) errors.push({ field: "lines", message: "At least one invoice line is required." })
  lines.forEach((line, index) => {
    for (const field of ["hsn", "quantity", "unit", "taxable_minor"]) if (line[field] === null || line[field] === undefined || line[field] === "") errors.push({ field: `lines.${index}.${field}`, message: `Line ${index + 1} ${field.replaceAll("_", " ")} is required.` })
    const taxable = Number(line.taxable_minor)
    for (const field of ["taxable_minor", "cgst_minor", "sgst_minor", "igst_minor", "cess_minor"]) {
      if (line[field] !== undefined && (!Number.isSafeInteger(Number(line[field])) || Number(line[field]) < 0)) errors.push({ field: `lines.${index}.${field}`, message: `Line ${index + 1} has an invalid ${field.replaceAll("_", " ")}.` })
    }
    if (!Number.isSafeInteger(taxable) || taxable <= 0) errors.push({ field: `lines.${index}.taxable_minor`, message: `Line ${index + 1} taxable value must be greater than zero.` })
    if (Number(line.igst_minor || 0) && (Number(line.cgst_minor || 0) || Number(line.sgst_minor || 0))) errors.push({ field: `lines.${index}.tax`, message: `Line ${index + 1} cannot mix IGST with CGST/SGST.` })
  })
  return { valid: errors.length === 0, errors, integrationStatus: "NOT_CONFIGURED" as const }
}

export function validateEwayBillPreparation(input: Record<string, unknown>) {
  const errors: Array<{ field: string; message: string }> = []
  for (const field of ["document_reference", "transaction_type", "transport_mode", "origin", "destination"]) {
    if (!String(input[field] || "").trim()) errors.push({ field, message: `${field.replaceAll("_", " ")} is required.` })
  }
  const distance = Number(input.distance_km)
  if (!Number.isFinite(distance) || distance <= 0 || distance > 4_000) errors.push({ field: "distance_km", message: "Transport distance must be between 1 and 4,000 km." })
  if (String(input.transport_mode || "").toUpperCase() === "ROAD" && !String(input.vehicle_number || "").trim()) errors.push({ field: "vehicle_number", message: "Vehicle number is required for road transport." })
  return { valid: errors.length === 0, errors, integrationStatus: "NOT_CONFIGURED" as const }
}

export function budgetVariance(budgetMinor: number, actualMinor: number) {
  assertNonNegativeMinor(budgetMinor, "Budget")
  if (!Number.isSafeInteger(actualMinor)) throw new Error("Actual amount is invalid.")
  const varianceMinor = budgetMinor - actualMinor
  const varianceBasisPoints = budgetMinor === 0 ? null : Number((BigInt(varianceMinor) * BigInt(10_000)) / BigInt(budgetMinor))
  return { budgetMinor, actualMinor, varianceMinor, varianceBasisPoints }
}

export function schedulePeriods(from: string, to: string) {
  const start = strictDate(from, "Schedule start")
  const end = strictDate(to, "Schedule end")
  if (end < start) throw new Error("Schedule end cannot be before schedule start.")
  const periods: Array<{ from: string; to: string }> = []
  let cursor = new Date(start)
  while (cursor.getTime() <= end) {
    const periodStart = cursor.getTime()
    const monthEnd = Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)
    const periodEnd = Math.min(monthEnd, end)
    periods.push({ from: isoDate(periodStart), to: isoDate(periodEnd) })
    cursor = new Date(periodEnd + DAY_MS)
  }
  return periods
}

export type PhaseThreeJournalResult = ValidatedJournal
