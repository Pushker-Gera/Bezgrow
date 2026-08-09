import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  PDFRawStream,
  PDFStream,
  type PDFPage,
} from "pdf-lib"
import type { PrintFormat, PrintInvoice, PrintSettings } from "@/components/print/types"
import { createInvoicePdf } from "@/lib/pdf-invoice"

const POINTS_PER_MM = 72 / 25.4
const MINIMUM_INVOICE_PDF_BYTES = 1_500
const MINIMUM_PAGE_CONTENT_BYTES = 80
const DOCUMENT_CACHE_LIMIT = 8

export type CanonicalInvoiceDocument = {
  key: string
  filename: string
  bytes: Uint8Array
  pageCount: number
  pageContentBytes: number[]
  format: PrintFormat
}

const documentCache = new Map<string, Promise<CanonicalInvoiceDocument>>()

function safeInvoiceFilename(invoiceNumber: string) {
  const safeNumber = (invoiceNumber || "invoice")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
  return `Invoice-${safeNumber || "invoice"}.pdf`
}

/**
 * The key deliberately includes only invoice-affecting state. It stays in
 * memory and is never logged or persisted.
 */
export function invoiceDocumentKey(invoice: PrintInvoice, settings: PrintSettings, format: PrintFormat) {
  return JSON.stringify({ invoice, settings, format })
}

function closeTo(value: number, expected: number, tolerance = 0.4) {
  return Math.abs(value - expected) <= tolerance
}

function decodedStreamBytes(stream: PDFStream) {
  try {
    return stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents()
  } catch {
    return stream.getContents()
  }
}

function pageContent(page: PDFPage) {
  const contents = page.node.Contents()
  if (!contents) return new Uint8Array()
  if (contents instanceof PDFStream) return decodedStreamBytes(contents)
  if (!(contents instanceof PDFArray)) return new Uint8Array()

  const chunks: Uint8Array[] = []
  let total = 0
  for (let index = 0; index < contents.size(); index += 1) {
    const stream = contents.lookupMaybe(index, PDFStream)
    if (!stream) continue
    const bytes = decodedStreamBytes(stream)
    chunks.push(bytes)
    total += bytes.byteLength
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

function validatePageContract(
  document: PDFDocument,
  invoice: PrintInvoice,
  settings: PrintSettings,
  format: PrintFormat,
) {
  const pages = document.getPages()
  if (!pages.length) throw new Error("The generated invoice PDF has no pages.")

  const shouldBeOnePage =
    format === "thermal" ||
    format === "half-top" ||
    (invoice.items.length <= 20 && (format === "a4" || format === "half-compact"))
  if (shouldBeOnePage && pages.length !== 1) {
    throw new Error(`The generated ${format} invoice unexpectedly contains ${pages.length} pages.`)
  }

  const first = pages[0]
  const thermalWidth = settings.thermalWidth === "58mm" ? 58 : 80
  if (format === "a4" || format === "half-top") {
    if (!closeTo(first.getWidth(), 210 * POINTS_PER_MM) || !closeTo(first.getHeight(), 297 * POINTS_PER_MM)) {
      throw new Error("The generated invoice does not satisfy the A4 210mm x 297mm page contract.")
    }
  } else if (format === "half-compact") {
    if (!closeTo(first.getWidth(), 148 * POINTS_PER_MM) || !closeTo(first.getHeight(), 210 * POINTS_PER_MM)) {
      throw new Error("The generated compact invoice does not satisfy the 148mm x 210mm page contract.")
    }
  } else if (!closeTo(first.getWidth(), thermalWidth * POINTS_PER_MM) || first.getHeight() < 40 * POINTS_PER_MM) {
    throw new Error(`The generated thermal receipt does not satisfy the ${thermalWidth}mm continuous-paper contract.`)
  }
}

export async function validateCanonicalInvoicePdf(
  bytes: Uint8Array,
  invoice: PrintInvoice,
  settings: PrintSettings,
  format: PrintFormat,
) {
  if (bytes.byteLength < MINIMUM_INVOICE_PDF_BYTES) {
    throw new Error("The generated invoice PDF is unexpectedly small and was rejected.")
  }
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") {
    throw new Error("The generated invoice does not have a valid PDF header.")
  }

  let document: PDFDocument
  try {
    document = await PDFDocument.load(bytes, { updateMetadata: false })
  } catch {
    throw new Error("The generated invoice PDF could not be reopened for validation.")
  }
  validatePageContract(document, invoice, settings, format)

  const pageContentBytes = document.getPages().map((page, index) => {
    const content = pageContent(page)
    const contentText = new TextDecoder("latin1").decode(content)
    if (content.byteLength < MINIMUM_PAGE_CONTENT_BYTES || !/\b(?:BT|Do|re|m|l)\b/.test(contentText)) {
      throw new Error(`Invoice PDF page ${index + 1} is blank or contains no visible drawing operations.`)
    }
    return content.byteLength
  })

  const expectedTitle = `Invoice ${String(invoice.invoiceNumber || "-")}`
  if (document.getTitle() !== expectedTitle) {
    throw new Error("The generated invoice PDF metadata does not match the current invoice.")
  }

  return { pageCount: document.getPageCount(), pageContentBytes }
}

async function renderCanonicalInvoiceDocument(
  invoice: PrintInvoice,
  settings: PrintSettings,
  format: PrintFormat,
  key: string,
): Promise<CanonicalInvoiceDocument> {
  const bytes = await createInvoicePdf(invoice, settings, format)
  const validation = await validateCanonicalInvoicePdf(bytes, invoice, settings, format)
  return {
    key,
    filename: safeInvoiceFilename(invoice.invoiceNumber),
    bytes,
    pageCount: validation.pageCount,
    pageContentBytes: validation.pageContentBytes,
    format,
  }
}

export function getCanonicalInvoiceDocument(
  invoice: PrintInvoice,
  settings: PrintSettings,
  format: PrintFormat,
) {
  const key = invoiceDocumentKey(invoice, settings, format)
  const cached = documentCache.get(key)
  if (cached) return cached

  if (documentCache.size >= DOCUMENT_CACHE_LIMIT) {
    const oldest = documentCache.keys().next().value
    if (oldest) documentCache.delete(oldest)
  }
  const rendering = renderCanonicalInvoiceDocument(invoice, settings, format, key).catch((error) => {
    documentCache.delete(key)
    throw error
  })
  documentCache.set(key, rendering)
  return rendering
}

export function clearCanonicalInvoiceDocumentCache() {
  documentCache.clear()
}
