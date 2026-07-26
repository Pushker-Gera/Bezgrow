import { PDFDocument, PageSizes, StandardFonts, rgb, type PDFImage, type PDFPage, type PDFFont } from "pdf-lib"
import { summarizeInvoiceExport, type DataRow, type InvoiceExportDataset, type InvoiceExportRow } from "@/lib/invoice-csv-export"

export type InvoiceReportType =
  | "invoice-register"
  | "sales-summary"
  | "customer-wise-sales"
  | "outstanding-receivables"
  | "gst-summary"
  | "payment-collection"
  | "detailed-lines"

export type InvoiceReportOrientation = "portrait" | "landscape" | "auto"

export type InvoiceReportOptions = {
  reportType: InvoiceReportType
  orientation: InvoiceReportOrientation
  pageSize: "A4" | "Letter"
  includeGstDetails: boolean
  includeLineItems: boolean
  includeCustomerContacts: boolean
  includePaymentSummary: boolean
  includeCharts: boolean
  logoUrl?: string
}

export type InvoiceReportResult = {
  bytes: Uint8Array
  filename: string
  title: string
  period: string
  invoiceCount: number
}

export function datasetForInvoiceReport(dataset: InvoiceExportDataset, reportType: InvoiceReportType) {
  if (reportType !== "outstanding-receivables") return dataset
  const invoiceRows = dataset.invoiceRows.filter((row) => row.dueAmount > 0)
  const invoiceIds = new Set(invoiceRows.map((row) => row.invoiceId))
  return {
    ...dataset,
    rows: dataset.rows.filter((row) => invoiceIds.has(row.invoiceId)),
    invoiceRows,
    summary: summarizeInvoiceExport(invoiceRows),
  }
}

type TableColumn = {
  key: string
  label: string
  ratio: number
  numeric?: boolean
  money?: boolean
}

type ReportRow = Record<string, string | number>

const INK = rgb(0.05, 0.09, 0.16)
const MUTED = rgb(0.34, 0.4, 0.49)
const ACCENT = rgb(0.02, 0.48, 0.62)
const BORDER = rgb(0.82, 0.85, 0.89)
const SOFT = rgb(0.96, 0.97, 0.98)
const WHITE = rgb(1, 1, 1)

const reportTitles: Record<InvoiceReportType, string> = {
  "invoice-register": "Invoice Register",
  "sales-summary": "Sales Summary",
  "customer-wise-sales": "Customer-wise Sales",
  "outstanding-receivables": "Outstanding Receivables",
  "gst-summary": "GST Summary",
  "payment-collection": "Payment Collection Report",
  "detailed-lines": "Detailed Invoice Lines",
}

function safeText(value: unknown) {
  return String(value ?? "")
    .replaceAll("₹", "Rs ")
    .replace(/[\r\n\t]+/g, " ")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
}

