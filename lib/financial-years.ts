export const DEFAULT_FISCAL_START_MONTH = 4
export const DEFAULT_BUSINESS_TIME_ZONE = "Asia/Kolkata"

export type FinancialYearDomainErrorCode =
  | "NEXT_FINANCIAL_YEAR_NOT_STARTED"
  | "FUTURE_FINANCIAL_YEAR_POSTING_NOT_ALLOWED"
  | "HISTORICAL_FINANCIAL_YEAR_READ_ONLY"
  | "FINANCIAL_YEAR_NOT_OPERATIONAL"
  | "FINANCIAL_YEAR_NOT_ENDED"
  | "FINANCIAL_YEAR_REPAIR_REVIEW_REQUIRED"

export class FinancialYearDomainError extends Error {
  constructor(readonly code: FinancialYearDomainErrorCode, message: string) {
    super(message)
    this.name = "FinancialYearDomainError"
  }
}

export type FinancialYearStatus = "OPEN" | "CLOSED" | "ARCHIVED"
export type InvoiceNumberingMode = "CONTINUE" | "RESTART"

export type FinancialYear = {
  id: string
  organization_id: string
  label: string
  start_date: string
  end_date: string
  start_month: number
  status: FinancialYearStatus
  is_active: number | boolean
  previous_financial_year_id?: string | null
  invoice_numbering_mode: InvoiceNumberingMode
  created_at: string
  closed_at?: string | null
  reopened_at?: string | null
  reopen_reason?: string | null
  close_backup_path?: string | null
  opening_snapshot_json?: string | null
  close_summary_json?: string | null
  schema_version: number
}

function pad(value: number) {
  return String(value).padStart(2, "0")
}

export function isoLocalDate(date = new Date(), timeZone = DEFAULT_BUSINESS_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

export function normalizeLocalDate(value: string | Date) {
  if (value instanceof Date) return isoLocalDate(value)
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) throw new Error("Enter a valid transaction date in YYYY-MM-DD format.")
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const candidate = new Date(year, month - 1, day, 12)
  if (candidate.getFullYear() !== year || candidate.getMonth() !== month - 1 || candidate.getDate() !== day) {
    throw new Error("Enter a valid transaction date.")
  }
  return `${year}-${pad(month)}-${pad(day)}`
}

export function fiscalStartYear(value: string | Date, startMonth = DEFAULT_FISCAL_START_MONTH) {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) throw new Error("Fiscal start month must be between 1 and 12.")
  const iso = normalizeLocalDate(value)
  const year = Number(iso.slice(0, 4))
  const month = Number(iso.slice(5, 7))
  return month >= startMonth ? year : year - 1
}

export function financialYearLabel(startYear: number) {
  return `FY ${startYear}\u2013${pad((startYear + 1) % 100)}`
}

export function financialYearId(organizationId: string, startYear: number, startMonth = DEFAULT_FISCAL_START_MONTH) {
  return `fy:${organizationId}:${startYear}:${startMonth}`
}

export function financialYearIdForDate(organizationId: string, value: string | Date, startMonth = DEFAULT_FISCAL_START_MONTH) {
  return financialYearId(organizationId, fiscalStartYear(value, startMonth), startMonth)
}

export function financialYearRange(startYear: number, startMonth = DEFAULT_FISCAL_START_MONTH) {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) throw new Error("Fiscal start month must be between 1 and 12.")
  const endMonth = startMonth === 1 ? 12 : startMonth - 1
  const endYear = startMonth === 1 ? startYear : startYear + 1
  const endDay = new Date(endYear, endMonth, 0, 12).getDate()
  return {
    startDate: `${startYear}-${pad(startMonth)}-01`,
    endDate: `${endYear}-${pad(endMonth)}-${pad(endDay)}`,
  }
}

export function financialYearForDate(organizationId: string, value: string | Date, startMonth = DEFAULT_FISCAL_START_MONTH) {
  const startYear = fiscalStartYear(value, startMonth)
  const range = financialYearRange(startYear, startMonth)
  return {
    id: financialYearId(organizationId, startYear, startMonth),
    organizationId,
    label: financialYearLabel(startYear),
    startYear,
    startMonth,
    ...range,
  }
}

