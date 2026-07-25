"use client"

import type { PrintInvoice } from "@/components/print/types"
import { invokeTauri, isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { createInvoicePdf } from "@/lib/pdf-invoice"

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string
    types: Array<{ description: string; accept: Record<string, string[]> }>
  }) => Promise<{
    createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>
  }>
}

export type InvoicePdfResult = {
  filename: string
  path?: string
  shared?: boolean
}

export function invoicePdfFilename(invoice: PrintInvoice) {
  const safeNumber = (invoice.invoiceNumber || "invoice")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
  return `${safeNumber || "invoice"}.pdf`
}

export function createInvoicePdfBlob(invoice: PrintInvoice) {
  const bytes = createInvoicePdf(invoice)
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new Blob([body], { type: "application/pdf" })
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = objectUrl
  link.download = filename
  link.style.display = "none"
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30000)
}

async function saveInDesktop(invoice: PrintInvoice) {
  const bytes = createInvoicePdf(invoice)
  const filename = invoicePdfFilename(invoice)
  const path = await invokeTauri<string>("desktop_save_invoice_pdf", {
    filename,
    bytes: Array.from(bytes),
  })
  return { filename, path }
}

export async function saveInvoicePdf(invoice: PrintInvoice): Promise<InvoicePdfResult> {
  if (await isTauriRuntimeAsync()) return saveInDesktop(invoice)

  const filename = invoicePdfFilename(invoice)
  const blob = createInvoicePdfBlob(invoice)
  const savePicker = (window as SaveFilePickerWindow).showSaveFilePicker

  if (savePicker) {
    const handle = await savePicker({
      suggestedName: filename,
      types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }],
    })
    const writable = await handle.createWritable()
    await writable.write(blob)
    await writable.close()
    return { filename }
  }

  triggerBrowserDownload(blob, filename)
  return { filename }
}

export async function downloadInvoicePdf(invoice: PrintInvoice): Promise<InvoicePdfResult> {
  if (await isTauriRuntimeAsync()) return saveInDesktop(invoice)

  const filename = invoicePdfFilename(invoice)
  triggerBrowserDownload(createInvoicePdfBlob(invoice), filename)
  return { filename }
}

export async function shareInvoicePdf(invoice: PrintInvoice): Promise<InvoicePdfResult> {
  const filename = invoicePdfFilename(invoice)
  const file = new File([createInvoicePdfBlob(invoice)], filename, { type: "application/pdf" })
  const canShareFiles = Boolean(navigator.share) && (!navigator.canShare || navigator.canShare({ files: [file] }))

  if (canShareFiles) {
    await navigator.share({
      title: `Invoice ${invoice.invoiceNumber}`,
      text: `Invoice from ${invoice.enterprise.name}`,
      files: [file],
    })
    return { filename, shared: true }
  }

  return saveInvoicePdf(invoice)
}
