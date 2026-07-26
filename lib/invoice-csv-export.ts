"use client"

import { escapeCsvCell, saveDesktopBytes } from "@/lib/desktop-file-export"
import { getOfflineData } from "@/lib/offline/db"

export type DataRow = Record<string, unknown> & { id?: string }

export type InvoiceDatePreset =
  | "all"
  | "today"
  | "yesterday"
  | "this-week"
  | "last-7-days"
  | "this-month"
  | "previous-month"
  | "financial-year"
  | "custom"

export type InvoiceExportFilters = {
  datePreset?: InvoiceDatePreset | "week" | "month"
  period?: string
  fromDate?: string
  toDate?: string
  statuses?: string[]
  status?: string
  customerIds?: string[]
  customerId?: string
  customerSearch?: string
  paymentMethods?: string[]
  invoiceType?: "all" | "gst" | "non-gst"
  minimumAmount?: number | null
  maximumAmount?: number | null
  invoiceNumberFrom?: string
  invoiceNumberTo?: string
  search?: string
  risk?: string
  includeCancelled?: boolean
  includeArchived?: boolean
}

export type InvoiceExportOptions = {
  mode: "summary" | "detailed"
  includeCustomerContacts: boolean
  includeGstBreakdown: boolean
  includePaymentDetails: boolean
  includeNotes: boolean
  includeTimestamps: boolean
}

export type InvoiceExportRow = {
  invoiceId: string
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  customerName: string
  customerPhone: string
  customerEmail: string
  customerGstin: string
  invoiceStatus: string
  paymentStatus: string
  paymentMethod: string
  invoiceType: string
  subtotal: number
  discount: number
  taxableValue: number
  cgst: number
  sgst: number
  igst: number
  totalGst: number
  roundOff: number
  grandTotal: number
  paidAmount: number
  dueAmount: number
  notes: string
  createdAt: string
  updatedAt: string
  itemNumber?: number
  productName?: string
  hsnSac?: string
  quantity?: number
  freeQuantity?: number
  unit?: string
  rate?: number
  lineDiscount?: number
  lineTaxable?: number
  lineCgst?: number
  lineSgst?: number
  lineIgst?: number
  lineTotal?: number
}

export type InvoiceExportSummary = {
  invoiceCount: number
  taxableAmount: number
  cgst: number
  sgst: number
  igst: number
  totalGst: number
  grandTotal: number
  paidAmount: number
  outstandingAmount: number
  collectionRate: number
}

export type InvoiceExportDataset = {
  businessName: string
  organization: DataRow | null
  rows: InvoiceExportRow[]
  invoiceRows: InvoiceExportRow[]
  summary: InvoiceExportSummary
  periodLabel: string
  filtersLabel: string
  filenameStem: string
}

export const defaultInvoiceExportOptions: InvoiceExportOptions = {
  mode: "summary",
  includeCustomerContacts: true,
  includeGstBreakdown: true,
  includePaymentDetails: true,
  includeNotes: false,
  includeTimestamps: false,
}

