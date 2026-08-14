import assert from "node:assert/strict"
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream, PDFStream, type PDFPage } from "pdf-lib"
import { defaultPrintSettings } from "../components/print/settings/defaults"
import type { PrintFormat } from "../components/print/types"
import {
  clearCanonicalInvoiceDocumentCache,
  getCanonicalInvoiceDocument,
  validateCanonicalInvoicePdf,
} from "../lib/invoice-document"
import { invoice } from "./test-invoice-pdf-layout"

async function pdfText(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const standardFontDataUrl = decodeURIComponent(new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).pathname)
  const loading = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl })
  try {
    const document = await loading.promise
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "))
    }
    return pages.join("\n")
  } finally {
    await loading.destroy()
  }
}

async function pdfTextPositions(bytes: Uint8Array, pageNumber = 1) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const loading = pdfjs.getDocument({ data: bytes.slice() })
  try {
    const page = await (await loading.promise).getPage(pageNumber)
    const content = await page.getTextContent()
    return content.items.flatMap((item) => "str" in item && item.str.trim()
      ? [{ text: item.str, y: item.transform[5] }]
      : [])
  } finally {
    await loading.destroy()
  }
}

function drawingText(page: PDFPage) {
  const contents = page.node.Contents()
  if (!contents) return ""
  const streams: PDFStream[] = []
  if (contents instanceof PDFStream) streams.push(contents)
  else if (contents instanceof PDFArray) {
    for (let index = 0; index < contents.size(); index += 1) {
      const stream = contents.lookupMaybe(index, PDFStream)
      if (stream) streams.push(stream)
    }
  }
  return streams.map((stream) => {
    try {
      return new TextDecoder("latin1").decode(
        stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents(),
      )
    } catch {
      return new TextDecoder("latin1").decode(stream.getContents())
    }
  }).join("\n")
}

function assertDrawingStaysAbove(page: PDFPage, boundary: number) {
  const drawing = drawingText(page)
  type Matrix = [number, number, number, number, number, number]
  const multiply = (left: Matrix, right: Matrix): Matrix => [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ]
  const transformedY = (matrix: Matrix, x: number, y: number) => matrix[1] * x + matrix[3] * y + matrix[5]
  let transform: Matrix = [1, 0, 0, 1, 0, 0]
  const stack: Matrix[] = []
  const auditedY: number[] = []
  for (const rawLine of drawing.split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/)
    const operator = parts.at(-1)
    if (operator === "q") {
      stack.push([...transform])
    } else if (operator === "Q") {
      transform = stack.pop() || [1, 0, 0, 1, 0, 0]
    } else if (operator === "cm" && parts.length >= 7) {
      transform = multiply(transform, parts.slice(-7, -1).map(Number) as Matrix)
    } else if ((operator === "m" || operator === "l") && parts.length >= 3) {
      auditedY.push(transformedY(transform, Number(parts.at(-3)), Number(parts.at(-2))))
    } else if (operator === "re" && parts.length >= 5) {
      const [x, y, rectangleWidth, rectangleHeight] = parts.slice(-5, -1).map(Number)
      auditedY.push(
        transformedY(transform, x, y),
        transformedY(transform, x + rectangleWidth, y),
        transformedY(transform, x, y + rectangleHeight),
        transformedY(transform, x + rectangleWidth, y + rectangleHeight),
      )
    } else if (operator === "Tm" && parts.length >= 7) {
      const x = Number(parts.at(-3))
      const y = Number(parts.at(-2))
      auditedY.push(transformedY(transform, x, y))
    }
  }
  assert.ok(auditedY.length > 80, "Half A4 Top geometry audit found too few drawing coordinates")
  for (const y of auditedY) {
    assert.ok(y >= boundary - 0.5, `Half A4 Top drawing at y=${y} crossed the ${boundary.toFixed(2)}pt boundary`)
  }
}

