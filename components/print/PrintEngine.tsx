"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  createInvoiceEmailDraft,
  createInvoiceShareText,
  createWhatsAppInvoiceUrl,
  normalizeWhatsAppPhone,
  validateCustomerEmail,
} from "@/lib/invoice-share"
import {
  downloadInvoicePdf,
  saveInvoicePdf,
  shareInvoicePdf,
} from "@/lib/invoice-pdf-client"
import { invokeTauri, isTauriRuntimeAsync, openExternalUrl } from "@/lib/desktop/tauri"
import {
  openPdfForNativePrinting,
  prepareDesktopInvoiceShare,
  saveDesktopBytes,
  type DesktopSavedFile,
} from "@/lib/desktop-file-export"
import {
  getCanonicalInvoiceDocument,
  invoiceDocumentKey,
  type CanonicalInvoiceDocument,
} from "@/lib/invoice-document"
import { defaultPrintSettings, persistPrintSettings, saveStoredPrintSettings } from "@/components/print/settings/defaults"
import type { PrintFormat, PrintInvoice, PrintSettings } from "@/components/print/types"
import { getReprintHistory, rememberPdfOpenedForPrint } from "@/components/print/utils"
import { getOfflineMeta, setOfflineMeta } from "@/lib/offline/db"
import { InvoicePdfPreview } from "./InvoicePdfPreview"

const formatLabels: Record<PrintFormat, string> = {
  thermal: "Thermal Receipt",
  a4: "Full A4 Invoice",
  "half-compact": "Half A4 Compact",
  "half-top": "Half A4 Top",
}

type ShareChannel = "whatsapp" | "email"

type ShareDialogState = {
  channel: ShareChannel
  artifact: CanonicalInvoiceDocument
  phone: string
  email: string
  busy: boolean
  error: string
  preparedFile?: DesktopSavedFile
}

const PDF_REGENERATION_DEBOUNCE_MS = 180

