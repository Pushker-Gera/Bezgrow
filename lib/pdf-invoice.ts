import {
  PDFDocument,
  PageSizes,
  StandardFonts,
  degrees,
  rgb,
  type PDFImage,
  type PDFPage,
  type PDFFont,
} from "pdf-lib"
import QRCode from "qrcode"
import type { PrintFormat, PrintInvoice, PrintInvoiceItem, PrintSettings } from "@/components/print/types"
import { defaultPrintSettings } from "@/components/print/settings/defaults"
import { formatIndiaState } from "@/lib/india-gst-states"

type PdfContext = {
  document: PDFDocument
  regular: PDFFont
  bold: PDFFont
  logo: PDFImage | null
  qr: PDFImage | null
  settings: PrintSettings
  format: PrintFormat
}

const POINTS_PER_MM = 72 / 25.4
const INK = rgb(0.06, 0.09, 0.16)
const MUTED = rgb(0.28, 0.36, 0.47)
const BLUE = rgb(0.11, 0.31, 0.85)
const BORDER = rgb(0.82, 0.87, 0.93)
const SOFT = rgb(0.97, 0.98, 0.99)
const WHITE = rgb(1, 1, 1)
const IMMUTABLE_ASSET_CACHE_LIMIT = 24
const logoByteCache = new Map<string, Promise<Uint8Array | null>>()
const qrByteCache = new Map<string, Promise<Uint8Array | null>>()

function rememberImmutableAsset<T>(cache: Map<string, Promise<T>>, key: string, value: Promise<T>) {
  if (cache.size >= IMMUTABLE_ASSET_CACHE_LIMIT && !cache.has(key)) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
  cache.set(key, value)
  return value
}

function safeText(value: unknown) {
  return String(value ?? "-")
    .replaceAll("₹", "Rs ")
    .replace(/[\r\n\t]+/g, " ")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .trim() || "-"
}

function money(value: number) {
  return `Rs ${Number(value || 0).toFixed(2)}`
}

function dateText(value: string) {
  if (!value || value === "-") return "-"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? safeText(value) : date.toLocaleDateString("en-IN")
}

