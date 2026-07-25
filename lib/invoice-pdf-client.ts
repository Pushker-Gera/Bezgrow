"use client"

import type { PrintFormat, PrintInvoice, PrintSettings } from "@/components/print/types"
import { defaultPrintSettings } from "@/components/print/settings/defaults"
import { saveDesktopBytes, type DesktopSavedFile } from "@/lib/desktop-file-export"
import { createInvoicePdf } from "@/lib/pdf-invoice"

export type InvoicePdfResult = DesktopSavedFile

export function invoicePdfFilename(invoice: PrintInvoice) {
  const safeNumber = (invoice.invoiceNumber || "invoice")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
  return `Invoice-${safeNumber || "invoice"}.pdf`
}

export async function createInvoicePdfBytes(
  invoice: PrintInvoice,
  settings: PrintSettings = defaultPrintSettings,
  format: PrintFormat = settings.defaultFormat
) {
  return createInvoicePdf(invoice, settings, format)
}

export async function createInvoicePdfBlob(
  invoice: PrintInvoice,
  settings: PrintSettings = defaultPrintSettings,
  format: PrintFormat = settings.defaultFormat
) {
  const bytes = await createInvoicePdfBytes(invoice, settings, format)
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new Blob([body], { type: "application/pdf" })
}

export async function saveInvoicePdf(
  invoice: PrintInvoice,
  settings: PrintSettings = defaultPrintSettings,
  format: PrintFormat = settings.defaultFormat
) {
  const filename = invoicePdfFilename(invoice)
  const bytes = await createInvoicePdfBytes(invoice, settings, format)
  return saveDesktopBytes(filename, bytes, "pdf")
}

export async function downloadInvoicePdf(
  invoice: PrintInvoice,
  settings: PrintSettings = defaultPrintSettings,
  format: PrintFormat = settings.defaultFormat
) {
  return saveInvoicePdf(invoice, settings, format)
}

export async function shareInvoicePdf(
  invoice: PrintInvoice,
  settings: PrintSettings = defaultPrintSettings,
  format: PrintFormat = settings.defaultFormat
): Promise<(InvoicePdfResult & { shared?: boolean }) | null> {
  const filename = invoicePdfFilename(invoice)
  const file = new File([await createInvoicePdfBlob(invoice, settings, format)], filename, { type: "application/pdf" })
  const canShareFiles = Boolean(navigator.share) && (!navigator.canShare || navigator.canShare({ files: [file] }))

  if (canShareFiles) {
    await navigator.share({
      title: `Invoice ${invoice.invoiceNumber}`,
      text: `Invoice from ${invoice.enterprise.name}`,
      files: [file],
    })
    return { filename, path: filename, bytes: file.size, shared: true }
  }

  return saveInvoicePdf(invoice, settings, format)
}

