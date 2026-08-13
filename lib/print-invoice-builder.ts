import type { PrintInvoice, PrintInvoiceItem } from "@/components/print/types"
import { amountInIndianWords } from "@/components/print/utils"

export type PrintRow = Record<string, unknown> & { id: string }

const genericBusinessNames = new Set(["business", "bezgrow", "bezgrow erp", "enterprise", "your business"])

export function stringFrom(row: Record<string, unknown> | null | undefined, fields: string[]) {
  if (!row) return ""
  for (const field of fields) {
    const value = row[field]
    if (typeof value === "string" && value.trim()) return value
  }
  return ""
}

export function resolvePrintOrganization(
  ...sources: Array<Record<string, unknown> | null | undefined>
): PrintRow | null {
  const organizations = sources.filter((source): source is Record<string, unknown> => Boolean(source))
  if (!organizations.length) return null

  const merged = Object.assign({}, ...organizations.slice().reverse()) as PrintRow
  const names = organizations
    .flatMap((source) => [
      stringFrom(source, ["business_name"]),
      stringFrom(source, ["name"]),
    ])
    .filter(Boolean)
  const preferredName = names.find((name) => !genericBusinessNames.has(name.trim().toLowerCase())) || names[0]

  if (preferredName) {
    merged.name = preferredName
    merged.business_name = preferredName
  }

  return merged
}

export function numberFrom(row: Record<string, unknown> | null | undefined, fields: string[]) {
  if (!row) return 0
  for (const field of fields) {
    const value = row[field]
    if (value !== null && value !== undefined && value !== "") return Number(value || 0)
  }
  return 0
}

export function dateValue(row: Record<string, unknown> | null | undefined, fields: string[]) {
  return stringFrom(row, fields) || "-"
}

function compactQrText(value: string, maximum = 80) {
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim()
  return normalized.length > maximum ? `${normalized.slice(0, maximum - 3)}...` : normalized
}

export function buildInvoiceQrPayload({
  business,
  gstin,
  invoiceNumber,
  invoiceDate,
  customer,
  subtotal,
  tax,
  grandTotal,
  paymentStatus,
  paid,
  due,
}: {
  business: string
  gstin?: string
  invoiceNumber: string
  invoiceDate: string
  customer: string
  subtotal: number
  tax: number
  grandTotal: number
  paymentStatus: string
  paid: number
  due: number
}) {
  const lines = [
    "BEZGROW INVOICE",
    `Business: ${compactQrText(business)}`,
    ...(gstin && gstin !== "-" ? [`GSTIN: ${compactQrText(gstin, 24)}`] : []),
    `Invoice: ${compactQrText(invoiceNumber, 40)}`,
    `Date: ${compactQrText(invoiceDate, 32)}`,
    `Customer: ${compactQrText(customer)}`,
    `Subtotal: Rs ${subtotal.toFixed(2)}`,
    `Tax: Rs ${tax.toFixed(2)}`,
    `Grand Total: Rs ${grandTotal.toFixed(2)}`,
    `Payment Status: ${compactQrText(paymentStatus || "unpaid", 24)}`,
    `Paid: Rs ${paid.toFixed(2)}`,
    `Due: Rs ${due.toFixed(2)}`,
  ]
  return lines.join("\n")
}

