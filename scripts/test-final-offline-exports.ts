import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PDFDocument } from "pdf-lib"
import { buildCsvBytes, buildCsvText, escapeCsvCell, safeSpreadsheetText } from "../lib/desktop-file-export"
import { createInvoicePdf } from "../lib/pdf-invoice"
import {
  buildInvoiceExportRows,
  buildProfessionalInvoiceCsvBytes,
  buildProfessionalInvoiceCsvText,
  resolveInvoiceDateRange,
  summarizeInvoiceExport,
  type InvoiceExportDataset,
} from "../lib/invoice-csv-export"
import { createInvoiceReportPdf } from "../lib/invoice-report-pdf"
import { defaultPrintSettings } from "../components/print/settings/defaults"
import type { PrintInvoice } from "../components/print/types"
import { compareVersions } from "../lib/app-updates"
import { resolvePrintOrganization } from "../lib/print-invoice-builder"
import {
  createInvoiceEmailDraft,
  createInvoiceShareText,
  createWhatsAppInvoiceUrl,
  normalizeWhatsAppPhone,
  validateCustomerEmail,
} from "../lib/invoice-share"

const logo =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYGJAQoAHgQCAelx2VQAAAAASUVORK5CYII="

function fixture(itemCount = 3): PrintInvoice {
  const items = Array.from({ length: itemCount }, (_, index) => ({
    id: `item-${index}`,
    name: `E2E-OFFLINE-FINAL-Product ${index + 1}`,
    description: index === 0 ? "Unicode नमस्ते, quoted \"value\"" : "",
    sku: `000${index + 1}`,
    hsnCode: "30049099",
    batchNumber: `BATCH-${index + 1}`,
    manufacturingDate: "2026-01-01",
    expiryDate: "2028-12-31",
    scheduleType: "OTC",
    unit: "pcs",
    quantity: 2,
    freeQuantity: 0,
    rate: 100,
    mrp: 120,
    discountPercent: 0,
    discountAmount: 0,
    taxableValue: 200,
    cgstPercent: 9,
    cgstAmount: 18,
    sgstPercent: 9,
    sgstAmount: 18,
    igstPercent: 0,
    igstAmount: 0,
    finalAmount: 236,
  }))
  const subtotal = itemCount * 200
  const tax = itemCount * 36
  const grandTotal = subtotal + tax
  return {
    id: "E2E-OFFLINE-FINAL-invoice",
    invoiceNumber: "INV-00004",
    invoiceTitle: "Tax Invoice",
    invoiceDate: "2026-07-26",
    dueDate: "2026-08-02",
    salesperson: "Local User",
    enterprise: {
      organizationId: "biz_r-g-healthcare",
      name: "E2E-OFFLINE-FINAL-Business",
      businessType: "Pharmacy",
      gstNumber: "09ABCDE1234F1Z5",
      fssai: "-",
      phone: "09876543210",
      email: "billing@example.test",
      website: "-",
      address: "Local address",
      logoUrl: logo,
      branchName: "Main Branch",
    },
    customer: {
      id: "000042",
      name: "E2E-OFFLINE-FINAL-Customer",
      phone: "9876543210",
      email: "customer@example.test",
      gstin: "07ABCDE1234F1Z5",
      address: "Line one\nLine two",
      state: "Delhi",
      stateCode: "07",
    },
    items,
    payment: { mode: "Cash", paidAmount: grandTotal / 2, dueAmount: grandTotal / 2, balanceAmount: 0, cashReceived: grandTotal / 2 },
    totals: {
      subtotal,
      discount: 0,
      taxableAmount: subtotal,
      cgst: tax / 2,
      sgst: tax / 2,
      igst: 0,
      roundOff: 0,
      grandTotal,
      amountInWords: "Rupees only",
    },
    terms: ["Goods once sold will not be returned."],
    notes: "Offline PDF test",
    qrValue: "BEZGROW-INVOICE:INV-00004",
    barcodeValue: "INV-00004",
    watermark: "PAID",
  }
}

