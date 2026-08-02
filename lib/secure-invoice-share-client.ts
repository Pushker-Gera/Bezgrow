"use client"

export type SecureInvoiceShareRequest = {
  organizationId: string
  invoiceId: string
  invoiceNumber: string
  customerName: string
  filename: string
  pdfBytes: Uint8Array
  expiresInDays?: 7 | 30
}

export type SecureInvoiceShareResult = {
  id: string
  url: string
  expiresAt: string
  filename: string
}

export class InvoiceShareOfflineError extends Error {
  constructor() {
    super("Cloud PDF upload is disabled. Save the PDF locally and attach it using the operating-system share sheet, email app, or WhatsApp.")
    this.name = "InvoiceShareOfflineError"
  }
}

function cloudPdfUploadDisabled(): never {
  throw new InvoiceShareOfflineError()
}

export async function createSecureInvoiceShare(input: SecureInvoiceShareRequest): Promise<SecureInvoiceShareResult> {
  void input
  return cloudPdfUploadDisabled()
}

export async function revokeSecureInvoiceShare(organizationId: string, shareId: string) {
  void organizationId
  void shareId
  return cloudPdfUploadDisabled()
}

export async function createSecureReportShare(input: {
  organizationId: string
  title: string
  period: string
  filename: string
  pdfBytes: Uint8Array
  expiresInDays?: 7 | 30
}): Promise<SecureInvoiceShareResult> {
  void input
  return cloudPdfUploadDisabled()
}

export async function revokeSecureReportShare(organizationId: string, shareId: string) {
  void organizationId
  void shareId
  return cloudPdfUploadDisabled()
}