export function buildPrintInvoice({
  invoice,
  items,
  organization,
  customer,
  products,
  origin,
}: {
  invoice: PrintRow
  items: PrintRow[]
  organization: PrintRow | null
  customer: PrintRow | null
  products: PrintRow[]
  origin: string
}): PrintInvoice {
  const productMap = new Map(products.map((product) => [product.id, product]))
  const taxTotal = numberFrom(invoice, ["tax_amount", "tax_total"])
  const grandTotal = numberFrom(invoice, ["grand_total", "total_amount", "total"])
  const itemBaseSubtotal = items.reduce((sum, item) => {
    return sum + numberFrom(item, ["quantity"]) * numberFrom(item, ["unit_price", "rate"])
  }, 0)
  const itemDiscount = items.reduce((sum, item) => {
    const base = numberFrom(item, ["quantity"]) * numberFrom(item, ["unit_price", "rate"])
    return sum + (base * numberFrom(item, ["discount_percent"])) / 100
  }, 0)
  const discount = numberFrom(invoice, ["discount_amount", "discount_total"]) || itemDiscount
  const subtotal = numberFrom(invoice, ["subtotal", "sub_total"]) || itemBaseSubtotal
  const taxableAmount = numberFrom(invoice, ["taxable_amount"]) || Math.max(0, subtotal - discount)
  const paid = numberFrom(invoice, ["paid_amount"]) ||
    (stringFrom(invoice, ["payment_status", "status"]).toLowerCase() === "paid" ? grandTotal : 0)
  const dueAmount = numberFrom(invoice, ["outstanding_amount", "due_amount"]) || Math.max(0, grandTotal - paid)
  const organizationStateCode = stringFrom(organization, ["state_code", "gst_state_code"])
  const customerStateCode = stringFrom(customer, ["state_code", "gst_state_code"])
  const supplyType = stringFrom(invoice, ["supply_type", "tax_type"]).toLowerCase()
  const isInterstate =
    supplyType === "interstate" ||
    supplyType === "igst" ||
    Boolean(organizationStateCode && customerStateCode && organizationStateCode !== customerStateCode)

  const mappedItems: PrintInvoiceItem[] = items.map((item, index) => {
    const product = productMap.get(stringFrom(item, ["product_id"])) || null
    const quantity = numberFrom(item, ["quantity"])
    const rate = numberFrom(item, ["unit_price", "rate"])
    const base = quantity * rate
    const discountPercent = numberFrom(item, ["discount_percent"])
    const discountAmount = (base * discountPercent) / 100
    const taxableValue = numberFrom(item, ["line_total"]) || base - discountAmount
    const itemTax = numberFrom(item, ["gst_amount", "tax_amount"])
    const taxPercent = numberFrom(item, ["tax_percent", "gst"])
    const directCgst = numberFrom(item, ["cgst_amount"])
    const directSgst = numberFrom(item, ["sgst_amount"])
    const directIgst = numberFrom(item, ["igst_amount"])
    const hasDirectTaxSplit = directCgst > 0 || directSgst > 0 || directIgst > 0

    return {
      id: item.id || `${invoice.id}-${index}`,
      name: stringFrom(item, ["product_name", "name"]) || stringFrom(product, ["name"]) || "Product",
      batchNumber: stringFrom(item, ["batch_no", "batch_number"]) || "-",
      manufacturingDate: dateValue(item, ["manufacturing_date", "mfg_date"]),
      expiryDate: dateValue(item, ["expiry_date"]),
      scheduleType: stringFrom(item, ["schedule_type"]) || "-",
      hsnCode: stringFrom(item, ["hsn_code", "hsn"]) || "-",
      quantity,
      freeQuantity: numberFrom(item, ["free_quantity", "free_qty"]),
      unit: stringFrom(item, ["unit"]) || "PCS",
      mrp: numberFrom(item, ["mrp"]) || rate,
      rate,
      discountPercent,
      discountAmount,
      taxableValue,
      cgstPercent: directCgst > 0 || (!hasDirectTaxSplit && !isInterstate) ? taxPercent / 2 : 0,
      cgstAmount: hasDirectTaxSplit ? directCgst : isInterstate ? 0 : itemTax / 2,
      sgstPercent: directSgst > 0 || (!hasDirectTaxSplit && !isInterstate) ? taxPercent / 2 : 0,
      sgstAmount: hasDirectTaxSplit ? directSgst : isInterstate ? 0 : itemTax / 2,
      igstPercent: directIgst > 0 || (!hasDirectTaxSplit && isInterstate) ? taxPercent : 0,
      igstAmount: hasDirectTaxSplit ? directIgst : isInterstate ? itemTax : 0,
      finalAmount: taxableValue + itemTax,
    }
  })
  const mappedCgst = mappedItems.reduce((sum, item) => sum + item.cgstAmount, 0)
  const mappedSgst = mappedItems.reduce((sum, item) => sum + item.sgstAmount, 0)
  const mappedIgst = mappedItems.reduce((sum, item) => sum + item.igstAmount, 0)
  const explicitCgst = numberFrom(invoice, ["cgst_amount", "cgst_total"])
  const explicitSgst = numberFrom(invoice, ["sgst_amount", "sgst_total"])
  const explicitIgst = numberFrom(invoice, ["igst_amount", "igst_total"])
  const hasMappedTax = mappedCgst > 0 || mappedSgst > 0 || mappedIgst > 0
  const cgst = explicitCgst || mappedCgst || (!hasMappedTax && !isInterstate ? taxTotal / 2 : 0)
  const sgst = explicitSgst || mappedSgst || (!hasMappedTax && !isInterstate ? taxTotal / 2 : 0)
  const igst = explicitIgst || mappedIgst || (!hasMappedTax && isInterstate ? taxTotal : 0)

  const invoiceNumber = stringFrom(invoice, ["invoice_number"]) || invoice.id
  const invoiceDate = dateValue(invoice, ["created_at", "invoice_date"])
  const businessName = stringFrom(organization, ["business_name", "name"]) || "Your Business"
  const businessGstin = stringFrom(organization, ["gst_number", "gstin", "tax_id"]) || "-"
  const customerName = stringFrom(customer, ["name"]) || stringFrom(invoice, ["customer_name"]) || "Walk-in customer"
  const paymentStatus = stringFrom(invoice, ["payment_status", "status"]) || (dueAmount > 0 ? "unpaid" : "paid")
  void origin

  return {
    id: invoice.id,
    invoiceNumber,
    invoiceTitle: stringFrom(invoice, ["invoice_type"]) === "no_gst" ? "Bill of Supply" : "Tax Invoice",
    invoiceDate,
    dueDate: dateValue(invoice, ["due_date"]),
    salesperson: stringFrom(invoice, ["salesperson", "salesperson_name"]) || "-",
    enterprise: {
      organizationId: stringFrom(organization, ["id"]) || stringFrom(invoice, ["organization_id"]),
      name: businessName,
      businessType: stringFrom(organization, ["business_type", "industry", "business_category"]) || "Enterprise",
      gstNumber: businessGstin,
      fssai: stringFrom(organization, ["fssai", "fssai_number"]) || "-",
      phone: stringFrom(organization, ["phone", "contact_phone"]) || "-",
      email: stringFrom(organization, ["email", "support_email"]) || "-",
      website: stringFrom(organization, ["website"]) || "-",
      address: stringFrom(organization, ["address", "business_address"]) || "-",
      logoUrl: stringFrom(organization, ["logo_url", "logo", "business_logo_url"]),
      branchName: stringFrom(organization, ["branch_name"]) || "Main Branch",
    },
    customer: {
      id: stringFrom(customer, ["customer_code", "id"]) || stringFrom(invoice, ["customer_id"]) || "-",
      name: customerName,
      address: stringFrom(customer, ["address", "billing_address"]) || "-",
      phone: stringFrom(customer, ["phone"]) || "-",
      email: stringFrom(customer, ["email"]) || "-",
      gstin: stringFrom(customer, ["gst_number", "gstin", "tax_id"]) || "-",
      state: stringFrom(customer, ["state"]) || "-",
      stateCode: stringFrom(customer, ["state_code"]) || "-",
    },
    items: mappedItems,
    payment: {
      mode: stringFrom(invoice, ["payment_method"]) || "Cash",
      paidAmount: paid,
      dueAmount,
      balanceAmount: dueAmount,
      cashReceived: paid,
    },
    totals: {
      subtotal,
      discount,
      taxableAmount,
      cgst,
      sgst,
      igst,
      roundOff: numberFrom(invoice, ["round_off"]),
      grandTotal,
      amountInWords: amountInIndianWords(grandTotal),
    },
    terms: [],
    notes: stringFrom(invoice, ["notes"]),
    qrValue: buildInvoiceQrPayload({
      business: businessName,
      gstin: businessGstin,
      invoiceNumber,
      invoiceDate,
      customer: customerName,
      subtotal,
      tax: cgst + sgst + igst,
      grandTotal,
      paymentStatus,
      paid,
      due: dueAmount,
    }),
    barcodeValue: invoiceNumber,
    watermark: businessName,
  }
}