const csvRows = [
  { invoice: "00004", customer: "Müller, नमस्ते", notes: "Line one\nLine \"two\"", value: "=2+3" },
  { invoice: "00105", customer: "+CMD", notes: "@unsafe", value: "-10" },
]
const csvColumns = [
  { header: "Invoice", value: "invoice" as const, preserveLeadingZeros: true },
  { header: "Customer", value: "customer" as const },
  { header: "Notes", value: "notes" as const },
  { header: "Value", value: "value" as const },
]
const csvText = buildCsvText(csvColumns, csvRows)
const csvBytes = buildCsvBytes(csvColumns, csvRows)
assert.deepEqual(Array.from(csvBytes.slice(0, 3)), [0xef, 0xbb, 0xbf])
assert.match(csvText, /"Müller, नमस्ते"/)
assert.match(csvText, /"Line one\nLine ""two"""/)
assert.match(csvText, /"'=2\+3"/)
assert.match(csvText, /"'\+CMD"/)
assert.match(csvText, /"'@unsafe"/)
assert.equal(escapeCsvCell("a,b"), "\"a,b\"")
assert.equal(safeSpreadsheetText("00004", true), "\t00004")

const invoiceExportRows = buildInvoiceExportRows(
  [
    { id: "invoice-1", invoice_number: "00004", customer_id: "customer-1", payment_status: "paid", subtotal: 100, tax_amount: 18, grand_total: 118, notes: "Visible" },
    { id: "invoice-2", invoice_number: "00005", customer_id: "customer-2", payment_status: "unpaid", subtotal: 200, grand_total: 200 },
  ],
  [
    { id: "customer-1", name: "Müller, नमस्ते", phone: "09876543210", gst_number: "07ABCDE1234F1Z5" },
    { id: "customer-2", name: "Other customer" },
  ],
  [],
  { search: "Müller", status: "paid" }
)
assert.equal(invoiceExportRows.length, 1)
assert.equal(invoiceExportRows[0].invoiceNumber, "00004")
assert.equal(invoiceExportRows[0].paidAmount, 118)
assert.equal(invoiceExportRows[0].cgst, 9)
assert.equal(invoiceExportRows[0].sgst, 9)

const detailedRows = buildInvoiceExportRows(
  [
    { id: "invoice-1", invoice_number: "INV-00004", invoice_date: "2026-07-26", customer_id: "customer-1", payment_status: "partial", payment_method: "UPI", subtotal: 100, tax_amount: 18, grand_total: 118, paid_amount: 50 },
    { id: "invoice-2", invoice_number: "INV-00005", invoice_date: "2026-06-30", customer_id: "customer-2", payment_status: "paid", payment_method: "Cash", grand_total: 200 },
  ],
  [
    { id: "customer-1", name: "=Formula customer", phone: "9876543210", email: "one@example.test" },
    { id: "customer-2", name: "Other customer" },
  ],
  [
    { id: "item-1", invoice_id: "invoice-1", product_name: "Quoted, \"product\"", hsn_code: "0001", quantity: 1, rate: 100, line_total: 100, gst_amount: 18 },
  ],
  {
    datePreset: "custom",
    fromDate: "2026-07-01",
    toDate: "2026-07-31",
    statuses: ["partial", "unpaid"],
    customerIds: ["customer-1"],
    paymentMethods: ["UPI"],
    minimumAmount: 100,
    maximumAmount: 150,
    invoiceType: "gst",
  },
  {
    mode: "detailed",
    includeCustomerContacts: true,
    includeGstBreakdown: true,
    includePaymentDetails: true,
    includeNotes: true,
    includeTimestamps: true,
  },
  new Date("2026-07-26T10:00:00+05:30"),
)
assert.equal(detailedRows.length, 1)
assert.equal(detailedRows[0].productName, "Quoted, \"product\"")
assert.equal(detailedRows[0].dueAmount, 68)
assert.equal(detailedRows[0].lineCgst, 9)
assert.equal(detailedRows[0].lineSgst, 9)
assert.deepEqual(resolveInvoiceDateRange({ datePreset: "financial-year" }, new Date("2026-07-26T10:00:00+05:30")), {
  preset: "financial-year",
  from: "2026-04-01",
  to: "2026-07-26",
  label: "01/04/2026 to 26/07/2026",
})

