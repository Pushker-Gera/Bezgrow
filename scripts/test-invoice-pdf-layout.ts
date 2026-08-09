import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { PDFDocument } from "pdf-lib"
import { createInvoicePdf } from "../lib/pdf-invoice"
import { defaultPrintSettings } from "../components/print/settings/defaults"
import type { PrintFormat, PrintInvoice } from "../components/print/types"

const PT_PER_MM = 72 / 25.4
const logo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYGJAQoAHgQCAelx2VQAAAAASUVORK5CYII="

export function invoice(itemCount: number, gst: boolean): PrintInvoice {
  const items = Array.from({ length: itemCount }, (_, index) => {
    const taxableValue = 99.95 * (index % 3 + 1)
    const discountAmount = index === 0 ? 9.5 : 0
    const tax = gst ? taxableValue * 0.18 : 0
    return {
      id: `layout-item-${index}`,
      name: index === 0 ? "Extra-long representative product name with batch and packaging details" : `Representative product ${index + 1}`,
      description: "",
      sku: `SKU-${String(index + 1).padStart(4, "0")}`,
      hsnCode: gst ? "30049099" : "",
      batchNumber: `B-${index + 1}`,
      manufacturingDate: "2026-01-01",
      expiryDate: "2028-01-01",
      scheduleType: "OTC",
      unit: "pcs",
      quantity: index % 3 + 1,
      freeQuantity: 0,
      rate: 99.95,
      mrp: 120,
      discountPercent: index === 0 ? 5 : 0,
      discountAmount,
      taxableValue,
      cgstPercent: gst ? 9 : 0,
      cgstAmount: tax / 2,
      sgstPercent: gst ? 9 : 0,
      sgstAmount: tax / 2,
      igstPercent: 0,
      igstAmount: 0,
      finalAmount: taxableValue + tax,
    }
  })
  const subtotal = items.reduce((sum, item) => sum + item.taxableValue, 0)
  const discount = items.reduce((sum, item) => sum + item.discountAmount, 0)
  const tax = gst ? subtotal * 0.18 : 0
  const grandTotal = subtotal - discount + tax
  return {
    id: `invoice-${itemCount}-${gst ? "gst" : "non-gst"}`,
    invoiceNumber: `INV-LAYOUT-${itemCount}`,
    invoiceTitle: gst ? "Tax Invoice" : "Invoice",
    invoiceDate: "2026-08-01",
    dueDate: "2026-08-08",
    salesperson: "Desktop QA",
    enterprise: {
      organizationId: "layout-business",
      name: "Bezgrow Representative Healthcare Distribution and Retail Private Limited",
      businessType: "Retail and wholesale",
      gstNumber: gst ? "09ABCDE1234F1Z5" : "",
      fssai: "12345678901234",
      phone: "9876543210",
      email: "billing@example.test",
      website: "www.example.test",
      address: "Long business address, Industrial Area, New Delhi, India 110001",
      logoUrl: logo,
      branchName: "Main Branch",
    },
    customer: {
      id: "layout-customer",
      name: "A Representative Customer With A Deliberately Long Legal Trading Name",
      phone: "9876543210",
      email: "customer@example.test",
      gstin: gst ? "07ABCDE1234F1Z5" : "",
      address: "A long customer address with locality, district, state and postal code",
      state: "Delhi",
      stateCode: "07",
    },
    items,
    payment: { mode: "UPI", paidAmount: grandTotal / 2, dueAmount: grandTotal / 2, balanceAmount: 0, cashReceived: 0 },
    totals: {
      subtotal,
      discount,
      taxableAmount: subtotal - discount,
      cgst: tax / 2,
      sgst: tax / 2,
      igst: 0,
      roundOff: 0,
      grandTotal,
      amountInWords: "Representative amount in words only",
    },
    terms: ["Goods once sold will not be returned.", "Payment is due by the stated due date."],
    notes: "Representative print layout regression invoice.",
    qrValue: `BEZGROW:INV-LAYOUT-${itemCount}`,
    barcodeValue: `INVLAYOUT${String(itemCount).padStart(2, "0")}`,
    watermark: "PAID",
  }
}