function stringFrom(row: DataRow | null | undefined, fields: string[]) {
  if (!row) return ""
  for (const field of fields) {
    const value = row[field]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function numberFrom(row: DataRow | null | undefined, fields: string[]) {
  if (!row) return 0
  for (const field of fields) {
    const value = row[field]
    if (value !== null && value !== undefined && value !== "") {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return 0
}

function roundMoney(value: number) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100
}

function dateOnly(value: string) {
  if (!value) return ""
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (match) return `${match[1]}-${match[2]}-${match[3]}`
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10)
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, "0")
  const day = String(parsed.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function displayDate(value: string) {
  const normalized = dateOnly(value)
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return match ? `${match[3]}/${match[2]}/${match[1]}` : normalized || "-"
}

function localDate(value: string) {
  const normalized = dateOnly(value)
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0)
}

function ymd(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
}

export function resolveInvoiceDateRange(filters: InvoiceExportFilters, now = new Date()) {
  const requested = filters.datePreset || (filters.period as InvoiceDatePreset | undefined) || "all"
  const preset = requested === "week" ? "last-7-days" : requested === "month" ? "this-month" : requested
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)
  let from: Date | null = null
  let to: Date | null = null

  if (preset === "today") from = to = startOfToday
  if (preset === "yesterday") {
    from = new Date(startOfToday)
    from.setDate(from.getDate() - 1)
    to = new Date(from)
  }
  if (preset === "this-week") {
    const mondayOffset = (startOfToday.getDay() + 6) % 7
    from = new Date(startOfToday)
    from.setDate(from.getDate() - mondayOffset)
    to = startOfToday
  }
  if (preset === "last-7-days") {
    from = new Date(startOfToday)
    from.setDate(from.getDate() - 6)
    to = startOfToday
  }
  if (preset === "this-month") {
    from = new Date(now.getFullYear(), now.getMonth(), 1, 12)
    to = startOfToday
  }
  if (preset === "previous-month") {
    from = new Date(now.getFullYear(), now.getMonth() - 1, 1, 12)
    to = new Date(now.getFullYear(), now.getMonth(), 0, 12)
  }
  if (preset === "financial-year") {
    const startYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1
    from = new Date(startYear, 3, 1, 12)
    to = startOfToday
  }
  if (preset === "custom") {
    from = filters.fromDate ? localDate(filters.fromDate) : null
    to = filters.toDate ? localDate(filters.toDate) : null
  }

  return {
    preset,
    from: from ? ymd(from) : "",
    to: to ? ymd(to) : "",
    label: from || to ? `${displayDate(from ? ymd(from) : "")} to ${displayDate(to ? ymd(to) : "")}` : "All time",
  }
}

function riskState(invoice: DataRow, now = new Date()) {
  const status = stringFrom(invoice, ["payment_status", "status"]).toLowerCase()
  if (status === "paid") return "paid"
  const due = localDate(stringFrom(invoice, ["due_date"]))
  if (!due) return "open"
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)
  if (due < today) return "overdue"
  const soon = new Date(today)
  soon.setDate(soon.getDate() + 7)
  return due <= soon ? "due-soon" : "open"
}

function normalizedPaymentStatus(invoice: DataRow) {
  const value = stringFrom(invoice, ["payment_status", "status"]).toLowerCase()
  if (value === "partially paid" || value === "partially_paid") return "partial"
  return value || "unpaid"
}

function normalizedPaymentMethod(value: string) {
  const compact = value.toLowerCase().replace(/[\s_-]+/g, "")
  if (compact === "bank" || compact === "banktransfer" || compact === "neft" || compact === "rtgs") return "banktransfer"
  if (compact === "creditcard" || compact === "debitcard" || compact === "card") return "card"
  if (compact === "cash") return "cash"
  if (compact === "upi") return "upi"
  if (compact === "credit") return "credit"
  return compact || "other"
}

function invoiceTaxValues(invoice: DataRow, invoiceItems: DataRow[]) {
  const totalTax = numberFrom(invoice, ["tax_amount", "tax_total", "gst_amount"])
  const itemCgst = invoiceItems.reduce((sum, item) => sum + numberFrom(item, ["cgst_amount"]), 0)
  const itemSgst = invoiceItems.reduce((sum, item) => sum + numberFrom(item, ["sgst_amount"]), 0)
  const itemIgst = invoiceItems.reduce((sum, item) => sum + numberFrom(item, ["igst_amount"]), 0)
  let cgst = numberFrom(invoice, ["cgst_amount", "cgst_total"]) || itemCgst
  let sgst = numberFrom(invoice, ["sgst_amount", "sgst_total"]) || itemSgst
  const igst = numberFrom(invoice, ["igst_amount", "igst_total"]) || itemIgst
  if (!cgst && !sgst && !igst && totalTax) {
    cgst = totalTax / 2
    sgst = totalTax / 2
  }
  return {
    cgst: roundMoney(cgst),
    sgst: roundMoney(sgst),
    igst: roundMoney(igst),
    totalGst: roundMoney(cgst + sgst + igst || totalTax),
  }
}