function money(value: number) {
  return `Rs ${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function dateText(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value || "-"
}

function stringFrom(row: DataRow | null | undefined, fields: string[]) {
  if (!row) return ""
  for (const field of fields) {
    const value = row[field]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function fitText(text: unknown, font: PDFFont, size: number, width: number) {
  const input = safeText(text) || "-"
  if (font.widthOfTextAtSize(input, size) <= width) return input
  let fitted = input
  while (fitted.length > 1 && font.widthOfTextAtSize(`${fitted}...`, size) > width) fitted = fitted.slice(0, -1)
  return `${fitted}...`
}

async function logoBytes(url?: string) {
  if (!url) return null
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    if (png || jpeg) return bytes

    // pdf-lib embeds PNG/JPEG only. The desktop logo manager also accepts WebP,
    // so convert that validated local asset in-memory without changing the
    // persistent source file.
    if (typeof document === "undefined") return null
    const objectUrl = URL.createObjectURL(new Blob([bytes]))
    try {
      const image = new Image()
      image.src = objectUrl
      await image.decode()
      const canvas = document.createElement("canvas")
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext("2d")
      if (!context) return null
      context.drawImage(image, 0, 0)
      const encoded = canvas.toDataURL("image/png").split(",")[1] || ""
      const binary = atob(encoded)
      return Uint8Array.from(binary, (character) => character.charCodeAt(0))
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  } catch {
    return null
  }
}

async function embedLogo(document: PDFDocument, url?: string) {
  const bytes = await logoBytes(url)
  if (!bytes) return null
  try {
    return bytes[0] === 0xff ? document.embedJpg(bytes) : document.embedPng(bytes)
  } catch {
    return null
  }
}

function drawContainedImage(page: PDFPage, image: PDFImage, x: number, y: number, width: number, height: number) {
  const scale = Math.min(width / image.width, height / image.height)
  const imageWidth = image.width * scale
  const imageHeight = image.height * scale
  page.drawImage(image, {
    x: x + (width - imageWidth) / 2,
    y: y + (height - imageHeight) / 2,
    width: imageWidth,
    height: imageHeight,
  })
}

function aggregateBy(rows: InvoiceExportRow[], key: (row: InvoiceExportRow) => string) {
  const map = new Map<string, InvoiceExportRow[]>()
  rows.forEach((row) => {
    const value = key(row) || "Unspecified"
    map.set(value, [...(map.get(value) || []), row])
  })
  return map
}

function sum(rows: InvoiceExportRow[], field: keyof InvoiceExportRow) {
  return rows.reduce((total, row) => total + Number(row[field] || 0), 0)
}

function reportRows(dataset: InvoiceExportDataset, options: InvoiceReportOptions): { columns: TableColumn[]; rows: ReportRow[] } {
  const source = options.reportType === "detailed-lines" || options.includeLineItems ? dataset.rows : dataset.invoiceRows
  if (options.reportType === "customer-wise-sales") {
    const groups = aggregateBy(dataset.invoiceRows, (row) => row.customerName)
    return {
      columns: [
        { key: "customer", label: "Customer", ratio: 2.1 },
        { key: "invoices", label: "Invoices", ratio: 0.7, numeric: true },
        { key: "taxable", label: "Taxable", ratio: 1.1, numeric: true, money: true },
        { key: "gst", label: "GST", ratio: 0.9, numeric: true, money: true },
        { key: "sales", label: "Sales", ratio: 1.15, numeric: true, money: true },
        { key: "paid", label: "Paid", ratio: 1.05, numeric: true, money: true },
        { key: "outstanding", label: "Outstanding", ratio: 1.15, numeric: true, money: true },
      ],
      rows: [...groups].map(([customer, rows]) => ({
        customer,
        invoices: rows.length,
        taxable: sum(rows, "taxableValue"),
        gst: sum(rows, "totalGst"),
        sales: sum(rows, "grandTotal"),
        paid: sum(rows, "paidAmount"),
        outstanding: sum(rows, "dueAmount"),
      })),
    }
  }
  if (options.reportType === "gst-summary") {
    const groups = aggregateBy(dataset.invoiceRows, (row) => row.invoiceType)
    return {
      columns: [
        { key: "type", label: "Invoice Type", ratio: 1.7 },
        { key: "invoices", label: "Invoices", ratio: 0.8, numeric: true },
        { key: "taxable", label: "Taxable", ratio: 1.2, numeric: true, money: true },
        { key: "cgst", label: "CGST", ratio: 1, numeric: true, money: true },
        { key: "sgst", label: "SGST", ratio: 1, numeric: true, money: true },
        { key: "igst", label: "IGST", ratio: 1, numeric: true, money: true },
        { key: "total", label: "Grand Total", ratio: 1.25, numeric: true, money: true },
      ],
      rows: [...groups].map(([type, rows]) => ({
        type,
        invoices: rows.length,
        taxable: sum(rows, "taxableValue"),
        cgst: sum(rows, "cgst"),
        sgst: sum(rows, "sgst"),
        igst: sum(rows, "igst"),
        total: sum(rows, "grandTotal"),
      })),
    }
  }
  if (options.reportType === "payment-collection") {
    const groups = aggregateBy(dataset.invoiceRows, (row) => row.paymentMethod)
    return {
      columns: [
        { key: "method", label: "Payment Method", ratio: 1.9 },
        { key: "invoices", label: "Invoices", ratio: 0.8, numeric: true },
        { key: "billed", label: "Billed", ratio: 1.2, numeric: true, money: true },
        { key: "paid", label: "Collected", ratio: 1.2, numeric: true, money: true },
        { key: "outstanding", label: "Outstanding", ratio: 1.2, numeric: true, money: true },
        { key: "rate", label: "Collection %", ratio: 1, numeric: true },
      ],
      rows: [...groups].map(([method, rows]) => {
        const billed = sum(rows, "grandTotal")
        const paid = sum(rows, "paidAmount")
        return {
          method,
          invoices: rows.length,
          billed,
          paid,
          outstanding: sum(rows, "dueAmount"),
          rate: billed ? `${(paid / billed * 100).toFixed(1)}%` : "0.0%",
        }
      }),
    }
  }
  if (options.reportType === "sales-summary") {
    const groups = aggregateBy(dataset.invoiceRows, (row) => row.invoiceDate)
    return {
      columns: [
        { key: "date", label: "Date", ratio: 1.3 },
        { key: "invoices", label: "Invoices", ratio: 0.8, numeric: true },
        { key: "taxable", label: "Taxable", ratio: 1.15, numeric: true, money: true },
        { key: "gst", label: "GST", ratio: 1, numeric: true, money: true },
        { key: "sales", label: "Sales", ratio: 1.15, numeric: true, money: true },
        { key: "paid", label: "Paid", ratio: 1.1, numeric: true, money: true },
        { key: "outstanding", label: "Outstanding", ratio: 1.15, numeric: true, money: true },
      ],
      rows: [...groups].map(([date, rows]) => ({
        date: dateText(date),
        invoices: rows.length,
        taxable: sum(rows, "taxableValue"),
        gst: sum(rows, "totalGst"),
        sales: sum(rows, "grandTotal"),
        paid: sum(rows, "paidAmount"),
        outstanding: sum(rows, "dueAmount"),
      })),
    }
  }

  const detailed = options.reportType === "detailed-lines" || options.includeLineItems
  const outstanding = options.reportType === "outstanding-receivables"
  const filtered = outstanding ? dataset.invoiceRows.filter((row) => row.dueAmount > 0) : source
  const columns: TableColumn[] = [
    { key: "invoice", label: "Invoice", ratio: 1.25 },
    { key: "date", label: "Date", ratio: 0.95 },
    { key: "customer", label: "Customer", ratio: 1.65 },
  ]
  if (detailed) {
    columns.push(
      { key: "item", label: "Item", ratio: 1.7 },
      { key: "qty", label: "Qty", ratio: 0.55, numeric: true },
      { key: "rate", label: "Rate", ratio: 0.85, numeric: true, money: true },
    )
  }
  if (options.includeGstDetails) columns.push({ key: "gst", label: "GST", ratio: 0.85, numeric: true, money: true })
  columns.push(
    { key: "total", label: "Total", ratio: 1, numeric: true, money: true },
    { key: "paid", label: "Paid", ratio: 0.95, numeric: true, money: true },
    { key: "due", label: "Outstanding", ratio: 1.05, numeric: true, money: true },
  )
  if (options.includePaymentSummary) columns.push({ key: "payment", label: "Payment", ratio: 0.9 })
  return {
    columns,
    rows: filtered.map((row) => ({
      invoice: row.invoiceNumber,
      date: dateText(row.invoiceDate),
      customer: options.includeCustomerContacts && row.customerPhone ? `${row.customerName} | ${row.customerPhone}` : row.customerName,
      item: row.productName || "-",
      qty: row.quantity ?? "-",
      rate: row.rate ?? 0,
      gst: detailed ? (row.lineCgst || 0) + (row.lineSgst || 0) + (row.lineIgst || 0) : row.totalGst,
      total: detailed ? row.lineTotal || 0 : row.grandTotal,
      paid: row.paidAmount,
      due: row.dueAmount,
      payment: row.paymentMethod,
    })),
  }
}

function pageDimensions(options: InvoiceReportOptions, columnCount: number): [number, number] {
  const base = options.pageSize === "Letter" ? PageSizes.Letter : PageSizes.A4
  const landscape = options.orientation === "landscape" || (options.orientation === "auto" && columnCount > 7)
  return landscape ? [base[1], base[0]] : [base[0], base[1]]
}

function drawHeader(input: {
  page: PDFPage
  dataset: InvoiceExportDataset
  title: string
  regular: PDFFont
  bold: PDFFont
  logo: PDFImage | null
  margin: number
}) {
  const { page, dataset, title, regular, bold, logo, margin } = input
  const organization = dataset.organization
  let x = margin
  if (logo) {
    drawContainedImage(page, logo, margin, page.getHeight() - margin - 42, 46, 38)
    x += 56
  }
  page.drawText(fitText(dataset.businessName, bold, 17, page.getWidth() * 0.52), {
    x,
    y: page.getHeight() - margin - 16,
    size: 17,
    font: bold,
    color: INK,
  })
  const contact = [
    stringFrom(organization, ["address", "business_address"]),
    stringFrom(organization, ["gst_number", "gstin"]) ? `GSTIN: ${stringFrom(organization, ["gst_number", "gstin"])}` : "",
    stringFrom(organization, ["phone"]),
    stringFrom(organization, ["email"]),
  ].filter(Boolean).join(" | ")
  page.drawText(fitText(contact, regular, 7.5, page.getWidth() * 0.59), {
    x,
    y: page.getHeight() - margin - 32,
    size: 7.5,
    font: regular,
    color: MUTED,
  })
  const titleWidth = bold.widthOfTextAtSize(title, 15)
  page.drawText(title, {
    x: page.getWidth() - margin - titleWidth,
    y: page.getHeight() - margin - 15,
    size: 15,
    font: bold,
    color: ACCENT,
  })
  const periodText = `Period: ${dataset.periodLabel}`
  page.drawText(periodText, {
    x: page.getWidth() - margin - regular.widthOfTextAtSize(periodText, 8),
    y: page.getHeight() - margin - 31,
    size: 8,
    font: regular,
    color: MUTED,
  })
  const lineY = page.getHeight() - margin - 50
  page.drawLine({ start: { x: margin, y: lineY }, end: { x: page.getWidth() - margin, y: lineY }, thickness: 1.25, color: INK })
  return lineY - 12
}

function drawSummary(page: PDFPage, dataset: InvoiceExportDataset, regular: PDFFont, bold: PDFFont, margin: number, y: number) {
  const metrics = [
    ["Invoices", dataset.summary.invoiceCount],
    ["Taxable", money(dataset.summary.taxableAmount)],
    ["GST", money(dataset.summary.totalGst)],
    ["Grand Total", money(dataset.summary.grandTotal)],
    ["Paid", money(dataset.summary.paidAmount)],
    ["Outstanding", money(dataset.summary.outstandingAmount)],
    ["Collection", `${dataset.summary.collectionRate.toFixed(1)}%`],
  ]
  const gap = 6
  const width = (page.getWidth() - margin * 2 - gap * (metrics.length - 1)) / metrics.length
  metrics.forEach(([label, value], index) => {
    const x = margin + index * (width + gap)
    page.drawRectangle({ x, y: y - 39, width, height: 39, color: SOFT, borderColor: BORDER, borderWidth: 0.6 })
    page.drawText(String(label), { x: x + 6, y: y - 13, size: 6.2, font: bold, color: MUTED })
    page.drawText(fitText(value, bold, 8.5, width - 12), { x: x + 6, y: y - 29, size: 8.5, font: bold, color: INK })
  })
  return y - 51
}

function drawTableHeader(page: PDFPage, columns: TableColumn[], bold: PDFFont, margin: number, y: number) {
  const width = page.getWidth() - margin * 2
  const totalRatio = columns.reduce((total, column) => total + column.ratio, 0)
  let x = margin
  page.drawRectangle({ x: margin, y: y - 20, width, height: 20, color: INK })
  const positioned = columns.map((column) => {
    const columnWidth = width * column.ratio / totalRatio
    const label = fitText(column.label, bold, 6.6, columnWidth - 8)
    const labelWidth = bold.widthOfTextAtSize(label, 6.6)
    page.drawText(label, {
      x: column.numeric ? x + columnWidth - 4 - labelWidth : x + 4,
      y: y - 13,
      size: 6.6,
      font: bold,
      color: WHITE,
    })
    const result = { ...column, x, width: columnWidth }
    x += columnWidth
    return result
  })
  return { columns: positioned, y: y - 20 }
}

function drawTableRow(
  page: PDFPage,
  columns: Array<TableColumn & { x: number; width: number }>,
  row: ReportRow,
  regular: PDFFont,
  bold: PDFFont,
  margin: number,
  y: number,
  index: number
) {
  const rowHeight = 21
  page.drawRectangle({
    x: margin,
    y: y - rowHeight,
    width: page.getWidth() - margin * 2,
    height: rowHeight,
    color: index % 2 ? SOFT : WHITE,
    borderColor: BORDER,
    borderWidth: 0.35,
  })
  columns.forEach((column) => {
    const raw = row[column.key] ?? "-"
    const text = column.money && typeof raw === "number" ? money(raw) : String(raw)
    const font = column.key === "invoice" || column.key === "total" ? bold : regular
    const size = 6.8
    const fitted = fitText(text, font, size, column.width - 8)
    const textWidth = font.widthOfTextAtSize(fitted, size)
    page.drawText(fitted, {
      x: column.numeric ? column.x + column.width - 4 - textWidth : column.x + 4,
      y: y - 14,
      size,
      font,
      color: INK,
    })
  })
  return y - rowHeight
}

export async function createInvoiceReportPdf(
  dataset: InvoiceExportDataset,
  options: InvoiceReportOptions
): Promise<InvoiceReportResult> {
  dataset = datasetForInvoiceReport(dataset, options.reportType)
  if (!dataset.summary.invoiceCount) {
    throw new Error(options.reportType === "outstanding-receivables" ? "No outstanding invoices match these filters." : "No invoices match these filters.")
  }
  const document = await PDFDocument.create()
  const [regular, bold, logo] = await Promise.all([
    document.embedFont(StandardFonts.Helvetica),
    document.embedFont(StandardFonts.HelveticaBold),
    embedLogo(document, options.logoUrl),
  ])
  const title = reportTitles[options.reportType]
  const table = reportRows(dataset, options)
  const dimensions = pageDimensions(options, table.columns.length)
  const margin = 28
  const pages: PDFPage[] = []
  let page = document.addPage(dimensions)
  pages.push(page)
  let y = drawHeader({ page, dataset, title, regular, bold, logo, margin })
  y = drawSummary(page, dataset, regular, bold, margin, y)
  let header = drawTableHeader(page, table.columns, bold, margin, y)
  let positionedColumns = header.columns
  y = header.y

  table.rows.forEach((row, index) => {
    if (y - 21 < 35) {
      page = document.addPage(dimensions)
      pages.push(page)
      y = drawHeader({ page, dataset, title, regular, bold, logo, margin })
      header = drawTableHeader(page, table.columns, bold, margin, y)
      positionedColumns = header.columns
      y = header.y
    }
    y = drawTableRow(page, positionedColumns, row, regular, bold, margin, y, index)
  })

  const generated = new Date().toLocaleString("en-IN")
  pages.forEach((reportPage, index) => {
    reportPage.drawLine({ start: { x: margin, y: 23 }, end: { x: reportPage.getWidth() - margin, y: 23 }, thickness: 0.5, color: BORDER })
    const left = `Generated by Bezgrow | ${dataset.periodLabel}`
    reportPage.drawText(fitText(left, regular, 7, reportPage.getWidth() * 0.62), { x: margin, y: 10, size: 7, font: regular, color: MUTED })
    const right = `Page ${index + 1} of ${pages.length} | ${generated}`
    reportPage.drawText(right, {
      x: reportPage.getWidth() - margin - regular.widthOfTextAtSize(right, 7),
      y: 10,
      size: 7,
      font: regular,
      color: MUTED,
    })
  })
  document.setTitle(`${title} - ${dataset.businessName}`)
  document.setAuthor(dataset.businessName)
  document.setSubject(`${title}, ${dataset.periodLabel}`)
  document.setCreator("Bezgrow")
  document.setProducer("Bezgrow local PDF report engine")
  const bytes = await document.save({ useObjectStreams: false })
  const reportSlug = title.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "")
  return {
    bytes,
    filename: `${dataset.filenameStem.replace("Invoice-Register", reportSlug)}.pdf`,
    title,
    period: dataset.periodLabel,
    invoiceCount: dataset.summary.invoiceCount,
  }
}

export function invoiceReportTitle(type: InvoiceReportType) {
  return reportTitles[type]
}
