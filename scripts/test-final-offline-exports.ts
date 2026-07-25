import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PDFDocument } from "pdf-lib"
import { buildCsvBytes, buildCsvText, escapeCsvCell, safeSpreadsheetText } from "../lib/desktop-file-export"
import { createInvoicePdf } from "../lib/pdf-invoice"
import { buildInvoiceExportRows } from "../lib/invoice-csv-export"
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
assert.match(createInvoiceShareText(shareInput), /attach it before sending/)
assert.match(createWhatsAppInvoiceUrl(shareInput), /^https:\/\/wa\.me\/919876543210\?text=/)
assert.match(createInvoiceEmailDraft(shareInput).mailtoUrl, /^mailto:/)

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

  console.log(`Final offline export/PDF/share tests passed (${testDirectory}).`)
}

void run()