function invoiceMatches(
  invoice: DataRow,
  customer: DataRow | undefined,
  invoiceItems: DataRow[],
  filters: InvoiceExportFilters,
  now: Date
) {
  if (invoice.deleted_at && !filters.includeArchived) return false
  const paymentStatus = normalizedPaymentStatus(invoice)
  const statuses = filters.statuses?.length
    ? filters.statuses.map((status) => status.toLowerCase())
    : filters.status && filters.status !== "all"
      ? [filters.status.toLowerCase()]
      : []
  const risk = riskState(invoice, now)
  if (statuses.length && !statuses.some((status) => status === paymentStatus || status === risk)) return false
  if (!filters.includeCancelled && paymentStatus === "cancelled" && !statuses.includes("cancelled")) return false
  if (filters.risk && filters.risk !== "all" && risk !== filters.risk) return false

  const range = resolveInvoiceDateRange(filters, now)
  const invoiceDate = dateOnly(stringFrom(invoice, ["invoice_date", "date", "created_at"]))
  if (range.from && invoiceDate < range.from) return false
  if (range.to && invoiceDate > range.to) return false

  const selectedCustomers = filters.customerIds?.length
    ? filters.customerIds
    : filters.customerId && filters.customerId !== "all"
      ? [filters.customerId]
      : []
  if (selectedCustomers.length && !selectedCustomers.includes(stringFrom(invoice, ["customer_id"]))) return false

  const customerTerm = filters.customerSearch?.trim().toLowerCase() || ""
  if (customerTerm) {
    const customerText = [
      stringFrom(customer, ["name"]),
      stringFrom(customer, ["phone"]),
      stringFrom(customer, ["email"]),
      stringFrom(customer, ["gst_number", "gstin", "tax_id"]),
      stringFrom(invoice, ["customer_name"]),
    ].join(" ").toLowerCase()
    if (!customerText.includes(customerTerm)) return false
  }

  const methods = (filters.paymentMethods || []).map(normalizedPaymentMethod)
  if (methods.length) {
    const actualMethod = normalizedPaymentMethod(stringFrom(invoice, ["payment_method"]))
    const known = new Set(["cash", "card", "upi", "banktransfer", "credit"])
    const matchesOther = methods.includes("other") && !known.has(actualMethod)
    if (!methods.includes(actualMethod) && !matchesOther) return false
  }

  const total = numberFrom(invoice, ["grand_total", "total_amount", "total"])
  if (filters.minimumAmount !== null && filters.minimumAmount !== undefined && total < filters.minimumAmount) return false
  if (filters.maximumAmount !== null && filters.maximumAmount !== undefined && total > filters.maximumAmount) return false

  const invoiceNumber = stringFrom(invoice, ["invoice_number"])
  if (filters.invoiceNumberFrom && invoiceNumber.localeCompare(filters.invoiceNumberFrom, undefined, { numeric: true }) < 0) return false
  if (filters.invoiceNumberTo && invoiceNumber.localeCompare(filters.invoiceNumberTo, undefined, { numeric: true }) > 0) return false

  const search = filters.search?.trim().toLowerCase() || ""
  if (search) {
    const searchable = [
      invoiceNumber,
      stringFrom(invoice, ["notes"]),
      stringFrom(invoice, ["payment_method"]),
      stringFrom(customer, ["name", "phone", "email", "gst_number", "gstin"]),
    ].join(" ").toLowerCase()
    if (!searchable.includes(search)) return false
  }

  const tax = invoiceTaxValues(invoice, invoiceItems).totalGst
  if (filters.invoiceType === "gst" && tax <= 0) return false
  if (filters.invoiceType === "non-gst" && tax > 0) return false
  return true
}

