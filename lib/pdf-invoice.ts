import { degrees, PDFDocument, PageSizes, StandardFonts, rgb, type PDFImage, type PDFPage, type PDFFont } from "pdf-lib"
import QRCode from "qrcode"
import type { PrintFormat, PrintInvoice, PrintInvoiceItem, PrintSettings } from "@/components/print/types"
import { defaultPrintSettings } from "@/components/print/settings/defaults"

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

function pageSize(format: PrintFormat, settings: PrintSettings, itemCount: number): [number, number] {
  if (format === "thermal") {
    const width = (settings.thermalWidth === "58mm" ? 58 : 80) * POINTS_PER_MM
    const fixedContentHeight = 137 + (settings.showLogo ? 47 : 0)
    const totalsHeight = (settings.showGstDetails ? 6 : 5) * 12 + 4
    const referenceHeight = (settings.showBarcode ? 54 : 0) + (settings.showQr ? 74 : 0)
    const footerAndSafety = 32
    const height = Math.max(
      settings.thermalWidth === "58mm" ? 255 : 275,
      fixedContentHeight + itemCount * 24 + totalsHeight + referenceHeight + footerAndSafety,
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
  return settings.blackAndWhite ? INK : BLUE
}

function drawWatermark(context: PdfContext, page: PDFPage, invoice: PrintInvoice) {
  if (!context.settings.showWatermark) return
  const label = safeText(invoice.watermark || "INVOICE").toUpperCase()
  const size = Math.min(74, page.getWidth() / Math.max(5, label.length * 0.55))
  page.drawText(label, {
    x: page.getWidth() * 0.18,
    y: page.getHeight() * 0.42,
    size,
    font: context.bold,
    color: context.settings.blackAndWhite ? rgb(0.65, 0.65, 0.65) : rgb(0.72, 0.8, 0.94),
    opacity: 0.18,
    rotate: degrees(32),
  })
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

async function imageBytesFromUrl(url: string) {
  if (!url) return null
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
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

async function embedImage(document: PDFDocument, bytes: Uint8Array | null) {
  if (!bytes?.length) return null
  try {
    return bytes[0] === 0xff ? await document.embedJpg(bytes) : await document.embedPng(bytes)
  } catch {
    return null
  }
}

function drawContainedImage(page: PDFPage, image: PDFImage, x: number, y: number, width: number, height: number) {
  const scale = Math.min(width / image.width, height / image.height)
  const drawnWidth = image.width * scale
  const drawnHeight = image.height * scale
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
  const logoBytes = settings.showLogo ? await imageBytesFromUrl(invoice.enterprise.logoUrl) : null
  const logo = await embedImage(document, logoBytes)
  let qr: PDFImage | null = null
  if (settings.showQr && invoice.qrValue) {
    try {
      const qrUrl = await QRCode.toDataURL(invoice.qrValue, { width: 220, margin: 1, errorCorrectionLevel: "M" })
      qr = await document.embedPng(bytesFromDataUrl(qrUrl))
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
  const logoSize = compact ? 32 : 42
  let brandX = margin
  if (settings.showLogo && logo) {
    drawContainedImage(page, logo, margin, top - logoSize, logoSize, logoSize)
    brandX += logoSize + 10
  }
  drawText(page, bold, invoice.enterprise.name, brandX, top - 17, fontSize(settings, compact ? 16 : 22), INK, page.getWidth() * 0.52)
  drawText(page, regular, invoice.enterprise.address, brandX, top - 34, fontSize(settings, compact ? 7.5 : 9), MUTED, page.getWidth() * 0.52)
  const contact = [
    invoice.enterprise.gstNumber !== "-" ? `GST: ${invoice.enterprise.gstNumber}` : "",
    invoice.enterprise.phone !== "-" ? `Phone: ${invoice.enterprise.phone}` : "",
  ].filter(Boolean).join(" | ")
  if (contact) drawText(page, regular, contact, brandX, top - 48, fontSize(settings, compact ? 7 : 8.5), MUTED, page.getWidth() * 0.54)

  const cardWidth = compact ? 150 : 175
  const cardX = page.getWidth() - margin - cardWidth
  page.drawRectangle({ x: cardX, y: top - 58, width: cardWidth, height: 56, color: SOFT, borderColor: BORDER, borderWidth: 0.8 })
  drawText(page, bold, invoice.invoiceTitle, cardX + 10, top - 17, fontSize(settings, 8), MUTED)
  drawText(page, bold, invoice.invoiceNumber, cardX + 10, top - 35, fontSize(settings, compact ? 11 : 14), accent(settings), cardWidth - 20)
  drawText(page, regular, `Date: ${dateText(invoice.invoiceDate)}`, cardX + 10, top - 49, fontSize(settings, 8), INK)
  page.drawLine({ start: { x: margin, y: top - 70 }, end: { x: page.getWidth() - margin, y: top - 70 }, thickness: 1.4, color: INK })
  return top - 82
}

function drawCustomer(context: PdfContext, page: PDFPage, invoice: PrintInvoice, y: number, compact = false) {
  const { regular, bold, settings } = context
  const margin = pageMargin(settings, compact)
  const gap = 10
  const width = (page.getWidth() - margin * 2 - gap) / 2
  const height = compact ? 53 : 68
  for (const x of [margin, margin + width + gap]) {
    page.drawRectangle({ x, y: y - height, width, height, color: SOFT, borderColor: BORDER, borderWidth: 0.7 })
  }
  drawText(page, bold, "BILL TO", margin + 10, y - 15, fontSize(settings, 7), accent(settings))
  drawText(page, bold, invoice.customer.name, margin + 10, y - 31, fontSize(settings, compact ? 10 : 12), INK, width - 20)
  drawText(page, regular, invoice.customer.phone, margin + 10, y - 45, fontSize(settings, 8), MUTED, width - 20)
  if (!compact) drawText(page, regular, invoice.customer.address, margin + 10, y - 58, fontSize(settings, 8), MUTED, width - 20)
  const taxX = margin + width + gap + 10
  drawText(page, bold, "TAX & PAYMENT", taxX, y - 15, fontSize(settings, 7), accent(settings))
  if (settings.showGstDetails) drawText(page, regular, `GSTIN: ${invoice.customer.gstin}`, taxX, y - 31, fontSize(settings, 8), INK, width - 20)
  drawText(page, regular, `Payment: ${invoice.payment.mode}`, taxX, y - 45, fontSize(settings, 8), INK, width - 20)
  if (!compact) drawText(page, regular, `Due: ${dateText(invoice.dueDate)}`, taxX, y - 58, fontSize(settings, 8), INK, width - 20)
  return y - height - 10
}

function tableColumns(page: PDFPage, settings: PrintSettings, compact: boolean) {
  const margin = pageMargin(settings, compact)
  const available = page.getWidth() - margin * 2
  const columns = [
    { key: "item", label: "Item", ratio: settings.pharmaMode ? 0.35 : 0.42 },
    ...(settings.pharmaMode ? [{ key: "batch", label: "Batch / Exp", ratio: 0.17 }] : []),
    ...(settings.showHsn ? [{ key: "hsn", label: "HSN", ratio: 0.11 }] : []),
    { key: "qty", label: "Qty", ratio: 0.09 },
    { key: "rate", label: "Rate", ratio: 0.14 },
    ...(settings.showGstDetails ? [{ key: "gst", label: "GST", ratio: 0.10 }] : []),
    { key: "amount", label: "Amount", ratio: 0.16 },
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
  const height = compact ? 18 : 21
  page.drawRectangle({ x: margin, y: y - height, width: page.getWidth() - margin * 2, height, color: INK })
  for (const column of columns) {
    drawText(page, bold, column.label, column.x + 4, y - height + 6, fontSize(settings, compact ? 6.2 : 7), WHITE, column.width - 8)
  }
  return { columns, y: y - height }
}

function itemCell(item: PrintInvoiceItem, key: string) {
  if (key === "item") return item.name
  if (key === "batch") return `${item.batchNumber} / ${item.expiryDate}`
  if (key === "hsn") return item.hsnCode
  if (key === "qty") return `${item.quantity} ${item.unit}`
  if (key === "rate") return money(item.rate)
  if (key === "gst") return `${item.cgstPercent + item.sgstPercent + item.igstPercent}%`
  return money(item.finalAmount)
}

function drawItemRow(context: PdfContext, page: PDFPage, item: PrintInvoiceItem, y: number, compact: boolean, rowHeight?: number) {
  const { regular, bold, settings } = context
  const columns = tableColumns(page, settings, compact)
  const margin = pageMargin(settings, compact)
  const height = rowHeight || (compact ? 22 : 28)
  page.drawRectangle({
    x: margin,
    y: y - height,
    width: page.getWidth() - margin * 2,
    height,
    borderColor: BORDER,
    borderWidth: 0.55,
    color: WHITE,
  })
  for (const column of columns) {
    drawText(
      page,
      column.key === "item" || column.key === "amount" ? bold : regular,
      itemCell(item, column.key),
      column.x + 4,
      y - height + Math.max(3, (height - fontSize(settings, compact ? 6.6 : 7.7)) / 2),
      fontSize(settings, compact ? 6.6 : 7.7),
      INK,
      column.width - 8
    )
  }
  return y - height
}

function drawCode39(page: PDFPage, value: string, x: number, y: number, maxWidth: number, height: number) {
  const patterns: Record<string, string> = {
    "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn", "4": "nnnwwnnnw",
    "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw", "8": "wnnwnnwnn", "9": "nnwwnnwnn",
    A: "wnnnnwnnw", B: "nnwnnwnnw", C: "wnwnnwnnn", D: "nnnnwwnnw", E: "wnnnwwnnn",
    F: "nnwnwwnnn", G: "nnnnnwwnw", H: "wnnnnwwnn", I: "nnwnnwwnn", J: "nnnnwwwnn",
    K: "wnnnnnnww", L: "nnwnnnnww", M: "wnwnnnnwn", N: "nnnnwnnww", O: "wnnnwnnwn",
    P: "nnwnwnnwn", Q: "nnnnnnwww", R: "wnnnnnwwn", S: "nnwnnnwwn", T: "nnnnwnwwn",
    U: "wwnnnnnnw", V: "nwwnnnnnw", W: "wwwnnnnnn", X: "nwnnwnnnw", Y: "wwnnwnnnn",
    Z: "nwwnwnnnn", "-": "nwnnnnwnw", ".": "wwnnnnwnn", " ": "nwwnnnwnn", "*": "nwnnwnwnn",
  }
  const encoded = `*${safeText(value).toUpperCase().replace(/[^0-9A-Z .-]/g, "-")}*`
  const units = Array.from(encoded).reduce((sum, character) => {
    const pattern = patterns[character] || patterns["-"]
    return sum + Array.from(pattern).reduce((width, unit) => width + (unit === "w" ? 3 : 1), 0) + 1
  }, 0)
  const unitWidth = Math.min(1.15, maxWidth / Math.max(1, units))
  let cursor = x
  for (const character of encoded) {
    const pattern = patterns[character] || patterns["-"]
    Array.from(pattern).forEach((unit, index) => {
      const width = (unit === "w" ? 3 : 1) * unitWidth
      if (index % 2 === 0) page.drawRectangle({ x: cursor, y, width, height, color: INK })
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
  page.drawRectangle({ x: totalsX, y: boxBottom, width: totalsWidth, height: totalHeight, color: SOFT, borderColor: BORDER, borderWidth: 0.7 })
  rows.forEach(([label, value], index) => {
    const rowY = y - 15 - index * rowHeight
    drawText(page, regular, label, totalsX + 10, rowY, fontSize(settings, compact ? 7 : 8.5), MUTED)
    const valueText = money(value)
    const valueWidth = bold.widthOfTextAtSize(valueText, fontSize(settings, compact ? 7 : 8.5))
    drawText(page, bold, valueText, totalsX + totalsWidth - 10 - valueWidth, rowY, fontSize(settings, compact ? 7 : 8.5), INK)
  })
  page.drawLine({ start: { x: totalsX + 8, y: boxBottom + 27 }, end: { x: totalsX + totalsWidth - 8, y: boxBottom + 27 }, thickness: 0.7, color: BORDER })
  drawText(page, bold, "Grand Total", totalsX + 10, boxBottom + 10, fontSize(settings, compact ? 9 : 11), accent(settings))
  const totalText = money(invoice.totals.grandTotal)
  const totalSize = fontSize(settings, compact ? 9 : 11)
  drawText(page, bold, totalText, totalsX + totalsWidth - 10 - bold.widthOfTextAtSize(totalText, totalSize), boxBottom + 10, totalSize, accent(settings))

  const leftWidth = totalsX - margin - 12
  drawText(page, bold, "Amount in words", margin, y - 14, fontSize(settings, 7), accent(settings))
  wrapText(invoice.totals.amountInWords, regular, fontSize(settings, 8), leftWidth, compact ? 2 : 3).forEach((line, index) => {
    drawText(page, regular, line, margin, y - 30 - index * 12, fontSize(settings, 8), INK)
  })
  const paymentTop = compact ? Math.max(boxBottom + 48, y - 60) : boxBottom + 22
  drawText(page, bold, `Paid: ${money(invoice.payment.paidAmount)}`, margin, paymentTop, fontSize(settings, 8), INK, leftWidth)
  drawText(page, bold, `Due: ${money(invoice.payment.dueAmount)}`, margin, paymentTop - 13, fontSize(settings, 8), INK, leftWidth)

  const codesY = Math.max(32, boxBottom - (compact ? 64 : 78))
  const barcodeWidth = compact ? 120 : 165
  const barcodeHeight = compact ? 24 : 29
  if (settings.showBarcode) {
    drawCode39(page, invoice.barcodeValue, margin, codesY + 22, barcodeWidth, barcodeHeight)
    drawText(page, bold, invoice.invoiceNumber, margin, codesY + 8, fontSize(settings, 6.5), INK, barcodeWidth)
  }
  const qrSize = compact ? 44 : 52
  const qrX = margin + (settings.showBarcode ? barcodeWidth + 14 : 0)
  if (settings.showQr && qr) {
    drawContainedImage(page, qr, qrX, codesY + 6, qrSize, qrSize)
    drawText(page, regular, "Invoice reference", qrX, codesY - 3, fontSize(settings, 5.8), MUTED, qrSize + 18)
  }
  if (settings.showSignature) {
    const signatureRight = page.getWidth() - margin
    const signatureLeft = Math.max(qrX + (settings.showQr ? qrSize + 18 : 0), signatureRight - (compact ? 92 : 120))
    page.drawLine({ start: { x: signatureLeft, y: codesY + 12 }, end: { x: signatureRight, y: codesY + 12 }, thickness: 0.6, color: MUTED })
    drawText(page, regular, "Authorized Signatory", signatureLeft, codesY, fontSize(settings, 7), MUTED, signatureRight - signatureLeft)
  }
  page.drawLine({ start: { x: margin, y: 27 }, end: { x: page.getWidth() - margin, y: 27 }, thickness: 0.6, color: BORDER })
  drawCenteredText(page, bold, "Thank you", 15, fontSize(settings, 7.5), INK)
  drawCenteredText(page, regular, "Generated by Bezgrow", 5, fontSize(settings, 6.2), MUTED)
  const pageLabel = `Page ${pageNumber} of ${pageCount}`
  drawText(page, regular, pageLabel, page.getWidth() - margin - regular.widthOfTextAtSize(pageLabel, fontSize(settings, 6.2)), 5, fontSize(settings, 6.2), MUTED)
}

function addDocumentPage(context: PdfContext, invoice: PrintInvoice, continuation = false) {
  const compact = context.format !== "a4"
  const size = pageSize(context.format, context.settings, invoice.items.length)
  const page = context.document.addPage(size)
  if (context.settings.blackAndWhite) {
    page.drawRectangle({ x: 0, y: 0, width: page.getWidth(), height: page.getHeight(), color: WHITE })
  }
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
  const bottomReserve = current.compact ? 155 : 220
  const defaultRowHeight = current.compact ? 22 : 28
  const minimumRowHeight = current.compact ? 11 : 16
  const fittedRowHeight = invoice.items.length > 0
    ? Math.floor((y - bottomReserve - 10) / Math.min(20, invoice.items.length))
    : defaultRowHeight
  const rowHeight = Math.max(minimumRowHeight, Math.min(defaultRowHeight, fittedRowHeight))

  for (const item of invoice.items) {
    if (y - rowHeight < bottomReserve) {
      current = addDocumentPage(context, invoice, true)
      pageRecords.push({ page: current.page, compact: current.compact })
      header = drawTableHeader(context, current.page, current.y, current.compact)
      y = header.y
    }
    y = drawItemRow(context, current.page, item, y, current.compact, rowHeight)
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
      record.page.drawLine({ start: { x: margin, y: 27 }, end: { x: record.page.getWidth() - margin, y: 27 }, thickness: 0.6, color: BORDER })
      drawCenteredText(record.page, context.bold, "Thank you", 15, fontSize(context.settings, 7.5), INK)
      drawCenteredText(record.page, context.regular, "Generated by Bezgrow", 5, fontSize(context.settings, 6.2), MUTED)
      drawText(record.page, context.regular, `Page ${index + 1} of ${pageRecords.length}`, record.page.getWidth() - margin - 56, 5, fontSize(context.settings, 6.2), MUTED)
    }
  })
}

function renderHalfTopInvoice(context: PdfContext, invoice: PrintInvoice) {
  const page = context.document.addPage(PageSizes.A4)
  const { regular, bold, logo, qr, settings } = context
  const width = page.getWidth()
  const height = page.getHeight()
  const topHalfBottom = height / 2
  const margin = 16
  if (settings.blackAndWhite) page.drawRectangle({ x: 0, y: topHalfBottom, width, height: topHalfBottom, color: WHITE })
  if (settings.showWatermark) {
    const label = safeText(invoice.watermark || "INVOICE").toUpperCase()
    page.drawText(label, {
      x: width * 0.24,
      y: topHalfBottom + 120,
      size: Math.min(48, width / Math.max(6, label.length * 0.6)),
      font: bold,
      color: settings.blackAndWhite ? rgb(0.65, 0.65, 0.65) : rgb(0.72, 0.8, 0.94),
      opacity: 0.16,
      rotate: degrees(24),
    })
  }

  let y = height - 15
  let brandX = margin
  if (settings.showLogo && logo) {
    drawContainedImage(page, logo, margin, y - 29, 29, 29)
    brandX += 36
  }
  drawText(page, bold, invoice.enterprise.name, brandX, y - 11, fontSize(settings, 13), INK, width * 0.55)
  drawText(page, regular, invoice.enterprise.address, brandX, y - 24, fontSize(settings, 6.8), MUTED, width * 0.55)
  const metaX = width - margin - 172
  page.drawRectangle({ x: metaX, y: y - 31, width: 172, height: 31, color: SOFT, borderColor: BORDER, borderWidth: 0.7 })
  drawText(page, bold, invoice.invoiceTitle, metaX + 8, y - 11, fontSize(settings, 6.5), MUTED)
  drawText(page, bold, invoice.invoiceNumber, metaX + 8, y - 24, fontSize(settings, 9), accent(settings), 100)
  drawText(page, regular, dateText(invoice.invoiceDate), metaX + 116, y - 24, fontSize(settings, 6.5), INK, 48)
  y -= 39
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 1, color: INK })
  y -= 16
  drawText(page, bold, "BILL TO", margin, y, fontSize(settings, 6.2), accent(settings))
  drawText(page, bold, invoice.customer.name, margin + 44, y, fontSize(settings, 8), INK, 155)
  drawText(page, regular, invoice.customer.phone, margin + 205, y, fontSize(settings, 7), MUTED, 80)
  drawText(page, regular, invoice.customer.address, margin + 290, y, fontSize(settings, 7), MUTED, width - margin * 2 - 290)
  y -= 10
  if (settings.showGstDetails) {
    drawText(page, regular, `GSTIN: ${invoice.customer.gstin}`, margin + 44, y, fontSize(settings, 6.5), MUTED, 180)
  }
  drawText(page, regular, `Payment: ${invoice.payment.mode}`, margin + 290, y, fontSize(settings, 6.5), MUTED, 100)
  y -= 11

  const columns = [
    { label: "#", x: margin, width: 24 },
    { label: "Item", x: margin + 24, width: 222 },
    ...(settings.showHsn ? [{ label: "HSN", x: margin + 246, width: 60 }] : []),
    { label: "Qty", x: settings.showHsn ? margin + 306 : margin + 246, width: 55 },
    { label: "Rate", x: settings.showHsn ? margin + 361 : margin + 301, width: 70 },
    ...(settings.showGstDetails ? [{ label: "GST", x: settings.showHsn ? margin + 431 : margin + 371, width: 43 }] : []),
  ]
  const amountX = columns.at(-1)!.x + columns.at(-1)!.width
  columns.push({ label: "Amount", x: amountX, width: width - margin - amountX })
  const headerHeight = 13
  page.drawRectangle({ x: margin, y: y - headerHeight, width: width - margin * 2, height: headerHeight, color: INK })
  columns.forEach((column) => drawText(page, bold, column.label, column.x + 3, y - 9, fontSize(settings, 5.8), WHITE, column.width - 6))
  y -= headerHeight

  const footerReserve = 91
  const rowHeight = invoice.items.length > 0
    ? Math.max(7.2, Math.min(12, (y - topHalfBottom - footerReserve) / invoice.items.length))
    : 12
  for (const [index, item] of invoice.items.entries()) {
    if (y - rowHeight < topHalfBottom + footerReserve) {
      throw new Error("Half A4 Top supports up to 20 standard invoice lines without clipping.")
    }
    page.drawRectangle({ x: margin, y: y - rowHeight, width: width - margin * 2, height: rowHeight, color: WHITE, borderColor: BORDER, borderWidth: 0.45 })
    const values = [
      String(index + 1), item.name, ...(settings.showHsn ? [item.hsnCode] : []), `${item.quantity} ${item.unit}`,
      money(item.rate), ...(settings.showGstDetails ? [`${item.cgstPercent + item.sgstPercent + item.igstPercent}%`] : []), money(item.finalAmount),
    ]
    columns.forEach((column, columnIndex) => drawText(page, columnIndex === 1 || columnIndex === columns.length - 1 ? bold : regular, values[columnIndex], column.x + 3, y - rowHeight + Math.max(2, (rowHeight - 6.2) / 2), fontSize(settings, 6.2), INK, column.width - 6))
    y -= rowHeight
  }

  y -= 5
  const totalsX = width - margin - 178
  drawText(page, bold, "Amount in words", margin, y - 8, fontSize(settings, 6), accent(settings))
  wrapText(invoice.totals.amountInWords, regular, fontSize(settings, 7), totalsX - margin - 10, 2).forEach((line, index) => drawText(page, regular, line, margin, y - 19 - index * 9, fontSize(settings, 7), INK))
  const totalLines = [
    ["Subtotal", invoice.totals.subtotal], ["Discount", invoice.totals.discount],
    ...(settings.showGstDetails ? [["CGST", invoice.totals.cgst], ["SGST", invoice.totals.sgst], ["IGST", invoice.totals.igst]] as Array<[string, number]> : []),
  ] as Array<[string, number]>
  totalLines.forEach(([label, value], index) => {
    drawText(page, regular, label, totalsX, y - 7 - index * 8, fontSize(settings, 6), MUTED)
    const valueText = money(value)
    drawText(page, bold, valueText, width - margin - bold.widthOfTextAtSize(valueText, fontSize(settings, 6)), y - 7 - index * 8, fontSize(settings, 6), INK)
  })
  const grandY = y - 10 - totalLines.length * 8
  drawText(page, bold, "Grand Total", totalsX, grandY, fontSize(settings, 8), accent(settings))
  const grandText = money(invoice.totals.grandTotal)
  drawText(page, bold, grandText, width - margin - bold.widthOfTextAtSize(grandText, fontSize(settings, 8)), grandY, fontSize(settings, 8), accent(settings))

  const codeY = topHalfBottom + 19
  if (settings.showBarcode) drawCode39(page, invoice.barcodeValue, margin, codeY + 12, 115, 21)
  if (settings.showQr && qr) drawContainedImage(page, qr, margin + (settings.showBarcode ? 129 : 0), codeY, 34, 34)
  if (settings.showSignature) {
    page.drawLine({ start: { x: width - margin - 112, y: codeY + 11 }, end: { x: width - margin, y: codeY + 11 }, thickness: 0.6, color: MUTED })
    drawText(page, regular, "Authorized Signatory", width - margin - 112, codeY, fontSize(settings, 6.2), MUTED, 112)
  }
  page.drawLine({ start: { x: margin, y: topHalfBottom + 13 }, end: { x: width - margin, y: topHalfBottom + 13 }, thickness: 0.5, color: BORDER })
  drawCenteredText(page, bold, "Thank you", topHalfBottom + 9, fontSize(settings, 6.7), INK)
  drawCenteredText(page, regular, "Generated by Bezgrow", topHalfBottom + 1, fontSize(settings, 5.7), MUTED)
}

function renderThermalInvoice(context: PdfContext, invoice: PrintInvoice) {
  const page = context.document.addPage(pageSize("thermal", context.settings, invoice.items.length))
  const { regular, bold, logo, qr, settings } = context
  const width = page.getWidth()
  if (settings.blackAndWhite) {
    page.drawRectangle({ x: 0, y: 0, width, height: page.getHeight(), color: WHITE })
  }
  drawWatermark(context, page, invoice)
  const margin = settings.thermalWidth === "58mm" ? 10 : 14
  let y = page.getHeight() - 16
  if (settings.showLogo && logo) {
    drawContainedImage(page, logo, width / 2 - 22, y - 42, 44, 38)
    y -= 47
  }
  const businessName = safeText(invoice.enterprise.name)
  const nameSize = fontSize(settings, settings.thermalWidth === "58mm" ? 12 : 15)
  drawText(page, bold, businessName, Math.max(margin, (width - bold.widthOfTextAtSize(businessName, nameSize)) / 2), y, nameSize, INK, width - margin * 2)
  y -= 15
  drawText(page, regular, invoice.enterprise.address, margin, y, fontSize(settings, 7), MUTED, width - margin * 2)
  y -= 14
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.7, color: INK, dashArray: [3, 2] })
  y -= 14
  for (const [label, value] of [
    ["Invoice", invoice.invoiceNumber],
    ["Date", dateText(invoice.invoiceDate)],
    ["Customer", invoice.customer.name],
    ["Payment", invoice.payment.mode],
  ]) {
    drawText(page, regular, label, margin, y, fontSize(settings, 7.5), MUTED)
    drawText(page, bold, value, width * 0.39, y, fontSize(settings, 7.5), INK, width * 0.61 - margin)
    y -= 12
  }
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.7, color: INK, dashArray: [3, 2] })
  y -= 15
  for (const item of invoice.items) {
    drawText(page, bold, item.name, margin, y, fontSize(settings, 7.5), INK, width * 0.58)
    const amount = money(item.finalAmount)
    drawText(page, bold, amount, width - margin - bold.widthOfTextAtSize(amount, fontSize(settings, 7.5)), y, fontSize(settings, 7.5), INK)
    y -= 10
    const detail = `${item.quantity} x ${money(item.rate)}${settings.pharmaMode ? ` | ${item.batchNumber} | ${item.expiryDate}` : ""}`
    drawText(page, regular, detail, margin, y, fontSize(settings, 6.5), MUTED, width - margin * 2)
    y -= 14
  }
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.8, color: INK })
  y -= 15
  for (const [label, value] of [
    ["Subtotal", invoice.totals.subtotal],
    ["Discount", invoice.totals.discount],
    ...(settings.showGstDetails
      ? ([["GST", invoice.totals.cgst + invoice.totals.sgst + invoice.totals.igst]] as Array<[string, number]>)
      : []),
    ["Grand Total", invoice.totals.grandTotal],
    ["Paid", invoice.payment.paidAmount],
    ["Due", invoice.payment.dueAmount],
  ] as Array<[string, number]>) {
    drawText(page, label === "Grand Total" ? bold : regular, label, margin, y, fontSize(settings, label === "Grand Total" ? 9 : 7.5), INK)
    const valueText = money(value)
    const valueFont = label === "Grand Total" ? bold : regular
    const valueSize = fontSize(settings, label === "Grand Total" ? 9 : 7.5)
    drawText(page, valueFont, valueText, width - margin - valueFont.widthOfTextAtSize(valueText, valueSize), y, valueSize, INK)
    y -= label === "Grand Total" ? 16 : 12
  }
  if (settings.showBarcode) {
    drawCode39(page, invoice.barcodeValue, margin, y - 30, width - margin * 2, 27)
    y -= 40
    drawCenteredText(page, bold, invoice.invoiceNumber, y, fontSize(settings, 7.2), INK)
    y -= 14
  }
  if (settings.showQr && qr) {
    drawContainedImage(page, qr, width / 2 - 27, y - 54, 54, 54)
    y -= 61
    drawCenteredText(page, regular, "Invoice reference", y, fontSize(settings, 6.3), MUTED)
    y -= 13
  }
  const thankYouY = Math.max(19, y)
  drawCenteredText(page, bold, "Thank you", thankYouY, fontSize(settings, 8), INK)
  drawCenteredText(page, regular, "Generated by Bezgrow", thankYouY - 10, fontSize(settings, 6.6), MUTED)
}

export async function createInvoicePdf(
  invoice: PrintInvoice,
  settings: PrintSettings = defaultPrintSettings,
  format: PrintFormat = settings.defaultFormat
) {
  const context = await prepareContext(invoice, settings, format)
  if (format === "thermal") renderThermalInvoice(context, invoice)
  else if (format === "half-top") renderHalfTopInvoice(context, invoice)
  else renderPagedInvoice(context, invoice)
  return context.document.save({ useObjectStreams: false })
}