async function run() {
  clearCanonicalInvoiceDocumentCache()
  const representative = {
    ...invoice(5, true),
    id: "canonical-invoice",
    invoiceNumber: "INV-00005",
    barcodeValue: "INV00005",
    qrValue: "BEZGROW:INV-00005",
    customer: { ...invoice(5, true).customer, name: "Monika Sharma" },
  }
  const settings = {
    ...defaultPrintSettings,
    showLogo: true,
    showQr: true,
    showBarcode: true,
    showHsn: true,
    showGstDetails: true,
    showSignature: true,
    showWatermark: true,
  }

  const firstRenderStarted = performance.now()
  const promises = [
    getCanonicalInvoiceDocument(representative, settings, "a4"),
    getCanonicalInvoiceDocument(representative, settings, "a4"),
  ] as const
  assert.strictEqual(promises[0], promises[1], "Identical PDF requests must share one in-flight render")
  const [a4, cachedA4] = await Promise.all(promises)
  const firstRenderMs = performance.now() - firstRenderStarted
  assert.strictEqual(a4, cachedA4, "Preview, Save, Print, and Share must reuse the same artifact object")
  const cachedRenderStarted = performance.now()
  assert.strictEqual(await getCanonicalInvoiceDocument(representative, settings, "a4"), a4)
  const cachedRenderMs = performance.now() - cachedRenderStarted
  assert.equal(new TextDecoder().decode(a4.bytes.slice(0, 5)), "%PDF-")
  assert.ok(a4.bytes.byteLength > 5_000)
  assert.equal(a4.pageCount, 1)
  assert.ok(a4.pageContentBytes[0] > 1_000, "The canonical A4 first page must contain substantial drawing content")

  const text = (await pdfText(a4.bytes)).replace(/\s+/g, " ")
  assert.match(text, /INV-00005/, "The authoritative PDF must contain the invoice number")
  assert.match(text, /Monika Sharma/, "The authoritative PDF must contain the customer name")
  assert.match(text, /Grand Total/i, "The authoritative PDF must contain the grand total label")
  assert.match(text, /Thank you/, "The authoritative PDF must contain the invoice footer")
  assert.match(text, /Generated by Bezgrow/, "The authoritative PDF must contain the Bezgrow attribution")
  for (const expectedLabel of [
    "GSTIN:", "FSSAI:", "Invoice Number", "Invoice Date", "Due Date", "Branch:", "State:", "HSN", "Qty",
    "MRP", "Rate", "Disc", "Taxable", "CGST", "SGST", "IGST", "Amount",
    "Subtotal", "Discount", "Round Off", "Paid:", "Balance Due:", "Amount in words",
  ]) {
    assert.ok(text.includes(expectedLabel), `Professional A4 field missing: ${expectedLabel}`)
  }

  const formats: PrintFormat[] = ["a4", "half-compact", "half-top", "thermal"]
  for (const format of formats) {
    const artifact = await getCanonicalInvoiceDocument(representative, settings, format)
    const validation = await validateCanonicalInvoicePdf(artifact.bytes, representative, settings, format)
    assert.equal(validation.pageCount, 1, `${format} must remain one page for the representative invoice`)
    assert.ok(validation.pageContentBytes[0] > 500, `${format} must not contain a blank first page`)
    assert.equal((await PDFDocument.load(artifact.bytes)).getTitle(), "Invoice INV-00005")
    const formatText = (await pdfText(artifact.bytes)).replace(/\s+/g, " ")
    assert.match(formatText, /Thank you/, `${format} must retain the exact primary footer`)
    assert.match(formatText, /Generated by Bezgrow/, `${format} must retain the exact attribution footer`)
  }

  const halfTop = await getCanonicalInvoiceDocument(invoice(20, true), settings, "half-top")
  const halfTopDocument = await PDFDocument.load(halfTop.bytes)
  const halfTopBoundary = halfTopDocument.getPage(0).getHeight() / 2
  const halfTopText = await pdfTextPositions(halfTop.bytes)
  assert.equal(halfTopDocument.getPageCount(), 2, "Long Half A4 Top invoices must paginate instead of shrinking below a readable size")
  assert.ok(halfTopText.length > 80, "Half A4 Top must substantially fill its intended content region")
  assert.ok(halfTopText.every((item) => item.y >= halfTopBoundary - 0.5), "Half A4 Top text must leave the lower physical half blank")
  assert.ok(Math.min(...halfTopText.map((item) => item.y)) < halfTopBoundary + 35, "Half A4 Top must use the lower edge of its top-half content region")
  const amountWordsY = halfTopText.find((item) => item.text === "Amount in words")?.y
  const grandTotalY = halfTopText.find((item) => item.text === "Grand Total")?.y
  assert.ok(amountWordsY !== undefined && grandTotalY !== undefined, "Half A4 Top must contain amount-in-words and totals sections")
  assert.ok(grandTotalY < amountWordsY - 20, "Half A4 Top totals must sit lower than amount in words with intentional breathing space")
  for (let pageIndex = 0; pageIndex < halfTopDocument.getPageCount(); pageIndex += 1) {
    const pageText = await pdfTextPositions(halfTop.bytes, pageIndex + 1)
    assert.ok(pageText.every((item) => item.y >= halfTopBoundary - 0.5), `Half A4 Top page ${pageIndex + 1} must leave its lower half blank`)
    assertDrawingStaysAbove(halfTopDocument.getPage(pageIndex), halfTopBoundary)
  }

  const halfCompactOne = await getCanonicalInvoiceDocument(invoice(1, true), settings, "half-compact")
  const halfCompactOneText = (await pdfText(halfCompactOne.bytes)).replace(/\s+/g, " ")
  assert.match(halfCompactOneText, /NOTES & TERMS/, "Short Half A4 Compact invoices must use their flexible body area intentionally")
  assert.match(halfCompactOneText, /Amount in words[\s\S]*Grand Total/, "Half A4 Compact must retain readable aligned summary sections")

  const interstate = invoice(5, true)
  interstate.items = interstate.items.map((item) => ({
    ...item,
    cgstPercent: 0,
    cgstAmount: 0,
    sgstPercent: 0,
    sgstAmount: 0,
    igstPercent: 18,
    igstAmount: item.taxableValue * 0.18,
  }))
  interstate.totals.cgst = 0
  interstate.totals.sgst = 0
  interstate.totals.igst = interstate.items.reduce((sum, item) => sum + item.igstAmount, 0)
  const interstateText = (await pdfText((await getCanonicalInvoiceDocument(interstate, settings, "a4")).bytes)).replace(/\s+/g, " ")
  assert.match(interstateText, /IGST/, "Interstate A4 invoices must preserve the IGST accounting column and total")

  const withoutAssets = await getCanonicalInvoiceDocument(representative, {
    ...settings,
    showLogo: false,
    showQr: false,
    showBarcode: false,
  }, "a4")
  assert.ok(a4.bytes.byteLength > withoutAssets.bytes.byteLength, "Enabled logo/QR/barcode output must add document content")

  console.log(`canonical-invoice-document-ok formats=${formats.length} a4_bytes=${a4.bytes.byteLength} a4_content=${a4.pageContentBytes[0]} first_ms=${firstRenderMs.toFixed(1)} cached_ms=${cachedRenderMs.toFixed(3)}`)
}

void run()