function buildSummaryRow(invoice: DataRow, customer: DataRow | undefined, invoiceItems: DataRow[]): InvoiceExportRow {
  const subtotal = numberFrom(invoice, ["subtotal", "sub_total"])
  const discount = numberFrom(invoice, ["discount_amount", "discount_total"])
  const tax = invoiceTaxValues(invoice, invoiceItems)
  const grandTotal = numberFrom(invoice, ["grand_total", "total_amount", "total"])
  const taxableValue = numberFrom(invoice, ["taxable_amount", "taxable_value"]) || Math.max(0, subtotal - discount) || Math.max(0, grandTotal - tax.totalGst)
  const paymentStatus = normalizedPaymentStatus(invoice)
  const paidAmount = numberFrom(invoice, ["paid_amount"]) || (paymentStatus === "paid" ? grandTotal : 0)
  const dueAmount = numberFrom(invoice, ["outstanding_amount", "due_amount"]) || Math.max(0, grandTotal - paidAmount)
  return {
    invoiceId: String(invoice.id || ""),
    invoiceNumber: stringFrom(invoice, ["invoice_number"]),
    invoiceDate: dateOnly(stringFrom(invoice, ["invoice_date", "date", "created_at"])),
    dueDate: dateOnly(stringFrom(invoice, ["due_date"])),
    customerName: stringFrom(customer, ["name"]) || stringFrom(invoice, ["customer_name"]) || "Walk-in customer",
    customerPhone: stringFrom(customer, ["phone"]) || stringFrom(invoice, ["customer_phone"]),
    customerEmail: stringFrom(customer, ["email"]) || stringFrom(invoice, ["customer_email"]),
    customerGstin: stringFrom(customer, ["gst_number", "gstin", "tax_id"]),
    invoiceStatus: stringFrom(invoice, ["status"]) || paymentStatus,
    paymentStatus,
    paymentMethod: stringFrom(invoice, ["payment_method"]) || "Other",
    invoiceType: tax.totalGst > 0 ? "GST" : "Non-GST",
    subtotal: roundMoney(subtotal || taxableValue + discount),
    discount: roundMoney(discount),
    taxableValue: roundMoney(taxableValue),
    ...tax,
    roundOff: roundMoney(numberFrom(invoice, ["round_off"])),
    grandTotal: roundMoney(grandTotal),
    paidAmount: roundMoney(Math.min(grandTotal, paidAmount)),
    dueAmount: roundMoney(Math.max(0, dueAmount)),
    notes: stringFrom(invoice, ["notes"]),
    createdAt: stringFrom(invoice, ["created_at"]),
    updatedAt: stringFrom(invoice, ["updated_at"]),
  }
}

