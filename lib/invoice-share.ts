export type InvoiceShareInput = {
  customerName: string
  customerPhone?: string | null
  enterpriseName: string
  invoiceNumber: string
  amount: number
  invoiceUrl: string
}

export function normalizeWhatsAppPhone(phone: string | null | undefined) {
  const digits = String(phone || "").replace(/\D/g, "")
  if (!digits) return ""
  if (digits.length === 10) return `91${digits}`
  if (digits.length >= 11 && digits.length <= 15) return digits
  return ""
}

export function createInvoiceShareText(input: InvoiceShareInput) {
  return [
    `Hello ${input.customerName || "Customer"},`,
    `Thank you for purchasing from ${input.enterpriseName || "Bezgrow"}.`,
    `Invoice Number: ${input.invoiceNumber || "Invoice"}`,
    `Amount: \u20b9${Math.round(input.amount).toLocaleString("en-IN")}`,
    `Download/View Invoice: ${input.invoiceUrl}`,
  ].join("\n")
}

export function createWhatsAppInvoiceUrl(input: InvoiceShareInput) {
  const phone = normalizeWhatsAppPhone(input.customerPhone)
  if (!phone) return ""

  return `https://wa.me/${phone}?text=${encodeURIComponent(createInvoiceShareText(input))}`
}
