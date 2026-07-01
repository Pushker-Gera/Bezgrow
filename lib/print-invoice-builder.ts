import type { PrintInvoice, PrintInvoiceItem } from "@/components/print/types"
import { amountInIndianWords } from "@/components/print/utils"

export type PrintRow = Record<string, unknown> & { id: string }

export function stringFrom(row: Record<string, unknown> | null | undefined, fields: string[]) {
  if (!row) return ""
  for (const field of fields) {
    const value = row[field]
    if (typeof value === "string" && value.trim()) return value
  }
  return ""
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
  const gstSplit = taxTotal / 2
  const paid = stringFrom(invoice, ["payment_status", "status"]).toLowerCase() === "paid" ? grandTotal : 0
  const dueAmount = Math.max(0, grandTotal - paid)

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
    const isInterstate = false

    return {
      id: item.id || `${invoice.id}-${index}`,
      name: stringFrom(item, ["product_name", "name"]) || stringFrom(product, ["name"]) || "Product",
      batchNumber: stringFrom(item, ["batch_no", "batch_number"]) || stringFrom(product, ["batch_no", "batch_number"]) || "-",
      manufacturingDate: dateValue(item, ["manufacturing_date", "mfg_date"]) || dateValue(product, ["manufacturing_date", "mfg_date"]),
      expiryDate: dateValue(item, ["expiry_date"]) || dateValue(product, ["expiry_date"]),
      scheduleType: stringFrom(item, ["schedule_type"]) || stringFrom(product, ["schedule_type"]) || "-",
      hsnCode: stringFrom(item, ["hsn_code", "hsn"]) || stringFrom(product, ["hsn_code", "hsn"]) || "-",
      quantity,
      freeQuantity: numberFrom(item, ["free_quantity", "free_qty"]),
      unit: stringFrom(item, ["unit"]) || stringFrom(product, ["unit"]) || "PCS",
      mrp: numberFrom(item, ["mrp"]) || numberFrom(product, ["mrp", "price", "sale_rate"]) || rate,
      rate,
      discountPercent,
      discountAmount,
      taxableValue,
      cgstPercent: isInterstate ? 0 : taxPercent / 2,
      cgstAmount: isInterstate ? 0 : itemTax / 2,
      sgstPercent: isInterstate ? 0 : taxPercent / 2,
      sgstAmount: isInterstate ? 0 : itemTax / 2,
      igstPercent: isInterstate ? taxPercent : 0,
      igstAmount: isInterstate ? itemTax : 0,
      finalAmount: taxableValue + itemTax,
    }
  })

  const invoiceNumber = stringFrom(invoice, ["invoice_number"]) || invoice.id
  const publicInvoiceUrl = `${origin}/public/invoices/${invoice.id}/pdf`

  return {
    id: invoice.id,
    invoiceNumber,
    invoiceTitle: stringFrom(invoice, ["invoice_type"]) === "no_gst" ? "Bill of Supply" : "Tax Invoice",
    invoiceDate: dateValue(invoice, ["created_at", "invoice_date"]),
    dueDate: dateValue(invoice, ["due_date"]),
    salesperson: stringFrom(invoice, ["salesperson", "salesperson_name"]) || "-",
    enterprise: {
      name: stringFrom(organization, ["name", "business_name"]) || "Bezgrow ERP",
      businessType: stringFrom(organization, ["business_type", "industry", "business_category"]) || "Enterprise",
      gstNumber: stringFrom(organization, ["gst_number", "gstin", "tax_id"]) || "-",
      fssai: stringFrom(organization, ["fssai", "fssai_number"]) || "-",
      phone: stringFrom(organization, ["phone", "contact_phone"]) || "-",
      email: stringFrom(organization, ["email", "support_email"]) || "-",
      website: stringFrom(organization, ["website"]) || "bezgrow.com",
      address: stringFrom(organization, ["address", "business_address"]) || "-",
      logoUrl: stringFrom(organization, ["logo_url", "logo"]) || "/brand/bezgrow-logo-3d.png",
      branchName: stringFrom(organization, ["branch_name"]) || "Main Branch",
    },
    customer: {
      id: stringFrom(customer, ["customer_code", "id"]) || stringFrom(invoice, ["customer_id"]) || "-",
      name: stringFrom(customer, ["name"]) || stringFrom(invoice, ["customer_name"]) || "Walk-in customer",
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
      cgst: gstSplit,
      sgst: gstSplit,
      igst: 0,
      roundOff: numberFrom(invoice, ["round_off"]),
      grandTotal,
      amountInWords: amountInIndianWords(grandTotal),
    },
    terms: [],
    notes: stringFrom(invoice, ["notes"]) || "Thank you for your business.",
    qrValue: publicInvoiceUrl,
    barcodeValue: invoiceNumber,
    watermark: stringFrom(organization, ["name", "business_name"]) || "BEZGROW",
  }
}