export function buildInvoiceExportRows(
  invoices: DataRow[],
  customers: DataRow[],
  items: DataRow[],
  filters: InvoiceExportFilters = {},
  options: InvoiceExportOptions = defaultInvoiceExportOptions,
  now = new Date()
) {
  const customerById = new Map(customers.map((customer) => [String(customer.id || ""), customer]))
  const itemsByInvoice = new Map<string, DataRow[]>()
  for (const item of items) {
    const invoiceId = stringFrom(item, ["invoice_id"])
    if (!invoiceId) continue
    itemsByInvoice.set(invoiceId, [...(itemsByInvoice.get(invoiceId) || []), item])
  }

  const invoiceRows: InvoiceExportRow[] = []
  const rows: InvoiceExportRow[] = []
  for (const invoice of invoices) {
    const customer = customerById.get(stringFrom(invoice, ["customer_id"]))
    const invoiceItems = itemsByInvoice.get(String(invoice.id || "")) || []
    if (!invoiceMatches(invoice, customer, invoiceItems, filters, now)) continue
    const summary = buildSummaryRow(invoice, customer, invoiceItems)
    invoiceRows.push(summary)
    if (options.mode !== "detailed") {
      rows.push(summary)
      continue
    }
    if (!invoiceItems.length) {
      rows.push(summary)
      continue
    }
    invoiceItems.forEach((item, index) => {
      const quantity = numberFrom(item, ["quantity"])
      const rate = numberFrom(item, ["unit_price", "rate"])
      const discountPercent = numberFrom(item, ["discount_percent"])
      const lineDiscount = numberFrom(item, ["discount_amount"]) || quantity * rate * discountPercent / 100
      const lineTaxable = numberFrom(item, ["taxable_value", "line_total"]) || Math.max(0, quantity * rate - lineDiscount)
      const lineCgst = numberFrom(item, ["cgst_amount"])
      const lineSgst = numberFrom(item, ["sgst_amount"])
      const lineIgst = numberFrom(item, ["igst_amount"])
      const lineTax = numberFrom(item, ["gst_amount", "tax_amount"]) || lineCgst + lineSgst + lineIgst
      rows.push({
        ...summary,
        itemNumber: index + 1,
        productName: stringFrom(item, ["product_name", "name"]) || "Product",
        hsnSac: stringFrom(item, ["hsn_code", "hsn"]),
        quantity,
        freeQuantity: numberFrom(item, ["free_quantity", "free_qty"]),
        unit: stringFrom(item, ["unit"]) || "PCS",
        rate: roundMoney(rate),
        lineDiscount: roundMoney(lineDiscount),
        lineTaxable: roundMoney(lineTaxable),
        lineCgst: roundMoney(lineCgst || (!lineIgst ? lineTax / 2 : 0)),
        lineSgst: roundMoney(lineSgst || (!lineIgst ? lineTax / 2 : 0)),
        lineIgst: roundMoney(lineIgst),
        lineTotal: roundMoney(numberFrom(item, ["final_amount"]) || lineTaxable + lineTax),
      })
    })
  }
  return Object.assign(rows, { invoiceRows })
}

export function summarizeInvoiceExport(rows: InvoiceExportRow[]): InvoiceExportSummary {
  const unique = new Map(rows.map((row) => [row.invoiceId || row.invoiceNumber, row]))
  const invoiceRows = [...unique.values()]
  const totals = invoiceRows.reduce((summary, row) => ({
    invoiceCount: summary.invoiceCount + 1,
    taxableAmount: summary.taxableAmount + row.taxableValue,
    cgst: summary.cgst + row.cgst,
    sgst: summary.sgst + row.sgst,
    igst: summary.igst + row.igst,
    totalGst: summary.totalGst + row.totalGst,
    grandTotal: summary.grandTotal + row.grandTotal,
    paidAmount: summary.paidAmount + row.paidAmount,
    outstandingAmount: summary.outstandingAmount + row.dueAmount,
    collectionRate: 0,
  }), {
    invoiceCount: 0,
    taxableAmount: 0,
    cgst: 0,
    sgst: 0,
    igst: 0,
    totalGst: 0,
    grandTotal: 0,
    paidAmount: 0,
    outstandingAmount: 0,
    collectionRate: 0,
  })
  Object.keys(totals).forEach((key) => {
    if (key !== "invoiceCount" && key !== "collectionRate") {
      totals[key as keyof InvoiceExportSummary] = roundMoney(totals[key as keyof InvoiceExportSummary])
    }
  })
  totals.collectionRate = totals.grandTotal ? roundMoney(totals.paidAmount / totals.grandTotal * 100) : 0
  return totals
}

function safeFilenamePart(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "Business"
}

function filtersLabel(filters: InvoiceExportFilters) {
  const statuses = filters.statuses?.length ? filters.statuses.join(", ") : filters.status && filters.status !== "all" ? filters.status : "All invoices"
  const customers = filters.customerIds?.length || (filters.customerId && filters.customerId !== "all") ? "Selected customer" : "All customers"
  const payments = filters.paymentMethods?.length ? filters.paymentMethods.join(", ") : "All payment methods"
  return `${statuses} | ${customers} | ${payments}`
}