function closeTo(value: number, expected: number, tolerance = 0.3) {
  assert.ok(Math.abs(value - expected) <= tolerance, `${value} was not within ${tolerance}pt of ${expected}`)
}

const formats: Array<{
  label: string
  format: PrintFormat
  widthMm: number
  heightMm: number | null
  thermalWidth: "58mm" | "80mm"
}> = [
  { label: "a4", format: "a4", widthMm: 210, heightMm: 297, thermalWidth: "80mm" },
  { label: "half-compact", format: "half-compact", widthMm: 148, heightMm: 210, thermalWidth: "80mm" },
  { label: "half-top", format: "half-top", widthMm: 210, heightMm: 297, thermalWidth: "80mm" },
  { label: "thermal-80", format: "thermal", widthMm: 80, heightMm: null, thermalWidth: "80mm" },
  { label: "thermal-58", format: "thermal", widthMm: 58, heightMm: null, thermalWidth: "58mm" },
]

async function run() {
  const results: string[] = []
  const fixtureDirectory = process.env.BEZGROW_PRINT_EVIDENCE_DIR || "tmp/pdfs/bezgrow-invoice-layout-qa"
  const keepFixtures = process.env.BEZGROW_KEEP_PDF_FIXTURES === "1"
  if (keepFixtures) mkdirSync(fixtureDirectory, { recursive: true })
  for (const itemCount of [1, 5, 20]) {
    for (const gst of [true, false]) {
      for (const expected of formats) {
        const bytes = await createInvoicePdf(
          invoice(itemCount, gst),
          { ...defaultPrintSettings, thermalWidth: expected.thermalWidth, showLogo: true, showQr: true, showBarcode: true },
          expected.format,
        )
        assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-")
        const document = await PDFDocument.load(bytes)
        assert.equal(document.getPageCount(), 1, `${expected.label}/${itemCount}/${gst ? "gst" : "non-gst"} split unexpectedly`)
        const page = document.getPage(0)
        assert.ok(page.node.Contents(), `${expected.label} produced a blank first page`)
        closeTo(page.getWidth(), expected.widthMm * PT_PER_MM)
        if (expected.heightMm) closeTo(page.getHeight(), expected.heightMm * PT_PER_MM)
        else assert.ok(page.getHeight() > 100 * PT_PER_MM, "Thermal receipt did not expand to a usable continuous height")
        const box = page.getMediaBox()
        assert.equal(box.x, 0)
        assert.equal(box.y, 0)
        closeTo(box.width, page.getWidth())
        closeTo(box.height, page.getHeight())
        if (keepFixtures && itemCount === 20 && gst) {
          writeFileSync(`${fixtureDirectory}/${expected.label}-20-items-gst-bw-watermark.pdf`, await createInvoicePdf(
            invoice(itemCount, gst),
            { ...defaultPrintSettings, thermalWidth: expected.thermalWidth, showLogo: true, showQr: true, showBarcode: true, showWatermark: true, blackAndWhite: true },
            expected.format,
          ))
        }
        results.push(`${expected.label}:${itemCount}:${gst ? "gst" : "non-gst"}=1page ${page.getWidth().toFixed(2)}x${page.getHeight().toFixed(2)}pt`)
      }
    }
  }
  const longA4 = await PDFDocument.load(await createInvoicePdf(invoice(90, true), {
    ...defaultPrintSettings,
    showLogo: true,
    showQr: true,
    showBarcode: true,
    showWatermark: true,
  }, "a4"))
  assert.ok(longA4.getPageCount() >= 3, "A very long A4 invoice must use controlled continuation pages")
  for (const page of longA4.getPages()) assert.ok(page.node.Contents(), "A4 continuation output contained a blank page")
  console.log(`Invoice PDF layout matrix passed (${results.length} PDFs).`)
  for (const result of results) console.log(result)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void run()