export function PrintEngine({
  invoice,
  initialSettings = defaultPrintSettings,
}: {
  invoice: PrintInvoice
  initialSettings?: PrintSettings
}) {
  const [settings, setSettings] = useState<PrintSettings>(initialSettings)
  const [format, setFormat] = useState<PrintFormat>(() => {
    if (typeof window !== "undefined") {
      const requestedFormat = new URLSearchParams(window.location.search).get("format")
      if (requestedFormat && requestedFormat in formatLabels) return requestedFormat as PrintFormat
    }
    return initialSettings.defaultFormat
  })
  const [zoom, setZoom] = useState(1)
  const [notice, setNotice] = useState("")
  const [pendingAction, setPendingAction] = useState("")
  const [termsText, setTermsText] = useState(invoice.terms.join("\n"))
  const [history, setHistory] = useState(() => getReprintHistory().filter((entry) => entry.invoiceId === invoice.id))
  const [shareDialog, setShareDialog] = useState<ShareDialogState | null>(null)
  const [artifact, setArtifact] = useState<CanonicalInvoiceDocument | null>(null)
  const [rendering, setRendering] = useState(true)
  const [renderError, setRenderError] = useState("")
  const requestedShareHandled = useRef(false)
  const requestedPrintHandled = useRef(false)
  const actionInFlight = useRef(false)
  const renderSequence = useRef(0)

  const effectiveInvoice = useMemo<PrintInvoice>(() => ({
    ...invoice,
    terms: termsText
      .split("\n")
      .map((term) => term.trim())
      .filter(Boolean),
  }), [invoice, termsText])

  const requestedDocumentKey = useMemo(
    () => invoiceDocumentKey(effectiveInvoice, settings, format),
    [effectiveInvoice, format, settings],
  )

  useEffect(() => {
    const sequence = ++renderSequence.current
    setRendering(true)
    setRenderError("")
    const timeout = globalThis.setTimeout(() => {
      void getCanonicalInvoiceDocument(effectiveInvoice, settings, format)
        .then((nextArtifact) => {
          if (renderSequence.current !== sequence) return
          setArtifact(nextArtifact)
        })
        .catch((error) => {
          if (renderSequence.current !== sequence) return
          setRenderError(error instanceof Error ? error.message : "The invoice PDF could not be generated.")
        })
        .finally(() => {
          if (renderSequence.current === sequence) setRendering(false)
        })
    }, PDF_REGENERATION_DEBOUNCE_MS)

    return () => globalThis.clearTimeout(timeout)
  }, [effectiveInvoice, format, requestedDocumentKey, settings])

  function updateSettings(next: Partial<PrintSettings>) {
    const updated = { ...settings, ...next }
    setSettings(updated)
    saveStoredPrintSettings(updated)
    void persistPrintSettings(invoice.enterprise.organizationId, updated)
      .then(() => setNotice("Print settings saved locally."))
      .catch((error) => setNotice(error instanceof Error ? error.message : "Print settings could not be saved."))
  }

  function changeFormat(nextFormat: PrintFormat) {
    setFormat(nextFormat)
    updateSettings({ defaultFormat: nextFormat })
  }

  function validateInvoiceForDocumentAction() {
    if (!effectiveInvoice.invoiceNumber.trim() || effectiveInvoice.invoiceNumber === "-") {
      throw new Error("The invoice number is missing.")
    }
    if (!effectiveInvoice.items.length) throw new Error("Add at least one invoice item before printing or sharing.")
    if (!Number.isFinite(effectiveInvoice.totals.grandTotal)) throw new Error("The invoice grand total is invalid.")
  }

  async function currentDocument() {
    validateInvoiceForDocumentAction()
    const nextArtifact = await getCanonicalInvoiceDocument(effectiveInvoice, settings, format)
    if (nextArtifact.key !== requestedDocumentKey) {
      throw new Error("Invoice settings changed while the PDF was being generated. Please try again.")
    }
    setArtifact(nextArtifact)
    setRenderError("")
    return nextArtifact
  }

  function resultNotice(action: string, result: { filename: string; path?: string }) {
    return result.path ? `${action}: ${result.path}` : `${action}: ${result.filename}`
  }

  async function runAction(label: string, action: () => Promise<void>) {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setPendingAction(label)
    setNotice("")
    try {
      await action()
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setNotice("")
      } else {
        setNotice(error instanceof Error ? error.message : `${label} could not be completed.`)
      }
    } finally {
      actionInFlight.current = false
      setPendingAction("")
    }
  }

  function printInvoice() {
    void runAction("Opening PDF", async () => {
      const document = await currentDocument()
      const opened = await openPdfForNativePrinting(document.filename, document.bytes, document.pageCount)
      if (opened.bytes !== document.bytes.byteLength || opened.pageCount !== document.pageCount) {
        throw new Error("The operating system received a different PDF than the validated preview.")
      }
      rememberPdfOpenedForPrint(effectiveInvoice, format)
      setHistory(getReprintHistory().filter((entry) => entry.invoiceId === invoice.id))
      setNotice("The exact validated PDF opened in your default PDF app. Choose Print there to use the operating-system printer dialog; cancelling it does not leave Bezgrow loading.")
    })
  }

  function savePdf() {
    void runAction("Saving PDF", async () => {
      const document = await currentDocument()
      const result = await saveInvoicePdf(document)
      if (!result) return
      if (result.bytes !== document.bytes.byteLength) throw new Error("The saved PDF byte count does not match the validated preview.")
      if (!settings.autoPrintAfterSave) {
        setNotice(resultNotice("PDF saved", result))
        return
      }

      const opened = await openPdfForNativePrinting(document.filename, document.bytes, document.pageCount)
      if (opened.bytes !== document.bytes.byteLength || opened.pageCount !== document.pageCount) {
        throw new Error("The operating system received a different PDF than the validated preview.")
      }
      rememberPdfOpenedForPrint(effectiveInvoice, format)
      setHistory(getReprintHistory().filter((entry) => entry.invoiceId === invoice.id))
      setNotice(`${resultNotice("PDF saved", result)}. Auto Print After Save opened that exact PDF in your default PDF app.`)
    })
  }

  function downloadPdf() {
    void runAction("Downloading PDF", async () => {
      const document = await currentDocument()
      const result = await downloadInvoicePdf(document)
      if (!result) return
      if (result.bytes !== document.bytes.byteLength) throw new Error("The downloaded PDF byte count does not match the validated preview.")
      setNotice(resultNotice("PDF downloaded", result))
    })
  }

  function sharePdf() {
    void runAction("Sharing PDF", async () => {
      const document = await currentDocument()
      const result = await shareInvoicePdf(document, {
        title: `Invoice ${invoice.invoiceNumber}`,
        text: createInvoiceShareText(preparedShareInput({ phone: invoice.customer.phone, email: invoice.customer.email })),
      })
      if (!result) return
      setNotice(result.shared
        ? "The exact invoice PDF was handed to the operating-system share sheet. The final recipient and Send action remain under your control."
        : `${resultNotice("Direct file sharing is unavailable, so the exact PDF was saved", result)}.`)
    })
  }

  function prepareInvoiceShare(channel: ShareChannel) {
    void runAction(channel === "whatsapp" ? "Preparing WhatsApp" : "Preparing email", async () => {
      const document = await currentDocument()
      setShareDialog({
        channel,
        artifact: document,
        phone: normalizeWhatsAppPhone(invoice.customer.phone) || (invoice.customer.phone === "-" ? "" : invoice.customer.phone),
        email: validateCustomerEmail(invoice.customer.email) || (invoice.customer.email === "-" ? "" : invoice.customer.email),
        busy: false,
        error: "",
      })
      setNotice("The exact previewed invoice PDF is ready locally.")
    })
  }

  function preparedShareInput(contact: { phone: string; email: string }) {
    return {
      customerName: invoice.customer.name,
      customerPhone: contact.phone,
      customerEmail: contact.email,
      enterpriseName: invoice.enterprise.name,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      amount: invoice.totals.grandTotal,
      paidAmount: invoice.payment.paidAmount,
      dueAmount: invoice.payment.dueAmount,
    }
  }

  async function copyPreparedMessage(dialog: ShareDialogState) {
    const input = preparedShareInput(dialog)
    if (dialog.channel === "email") {
      const draft = createInvoiceEmailDraft(input)
      await navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.body}`)
      setNotice("Prepared email message copied.")
      return
    }
    await navigator.clipboard.writeText(createInvoiceShareText(input))
    setNotice("Prepared WhatsApp message copied.")
  }

  async function savePreparedPdf(dialog: ShareDialogState) {
    const result = await saveDesktopBytes(dialog.artifact.filename, dialog.artifact.bytes, "pdf")
    if (!result) return
    if (result.bytes !== dialog.artifact.bytes.byteLength) throw new Error("The saved attachment does not match the validated invoice PDF.")
    setNotice(resultNotice("PDF saved", result))
  }

  async function ensurePreparedShareFile(dialog: ShareDialogState) {
    if (dialog.preparedFile) return dialog.preparedFile
    const prepared = await prepareDesktopInvoiceShare(dialog.artifact.filename, dialog.artifact.bytes)
    if (prepared) setShareDialog((current) => current ? { ...current, preparedFile: prepared } : null)
    return prepared
  }

  async function sharePreparedAttachment(dialog: ShareDialogState) {
    if (dialog.busy) return
    setShareDialog({ ...dialog, busy: true, error: "" })
    try {
      const file = new File([dialog.artifact.bytes.slice().buffer as ArrayBuffer], dialog.artifact.filename, { type: "application/pdf" })
      const canShareFiles = Boolean(navigator.share) && (!navigator.canShare || navigator.canShare({ files: [file] }))
      if (canShareFiles) {
        await navigator.share({
          title: `Invoice ${invoice.invoiceNumber}`,
          text: createInvoiceShareText(preparedShareInput(dialog)),
          files: [file],
        })
        setNotice("The exact invoice PDF was handed to the OS share sheet. Bezgrow did not upload or send it.")
      } else {
        const prepared = await ensurePreparedShareFile(dialog)
        if (prepared) {
          await invokeTauri<void>("desktop_reveal_file", { path: prepared.path })
          setNotice(`Direct attachment sharing is unavailable. The exact PDF is selected at ${prepared.path}; attach it in your chosen app and press Send yourself.`)
        } else {
          const saved = await saveDesktopBytes(dialog.artifact.filename, dialog.artifact.bytes, "pdf")
          if (saved) setNotice("Direct attachment sharing is unavailable. The exact PDF was downloaded for you to attach manually.")
        }
      }
      setShareDialog((current) => current ? { ...current, busy: false, error: "" } : null)
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setShareDialog((current) => current ? { ...current, busy: false } : null)
        return
      }
      setShareDialog((current) => current ? {
        ...current,
        busy: false,
        error: error instanceof Error ? error.message : "The local PDF could not be shared.",
      } : null)
    }
  }

  async function openPreparedMessage(dialog: ShareDialogState) {
    if (dialog.busy) return
    const phone = normalizeWhatsAppPhone(dialog.phone)
    const email = validateCustomerEmail(dialog.email)
    if (dialog.channel === "whatsapp" && !phone) {
      setShareDialog({ ...dialog, error: "Enter a valid mobile number with country code." })
      return
    }
    if (dialog.channel === "email" && !email) {
      setShareDialog({ ...dialog, error: "Enter a valid customer email address." })
      return
    }

    setShareDialog({ ...dialog, phone: phone || dialog.phone, email: email || dialog.email, busy: true, error: "" })
    try {
      let prepared = await ensurePreparedShareFile(dialog)
      if (!prepared && !(await isTauriRuntimeAsync())) {
        prepared = await saveDesktopBytes(dialog.artifact.filename, dialog.artifact.bytes, "pdf")
        if (!prepared) {
          setShareDialog((current) => current ? { ...current, busy: false } : null)
          return
        }
      }
      if (prepared && await isTauriRuntimeAsync()) {
        await invokeTauri<void>("desktop_reveal_file", { path: prepared.path })
      }

      if (dialog.channel === "whatsapp") {
        const url = createWhatsAppInvoiceUrl(preparedShareInput({ ...dialog, phone }))
        if (!url) throw new Error("The WhatsApp number is invalid.")
        await openExternalUrl(url)
        setNotice("WhatsApp opened on the correct customer with the prepared message, and the exact local PDF is selected for attachment. Bezgrow did not upload or automatically send anything.")
      } else {
        const draft = createInvoiceEmailDraft(preparedShareInput({ ...dialog, email }))
        await openExternalUrl(draft.mailtoUrl)
        setNotice("Your default email app opened with the prepared draft, and the exact local PDF is selected for attachment. Bezgrow did not upload it.")
      }
      setShareDialog((current) => current ? {
        ...current,
        phone: phone || current.phone,
        email: email || current.email,
        busy: false,
        error: "",
      } : null)
    } catch (error) {
      setShareDialog((current) => current ? {
        ...current,
        busy: false,
        error: error instanceof Error ? error.message : "The prepared message could not be opened.",
      } : null)
    }
  }

  useEffect(() => {
    if (requestedShareHandled.current || typeof window === "undefined") return
    if (new URLSearchParams(window.location.search).get("share") === "whatsapp") {
      requestedShareHandled.current = true
      queueMicrotask(() => prepareInvoiceShare("whatsapp"))
    }
  })

  useEffect(() => {
    if (requestedPrintHandled.current || typeof window === "undefined") return
    if (new URLSearchParams(window.location.search).get("autoprint") !== "1") return
    requestedPrintHandled.current = true
    const timeoutId = globalThis.setTimeout(printInvoice, 350)
    return () => globalThis.clearTimeout(timeoutId)
  })

  function queueSharingReminder() {
    void runAction("Queueing reminder", async () => {
      const key = "invoice_share_reminders_json"
      const existingText = await getOfflineMeta(key, "[]", invoice.enterprise.organizationId)
      let existing: Array<Record<string, unknown>> = []
      try {
        existing = JSON.parse(existingText) as Array<Record<string, unknown>>
      } catch {
        existing = []
      }
      const reminders = existing.filter((entry) => entry.invoiceId !== invoice.id)
      reminders.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        customerName: invoice.customer.name,
        phone: normalizeWhatsAppPhone(invoice.customer.phone),
        createdAt: new Date().toISOString(),
      })
      await setOfflineMeta(key, JSON.stringify(reminders), invoice.enterprise.organizationId)
      setNotice("Sharing reminder queued locally. Bezgrow will not contact WhatsApp or retry in the background.")
    })
  }

  function goBack() {
    if (window.history.length > 1) window.history.back()
    else window.location.href = "/dashboard/invoices"
  }

  const documentIsCurrent = artifact?.key === requestedDocumentKey
  return (
    <>
      <PrintEngineStyles />
      <div className="enterprise-print-shell">
        <aside className="print-control-panel">
          <div>
            <p className="panel-eyebrow">Enterprise Print Engine</p>
            <h1>{invoice.enterprise.name}</h1>
            <p>{invoice.invoiceNumber}</p>
          </div>

          <section>
            <p className="control-label">Template</p>
            <div className="template-grid">
              {(Object.keys(formatLabels) as PrintFormat[]).map((key) => (
                <button key={key} onClick={() => changeFormat(key)} className={format === key ? "active" : ""}>
                  {formatLabels[key]}
                </button>
              ))}
            </div>
          </section>

          <section>
            <p className="control-label">Print Settings</p>
            <select value={settings.thermalWidth} onChange={(event) => updateSettings({ thermalWidth: event.target.value as PrintSettings["thermalWidth"] })}>
              <option value="auto">Thermal auto width</option>
              <option value="58mm">58mm thermal</option>
              <option value="80mm">80mm thermal</option>
            </select>
            <select value={settings.margins} onChange={(event) => updateSettings({ margins: event.target.value as PrintSettings["margins"] })}>
              <option value="compact">Compact margins</option>
              <option value="standard">Standard margins</option>
              <option value="wide">Wide margins</option>
            </select>
            <select value={settings.fontSize} onChange={(event) => updateSettings({ fontSize: event.target.value as PrintSettings["fontSize"] })}>
              <option value="small">Small font</option>
              <option value="standard">Standard font</option>
              <option value="large">Large font</option>
            </select>
            {[
              ["showLogo", "Show Logo"],
              ["showQr", "Show QR"],
              ["showBarcode", "Show Barcode"],
              ["showHsn", "Show HSN"],
              ["showGstDetails", "Show GST Details"],
              ["showSignature", "Show Signature"],
              ["showWatermark", "Show Watermark"],
              ["blackAndWhite", "Black & White"],
              ["pharmaMode", "Pharma Mode"],
              ["autoPrintAfterSave", "Auto Print After Save"],
            ].map(([key, label]) => (
              <label key={key} className="toggle-row">
                <span>{label}</span>
                <input
                  type="checkbox"
                  checked={Boolean(settings[key as keyof PrintSettings])}
                  onChange={(event) => updateSettings({ [key]: event.target.checked } as Partial<PrintSettings>)}
                />
              </label>
            ))}
          </section>

          <section>
            <p className="control-label">Preview Zoom</p>
            <input type="range" min="0.55" max="1.25" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} />
          </section>

          <section>
            <p className="control-label">Terms & Conditions</p>
            <textarea className="terms-editor" value={termsText} onChange={(event) => setTermsText(event.target.value)} rows={5} />
          </section>

          {notice && <p className="print-notice">{notice}</p>}

          <section className="action-grid">
            <button onClick={printInvoice} disabled={Boolean(pendingAction)}>{pendingAction === "Opening PDF" ? "Opening..." : "Print"}</button>
            <button onClick={savePdf} disabled={Boolean(pendingAction)}>{pendingAction === "Saving PDF" ? "Saving..." : "Save PDF"}</button>
            <button onClick={downloadPdf} disabled={Boolean(pendingAction)}>{pendingAction === "Downloading PDF" ? "Downloading..." : "Download PDF"}</button>
            <button onClick={sharePdf} disabled={Boolean(pendingAction)}>{pendingAction === "Sharing PDF" ? "Sharing..." : "Share PDF"}</button>
            <button onClick={() => prepareInvoiceShare("whatsapp")} disabled={Boolean(pendingAction)}>{pendingAction === "Preparing WhatsApp" ? "Preparing..." : "WhatsApp"}</button>
            <button onClick={() => prepareInvoiceShare("email")} disabled={Boolean(pendingAction)}>{pendingAction === "Preparing email" ? "Preparing..." : "Email"}</button>
            <button onClick={queueSharingReminder} disabled={Boolean(pendingAction)}>{pendingAction === "Queueing reminder" ? "Queueing..." : "Queue Share Reminder"}</button>
          </section>

          <section>
            <p className="control-label">PDFs Opened for Printing</p>
            <div className="history-list">
              {history.length === 0 ? <p>No PDFs opened yet.</p> : history.slice(0, 5).map((entry) => (
                <p key={`${entry.printedAt}-${entry.format}`}>{formatLabels[entry.format]} - {new Date(entry.printedAt).toLocaleString()}</p>
              ))}
            </div>
          </section>
        </aside>

        <main className="print-preview-stage">
          <div className="mobile-toolbar">
            <select value={format} onChange={(event) => changeFormat(event.target.value as PrintFormat)}>
              {(Object.keys(formatLabels) as PrintFormat[]).map((key) => <option key={key} value={key}>{formatLabels[key]}</option>)}
            </select>
            <div className="mobile-action-grid">
              <button onClick={goBack}>Back</button>
              <button onClick={downloadPdf}>Download PDF</button>
              <button onClick={printInvoice}>Print</button>
              <button onClick={() => prepareInvoiceShare("whatsapp")}>WhatsApp</button>
            </div>
          </div>
          <div className="pdf-preview-meta">
            <span>{formatLabels[format]}</span>
            {artifact && <span>{artifact.pageCount} page{artifact.pageCount === 1 ? "" : "s"} · {(artifact.bytes.byteLength / 1024).toFixed(1)} KB</span>}
            <span>{documentIsCurrent && !rendering ? "Validated PDF" : "Updating PDF"}</span>
          </div>
          <div className="preview-scroll">
            <div className="pdf-zoom-layer" style={{ transform: `scale(${zoom})` }}>
              <InvoicePdfPreview artifact={artifact} rendering={rendering} error={renderError} />
            </div>
          </div>
        </main>
      </div>

      {shareDialog && (
        <div className="share-modal-backdrop" role="presentation">
          <section className="share-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title">
            <div>
              <p className="panel-eyebrow">{shareDialog.channel === "whatsapp" ? "WhatsApp Invoice" : "Email Invoice"}</p>
              <h2 id="share-dialog-title">Prepare local PDF share</h2>
              <p className="share-modal-helper">The exact previewed invoice PDF remains on this device. Bezgrow does not upload it or require an online Bezgrow sign-in.</p>
            </div>
            <dl className="share-summary-grid">
              <div><dt>Invoice</dt><dd>{invoice.invoiceNumber}</dd></div>
              <div><dt>Customer</dt><dd>{invoice.customer.name}</dd></div>
              <div><dt>File</dt><dd>{shareDialog.artifact.filename}</dd></div>
              <div><dt>Storage</dt><dd>Local-only</dd></div>
            </dl>
            {shareDialog.channel === "whatsapp" ? (
              <label className="share-field">
                <span>Customer phone</span>
                <input value={shareDialog.phone} onChange={(event) => setShareDialog({ ...shareDialog, phone: event.target.value, error: "" })} inputMode="tel" placeholder="9876543210 or country code + number" />
              </label>
            ) : (
              <label className="share-field">
                <span>Customer email</span>
                <input value={shareDialog.email} onChange={(event) => setShareDialog({ ...shareDialog, email: event.target.value, error: "" })} inputMode="email" placeholder="customer@example.com" />
              </label>
            )}
            {shareDialog.error && <div className="share-offline-box"><strong>{shareDialog.error}</strong><p>The PDF remains on this device.</p></div>}
            <div className="share-modal-actions">
              <button type="button" onClick={() => void savePreparedPdf(shareDialog)} disabled={shareDialog.busy}>Save PDF</button>
              <button type="button" onClick={() => void sharePreparedAttachment(shareDialog)} disabled={shareDialog.busy}>Share PDF with OS</button>
              <button type="button" onClick={() => void copyPreparedMessage(shareDialog)} disabled={shareDialog.busy}>{shareDialog.channel === "email" ? "Copy Email Message" : "Copy prepared message"}</button>
              <button type="button" className="primary" onClick={() => void openPreparedMessage(shareDialog)} disabled={shareDialog.busy}>
                {shareDialog.busy ? "Opening..." : shareDialog.channel === "email" ? "Open Email Draft" : "Open WhatsApp"}
              </button>
              <button type="button" onClick={() => setShareDialog(null)} disabled={shareDialog.busy}>Close</button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}

function PrintEngineStyles() {
  return (
    <style jsx global>{`
      .enterprise-print-shell { height: 100%; min-height: 0; min-width: 0; overflow: hidden; display: grid; grid-template-columns: 320px minmax(0, 1fr); background: #0a0d12; color: #f8fafc; }
      .print-control-panel { height: 100%; min-height: 0; overflow-y: auto; overscroll-behavior: contain; border-right: 1px solid rgba(255,255,255,.1); background: #070b12; padding: 22px; display: flex; flex-direction: column; gap: 20px; }
      .panel-eyebrow, .control-label { color: #0891b2; font-size: 10px; font-weight: 900; letter-spacing: .18em; text-transform: uppercase; }
      .print-control-panel h1 { margin: 8px 0 2px; font-size: 24px; font-weight: 900; }
      .print-control-panel section { display: grid; gap: 8px; }
      .template-grid, .action-grid { display: grid; gap: 8px; }
      .template-grid button, .action-grid button, .print-control-panel select, .mobile-toolbar select, .mobile-toolbar button { min-height: 42px; border-radius: 12px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: #fff; padding: 0 12px; font-weight: 800; }
      .template-grid button.active, .action-grid button:first-child { background: #fff; color: #020617; }
      .action-grid button:disabled, .mobile-toolbar button:disabled { cursor: wait; opacity: .55; }
      .terms-editor { width: 100%; min-height: 118px; resize: vertical; border-radius: 12px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: #fff; padding: 12px; font: inherit; font-size: 13px; line-height: 1.45; outline: none; }
      .terms-editor:focus, .share-field input:focus { border-color: rgba(34,211,238,.55); box-shadow: 0 0 0 3px rgba(34,211,238,.12); }
      .toggle-row { display: flex; justify-content: space-between; gap: 14px; align-items: center; min-height: 36px; font-size: 13px; color: #cbd5e1; }
      .print-notice { border: 1px solid rgba(251,191,36,.35); color: #fde68a; background: rgba(251,191,36,.1); border-radius: 12px; padding: 10px; font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
      .history-list { color: #94a3b8; font-size: 12px; display: grid; gap: 7px; }
      .print-preview-stage { min-width: 0; min-height: 0; overflow: hidden; display: grid; grid-template-rows: auto minmax(0,1fr); background: radial-gradient(circle at top left, rgba(34,211,238,.08), transparent 32%), #111827; }
      .mobile-toolbar { display: none; gap: 10px; padding: 12px; background: #070b12; border-bottom: 1px solid rgba(255,255,255,.1); }
      .mobile-action-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      .pdf-preview-meta { min-height: 42px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; border-bottom: 1px solid rgba(255,255,255,.08); padding: 8px 18px; color: #cbd5e1; background: rgba(2,6,23,.5); font-size: 11px; font-weight: 800; letter-spacing: .04em; }
      .preview-scroll { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 32px; display: flex; justify-content: center; align-items: flex-start; background: #111827; }
      .pdf-zoom-layer { transform-origin: top center; transition: transform .18s ease; }
      .canonical-pdf-preview { position: relative; min-width: min-content; min-height: 240px; }
      .canonical-pdf-pages { display: grid; justify-items: center; gap: 22px; }
      .canonical-pdf-page { overflow: hidden; background: #fff; box-shadow: 0 24px 90px rgba(0,0,0,.38); }
      .canonical-pdf-page canvas { display: block; max-width: none; background: #fff; }
      .pdf-preview-state { min-width: 320px; min-height: 240px; display: flex; align-items: center; justify-content: center; gap: 10px; border: 1px solid rgba(255,255,255,.12); border-radius: 16px; color: #e2e8f0; background: #0f172a; padding: 24px; text-align: center; }
      .pdf-preview-error { color: #fecaca; border-color: rgba(248,113,113,.35); background: #1b090b; }
      .pdf-preview-spinner { width: 22px; height: 22px; border: 2px solid #334155; border-top-color: #67e8f9; border-radius: 50%; animation: pdf-spin .8s linear infinite; }
      .pdf-refresh-indicator { position: fixed; right: 20px; bottom: 20px; z-index: 10; border: 1px solid rgba(34,211,238,.3); border-radius: 999px; background: #07131c; color: #cffafe; padding: 8px 12px; box-shadow: 0 12px 40px rgba(0,0,0,.35); font-size: 11px; font-weight: 900; }
      @keyframes pdf-spin { to { transform: rotate(360deg); } }
      .share-modal-backdrop { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; overflow-y: auto; padding: 20px; background: rgba(2,6,23,.78); backdrop-filter: blur(12px); }
      .share-confirm-modal { width: min(100%, 560px); border: 1px solid rgba(255,255,255,.14); border-radius: 24px; background: #080d16; color: #f8fafc; padding: 24px; box-shadow: 0 30px 100px rgba(0,0,0,.55); display: grid; gap: 18px; }
      .share-confirm-modal h2 { margin: 6px 0 0; font-size: 25px; font-weight: 900; }
      .share-modal-helper { margin-top: 5px; color: #94a3b8; font-size: 13px; line-height: 1.5; }
      .share-summary-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; margin: 0; }
      .share-summary-grid div { min-width: 0; border: 1px solid rgba(255,255,255,.09); border-radius: 14px; background: rgba(255,255,255,.04); padding: 11px; }
      .share-summary-grid dt { color: #94a3b8; font-size: 10px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
      .share-summary-grid dd { margin: 4px 0 0; overflow-wrap: anywhere; font-size: 13px; font-weight: 800; }
      .share-field { display: grid; gap: 7px; color: #cbd5e1; font-size: 12px; font-weight: 800; }
      .share-field input { width: 100%; min-height: 45px; border: 1px solid rgba(255,255,255,.12); border-radius: 12px; background: rgba(255,255,255,.06); color: #fff; padding: 0 12px; outline: none; }
      .share-offline-box { border: 1px solid rgba(251,191,36,.25); border-radius: 14px; background: rgba(251,191,36,.08); color: #fde68a; padding: 12px; font-size: 12px; line-height: 1.5; }
      .share-offline-box p { margin: 4px 0 0; color: #fef3c7; }
      .share-modal-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 9px; }
      .share-modal-actions button { min-height: 42px; border: 1px solid rgba(255,255,255,.12); border-radius: 12px; background: rgba(255,255,255,.06); color: #fff; padding: 0 14px; font-size: 12px; font-weight: 900; }
      .share-modal-actions button.primary { border-color: transparent; background: #fff; color: #020617; }
      .share-modal-actions button:disabled { cursor: wait; opacity: .55; }
      @media screen and (max-width: 900px) {
        .enterprise-print-shell { grid-template-columns: 1fr; }
        .print-control-panel { display: none; }
        .mobile-toolbar { display: grid; }
        .print-preview-stage { grid-template-rows: auto auto minmax(0,1fr); }
        .preview-scroll { padding: 12px; justify-content: flex-start; }
        .pdf-zoom-layer { transform: none !important; width: 100%; }
        .canonical-pdf-preview { min-width: 0; width: 100%; }
        .canonical-pdf-page { width: 100%; }
        .canonical-pdf-page canvas { width: 100% !important; height: auto !important; }
      }
      @media (max-width: 520px) {
        .share-summary-grid { grid-template-columns: 1fr; }
        .share-modal-actions { display: grid; grid-template-columns: 1fr; }
      }
    `}</style>
  )
}