export async function loadInvoiceExportDataset(
  organizationId: string,
  filters: InvoiceExportFilters = {},
  options: InvoiceExportOptions = defaultInvoiceExportOptions,
  now = new Date()
): Promise<InvoiceExportDataset> {
  const [invoices, customers, items, organizationValue] = await Promise.all([
    getOfflineData<DataRow[]>(organizationId, "invoices", []),
    getOfflineData<DataRow[]>(organizationId, "customers", []),
    getOfflineData<DataRow[]>(organizationId, "invoice_items", []),
    getOfflineData<DataRow[] | DataRow | null>(organizationId, "organization", null),
  ])
  const organization = Array.isArray(organizationValue) ? organizationValue[0] || null : organizationValue
  const businessName = stringFrom(organization, ["business_name", "name"]) || "Business"
  const built = buildInvoiceExportRows(invoices, customers, items, filters, options, now)
  const invoiceRows = built.invoiceRows || [...new Map(built.map((row) => [row.invoiceId, row])).values()]
  const range = resolveInvoiceDateRange(filters, now)
  const filenameRange = range.from || range.to ? `${range.from || "start"}_to_${range.to || "today"}` : "All-Time"
  return {
    businessName,
    organization,
    rows: [...built],
    invoiceRows,
    summary: summarizeInvoiceExport(invoiceRows),
    periodLabel: range.label,
    filtersLabel: filtersLabel(filters),
    filenameStem: `${safeFilenamePart(businessName)}_Invoice-Register_${filenameRange}`,
  }
}

type CsvColumn = {
  header: string
  value: keyof InvoiceExportRow
  identifier?: boolean
}

function formatIndianDate(value: unknown) {
  const input = String(value ?? "").trim()
  if (!input) return ""
  const dateOnlyMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (dateOnlyMatch) return `${dateOnlyMatch[3]}/${dateOnlyMatch[2]}/${dateOnlyMatch[1]}`
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return input
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date)
}

function formatIndianDateTime(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value ?? ""))
  if (Number.isNaN(date.getTime())) return String(value ?? "")
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value || ""
  return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")} ${part("dayPeriod").toUpperCase()}`
}

function csvValue(value: unknown, identifier = false, column?: keyof InvoiceExportRow) {
  if (typeof value === "number" && Number.isFinite(value)) return String(roundMoney(value))
  if (column === "invoiceDate" || column === "dueDate") return escapeCsvCell(formatIndianDate(value))
  if (column === "createdAt" || column === "updatedAt") return escapeCsvCell(formatIndianDateTime(value))
  return escapeCsvCell(value, identifier)
}

function columnsFor(options: InvoiceExportOptions): CsvColumn[] {
  const columns: CsvColumn[] = [
    { header: "Invoice Number", value: "invoiceNumber", identifier: true },
    { header: "Invoice Date", value: "invoiceDate" },
    { header: "Due Date", value: "dueDate" },
    { header: "Customer Name", value: "customerName" },
  ]
  if (options.includeCustomerContacts) {
    columns.push(
      { header: "Customer Phone", value: "customerPhone", identifier: true },
      { header: "Customer Email", value: "customerEmail" },
      { header: "Customer GSTIN", value: "customerGstin", identifier: true },
    )
  }
  columns.push(
    { header: "Invoice Type", value: "invoiceType" },
    { header: "Payment Status", value: "paymentStatus" },
    { header: "Taxable Value", value: "taxableValue" },
  )
  if (options.includeGstBreakdown) {
    columns.push(
      { header: "CGST", value: "cgst" },
      { header: "SGST", value: "sgst" },
      { header: "IGST", value: "igst" },
      { header: "Total GST", value: "totalGst" },
    )
  }
  columns.push(
    { header: "Grand Total", value: "grandTotal" },
    { header: "Paid Amount", value: "paidAmount" },
    { header: "Outstanding Amount", value: "dueAmount" },
  )
  if (options.includePaymentDetails) columns.splice(9, 0, { header: "Payment Method", value: "paymentMethod" })
  if (options.mode === "detailed") {
    columns.push(
      { header: "Line Number", value: "itemNumber" },
      { header: "Product / Service", value: "productName" },
      { header: "HSN / SAC", value: "hsnSac", identifier: true },
      { header: "Quantity", value: "quantity" },
      { header: "Free Quantity", value: "freeQuantity" },
      { header: "Unit", value: "unit" },
      { header: "Rate", value: "rate" },
      { header: "Line Discount", value: "lineDiscount" },
      { header: "Line Taxable", value: "lineTaxable" },
      { header: "Line CGST", value: "lineCgst" },
      { header: "Line SGST", value: "lineSgst" },
      { header: "Line IGST", value: "lineIgst" },
      { header: "Line Total", value: "lineTotal" },
    )
  }
  if (options.includeNotes) columns.push({ header: "Notes", value: "notes" })
  if (options.includeTimestamps) {
    columns.push(
      { header: "Created At", value: "createdAt" },
      { header: "Updated At", value: "updatedAt" },
    )
  }
  return columns
}