export function nextFinancialYear(year: Pick<FinancialYear, "organization_id" | "start_date" | "start_month">) {
  const startYear = Number(year.start_date.slice(0, 4)) + 1
  const startMonth = Number(year.start_month || DEFAULT_FISCAL_START_MONTH)
  const range = financialYearRange(startYear, startMonth)
  return {
    id: financialYearId(year.organization_id, startYear, startMonth),
    organizationId: year.organization_id,
    label: financialYearLabel(startYear),
    startYear,
    startMonth,
    ...range,
  }
}

export function dateBelongsToFinancialYear(value: string | Date, year: Pick<FinancialYear, "start_date" | "end_date">) {
  const date = normalizeLocalDate(value)
  return date >= year.start_date && date <= year.end_date
}

export function formatFinancialYearDate(value: string) {
  const date = normalizeLocalDate(value)
  const [year, month, day] = date.split("-").map(Number)
  return new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(year, month - 1, day, 12))
}

export function formatFinancialYearStartDate(value: string) {
  const date = normalizeLocalDate(value)
  const [year, month, day] = date.split("-").map(Number)
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric" }).format(new Date(year, month - 1, day, 12))
}

export function financialYearHasStarted(
  year: Pick<FinancialYear, "start_date"> | Pick<ReturnType<typeof financialYearForDate>, "startDate">,
  currentDate: string | Date = new Date()
) {
  const startDate = "start_date" in year ? year.start_date : year.startDate
  return normalizeLocalDate(currentDate) >= normalizeLocalDate(startDate)
}

export function financialYearIsCurrent(
  year: Pick<FinancialYear, "start_date" | "end_date">,
  currentDate: string | Date = new Date()
) {
  const today = normalizeLocalDate(currentDate)
  return today >= year.start_date && today <= year.end_date
}

export function assertFinancialYearCanStart(
  year: Pick<FinancialYear, "label" | "start_date"> | { label: string; startDate: string },
  currentDate: string | Date = new Date()
) {
  const startDate = "start_date" in year ? year.start_date : year.startDate
  if (normalizeLocalDate(currentDate) < startDate) {
    throw new FinancialYearDomainError(
      "NEXT_FINANCIAL_YEAR_NOT_STARTED",
      `${year.label} can be created from ${formatFinancialYearStartDate(startDate)}.`
    )
  }
}

export function assertOperationalTransactionDate(
  value: string | Date,
  currentDate: string | Date = new Date(),
  startMonth = DEFAULT_FISCAL_START_MONTH
) {
  const transactionDate = normalizeLocalDate(value)
  const today = normalizeLocalDate(currentDate)
  const transactionStartYear = fiscalStartYear(transactionDate, startMonth)
  const currentStartYear = fiscalStartYear(today, startMonth)
  if (transactionStartYear > currentStartYear) {
    const year = financialYearForDate("business", transactionDate, startMonth)
    throw new FinancialYearDomainError(
      "FUTURE_FINANCIAL_YEAR_POSTING_NOT_ALLOWED",
      `${year.label} has not started. Transactions for it can be entered from ${formatFinancialYearStartDate(year.startDate)}.`
    )
  }
  if (transactionStartYear < currentStartYear) {
    const year = financialYearForDate("business", transactionDate, startMonth)
    throw new FinancialYearDomainError(
      "HISTORICAL_FINANCIAL_YEAR_READ_ONLY",
      `${year.label} is a historical year. New transactions must be entered in the current operational financial year.`
    )
  }
  return transactionDate
}

export function closeConfirmation(year: Pick<FinancialYear, "label">) {
  return `CLOSE ${year.label.replace("\u2013", "-")}`
}

export function reopenConfirmation(year: Pick<FinancialYear, "label">) {
  return `REOPEN ${year.label.replace("\u2013", "-")}`
}
