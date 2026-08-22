export const DEFAULT_FISCAL_START_MONTH = 4

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

export function isoLocalDate(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
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

export function closeConfirmation(year: Pick<FinancialYear, "label">) {
  return `CLOSE ${year.label.replace("\u2013", "-")}`
}

export function reopenConfirmation(year: Pick<FinancialYear, "label">) {
  return `REOPEN ${year.label.replace("\u2013", "-")}`
}