function shortDateText(value: string) {
  if (!value || value === "-") return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return safeText(value)
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getFullYear()).slice(-2)}`
}

function pageSize(format: PrintFormat, settings: PrintSettings, itemCount: number, termCount = 0): [number, number] {
  if (format === "thermal") {
    const width = (settings.thermalWidth === "58mm" ? 58 : 80) * POINTS_PER_MM
    const fixedContentHeight = 204 + (settings.showLogo ? 52 : 0)
    const totalsHeight = (settings.showGstDetails ? 6 : 5) * 12 + 4
    const referenceHeight = (settings.showBarcode ? 54 : 0) + (settings.showQr ? 74 : 0)
    const termsHeight = termCount > 0 ? 18 + termCount * 10 : 0
    const footerAndSafety = 68
    const itemHeight = settings.thermalWidth === "58mm"
      ? (settings.pharmaMode ? 55 : 35)
      : (settings.pharmaMode ? 44 : 25)
    const height = Math.max(
      settings.thermalWidth === "58mm" ? 255 : 275,
      fixedContentHeight + itemCount * itemHeight + totalsHeight + termsHeight + referenceHeight + footerAndSafety,
    )
    return [width, height]
  }
  if (format === "half-compact") return [PageSizes.A5[0], PageSizes.A5[1]]
  if (format === "half-top") return [PageSizes.A4[0], PageSizes.A4[1]]
  return [PageSizes.A4[0], PageSizes.A4[1]]
}

function fontSize(settings: PrintSettings, base: number) {
  if (settings.fontSize === "small") return base * 0.9
  if (settings.fontSize === "large") return base * 1.1
  return base
}

function pageMargin(settings: PrintSettings, compact: boolean) {
  const base = compact ? 22 : 36
  if (settings.margins === "compact") return base * 0.72
  if (settings.margins === "wide") return base * 1.28
  return base
}

function accent(settings: PrintSettings) {
  void settings
  return BLUE
}

function ink(settings: PrintSettings) {
  void settings
  return INK
}

function muted(settings: PrintSettings) {
  void settings
  return MUTED
}

function border(settings: PrintSettings) {
  void settings
  return BORDER
}

function soft(settings: PrintSettings) {
  void settings
  return SOFT
}

function drawCenteredWatermark(
  context: PdfContext,
  page: PDFPage,
  invoice: PrintInvoice,
  box: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() },
) {
  const label = safeText(invoice.watermark || "INVOICE").toUpperCase()
  const maximumSize = context.format === "thermal" ? 14 : context.format === "a4" ? 40 : 28
  const availableWidth = box.width * (context.format === "thermal" ? 0.72 : 0.66)
  const unitWidth = Math.max(1, context.bold.widthOfTextAtSize(label, 1))
  const size = Math.max(context.format === "thermal" ? 7 : 12, Math.min(maximumSize, availableWidth / unitWidth))
  const textWidth = context.bold.widthOfTextAtSize(label, size)
  const angle = context.format === "thermal" ? 32 : 38
  const radians = angle * Math.PI / 180
  const rotatedWidth = Math.abs(textWidth * Math.cos(radians)) + Math.abs(size * Math.sin(radians))
  const rotatedHeight = Math.abs(textWidth * Math.sin(radians)) + Math.abs(size * Math.cos(radians))
  page.drawText(label, {
    x: box.x + Math.max(0, (box.width - rotatedWidth) / 2) + size * Math.sin(radians),
    y: box.y + Math.max(0, (box.height - rotatedHeight) / 2),
    size,
    font: context.bold,
    color: rgb(0.22, 0.31, 0.48),
    opacity: 0.052,
    rotate: degrees(angle),
  })
}

function drawWatermark(context: PdfContext, page: PDFPage, invoice: PrintInvoice) {
  if (context.settings.showWatermark) drawCenteredWatermark(context, page, invoice)
}

function fitText(text: string, font: PDFFont, size: number, width: number) {
  const safe = safeText(text)
  if (font.widthOfTextAtSize(safe, size) <= width) return safe
  let output = safe
  while (output.length > 1 && font.widthOfTextAtSize(`${output}...`, size) > width) output = output.slice(0, -1)
  return `${output}...`
}

function drawText(
  page: PDFPage,
  font: PDFFont,
  text: unknown,
  x: number,
  y: number,
  size: number,
  color = INK,
  maxWidth?: number
) {
  const safe = maxWidth ? fitText(safeText(text), font, size, maxWidth) : safeText(text)
  page.drawText(safe, { x, y, size, font, color })
}

function drawCenteredText(page: PDFPage, font: PDFFont, text: unknown, y: number, size: number, color = INK) {
  const value = safeText(text)
  page.drawText(value, {
    x: Math.max(0, (page.getWidth() - font.widthOfTextAtSize(value, size)) / 2),
    y,
    size,
    font,
    color,
  })
}

function wrapText(text: unknown, font: PDFFont, size: number, maxWidth: number, maxLines = 2) {
  const words = safeText(text).split(/\s+/)
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
    if (lines.length >= maxLines) break
  }
  if (current && lines.length < maxLines) lines.push(current)
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = fitText(`${lines[maxLines - 1]}...`, font, size, maxWidth)
  }
  return lines
}

function bytesFromDataUrl(value: string) {
  const encoded = value.split(",")[1] || ""
  if (typeof atob !== "function") throw new Error("Base64 decoding is unavailable.")
  const binary = atob(encoded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function loadImageBytesFromUrl(url: string) {
  if (!url) return null
  try {
    // WebKit in a packaged Tauri app can reject fetch(data:...), even though
    // Chromium and Node accept it. Saved business logos are deliberately
    // passed to the PDF generator as self-contained data URLs, so decode those
    // bytes directly instead of asking the network stack to load them.
    const bytes = /^data:/i.test(url)
      ? bytesFromDataUrl(url)
      : await (async () => {
          const response = await fetch(url)
          if (!response.ok) return null
          return new Uint8Array(await response.arrayBuffer())
        })()
    if (!bytes?.length) return null
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    if (isPng || isJpeg) {
      return bytes
    }
    if (typeof document === "undefined") return null
    const blob = new Blob([bytes])
    const objectUrl = URL.createObjectURL(blob)
    try {
      const image = new Image()
      image.src = objectUrl
      await image.decode()
      const canvas = document.createElement("canvas")
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext("2d")
      if (!context) return null
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0)
      return bytesFromDataUrl(canvas.toDataURL("image/png"))
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  } catch {
    return null
  }
}

function imageBytesFromUrl(url: string) {
  if (!url) return Promise.resolve(null)
  return logoByteCache.get(url) || rememberImmutableAsset(logoByteCache, url, loadImageBytesFromUrl(url))
}

function qrBytes(value: string) {
  if (!value) return Promise.resolve(null)
  const existing = qrByteCache.get(value)
  if (existing) return existing
  const generated = QRCode.toDataURL(value, { width: 220, margin: 1, errorCorrectionLevel: "M" })
    .then((dataUrl) => bytesFromDataUrl(dataUrl))
    .catch(() => null)
  return rememberImmutableAsset(qrByteCache, value, generated)
}

async function embedImage(document: PDFDocument, bytes: Uint8Array | null) {
  if (!bytes?.length) return null
  try {
    return bytes[0] === 0xff ? await document.embedJpg(bytes) : await document.embedPng(bytes)
  } catch {
    return null
  }
}

export function containedImageDimensions(imageWidth: number, imageHeight: number, maximumWidth: number, maximumHeight: number) {
  const scale = Math.min(maximumWidth / imageWidth, maximumHeight / imageHeight)
  return { width: imageWidth * scale, height: imageHeight * scale }
}

function drawContainedImage(page: PDFPage, image: PDFImage, x: number, y: number, width: number, height: number) {
  const { width: drawnWidth, height: drawnHeight } = containedImageDimensions(image.width, image.height, width, height)
  page.drawImage(image, {
    x: x + (width - drawnWidth) / 2,
    y: y + (height - drawnHeight) / 2,
    width: drawnWidth,
    height: drawnHeight,
  })
}

async function prepareContext(invoice: PrintInvoice, settings: PrintSettings, format: PrintFormat): Promise<PdfContext> {
  const document = await PDFDocument.create()
  const [regular, bold] = await Promise.all([
    document.embedFont(StandardFonts.Helvetica),
    document.embedFont(StandardFonts.HelveticaBold),
  ])
  const logoBytes = settings.showLogo
    ? await imageBytesFromUrl(invoice.enterprise.logoUrl)
    : null
  const logo = await embedImage(document, logoBytes)
  if (settings.showLogo && invoice.enterprise.logoUrl && !logo) {
    throw new Error("The saved business logo could not be embedded in the invoice PDF.")
  }
  let qr: PDFImage | null = null
  if (settings.showQr && invoice.qrValue) {
    try {
      qr = await embedImage(document, await qrBytes(invoice.qrValue))
    } catch {
      qr = null
    }
  }
  document.setTitle(`Invoice ${safeText(invoice.invoiceNumber)}`)
  document.setAuthor(safeText(invoice.enterprise.name))
  document.setCreator("Bezgrow offline desktop ERP")
  document.setProducer("Bezgrow local PDF engine")
  document.setSubject(`Invoice ${safeText(invoice.invoiceNumber)}`)
  return { document, regular, bold, logo, qr, settings, format }
}

function drawHeader(context: PdfContext, page: PDFPage, invoice: PrintInvoice, top: number, compact = false) {
  const { regular, bold, logo, settings } = context
  const margin = pageMargin(settings, compact)
  const logoWidth = compact ? 58 : 86
  const logoHeight = compact ? 36 : 54
  let brandX = margin
  if (settings.showLogo && logo) {
    drawContainedImage(page, logo, margin, top - logoHeight, logoWidth, logoHeight)
    brandX += logoWidth + 10
  }
  const cardWidth = compact ? 146 : 184
  const cardX = page.getWidth() - margin - cardWidth
  const brandWidth = Math.max(80, cardX - brandX - 12)
  const nameSize = Math.max(compact ? 10 : 15, fontSize(settings, compact ? 10 : 15))
  const nameLines = wrapText(invoice.enterprise.name, bold, nameSize, brandWidth, compact ? 2 : 3)
  nameLines.forEach((line, index) => drawText(page, bold, line, brandX, top - 14 - index * (nameSize + 1.5), nameSize, ink(settings), brandWidth))
  const detailsStart = compact
    ? top - 43
    : Math.min(top - 48, top - 19 - nameLines.length * (nameSize + 1.5))
  const addressSize = Math.max(compact ? 6.5 : 7.8, fontSize(settings, compact ? 6.5 : 7.8))
  const addressLines = wrapText(invoice.enterprise.address, regular, addressSize, brandWidth, 2)
  addressLines.forEach((line, index) => drawText(page, regular, line, brandX, detailsStart - index * (addressSize + 2), addressSize, muted(settings), brandWidth))
  const contact = [
    invoice.enterprise.gstNumber !== "-" ? `GSTIN: ${invoice.enterprise.gstNumber}` : "",
    invoice.enterprise.phone !== "-" ? `Phone: ${invoice.enterprise.phone}` : "",
  ].filter(Boolean).join(" | ")
  const identityY = detailsStart - addressLines.length * (addressSize + 2) - 2
  if (contact) drawText(page, regular, contact, brandX, identityY, fontSize(settings, compact ? 6.1 : 7.1), muted(settings), brandWidth)
  if (!compact) {
    const secondary = [
      invoice.enterprise.email !== "-" ? `Email: ${invoice.enterprise.email}` : "",
      invoice.enterprise.fssai !== "-" ? `FSSAI: ${invoice.enterprise.fssai}` : "",
      invoice.enterprise.website !== "-" ? invoice.enterprise.website : "",
    ].filter(Boolean).join(" | ")
    if (secondary) drawText(page, regular, secondary, brandX, identityY - 12, fontSize(settings, 6.5), muted(settings), brandWidth)
  }

  const cardHeight = compact ? 84 : 96
  page.drawRectangle({ x: cardX, y: top - cardHeight, width: cardWidth, height: cardHeight, color: soft(settings), borderColor: border(settings), borderWidth: 0.8 })
  page.drawRectangle({ x: cardX, y: top - 4, width: 3, height: 4, color: accent(settings) })
  drawText(page, bold, invoice.invoiceTitle.toUpperCase(), cardX + 11, top - 14, Math.max(7.2, fontSize(settings, 7.2)), muted(settings), cardWidth - 22)
  drawText(page, regular, "Invoice Number", cardX + 11, top - 27, Math.max(5.5, fontSize(settings, 5.5)), muted(settings), cardWidth - 22)
  drawText(page, bold, invoice.invoiceNumber, cardX + 11, top - 41, Math.max(compact ? 10 : 12.5, fontSize(settings, compact ? 10 : 12.5)), accent(settings), cardWidth - 22)
  const metaSize = Math.max(compact ? 6.2 : 6.8, fontSize(settings, compact ? 6.2 : 6.8))
  drawText(page, regular, `Invoice Date: ${dateText(invoice.invoiceDate)}`, cardX + 11, top - 56, metaSize, ink(settings), cardWidth - 22)
  drawText(page, regular, `Due Date: ${dateText(invoice.dueDate)}`, cardX + 11, top - 69, metaSize, ink(settings), cardWidth - 22)
  const branch = invoice.enterprise.branchName !== "-" ? invoice.enterprise.branchName : "-"
  drawText(page, regular, `Branch: ${branch}`, cardX + 11, top - (compact ? 78 : 82), metaSize, muted(settings), cardWidth - 22)
  const dividerY = top - cardHeight - 10
  page.drawLine({ start: { x: margin, y: dividerY }, end: { x: page.getWidth() - margin, y: dividerY }, thickness: 1.4, color: ink(settings) })
  return dividerY - 12
}

function paymentStatus(invoice: PrintInvoice) {
  if (invoice.payment.dueAmount <= 0) return "Paid"
  if (invoice.payment.paidAmount > 0) return "Partially paid"
  return "Unpaid"
}

function drawCustomer(context: PdfContext, page: PDFPage, invoice: PrintInvoice, y: number, compact = false) {
  const { regular, bold, settings } = context
  const margin = pageMargin(settings, compact)
  const gap = 10
  const width = (page.getWidth() - margin * 2 - gap) / 2
  const height = compact ? 58 : 82
  for (const x of [margin, margin + width + gap]) {
    page.drawRectangle({ x, y: y - height, width, height, color: soft(settings), borderColor: border(settings), borderWidth: 0.7 })
  }
  drawText(page, bold, "BILL TO", margin + 10, y - 15, fontSize(settings, 7), accent(settings))
  const customerNameSize = Math.max(compact ? 9.5 : 11.5, fontSize(settings, compact ? 9.5 : 11.5))
  const customerNameLines = wrapText(invoice.customer.name, bold, customerNameSize, width - 20, compact ? 1 : 2)
  customerNameLines.forEach((line, index) => {
    drawText(page, bold, line, margin + 10, y - 31 - index * (customerNameSize + 1), customerNameSize, ink(settings), width - 20)
  })
  const customerContact = [invoice.customer.phone, invoice.customer.email].filter((value) => value && value !== "-").join(" | ") || "-"
  const contactY = y - (compact ? 46 : 59)
  drawText(page, regular, customerContact, margin + 10, contactY, Math.max(7, fontSize(settings, compact ? 7 : 7.6)), muted(settings), width - 20)
  if (!compact) {
    wrapText(invoice.customer.address, regular, Math.max(7.4, fontSize(settings, 7.4)), width - 20, 2).forEach((line, index) => {
      drawText(page, regular, line, margin + 10, y - 71 - index * 9, Math.max(7.4, fontSize(settings, 7.4)), muted(settings), width - 20)
    })
  }
  const taxX = margin + width + gap + 10
  drawText(page, bold, "TAX & PAYMENT", taxX, y - 15, fontSize(settings, 7), accent(settings))
  if (settings.showGstDetails) drawText(page, regular, `GSTIN: ${invoice.customer.gstin}`, taxX, y - 31, Math.max(7.4, fontSize(settings, 7.4)), ink(settings), width - 20)
  drawText(page, regular, `State: ${formatIndiaState(invoice.customer.state, invoice.customer.stateCode)}`, taxX, y - (compact ? 42 : 46), Math.max(7.1, fontSize(settings, 7.1)), muted(settings), width - 20)
  drawText(page, regular, `Payment: ${invoice.payment.mode}`, taxX, y - (compact ? 54 : 61), Math.max(7.4, fontSize(settings, 7.4)), ink(settings), width - 20)
  if (!compact) drawText(page, regular, `Status: ${paymentStatus(invoice)}`, taxX, y - 75, Math.max(7.1, fontSize(settings, 7.1)), muted(settings), width - 20)
  return y - height - 10
}

function tableColumns(page: PDFPage, settings: PrintSettings, compact: boolean) {
  const margin = pageMargin(settings, compact)
  const available = page.getWidth() - margin * 2
  const columns = compact
    ? [
        { key: "index", label: "#", ratio: 0.055 },
        { key: "item", label: "Item", ratio: settings.pharmaMode ? 0.33 : 0.41 },
        ...(settings.pharmaMode ? [{ key: "batch", label: "Batch / Exp", ratio: 0.15 }] : []),
        ...(settings.showHsn ? [{ key: "hsn", label: "HSN", ratio: 0.11 }] : []),
        { key: "qty", label: "Qty", ratio: 0.09 },
        { key: "rate", label: "Rate", ratio: 0.13 },
        ...(settings.showGstDetails ? [{ key: "gst", label: "GST", ratio: 0.095 }] : []),
        { key: "amount", label: "Amount", ratio: 0.16 },
      ]
    : [
        { key: "item", label: "Item", ratio: settings.pharmaMode ? 0.18 : 0.27 },
        ...(settings.pharmaMode ? [{ key: "batch", label: "Batch / Exp", ratio: 0.115 }] : []),
        ...(settings.showHsn ? [{ key: "hsn", label: "HSN", ratio: 0.082 }] : []),
        { key: "qty", label: "Qty", ratio: 0.05 },
        { key: "mrp", label: "MRP", ratio: 0.066 },
        { key: "rate", label: "Rate", ratio: 0.072 },
        { key: "discount", label: "Disc", ratio: 0.074 },
        { key: "taxable", label: "Taxable", ratio: 0.078 },
        ...(settings.showGstDetails
          ? [
              { key: "cgst", label: "CGST", ratio: 0.071 },
              { key: "sgst", label: "SGST", ratio: 0.071 },
              { key: "igst", label: "IGST", ratio: 0.071 },
            ]
          : []),
        { key: "amount", label: "Amount", ratio: 0.092 },
      ]
  const totalRatio = columns.reduce((sum, column) => sum + column.ratio, 0)
  let x = margin
  return columns.map((column) => {
    const width = available * (column.ratio / totalRatio)
    const result = { ...column, x, width }
    x += width
    return result
  })
}

function drawTableHeader(context: PdfContext, page: PDFPage, y: number, compact: boolean) {
  const { bold, settings } = context
  const columns = tableColumns(page, settings, compact)
  const margin = pageMargin(settings, compact)
  const height = compact ? 19 : 23
  page.drawRectangle({ x: margin, y: y - height, width: page.getWidth() - margin * 2, height, color: ink(settings) })
  for (const column of columns) {
    const headingSize = Math.max(compact ? 6.4 : 6.5, fontSize(settings, compact ? 6.4 : 6.5))
    drawText(page, bold, column.label, column.x + (compact ? 4 : 2.5), y - height + 7, headingSize, WHITE, column.width - (compact ? 8 : 5))
  }
  return { columns, y: y - height }
}

function itemCell(item: PrintInvoiceItem, key: string, index = 0) {
  if (key === "index") return String(index + 1)
  if (key === "item") return item.name
  if (key === "batch") return `${item.batchNumber} / ${shortDateText(item.expiryDate)}`
  if (key === "hsn") return item.hsnCode
  if (key === "qty") return String(item.quantity)
  if (key === "free") return String(item.freeQuantity)
  if (key === "unit") return item.unit
  if (key === "mrp") return item.mrp.toFixed(2)
  if (key === "rate") return item.rate.toFixed(2)
  if (key === "gst") return `${item.cgstPercent + item.sgstPercent + item.igstPercent}%`
  if (key === "discount") return `${item.discountPercent.toFixed(1)}% ${item.discountAmount.toFixed(2)}`
  if (key === "taxable") return item.taxableValue.toFixed(2)
  if (key === "cgst") return `${item.cgstPercent.toFixed(1)}%`
  if (key === "sgst") return `${item.sgstPercent.toFixed(1)}%`
  if (key === "igst") return `${item.igstPercent.toFixed(1)}%`
  return item.finalAmount.toFixed(2)
}

function drawItemRow(context: PdfContext, page: PDFPage, item: PrintInvoiceItem, index: number, y: number, compact: boolean, rowHeight?: number) {
  const { regular, bold, settings } = context
  const columns = tableColumns(page, settings, compact)
  const margin = pageMargin(settings, compact)
  const height = rowHeight || (compact ? 24 : 30)
  const rowFontSize = Math.max(compact ? 6.8 : 7, fontSize(settings, compact ? 6.8 : 7))
  page.drawRectangle({
    x: margin,
    y: y - height,
    width: page.getWidth() - margin * 2,
    height,
    borderColor: border(settings),
    borderWidth: 0.55,
    color: WHITE,
  })
  for (const column of columns) {
    if (column.key === "item" && (!compact || height >= 21)) {
      const lines = wrapText(item.name, bold, rowFontSize, column.width - 6, 2)
      const lineHeight = rowFontSize + 1.5
      const blockHeight = lines.length * lineHeight
      const firstY = y - (height - blockHeight) / 2 - rowFontSize
      lines.forEach((line, lineIndex) => {
        drawText(page, bold, line, column.x + 3, firstY - lineIndex * lineHeight, rowFontSize, ink(settings), column.width - 6)
      })
      continue
    }
    const cellPadding = compact && column.key === "hsn" ? 2 : compact ? 4 : 3
    const cellFontSize = compact && column.key === "hsn" ? Math.min(rowFontSize, 6.2) : rowFontSize
    drawText(
      page,
      column.key === "item" || column.key === "amount" ? bold : regular,
      itemCell(item, column.key, index),
      column.x + cellPadding,
      y - height + Math.max(3, (height - cellFontSize) / 2),
      cellFontSize,
      ink(settings),
      column.width - cellPadding * 2
    )
  }
  return y - height
}

export function code39Payload(value: string) {
  return safeText(value).toUpperCase().replace(/[^0-9A-Z .-]/g, "-")
}

const CODE39_PATTERNS: Record<string, string> = {
    "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn", "4": "nnnwwnnnw",
    "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw", "8": "wnnwnnwnn", "9": "nnwwnnwnn",
    A: "wnnnnwnnw", B: "nnwnnwnnw", C: "wnwnnwnnn", D: "nnnnwwnnw", E: "wnnnwwnnn",
    F: "nnwnwwnnn", G: "nnnnnwwnw", H: "wnnnnwwnn", I: "nnwnnwwnn", J: "nnnnwwwnn",
    K: "wnnnnnnww", L: "nnwnnnnww", M: "wnwnnnnwn", N: "nnnnwnnww", O: "wnnnwnnwn",
    P: "nnwnwnnwn", Q: "nnnnnnwww", R: "wnnnnnwwn", S: "nnwnnnwwn", T: "nnnnwnwwn",
    U: "wwnnnnnnw", V: "nwwnnnnnw", W: "wwwnnnnnn", X: "nwnnwnnnw", Y: "wwnnwnnnn",
    Z: "nwwnwnnnn", "-": "nwnnnnwnw", ".": "wwnnnnwnn", " ": "nwwnnnwnn", "*": "nwnnwnwnn",
}

export function code39Modules(value: string) {
  const encoded = `*${code39Payload(value)}*`
  const modules: boolean[] = []
  for (const character of encoded) {
    const pattern = CODE39_PATTERNS[character] || CODE39_PATTERNS["-"]
    Array.from(pattern).forEach((unit, index) => {
      modules.push(...Array.from({ length: unit === "w" ? 3 : 1 }, () => index % 2 === 0))
    })
    modules.push(false)
  }
  return modules
}

function drawCode39(page: PDFPage, value: string, x: number, y: number, maxWidth: number, height: number, color = INK) {
  const encoded = `*${code39Payload(value)}*`
  const units = Array.from(encoded).reduce((sum, character) => {
    const pattern = CODE39_PATTERNS[character] || CODE39_PATTERNS["-"]
    return sum + Array.from(pattern).reduce((width, unit) => width + (unit === "w" ? 3 : 1), 0) + 1
  }, 0)
  const unitWidth = Math.min(1.15, maxWidth / Math.max(1, units))
  let cursor = x
  for (const character of encoded) {
    const pattern = CODE39_PATTERNS[character] || CODE39_PATTERNS["-"]
    Array.from(pattern).forEach((unit, index) => {
      const width = (unit === "w" ? 3 : 1) * unitWidth
      if (index % 2 === 0) page.drawRectangle({ x: cursor, y, width, height, color })
      cursor += width
    })
    cursor += unitWidth
  }
}

function drawTotalsAndFooter(context: PdfContext, page: PDFPage, invoice: PrintInvoice, y: number, pageNumber: number, pageCount: number, compact: boolean) {
  const { regular, bold, qr, settings } = context
  const margin = pageMargin(settings, compact)
  const width = page.getWidth() - margin * 2
  const totalsWidth = compact ? width * 0.48 : 185
  const totalsX = page.getWidth() - margin - totalsWidth
  const rows = [
    ["Subtotal", invoice.totals.subtotal],
    ["Discount", invoice.totals.discount],
    ["Taxable", invoice.totals.taxableAmount],
    ...(settings.showGstDetails
      ? ([["CGST", invoice.totals.cgst], ["SGST", invoice.totals.sgst], ["IGST", invoice.totals.igst]] as Array<[string, number]>)
      : []),
    ["Round Off", invoice.totals.roundOff],
  ] as Array<[string, number]>
  const rowHeight = compact ? 13 : 15
  const totalHeight = rows.length * rowHeight + 31
  const boxBottom = y - totalHeight
  page.drawRectangle({ x: totalsX, y: boxBottom, width: totalsWidth, height: totalHeight, color: soft(settings), borderColor: border(settings), borderWidth: 0.7 })
  rows.forEach(([label, value], index) => {
    const rowY = y - 15 - index * rowHeight
    drawText(page, regular, label, totalsX + 10, rowY, fontSize(settings, compact ? 7 : 8.5), muted(settings))
    const valueText = money(value)
    const valueWidth = bold.widthOfTextAtSize(valueText, fontSize(settings, compact ? 7 : 8.5))
    drawText(page, bold, valueText, totalsX + totalsWidth - 10 - valueWidth, rowY, fontSize(settings, compact ? 7 : 8.5), ink(settings))
  })
  page.drawLine({ start: { x: totalsX + 8, y: boxBottom + 27 }, end: { x: totalsX + totalsWidth - 8, y: boxBottom + 27 }, thickness: 0.7, color: border(settings) })
  drawText(page, bold, "Grand Total", totalsX + 10, boxBottom + 10, fontSize(settings, compact ? 9 : 11), accent(settings))
  const totalText = money(invoice.totals.grandTotal)
  const totalSize = fontSize(settings, compact ? 9 : 11)
  drawText(page, bold, totalText, totalsX + totalsWidth - 10 - bold.widthOfTextAtSize(totalText, totalSize), boxBottom + 10, totalSize, accent(settings))

  const leftWidth = totalsX - margin - 12
  drawText(page, bold, "Amount in words", margin, y - 14, fontSize(settings, 7), accent(settings))
  const amountLines = wrapText(invoice.totals.amountInWords, regular, fontSize(settings, 8), leftWidth, compact ? 2 : 3)
  amountLines.forEach((line, index) => {
    drawText(page, regular, line, margin, y - 30 - index * 12, fontSize(settings, 8), ink(settings))
  })
  let detailsY = y - 34 - amountLines.length * 12
  let renderedTerms = 0
  if (invoice.terms.length) {
    drawText(page, bold, "Terms & Conditions", margin, detailsY, fontSize(settings, 7), accent(settings))
    detailsY -= 12
    const termLimit = compact ? 2 : 3
    const visibleTerms = invoice.terms.slice(0, termLimit)
    renderedTerms = visibleTerms.length
    visibleTerms.forEach((term, index) => {
      drawText(page, regular, `${index + 1}. ${term}`, margin, detailsY - index * 11, fontSize(settings, compact ? 6.4 : 7), muted(settings), leftWidth)
    })
  }
  const paymentTop = compact
    ? detailsY - renderedTerms * 11 - 8
    : boxBottom + 22
  drawText(page, bold, `Paid: ${money(invoice.payment.paidAmount)}`, margin, paymentTop, fontSize(settings, 8), ink(settings), leftWidth)
  drawText(page, bold, `Balance Due: ${money(invoice.payment.dueAmount)}`, margin, paymentTop - 13, fontSize(settings, 8), ink(settings), leftWidth)

  const codesY = Math.max(32, boxBottom - (compact ? 64 : 78))
  const barcodeWidth = compact ? 120 : 165
  const barcodeHeight = compact ? 24 : 29
  if (settings.showBarcode) {
    drawCode39(page, invoice.barcodeValue, margin, codesY + 22, barcodeWidth, barcodeHeight, ink(settings))
    drawText(page, bold, invoice.barcodeValue, margin, codesY + 8, fontSize(settings, 6.5), ink(settings), barcodeWidth)
  }
  const qrSize = 54
  const qrX = margin + (settings.showBarcode ? barcodeWidth + 14 : 0)
  if (settings.showQr && qr) {
    drawContainedImage(page, qr, qrX, codesY + 6, qrSize, qrSize)
    drawText(page, regular, "Scan invoice summary", qrX, codesY - 3, fontSize(settings, 5.8), muted(settings), qrSize + 30)
  }
  if (settings.showSignature) {
    const signatureRight = page.getWidth() - margin
    const signatureLeft = Math.max(qrX + (settings.showQr ? qrSize + 18 : 0), signatureRight - (compact ? 92 : 120))
    page.drawLine({ start: { x: signatureLeft, y: codesY + 12 }, end: { x: signatureRight, y: codesY + 12 }, thickness: 0.6, color: muted(settings) })
    drawText(page, regular, "Authorized Signatory", signatureLeft, codesY, fontSize(settings, 7), muted(settings), signatureRight - signatureLeft)
  }
  page.drawLine({ start: { x: margin, y: 27 }, end: { x: page.getWidth() - margin, y: 27 }, thickness: 0.6, color: border(settings) })
  drawCenteredText(page, bold, "Thank you", 15, fontSize(settings, 7.5), ink(settings))
  drawCenteredText(page, regular, "Generated by Bezgrow", 5, fontSize(settings, 6.2), muted(settings))
  const pageLabel = `Page ${pageNumber} of ${pageCount}`
  drawText(page, regular, pageLabel, page.getWidth() - margin - regular.widthOfTextAtSize(pageLabel, fontSize(settings, 6.2)), 5, fontSize(settings, 6.2), muted(settings))
}

function addDocumentPage(context: PdfContext, invoice: PrintInvoice, continuation = false) {
  const compact = context.format !== "a4"
  const size = pageSize(context.format, context.settings, invoice.items.length)
  const page = context.document.addPage(size)
  drawWatermark(context, page, invoice)
  let y = drawHeader(context, page, invoice, page.getHeight() - (compact ? 18 : 28), compact)
  if (!continuation) y = drawCustomer(context, page, invoice, y, compact)
  return { page, y, compact }
}

function renderPagedInvoice(context: PdfContext, invoice: PrintInvoice) {
  const pageRecords: Array<{ page: PDFPage; totalsY?: number; compact: boolean }> = []
  let current = addDocumentPage(context, invoice)
  pageRecords.push({ page: current.page, compact: current.compact })
  let header = drawTableHeader(context, current.page, current.y, current.compact)
  let y = header.y
  const bottomReserve = current.compact ? 190 : 220
  const rowHeight = current.compact ? 24 : 30

  for (const [itemIndex, item] of invoice.items.entries()) {
    if (y - rowHeight < bottomReserve) {
      current = addDocumentPage(context, invoice, true)
      pageRecords.push({ page: current.page, compact: current.compact })
      header = drawTableHeader(context, current.page, current.y, current.compact)
      y = header.y
    }
    y = drawItemRow(context, current.page, item, itemIndex, y, current.compact, rowHeight)
  }
  if (y < bottomReserve + 10) {
    current = addDocumentPage(context, invoice, true)
    pageRecords.push({ page: current.page, compact: current.compact })
    y = current.y
  }
  pageRecords[pageRecords.length - 1].totalsY = y - 12
  pageRecords.forEach((record, index) => {
    if (record.totalsY !== undefined) {
      drawTotalsAndFooter(context, record.page, invoice, record.totalsY, index + 1, pageRecords.length, record.compact)
    } else {
      const margin = pageMargin(context.settings, record.compact)
      record.page.drawLine({ start: { x: margin, y: 27 }, end: { x: record.page.getWidth() - margin, y: 27 }, thickness: 0.6, color: border(context.settings) })
      drawCenteredText(record.page, context.bold, "Thank you", 15, fontSize(context.settings, 7.5), ink(context.settings))
      drawCenteredText(record.page, context.regular, "Generated by Bezgrow", 5, fontSize(context.settings, 6.2), muted(context.settings))
      drawText(record.page, context.regular, `Page ${index + 1} of ${pageRecords.length}`, record.page.getWidth() - margin - 56, 5, fontSize(context.settings, 6.2), muted(context.settings))
    }
  })
}

function renderHalfCompactInvoice(context: PdfContext, invoice: PrintInvoice) {
  if (invoice.items.length > 10) {
    renderPagedInvoice(context, invoice)
    return
  }
  const page = context.document.addPage(PageSizes.A5)
  const { regular, bold, qr, settings } = context
  const width = page.getWidth()
  const height = page.getHeight()
  const margin = pageMargin(settings, true)
  drawWatermark(context, page, invoice)

  let y = drawHeader(context, page, invoice, height - 18, true)
  const gap = 10
  const customerWidth = (width - margin * 2 - gap) / 2
  const customerHeight = 72
  for (const x of [margin, margin + customerWidth + gap]) {
    page.drawRectangle({
      x,
      y: y - customerHeight,
      width: customerWidth,
      height: customerHeight,
      color: soft(settings),
      borderColor: border(settings),
      borderWidth: 0.7,
    })
  }
  drawText(page, bold, "BILL TO", margin + 9, y - 14, fontSize(settings, 6.8), accent(settings))
  const customerNameLines = wrapText(invoice.customer.name, bold, fontSize(settings, 8.7), customerWidth - 18, 2)
  customerNameLines.forEach((line, index) => {
    drawText(page, bold, line, margin + 9, y - 27 - index * 10, fontSize(settings, 8.7), ink(settings), customerWidth - 18)
  })
  const customerContact = [invoice.customer.phone, invoice.customer.email]
    .filter((value) => value && value !== "-")
    .join(" | ") || "-"
  drawText(page, regular, customerContact, margin + 9, y - 49, fontSize(settings, 6.2), muted(settings), customerWidth - 18)
  wrapText(invoice.customer.address, regular, fontSize(settings, 5.8), customerWidth - 18, 2).forEach((line, index) => {
    drawText(page, regular, line, margin + 9, y - 59 - index * 8, fontSize(settings, 5.8), muted(settings), customerWidth - 18)
  })

  const taxX = margin + customerWidth + gap + 9
  drawText(page, bold, "TAX & PAYMENT", taxX, y - 14, fontSize(settings, 6.8), accent(settings))
  if (settings.showGstDetails) {
    drawText(page, regular, `GSTIN: ${invoice.customer.gstin}`, taxX, y - 29, fontSize(settings, 6.5), ink(settings), customerWidth - 18)
  }
  drawText(page, regular, `State: ${formatIndiaState(invoice.customer.state, invoice.customer.stateCode)}`, taxX, y - 42, fontSize(settings, 6.3), muted(settings), customerWidth - 18)
  drawText(page, regular, `Payment: ${invoice.payment.mode}`, taxX, y - 55, fontSize(settings, 6.6), ink(settings), customerWidth - 18)
  drawText(page, regular, `Status: ${paymentStatus(invoice)}`, taxX, y - 67, fontSize(settings, 6.1), muted(settings), customerWidth - 18)
  y -= customerHeight + 10

  const table = drawTableHeader(context, page, y, true)
  y = table.y
  const summaryTop = 194
  const availableRowsHeight = y - summaryTop
  const rowHeight = invoice.items.length > 0
    ? Math.max(17, Math.min(24, availableRowsHeight / invoice.items.length))
    : 24
  for (const [index, item] of invoice.items.entries()) {
    if (y - rowHeight < summaryTop - 0.5) {
      throw new Error("Half A4 Compact supports up to 20 standard invoice lines without clipping.")
    }
    y = drawItemRow(context, page, item, index, y, true, rowHeight)
  }
  const flexibleDetailsHeight = y - summaryTop
  if (flexibleDetailsHeight > 28) {
    page.drawRectangle({
      x: margin,
      y: summaryTop,
      width: width - margin * 2,
      height: flexibleDetailsHeight,
      borderColor: border(settings),
      borderWidth: 0.55,
      color: soft(settings),
    })
    drawText(page, bold, "NOTES & TERMS", margin + 9, y - 14, fontSize(settings, 6.2), accent(settings))
    const detailLines = [
      ...(invoice.notes && invoice.notes !== "-" ? [invoice.notes] : []),
      ...invoice.terms.map((term, index) => `${index + 1}. ${term}`),
    ]
    const availableDetailLines = Math.max(1, Math.floor((flexibleDetailsHeight - 24) / 9))
    detailLines.slice(0, availableDetailLines).forEach((line, index) => {
      drawText(page, regular, line, margin + 9, y - 27 - index * 9, fontSize(settings, 5.9), muted(settings), width - margin * 2 - 18)
    })
  }

  const totalsWidth = 172
  const totalsX = width - margin - totalsWidth
  const leftWidth = totalsX - margin - 12
  drawText(page, bold, "Amount in words", margin, summaryTop - 14, fontSize(settings, 6.8), accent(settings))
  const amountLines = wrapText(invoice.totals.amountInWords, regular, fontSize(settings, 7.2), leftWidth, 2)
  amountLines.forEach((line, index) => {
    drawText(page, regular, line, margin, summaryTop - 27 - index * 10, fontSize(settings, 7.2), ink(settings), leftWidth)
  })
  const detailsY = summaryTop - 34 - amountLines.length * 10
  drawText(page, bold, `Paid: ${money(invoice.payment.paidAmount)}`, margin, detailsY, fontSize(settings, 6.8), ink(settings), leftWidth)
  drawText(page, bold, `Balance Due: ${money(invoice.payment.dueAmount)}`, margin, detailsY - 11, fontSize(settings, 6.8), ink(settings), leftWidth)

  const totalRows = [
    ["Subtotal", invoice.totals.subtotal],
    ["Discount", invoice.totals.discount],
    ["Taxable", invoice.totals.taxableAmount],
    ...(settings.showGstDetails
      ? ([
          ["CGST", invoice.totals.cgst],
          ["SGST", invoice.totals.sgst],
          ["IGST", invoice.totals.igst],
        ] as Array<[string, number]>)
      : []),
    ["Round Off", invoice.totals.roundOff],
  ] as Array<[string, number]>
  const totalRowHeight = 11
  const totalsHeight = totalRows.length * totalRowHeight + 27
  const totalsBottom = summaryTop - totalsHeight
  page.drawRectangle({
    x: totalsX,
    y: totalsBottom,
    width: totalsWidth,
    height: totalsHeight,
    color: soft(settings),
    borderColor: border(settings),
    borderWidth: 0.7,
  })
  totalRows.forEach(([label, value], index) => {
    const rowY = summaryTop - 13 - index * totalRowHeight
    drawText(page, regular, label, totalsX + 9, rowY, fontSize(settings, 6.5), muted(settings))
    const valueText = money(value)
    const valueSize = fontSize(settings, 6.5)
    drawText(page, bold, valueText, width - margin - 9 - bold.widthOfTextAtSize(valueText, valueSize), rowY, valueSize, ink(settings))
  })
  page.drawLine({
    start: { x: totalsX + 8, y: totalsBottom + 23 },
    end: { x: width - margin - 8, y: totalsBottom + 23 },
    thickness: 0.7,
    color: border(settings),
  })
  drawText(page, bold, "Grand Total", totalsX + 9, totalsBottom + 8, fontSize(settings, 8.2), accent(settings))
  const grandText = money(invoice.totals.grandTotal)
  const grandSize = fontSize(settings, 8.2)
  drawText(page, bold, grandText, width - margin - 9 - bold.widthOfTextAtSize(grandText, grandSize), totalsBottom + 8, grandSize, accent(settings))

  const codeY = 36
  if (settings.showBarcode) {
    drawCode39(page, invoice.barcodeValue, margin, codeY + 16, 108, 22, ink(settings))
    drawText(page, bold, invoice.barcodeValue, margin, codeY + 5, fontSize(settings, 5.9), ink(settings), 108)
  }
  if (settings.showQr && qr) {
    const qrX = margin + (settings.showBarcode ? 120 : 0)
    drawContainedImage(page, qr, qrX, codeY + 1, 54, 54)
  }
  if (settings.showSignature) {
    const signatureRight = width - margin
    const signatureLeft = signatureRight - 92
    page.drawLine({ start: { x: signatureLeft, y: codeY + 14 }, end: { x: signatureRight, y: codeY + 14 }, thickness: 0.6, color: muted(settings) })
    drawText(page, regular, "Authorized Signatory", signatureLeft, codeY + 2, fontSize(settings, 6), muted(settings), 92)
  }
  page.drawLine({ start: { x: margin, y: 27 }, end: { x: width - margin, y: 27 }, thickness: 0.6, color: border(settings) })
  drawCenteredText(page, bold, "Thank you", 15, fontSize(settings, 7.2), ink(settings))
  drawCenteredText(page, regular, "Generated by Bezgrow", 5, fontSize(settings, 5.8), muted(settings))
  drawText(page, regular, "Page 1 of 1", width - margin - 48, 5, fontSize(settings, 5.8), muted(settings))
}

function renderHalfTopInvoice(context: PdfContext, invoice: PrintInvoice, pageNumber = 1, pageCount = 1) {
  const page = context.document.addPage(PageSizes.A4)
  const { regular, bold, logo, qr, settings } = context
  const width = page.getWidth()
  const height = page.getHeight()
  const topHalfBottom = height / 2
  const margin = 20
  if (settings.showWatermark) {
    drawCenteredWatermark(context, page, invoice, { x: 0, y: topHalfBottom, width, height: topHalfBottom })
  }

  let y = height - 18
  let brandX = margin
  if (settings.showLogo && logo) {
    drawContainedImage(page, logo, margin, y - 42, 82, 42)
    brandX += 90
  }
  const metaX = width - margin - 186
  const brandWidth = Math.max(80, metaX - brandX - 10)
  const businessNameSize = Math.max(14, fontSize(settings, 14))
  const businessNameLines = wrapText(invoice.enterprise.name, bold, businessNameSize, brandWidth, 2)
  businessNameLines.forEach((line, index) => drawText(page, bold, line, brandX, y - 13 - index * 14, businessNameSize, ink(settings), brandWidth))
  drawText(page, regular, invoice.enterprise.address, brandX, y - 43, fontSize(settings, 7.4), muted(settings), brandWidth)
  const enterpriseIdentity = [
    invoice.enterprise.gstNumber !== "-" ? `GST: ${invoice.enterprise.gstNumber}` : "",
    invoice.enterprise.phone !== "-" ? `Phone: ${invoice.enterprise.phone}` : "",
  ].filter(Boolean).join(" | ")
  if (enterpriseIdentity) drawText(page, regular, enterpriseIdentity, brandX, y - 54, fontSize(settings, 6.6), muted(settings), brandWidth)
  page.drawRectangle({ x: metaX, y: y - 52, width: 186, height: 52, color: soft(settings), borderColor: border(settings), borderWidth: 0.7 })
  drawText(page, bold, invoice.invoiceTitle, metaX + 10, y - 14, fontSize(settings, 7.4), muted(settings))
  drawText(page, bold, invoice.invoiceNumber, metaX + 10, y - 32, fontSize(settings, 11.5), accent(settings), 112)
  drawText(page, regular, `Date: ${dateText(invoice.invoiceDate)}`, metaX + 10, y - 45, fontSize(settings, 7), ink(settings), 82)
  drawText(page, regular, `Due Date: ${dateText(invoice.dueDate)}`, metaX + 94, y - 45, fontSize(settings, 6.6), ink(settings), 82)
  y -= 60
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 1, color: ink(settings) })
  y -= 15
  drawText(page, bold, "BILL TO", margin, y, fontSize(settings, 7), accent(settings))
  drawText(page, bold, invoice.customer.name, margin + 50, y, fontSize(settings, 9.2), ink(settings), 200)
  drawText(page, regular, invoice.customer.phone, margin + 255, y, fontSize(settings, 7.5), muted(settings), 85)
  drawText(page, regular, invoice.customer.address, margin + 345, y, fontSize(settings, 7.2), muted(settings), width - margin * 2 - 345)
  y -= 12
  if (settings.showGstDetails) {
    drawText(page, regular, `GSTIN: ${invoice.customer.gstin}`, margin + 50, y, fontSize(settings, 6.8), muted(settings), 190)
  }
  drawText(page, regular, `State: ${formatIndiaState(invoice.customer.state, invoice.customer.stateCode)}`, margin + 255, y, fontSize(settings, 6.8), muted(settings), 135)
  drawText(page, regular, `Payment: ${invoice.payment.mode}`, margin + 395, y, fontSize(settings, 6.8), muted(settings), 130)
  y -= 13

  const columns = tableColumns(page, settings, true)
  const headerHeight = 18
  page.drawRectangle({ x: margin, y: y - headerHeight, width: width - margin * 2, height: headerHeight, color: ink(settings) })
  columns.forEach((column) => drawText(page, bold, column.label, column.x + 3, y - 12, Math.max(6.5, fontSize(settings, 6.5)), WHITE, column.width - 6))
  y -= headerHeight

  const lowerSummaryTop = topHalfBottom + 139
  const rowHeight = invoice.items.length > 0
    ? Math.max(8.2, Math.min(14, (y - lowerSummaryTop) / invoice.items.length))
    : 14
  for (const [index, item] of invoice.items.entries()) {
    if (y - rowHeight < lowerSummaryTop - 0.5) {
      throw new Error("Half A4 Top supports up to 20 standard invoice lines without clipping.")
    }
    page.drawRectangle({ x: margin, y: y - rowHeight, width: width - margin * 2, height: rowHeight, color: WHITE, borderColor: border(settings), borderWidth: 0.45 })
    columns.forEach((column) => drawText(
      page,
      column.key === "item" || column.key === "amount" ? bold : regular,
      itemCell(item, column.key, index),
      column.x + 3,
      y - rowHeight + Math.max(2, (rowHeight - 6.8) / 2),
      Math.max(6.8, fontSize(settings, 6.8)),
      ink(settings),
      column.width - 6,
    ))
    y -= rowHeight
  }

  const amountTitleY = y - 9
  drawText(page, bold, "Amount in words", margin, amountTitleY, fontSize(settings, 6.6), accent(settings))
  wrapText(invoice.totals.amountInWords, regular, fontSize(settings, 7.2), width - margin * 2, 2).forEach((line, index) => {
    drawText(page, regular, line, margin, amountTitleY - 11 - index * 9, fontSize(settings, 7.2), ink(settings), width - margin * 2)
  })

  // Keep totals deliberately lower than the amount-in-words block while
  // reserving the final strip of the physical top half for references/footer.
  const totalsTop = topHalfBottom + 117
  const totalsBottom = topHalfBottom + 74
  const totalsWidth = width - margin * 2
  const breakdownWidth = 360
  page.drawRectangle({ x: margin, y: totalsBottom, width: totalsWidth, height: totalsTop - totalsBottom, color: soft(settings), borderColor: border(settings), borderWidth: 0.65 })
  page.drawLine({ start: { x: margin + breakdownWidth, y: totalsBottom }, end: { x: margin + breakdownWidth, y: totalsTop }, thickness: 0.55, color: border(settings) })
  const breakdownRows = [
    [["Subtotal", invoice.totals.subtotal], ["Discount", invoice.totals.discount], ["Taxable", invoice.totals.taxableAmount], ["Round Off", invoice.totals.roundOff]],
    [["CGST", invoice.totals.cgst], ["SGST", invoice.totals.sgst], ["IGST", invoice.totals.igst]],
  ] as Array<Array<[string, number]>>
  const breakdownColumnWidth = breakdownWidth / 4
  breakdownRows.forEach((row, rowIndex) => {
    row.forEach(([label, value], columnIndex) => {
      drawText(page, regular, `${label}: ${money(value)}`, margin + 7 + columnIndex * breakdownColumnWidth, totalsTop - 13 - rowIndex * 15, Math.max(6, fontSize(settings, 6)), muted(settings), breakdownColumnWidth - 10)
    })
  })
  const totalPanelX = margin + breakdownWidth + 8
  drawText(page, regular, `Paid ${money(invoice.payment.paidAmount)} | Balance Due ${money(invoice.payment.dueAmount)}`, totalPanelX, totalsTop - 13, Math.max(5.8, fontSize(settings, 5.8)), muted(settings), width - margin - totalPanelX)
  drawText(page, bold, "Grand Total", totalPanelX, totalsBottom + 8, Math.max(8.5, fontSize(settings, 8.5)), accent(settings))
  const grandText = money(invoice.totals.grandTotal)
  const halfTopGrandSize = Math.max(8.5, fontSize(settings, 8.5))
  drawText(page, bold, grandText, width - margin - bold.widthOfTextAtSize(grandText, halfTopGrandSize), totalsBottom + 8, halfTopGrandSize, accent(settings))

  const codeY = topHalfBottom + 20
  if (settings.showBarcode) {
    drawCode39(page, invoice.barcodeValue, margin, codeY + 12, 125, 21, ink(settings))
    drawText(page, bold, invoice.barcodeValue, margin, codeY + 2, Math.max(6.2, fontSize(settings, 6.2)), ink(settings), 125)
  }
  if (settings.showQr && qr) drawContainedImage(page, qr, margin + (settings.showBarcode ? 129 : 0), codeY, 54, 54)
  if (settings.showSignature) {
    page.drawLine({ start: { x: width - margin - 112, y: codeY + 11 }, end: { x: width - margin, y: codeY + 11 }, thickness: 0.6, color: muted(settings) })
    drawText(page, regular, "Authorized Signatory", width - margin - 112, codeY, fontSize(settings, 6.2), muted(settings), 112)
  }
  page.drawLine({ start: { x: margin, y: topHalfBottom + 17 }, end: { x: width - margin, y: topHalfBottom + 17 }, thickness: 0.5, color: border(settings) })
  drawCenteredText(page, bold, "Thank you", topHalfBottom + 10, fontSize(settings, 6.7), ink(settings))
  drawCenteredText(page, regular, "Generated by Bezgrow", topHalfBottom + 3, Math.max(5.9, fontSize(settings, 5.9)), muted(settings))
  if (pageCount > 1) {
    drawText(page, regular, `Page ${pageNumber} of ${pageCount}`, width - margin - 54, topHalfBottom + 3, Math.max(5.9, fontSize(settings, 5.9)), muted(settings), 54)
  }
}

function renderThermalInvoice(context: PdfContext, invoice: PrintInvoice) {
  const page = context.document.addPage(pageSize("thermal", context.settings, invoice.items.length, invoice.terms.length))
  const { regular, bold, logo, qr, settings } = context
  const width = page.getWidth()
  drawWatermark(context, page, invoice)
  const margin = settings.thermalWidth === "58mm" ? 10 : 14
  const nameSize = fontSize(settings, settings.thermalWidth === "58mm" ? 10 : 12)
  let y = page.getHeight() - 16
  if (settings.showLogo && logo) {
    const logoWidth = width - margin * 2
    drawContainedImage(page, logo, margin, y - 42, logoWidth, 40)
    // PDF text is positioned on its baseline. Account for the full cap height
    // plus an 8pt (~11px) visual gap so tall logos cannot touch the name while
    // contained square/wide logos keep the receipt compact.
    y -= 42 + nameSize + 8
  }
  const businessName = safeText(invoice.enterprise.name)
  const nameLines = wrapText(businessName, bold, nameSize, width - margin * 2, 3)
  nameLines.forEach((line, index) => {
    drawText(page, bold, line, Math.max(margin, (width - bold.widthOfTextAtSize(line, nameSize)) / 2), y - index * (nameSize + 2), nameSize, ink(settings), width - margin * 2)
  })
  y -= nameLines.length * (nameSize + 2)
  const addressLines = wrapText(invoice.enterprise.address, regular, Math.max(6.8, fontSize(settings, 6.8)), width - margin * 2, 2)
  addressLines.forEach((line, index) => {
    drawCenteredText(page, regular, line, y - index * 9, Math.max(6.8, fontSize(settings, 6.8)), muted(settings))
  })
  y -= addressLines.length * 9 + 3
  const businessIdentity = [
    invoice.enterprise.gstNumber !== "-" ? `GSTIN: ${invoice.enterprise.gstNumber}` : "",
    invoice.enterprise.phone !== "-" ? invoice.enterprise.phone : "",
  ].filter(Boolean).join(" | ")
  if (businessIdentity) {
    drawCenteredText(page, regular, businessIdentity, y, Math.max(6.3, fontSize(settings, 6.3)), muted(settings))
    y -= 11
  }
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.7, color: ink(settings), dashArray: [3, 2] })
  y -= 14
  for (const [label, value] of [
    ["Invoice Number", invoice.invoiceNumber],
    ["Invoice Date", dateText(invoice.invoiceDate)],
    ["Due Date", dateText(invoice.dueDate)],
    ["Customer", invoice.customer.name],
    ["State", formatIndiaState(invoice.customer.state, invoice.customer.stateCode)],
    ["Payment", invoice.payment.mode],
  ]) {
    drawText(page, regular, `${label}:`, margin, y, fontSize(settings, 7.5), muted(settings))
    const valueX = width * (settings.thermalWidth === "58mm" ? 0.45 : 0.39)
    drawText(page, bold, value, valueX, y, fontSize(settings, 7.5), ink(settings), width - valueX - margin)
    y -= 12
  }
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.7, color: ink(settings), dashArray: [3, 2] })
  y -= 15
  for (const item of invoice.items) {
    const itemSize = Math.max(7.5, fontSize(settings, 7.5))
    const itemLines = wrapText(item.name, bold, itemSize, width * 0.58 - margin, 2)
    itemLines.forEach((line, index) => {
      drawText(page, bold, line, margin, y - index * 10, itemSize, ink(settings), width * 0.58 - margin)
    })
    const amount = money(item.finalAmount)
    drawText(page, bold, amount, width - margin - bold.widthOfTextAtSize(amount, itemSize), y, itemSize, ink(settings))
    y -= itemLines.length * 10
    drawText(page, regular, `${item.quantity} x ${money(item.rate)}`, margin, y, Math.max(6.5, fontSize(settings, 6.5)), muted(settings), width - margin * 2)
    y -= 10
    if (settings.pharmaMode) {
      const pharma = `Batch: ${item.batchNumber || "-"} | Exp: ${dateText(item.expiryDate)}`
      drawText(page, regular, pharma, margin, y, Math.max(6.5, fontSize(settings, 6.5)), muted(settings), width - margin * 2)
      y -= 10
      if (settings.showHsn) {
        drawText(page, regular, `HSN: ${item.hsnCode || "-"}`, margin, y, Math.max(6.5, fontSize(settings, 6.5)), muted(settings), width - margin * 2)
        y -= 10
      }
    }
    y -= 5
  }
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.8, color: ink(settings) })
  y -= 15
  for (const [label, value] of [
    ["Subtotal", invoice.totals.subtotal],
    ["Discount", invoice.totals.discount],
    ...(settings.showGstDetails
      ? ([["GST", invoice.totals.cgst + invoice.totals.sgst + invoice.totals.igst]] as Array<[string, number]>)
      : []),
    ["Grand Total", invoice.totals.grandTotal],
    ["Paid", invoice.payment.paidAmount],
    ["Balance Due", invoice.payment.dueAmount],
  ] as Array<[string, number]>) {
    drawText(page, label === "Grand Total" ? bold : regular, label, margin, y, fontSize(settings, label === "Grand Total" ? 9 : 7.5), ink(settings))
    const valueText = money(value)
    const valueFont = label === "Grand Total" ? bold : regular
    const valueSize = fontSize(settings, label === "Grand Total" ? 9 : 7.5)
    drawText(page, valueFont, valueText, width - margin - valueFont.widthOfTextAtSize(valueText, valueSize), y, valueSize, ink(settings))
    y -= label === "Grand Total" ? 16 : 12
  }
  if (invoice.terms.length) {
    page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.6, color: ink(settings), dashArray: [3, 2] })
    y -= 13
    drawText(page, bold, "Terms", margin, y, fontSize(settings, 7), ink(settings))
    y -= 11
    for (const term of invoice.terms) {
      const lines = wrapText(term, regular, fontSize(settings, 6.3), width - margin * 2, 2)
      for (const line of lines) {
        drawText(page, regular, line, margin, y, fontSize(settings, 6.3), muted(settings), width - margin * 2)
        y -= 9
      }
    }
    y -= 3
  }
  if (settings.showBarcode) {
    drawCode39(page, invoice.barcodeValue, margin, y - 30, width - margin * 2, 27, ink(settings))
    y -= 40
    drawCenteredText(page, bold, invoice.barcodeValue, y, fontSize(settings, 7.2), ink(settings))
    y -= 14
  }
  if (settings.showQr && qr) {
    drawContainedImage(page, qr, width / 2 - 27, y - 54, 54, 54)
    y -= 61
    drawCenteredText(page, regular, "Scan invoice summary", y, Math.max(6.3, fontSize(settings, 6.3)), muted(settings))
    y -= 13
  }
  const thankYouY = Math.max(19, y)
  drawCenteredText(page, bold, "Thank you", thankYouY, fontSize(settings, 8), ink(settings))
  drawCenteredText(
    page,
    regular,
    "Generated by Bezgrow",
    thankYouY - 10,
    Math.max(settings.thermalWidth === "58mm" ? 5.2 : 5.8, fontSize(settings, settings.thermalWidth === "58mm" ? 5.2 : 5.8)),
    muted(settings),
  )
}

export async function createInvoicePdf(
  invoice: PrintInvoice,
  settings: PrintSettings = defaultPrintSettings,
  format: PrintFormat = settings.defaultFormat
) {
  const context = await prepareContext(invoice, settings, format)
  if (format === "thermal") renderThermalInvoice(context, invoice)
  else if (format === "half-top") {
    const pages = Array.from({ length: Math.max(1, Math.ceil(invoice.items.length / 12)) }, (_, index) =>
      invoice.items.slice(index * 12, (index + 1) * 12)
    )
    pages.forEach((items, index) => renderHalfTopInvoice(context, { ...invoice, items }, index + 1, pages.length))
  }
  else if (format === "half-compact") renderHalfCompactInvoice(context, invoice)
  else renderPagedInvoice(context, invoice)
  return context.document.save({ useObjectStreams: false })
}