export function buildProfessionalInvoiceCsvText(
  dataset: InvoiceExportDataset,
  options: InvoiceExportOptions = defaultInvoiceExportOptions,
  generatedAt = new Date()
) {
  const summary = dataset.summary
  const lines = [
    `${escapeCsvCell("Business Name:")},${escapeCsvCell(dataset.businessName)}`,
    `${escapeCsvCell("Report:")},${escapeCsvCell(options.mode === "detailed" ? "Detailed Invoice Lines" : "Invoice Register")}`,
    `${escapeCsvCell("Period:")},${escapeCsvCell(dataset.periodLabel)}`,
    `${escapeCsvCell("Generated:")},${escapeCsvCell(formatIndianDateTime(generatedAt))}`,
    `${escapeCsvCell("Filters:")},${escapeCsvCell(dataset.filtersLabel)}`,
    "",
    escapeCsvCell("Summary"),
    [
      "Invoice Count",
      "Total Taxable",
      "CGST",
      "SGST",
      "IGST",
      "Grand Total",
      "Paid",
      "Outstanding",
    ].map((value) => escapeCsvCell(value)).join(","),
    [
      summary.invoiceCount,
      summary.taxableAmount,
      summary.cgst,
      summary.sgst,
      summary.igst,
      summary.grandTotal,
      summary.paidAmount,
      summary.outstandingAmount,
    ].map((value) => csvValue(value)).join(","),
    "",
  ]
  const columns = columnsFor(options)
  lines.push(columns.map((column) => escapeCsvCell(column.header)).join(","))
  for (const row of dataset.rows) {
    lines.push(columns.map((column) => csvValue(row[column.value], column.identifier, column.value)).join(","))
  }
  return lines.join("\r\n")
}

export function buildProfessionalInvoiceCsvBytes(
  dataset: InvoiceExportDataset,
  options: InvoiceExportOptions = defaultInvoiceExportOptions,
  generatedAt = new Date()
) {
  const encoded = new TextEncoder().encode(buildProfessionalInvoiceCsvText(dataset, options, generatedAt))
  const result = new Uint8Array(encoded.length + 3)
  result.set([0xef, 0xbb, 0xbf])
  result.set(encoded, 3)
  return result
}

export async function exportInvoicesCsv(
  organizationId: string,
  filters: InvoiceExportFilters = {},
  options: InvoiceExportOptions = defaultInvoiceExportOptions,
  preparedDataset?: InvoiceExportDataset
) {
  const dataset = preparedDataset || await loadInvoiceExportDataset(organizationId, filters, options)
  if (!dataset.summary.invoiceCount) {
    throw new Error("No invoices match these filters.")
  }
  const filename = `${dataset.filenameStem}.csv`
  const result = await saveDesktopBytes(filename, buildProfessionalInvoiceCsvBytes(dataset, options), "csv")
  return { result, rowCount: dataset.summary.invoiceCount, dataset }
}
