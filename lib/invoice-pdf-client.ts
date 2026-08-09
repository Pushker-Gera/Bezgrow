"use client"

import type { PrintFormat, PrintInvoice, PrintSettings } from "@/components/print/types"
import { defaultPrintSettings } from "@/components/print/settings/defaults"
import { saveDesktopBytes, type DesktopSavedFile } from "@/lib/desktop-file-export"
import {
  getCanonicalInvoiceDocument,
  type CanonicalInvoiceDocument,
} from "@/lib/invoice-document"

export type InvoicePdfResult = DesktopSavedFile

export function invoicePdfFilename(invoice: PrintInvoice) {
  const safeNumber = (invoice.invoiceNumber || "invoice")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
  return `Invoice-${safeNumber || "invoice"}.pdf`
}

/** Compatibility entry point. New UI code keeps the returned canonical
 * document artifact and passes that exact artifact to every action. */
export async function createInvoicePdfBytes(
  invoice: PrintInvoice,
  settings: PrintSettings = defaultPrintSettings,
  format: PrintFormat = settings.defaultFormat,
) {
  return (await getCanonicalInvoiceDocument(invoice, settings, format)).bytes
}

export function createInvoicePdfBlob(artifact: CanonicalInvoiceDocument) {
  return new Blob([artifact.bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" })
}

export async function saveInvoicePdf(artifact: CanonicalInvoiceDocument) {
  return saveDesktopBytes(artifact.filename, artifact.bytes, "pdf")
}

export async function downloadInvoicePdf(artifact: CanonicalInvoiceDocument) {
  return saveInvoicePdf(artifact)
}

export async function shareInvoicePdf(
  artifact: CanonicalInvoiceDocument,
  options: { title: string; text: string },
): Promise<(InvoicePdfResult & { shared?: boolean }) | null> {
  const file = new File([createInvoicePdfBlob(artifact)], artifact.filename, { type: "application/pdf" })
  const canShareFiles = Boolean(navigator.share) && (!navigator.canShare || navigator.canShare({ files: [file] }))

  if (canShareFiles) {
    await navigator.share({ ...options, files: [file] })
    return { filename: artifact.filename, path: artifact.filename, bytes: file.size, shared: true }
  }

  return saveInvoicePdf(artifact)
}
