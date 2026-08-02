import "server-only"

export type PublicInvoiceShare = {
  id: string
  document_type: "invoice" | "report"
  title: string
  period?: string | null
  invoice_number: string
  customer_name: string
  business_name: string
  filename: string
  byte_size: number
  expires_at: string
  pdf_base64?: string
}

/** Legacy public links are intentionally unavailable after cloud PDF storage retirement. */
export async function findPublicInvoiceShare(token: string, options: { includePdf?: boolean } = {}) {
  void token
  void options
  return null as PublicInvoiceShare | null
}