const professionalDataset: InvoiceExportDataset = {
  businessName: "R & G Healthcare",
  organization: { id: "business", name: "R & G Healthcare" },
  rows: [...detailedRows],
  invoiceRows: [...detailedRows.invoiceRows],
  summary: summarizeInvoiceExport(detailedRows.invoiceRows),
  periodLabel: "01/07/2026 to 31/07/2026",
  filtersLabel: "Partially paid and Unpaid | Selected customer | UPI",
  filenameStem: "R-G-Healthcare_Invoice-Register_2026-07-01_to_2026-07-31",
}
const professionalCsv = buildProfessionalInvoiceCsvText(professionalDataset, {
  mode: "detailed",
  includeCustomerContacts: true,
  includeGstBreakdown: true,
  includePaymentDetails: true,
  includeNotes: true,
  includeTimestamps: true,
}, new Date("2026-07-26T03:40:00+05:30"))
const professionalCsvBytes = buildProfessionalInvoiceCsvBytes(professionalDataset)
assert.deepEqual(Array.from(professionalCsvBytes.slice(0, 3)), [0xef, 0xbb, 0xbf])
assert.match(professionalCsv, /"Business Name:","R & G Healthcare"/)
assert.match(professionalCsv, /"Report:","Detailed Invoice Lines"/)
assert.match(professionalCsv, /"Summary"/)
assert.match(professionalCsv, /"Invoice Number","Invoice Date"/)
assert.match(professionalCsv, /"'=Formula customer"/)
assert.match(professionalCsv, /"Quoted, ""product"""/)
assert.match(professionalCsv, /,118,50,68,/)

assert.equal(normalizeWhatsAppPhone("98765 43210"), "919876543210")
assert.equal(normalizeWhatsAppPhone("+44 7700 900123"), "447700900123")
assert.equal(normalizeWhatsAppPhone("12345"), "")
assert.equal(validateCustomerEmail("customer@example.test"), "customer@example.test")
assert.equal(validateCustomerEmail("bad email"), "")
const shareInput = {
  customerName: "Customer",
  customerPhone: "9876543210",
  customerEmail: "customer@example.test",
  enterpriseName: "Business",
  invoiceNumber: "INV-00004",
  invoiceDate: "2026-07-26",
  amount: 1234.5,
  paidAmount: 1000,
  dueAmount: 234.5,
}
assert.equal(createInvoiceShareText(shareInput), "Hello Customer,\n\nPlease find invoice INV-00004 from Business.\n\nInvoice total: ₹1,234.50\n\nThank you.\nGenerated by Bezgrow")
assert.match(createWhatsAppInvoiceUrl(shareInput), /^https:\/\/wa\.me\/919876543210\?text=/)
assert.match(createInvoiceEmailDraft(shareInput).mailtoUrl, /^mailto:/)
const linkedShareInput = { ...shareInput, secureInvoiceUrl: "https://www.bezgrow.com/i/secure-token" }
assert.match(createInvoiceShareText(linkedShareInput), /Please find invoice INV-00004 from Business\./)
assert.match(createInvoiceShareText(linkedShareInput), /View or download the invoice: https:\/\/www\.bezgrow\.com\/i\/secure-token/)
assert.match(createInvoiceShareText(linkedShareInput), /Thank you\.\nGenerated by Bezgrow$/)

assert.equal(compareVersions("1.10.0", "1.9.9"), 1)
assert.equal(compareVersions("1.0.0", "1.0.0"), 0)
assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.11"), -1)
assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1)
assert.equal(compareVersions("v2.0.0+build.4", "2.0.0"), 0)
assert.equal(
  resolvePrintOrganization({ name: "Business", business_name: "R&G Healthcare", id: "biz" })?.name,
  "R&G Healthcare"
)

