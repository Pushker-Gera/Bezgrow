import type { PrintInvoice } from "@/components/print/types"

type PdfLine = {
  x: number
  y: number
  text: string
  size?: number
  bold?: boolean
  color?: [number, number, number]
}

type PdfBox = {
  x: number
  y: number
  width: number
  height: number
  stroke?: [number, number, number]
  fill?: [number, number, number]
}

type PdfRule = {
  x1: number
  y1: number
  x2: number
  y2: number
  width?: number
  color?: [number, number, number]
}

type PdfPage = {
  width: number
  height: number
  lines: PdfLine[]
  boxes: PdfBox[]
  rules: PdfRule[]
}

const A4 = { width: 595.28, height: 841.89 }
const BLUE: [number, number, number] = [29, 78, 216]
const SLATE: [number, number, number] = [15, 23, 42]
const MUTED: [number, number, number] = [71, 85, 105]
const BORDER: [number, number, number] = [219, 227, 238]
const SOFT: [number, number, number] = [248, 250, 252]

function cleanText(value: string | number | null | undefined) {
  return String(value ?? "-")
    .replace(/[₹]/g, "Rs ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "")
    .trim() || "-"
}

function pdfEscape(value: string) {
  return cleanText(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
}

function money(value: number) {
  return `Rs ${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function dateText(value: string) {
  if (!value || value === "-") return "-"
  return new Date(value).toLocaleDateString("en-IN")
}

function wrapText(text: string, maxChars: number, maxLines = 2) {
  const words = cleanText(text).split(/\s+/)
  const lines: string[] = []
  let current = ""

  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > maxChars && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
    if (lines.length === maxLines) break
  }

  if (current && lines.length < maxLines) lines.push(current)
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, Math.max(0, maxChars - 3))}...`
  }

  return lines
}

function addText(page: PdfPage, x: number, y: number, text: string, size = 10, bold = false, color: [number, number, number] = SLATE) {
  page.lines.push({ x, y, text, size, bold, color })
}

function addBox(page: PdfPage, x: number, y: number, width: number, height: number, fill?: [number, number, number], stroke: [number, number, number] = BORDER) {
  page.boxes.push({ x, y, width, height, fill, stroke })
}

function addRule(page: PdfPage, x1: number, y1: number, x2: number, y2: number, width = 1, color: [number, number, number] = SLATE) {
  page.rules.push({ x1, y1, x2, y2, width, color })
}

function drawHeader(page: PdfPage, invoice: PrintInvoice) {
  addText(page, 36, 42, invoice.enterprise.businessType, 8, true, BLUE)
  addText(page, 36, 61, invoice.enterprise.name, 24, true)
  addText(page, 36, 78, invoice.enterprise.address, 9, false, MUTED)
  addText(page, 36, 93, `GST: ${invoice.enterprise.gstNumber} | Phone: ${invoice.enterprise.phone} | Email: ${invoice.enterprise.email}`, 9, false, MUTED)

  addBox(page, 388, 39, 171, 82, SOFT)
  addText(page, 404, 58, invoice.invoiceTitle, 8, true, MUTED)
  addText(page, 404, 78, invoice.invoiceNumber, 15, true, BLUE)
  addText(page, 404, 96, `Date: ${dateText(invoice.invoiceDate)}`, 9)
  addText(page, 404, 111, `Due: ${dateText(invoice.dueDate)}`, 9)
  addRule(page, 36, 137, 559, 137, 2)
}

function drawCustomer(page: PdfPage, invoice: PrintInvoice) {
  addBox(page, 36, 153, 254, 74, SOFT)
  addText(page, 48, 172, "BILL TO", 8, true, BLUE)
  addText(page, 48, 190, invoice.customer.name, 13, true)
  addText(page, 48, 207, `Phone: ${invoice.customer.phone}`, 9, false, MUTED)
  wrapText(`Address: ${invoice.customer.address}`, 45, 2).forEach((line, index) => {
    addText(page, 48, 222 + index * 13, line, 9, false, MUTED)
  })

  addBox(page, 305, 153, 254, 74, SOFT)
  addText(page, 317, 172, "TAX DETAILS", 8, true, BLUE)
  addText(page, 317, 190, `GSTIN: ${invoice.customer.gstin}`, 9)
  addText(page, 317, 205, `State: ${invoice.customer.state}`, 9)
  addText(page, 317, 220, `Payment: ${invoice.payment.mode}`, 9)
}

function drawTableHeader(page: PdfPage, y: number) {
  addBox(page, 36, y, 523, 22, SLATE, SLATE)
  addText(page, 43, y + 14, "SR", 7, true, [255, 255, 255])
  addText(page, 67, y + 14, "ITEM", 7, true, [255, 255, 255])
  addText(page, 292, y + 14, "QTY", 7, true, [255, 255, 255])
  addText(page, 342, y + 14, "RATE", 7, true, [255, 255, 255])
  addText(page, 410, y + 14, "GST", 7, true, [255, 255, 255])
  addText(page, 486, y + 14, "AMOUNT", 7, true, [255, 255, 255])
}

function drawInvoiceItems(pages: PdfPage[], invoice: PrintInvoice) {
  let page = pages[0]
  let y = 248
  drawTableHeader(page, y)
  y += 22

  invoice.items.forEach((item, index) => {
    if (y > 676) {
      page = createPage()
      pages.push(page)
      drawHeader(page, invoice)
      y = 154
      drawTableHeader(page, y)
      y += 22
    }

    const rowHeight = 30
    addBox(page, 36, y, 523, rowHeight, undefined, BORDER)
    addText(page, 43, y + 18, String(index + 1), 8)
    wrapText(item.name, 36, 2).forEach((line, lineIndex) => addText(page, 67, y + 13 + lineIndex * 11, line, 8, lineIndex === 0))
    addText(page, 292, y + 18, `${item.quantity} ${item.unit}`, 8)
    addText(page, 342, y + 18, money(item.rate), 8)
    addText(page, 410, y + 18, `${item.cgstPercent + item.sgstPercent + item.igstPercent}%`, 8)
    addText(page, 486, y + 18, money(item.finalAmount), 8, true)
    y += rowHeight
  })

  return { page, y }
}

function drawTotals(page: PdfPage, invoice: PrintInvoice, y: number) {
  const startY = Math.max(y + 18, 590)
  addBox(page, 36, startY, 326, 110, SOFT)
  addText(page, 50, startY + 20, "TERMS & AMOUNT IN WORDS", 8, true, BLUE)
  const terms = invoice.terms.length ? invoice.terms : ["Thank you for your business."]
  terms.slice(0, 3).forEach((term, index) => addText(page, 50, startY + 39 + index * 14, term, 9, false, MUTED))
  wrapText(invoice.totals.amountInWords, 52, 2).forEach((line, index) => addText(page, 50, startY + 87 + index * 13, line, 9, true))

  addBox(page, 376, startY, 183, 110, SOFT)
  const rows = [
    ["Subtotal", invoice.totals.subtotal],
    ["Discount", invoice.totals.discount],
    ["Taxable", invoice.totals.taxableAmount],
    ["GST", invoice.totals.cgst + invoice.totals.sgst + invoice.totals.igst],
    ["Round Off", invoice.totals.roundOff],
  ] as const
  rows.forEach(([label, value], index) => {
    addText(page, 390, startY + 20 + index * 14, label, 9)
    addText(page, 498, startY + 20 + index * 14, money(value), 9, true)
  })
  addRule(page, 390, startY + 82, 545, startY + 82, 1, BORDER)
  addText(page, 390, startY + 101, "Grand Total", 14, true, BLUE)
  addText(page, 478, startY + 101, money(invoice.totals.grandTotal), 14, true, BLUE)

  addBox(page, 36, startY + 126, 523, 44, undefined, BORDER)
  addText(page, 50, startY + 151, `Paid: ${money(invoice.payment.paidAmount)}    Due: ${money(invoice.payment.dueAmount)}    Balance: ${money(invoice.payment.balanceAmount)}`, 10, true)
}

function createPage(): PdfPage {
  return { ...A4, lines: [], boxes: [], rules: [] }
}

function pageToStream(page: PdfPage) {
  const commands: string[] = []
  const rgb = ([r, g, b]: [number, number, number]) => `${(r / 255).toFixed(3)} ${(g / 255).toFixed(3)} ${(b / 255).toFixed(3)}`

  for (const box of page.boxes) {
    if (box.fill) commands.push(`${rgb(box.fill)} rg ${box.x.toFixed(2)} ${(page.height - box.y - box.height).toFixed(2)} ${box.width.toFixed(2)} ${box.height.toFixed(2)} re f`)
    if (box.stroke) commands.push(`${rgb(box.stroke)} RG 0.7 w ${box.x.toFixed(2)} ${(page.height - box.y - box.height).toFixed(2)} ${box.width.toFixed(2)} ${box.height.toFixed(2)} re S`)
  }

  for (const rule of page.rules) {
    commands.push(`${rgb(rule.color || SLATE)} RG ${(rule.width || 1).toFixed(2)} w ${rule.x1.toFixed(2)} ${(page.height - rule.y1).toFixed(2)} m ${rule.x2.toFixed(2)} ${(page.height - rule.y2).toFixed(2)} l S`)
  }

  for (const line of page.lines) {
    commands.push(`${rgb(line.color || SLATE)} rg BT /${line.bold ? "F2" : "F1"} ${(line.size || 10).toFixed(2)} Tf ${line.x.toFixed(2)} ${(page.height - line.y).toFixed(2)} Td (${pdfEscape(line.text)}) Tj ET`)
  }

  return commands.join("\n")
}

function buildPdfDocument(pages: PdfPage[]) {
  const objects: string[] = []
  const pageObjectNumbers: number[] = []

  objects.push("<< /Type /Catalog /Pages 2 0 R >>")
  objects.push("PAGES_PLACEHOLDER")
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")

  for (const page of pages) {
    const content = pageToStream(page)
    const contentObjectNumber = objects.length + 2
    const pageObjectNumber = objects.length + 1
    pageObjectNumbers.push(pageObjectNumber)
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width.toFixed(2)} ${page.height.toFixed(2)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`)
    objects.push(`<< /Length ${Buffer.byteLength(content, "binary")} >>\nstream\n${content}\nendstream`)
  }

  objects[1] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pages.length} >>`

  let output = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n"
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output, "binary"))
    output += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(output, "binary")
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  offsets.slice(1).forEach((offset) => {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`
  })
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`

  return Buffer.from(output, "binary")
}

export function createInvoicePdf(invoice: PrintInvoice) {
  const pages = [createPage()]
  drawHeader(pages[0], invoice)
  drawCustomer(pages[0], invoice)
  const { page, y } = drawInvoiceItems(pages, invoice)
  drawTotals(page, invoice, y)
  pages.forEach((pdfPage, index) => addText(pdfPage, 510, 812, `Page ${index + 1} of ${pages.length}`, 8, false, MUTED))
  return buildPdfDocument(pages)
}