async function run() {
  const testDirectory = await mkdtemp(path.join(tmpdir(), "bezgrow-final-offline-"))
  const normalBytes = await createInvoicePdf(
    fixture(),
    { ...defaultPrintSettings, showLogo: true, showQr: true, showBarcode: true, showWatermark: true },
    "a4"
  )
  assert.equal(new TextDecoder().decode(normalBytes.slice(0, 5)), "%PDF-")
  assert.ok(normalBytes.byteLength > 5_000)
  const normalPath = path.join(testDirectory, "Invoice-INV-00004.pdf")
  await writeFile(normalPath, normalBytes)
  assert.equal((await readFile(normalPath)).byteLength, normalBytes.byteLength)
  const normalDocument = await PDFDocument.load(normalBytes)
  assert.match(normalDocument.getTitle() || "", /INV-00004/)
  assert.equal(normalDocument.getPageCount(), 1)

  const longBytes = await createInvoicePdf(fixture(90), defaultPrintSettings, "a4")
  const longDocument = await PDFDocument.load(longBytes)
  assert.ok(longDocument.getPageCount() >= 3)

  for (const width of ["58mm", "80mm"] as const) {
    const thermalBytes = await createInvoicePdf(fixture(8), { ...defaultPrintSettings, thermalWidth: width }, "thermal")
    const thermalDocument = await PDFDocument.load(thermalBytes)
    assert.equal(thermalDocument.getPageCount(), 1)
    const expectedWidth = Number.parseInt(width, 10) * (72 / 25.4)
    assert.ok(Math.abs(thermalDocument.getPage(0).getWidth() - expectedWidth) < 0.2)
  }

  const withoutLogo = await createInvoicePdf(fixture(), { ...defaultPrintSettings, showLogo: false }, "a4")
  assert.ok(normalBytes.byteLength > withoutLogo.byteLength)
  const repeated = await createInvoicePdf(fixture(), defaultPrintSettings, "a4")
  assert.equal(new TextDecoder().decode(repeated.slice(0, 5)), "%PDF-")
  await assert.rejects(writeFile(path.join(testDirectory, "missing", "denied.pdf"), repeated))

  const reportRows = Array.from({ length: 180 }, (_, index) => ({
    ...professionalDataset.invoiceRows[0],
    invoiceId: `report-invoice-${index}`,
    invoiceNumber: `INV-${String(index + 1).padStart(5, "0")}`,
    customerName: `Customer ${index + 1}`,
  }))
  const reportDataset: InvoiceExportDataset = {
    ...professionalDataset,
    rows: reportRows,
    invoiceRows: reportRows,
    summary: summarizeInvoiceExport(reportRows),
  }
  const report = await createInvoiceReportPdf(reportDataset, {
    reportType: "invoice-register",
    orientation: "auto",
    pageSize: "A4",
    includeGstDetails: true,
    includeLineItems: false,
    includeCustomerContacts: true,
    includePaymentSummary: true,
    includeCharts: false,
  })
  assert.equal(new TextDecoder().decode(report.bytes.slice(0, 5)), "%PDF-")
  const reportDocument = await PDFDocument.load(report.bytes)
  assert.ok(reportDocument.getPageCount() >= 5)
  assert.match(report.filename, /R-G-Healthcare_Invoice-Register_2026-07-01_to_2026-07-31\.pdf/)
  await writeFile(path.join(testDirectory, report.filename), report.bytes)
  await writeFile(
    path.join(testDirectory, "R-G-Healthcare_Invoice-Register_2026-07-01_to_2026-07-31.csv"),
    professionalCsvBytes,
  )

  const tenThousandInvoices = Array.from({ length: 10_000 }, (_, index) => ({
    id: `perf-${index}`,
    invoice_number: `INV-${String(index + 1).padStart(6, "0")}`,
    invoice_date: "2026-07-26",
    payment_status: index % 2 ? "paid" : "unpaid",
    grand_total: 118,
    paid_amount: index % 2 ? 118 : 0,
    tax_amount: 18,
  }))
  const performanceStart = performance.now()
  const performanceRows = buildInvoiceExportRows(tenThousandInvoices, [], [], { datePreset: "today" }, undefined, new Date("2026-07-26T10:00:00+05:30"))
  const performanceMs = performance.now() - performanceStart
  assert.equal(performanceRows.length, 10_000)
  assert.ok(performanceMs < 5_000, `10,000-row export filtering took ${performanceMs.toFixed(1)}ms`)

  console.log(`Final offline export/PDF/share tests passed (${testDirectory}); 10,000-row filter ${performanceMs.toFixed(1)}ms.`)
}

void run()
