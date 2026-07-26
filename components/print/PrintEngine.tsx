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
  createInvoicePdfBytes,
  downloadInvoicePdf,
  invoicePdfFilename,
  saveInvoicePdf,
  shareInvoicePdf,
} from "@/lib/invoice-pdf-client"
import { invokeTauri, isTauriRuntimeAsync, openExternalUrl } from "@/lib/desktop/tauri"
import { saveDesktopBytes } from "@/lib/desktop-file-export"
import {
  createSecureInvoiceShare,
  InvoiceShareOfflineError,
  revokeSecureInvoiceShare,
  type SecureInvoiceShareResult,
} from "@/lib/secure-invoice-share-client"
import { defaultPrintSettings, persistPrintSettings, saveStoredPrintSettings } from "@/components/print/settings/defaults"
import type { PrintFormat, PrintInvoice, PrintSettings } from "@/components/print/types"
import { getReprintHistory, rememberReprint } from "@/components/print/utils"
import { getOfflineMeta, setOfflineMeta } from "@/lib/offline/db"
import { A4Template } from "./templates/A4Template"
import { HalfCompactTemplate } from "./templates/HalfCompactTemplate"
import { HalfTopTemplate } from "./templates/HalfTopTemplate"
import { ThermalTemplate } from "./templates/ThermalTemplate"

const formatLabels: Record<PrintFormat, string> = {
  thermal: "Thermal Receipt",
  a4: "Full A4 Invoice",
  "half-compact": "Half A4 Compact",
  "half-top": "Half A4 Top",
}

type ShareChannel = "whatsapp" | "email"

type ShareDialogState = {
  channel: ShareChannel
  bytes: Uint8Array
  filename: string
  phone: string
  email: string
  expiresInDays: 7 | 30
  busy: boolean
  offline: boolean
  error: string
  result: SecureInvoiceShareResult | null
}

export function PrintEngine({
  invoice,
  initialSettings = defaultPrintSettings,
  publicMode = false,
}: {
  invoice: PrintInvoice
  initialSettings?: PrintSettings
  publicMode?: boolean
}) {
  const [settings, setSettings] = useState<PrintSettings>(initialSettings)
  const [format, setFormat] = useState<PrintFormat>(() => {
    if (publicMode && typeof window !== "undefined") {
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
  const requestedShareHandled = useRef(false)
  const requestedPrintHandled = useRef(false)

  const effectiveInvoice = useMemo<PrintInvoice>(() => {
    const terms = termsText
      .split("\n")
      .map((term) => term.trim())
      .filter(Boolean)

    return {
      ...invoice,
      terms,
      qrValue: invoice.qrValue,
    }
  }, [invoice, termsText])

  useEffect(() => {
    document.documentElement.dataset.printFormat = format
    document.getElementById("dynamic-thermal-page-size")?.remove()
    return () => {
      delete document.documentElement.dataset.printFormat
      document.getElementById("dynamic-thermal-page-size")?.remove()
    }
  }, [format])

  function updateSettings(next: Partial<PrintSettings>) {
    const updated = { ...settings, ...next }
    setSettings(updated)
    saveStoredPrintSettings(updated)
    void persistPrintSettings(invoice.enterprise.organizationId, updated)
      .then(() => setNotice("Print settings saved locally."))
      .catch((error) => setNotice(error instanceof Error ? error.message : "Print settings could not be saved."))
  }

  function escapeHtml(value: string) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
  }

  function printWindowOverrides() {
    const thermalPaperWidth = settings.thermalWidth === "58mm" ? "58mm" : "80mm"
    const printSafeMargin = format === "thermal" ? "0" : "7mm"
    const pageSize =
      format === "thermal"
        ? `${thermalPaperWidth} 160mm`
        : format === "half-top"
          ? "210mm 148.5mm"
          : format === "half-compact"
            ? "A5 portrait"
            : "A4 portrait"
    const bodyWidth = format === "thermal" ? thermalPaperWidth : format === "half-compact" ? "134mm" : "196mm"
    const bodyHeight = format === "half-top" ? "134.5mm" : format === "half-compact" ? "196mm" : format === "thermal" ? "auto" : "283mm"

    return `
      <style>
        @page { size: ${pageSize}; margin: ${printSafeMargin}; }
        @media screen {
          html, body { margin: 0; padding: 0; background: #e5e7eb; }
          body { min-height: 100vh; display: flex; justify-content: center; align-items: flex-start; padding: 16px; }
          .print-document { transform: none !important; transition: none !important; }
          .invoice-paper { box-shadow: 0 12px 40px rgba(15, 23, 42, .18); }
          .print-thermal { box-shadow: none !important; }
        }
        @media print {
          html, body {
            width: ${bodyWidth} !important;
            max-width: ${bodyWidth} !important;
            min-height: ${bodyHeight} !important;
            margin: 0 !important;
            padding: 0 !important;
            overflow: visible !important;
            background: #fff !important;
            color: #000 !important;
            print-color-adjust: exact !important;
            -webkit-print-color-adjust: exact !important;
          }
          body * { visibility: visible !important; }
          .no-print { display: none !important; }
          .print-document {
            position: static !important;
            display: block !important;
            width: ${bodyWidth} !important;
            max-width: ${bodyWidth} !important;
            height: auto !important;
            min-height: ${bodyHeight} !important;
            padding: 0 !important;
            margin: 0 !important;
            overflow: visible !important;
            background: #fff !important;
            print-color-adjust: exact !important;
            -webkit-print-color-adjust: exact !important;
            transform: none !important;
            transition: none !important;
          }
          .invoice-paper {
            box-shadow: none !important;
            margin: 0 !important;
            overflow: visible !important;
            background: #fff !important;
            color: #000 !important;
          }
          .print-a4 {
            width: ${bodyWidth} !important;
            max-width: ${bodyWidth} !important;
            min-height: 283mm !important;
            padding: 6mm !important;
          }
          .print-half-compact {
            width: ${bodyWidth} !important;
            max-width: ${bodyWidth} !important;
            min-height: ${bodyHeight} !important;
            padding: 6mm !important;
          }
          .print-half-top {
            width: ${bodyWidth} !important;
            max-width: ${bodyWidth} !important;
            min-height: 134.5mm !important;
            max-height: none !important;
            padding: 0 !important;
          }
          .top-half-content {
            height: auto !important;
            min-height: 134.5mm !important;
            max-height: none !important;
            padding: 4mm !important;
            overflow: visible !important;
          }
          .print-thermal {
            width: ${thermalPaperWidth} !important;
            max-width: ${thermalPaperWidth} !important;
            min-height: 0 !important;
            padding: ${settings.thermalWidth === "58mm" ? "2mm" : "3mm 4mm"} !important;
            font-size: 11px !important;
          }
        }
      </style>
    `
  }

  function printableHtml(printDocumentHtml: string) {
    const styleMarkup = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))
      .map((node) => node.outerHTML)
      .join("\n")
    const title = `${invoice.invoiceNumber || "Invoice"} - ${formatLabels[format]}`
    const thermalPaperWidth = settings.thermalWidth === "58mm" ? "58mm" : "80mm"

    return `<!doctype html>
      <html data-print-format="${format}" data-thermal-width="${thermalPaperWidth}">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>${escapeHtml(title)}</title>
          ${styleMarkup}
          ${printWindowOverrides()}
        </head>
        <body>
          <div class="print-document">${printDocumentHtml}</div>
          <script>
            (function () {
              function waitForImages() {
                var images = Array.prototype.slice.call(document.images || []);
                return Promise.all(images.map(function (image) {
                  if (image.complete) return Promise.resolve();
                  return new Promise(function (resolve) {
                    image.addEventListener("load", resolve, { once: true });
                    image.addEventListener("error", resolve, { once: true });
                  });
                }));
              }

              function printWhenReady() {
                var fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready.catch(function () {}) : Promise.resolve();
                Promise.all([waitForImages(), fontsReady]).then(function () {
                  requestAnimationFrame(function () {
                    requestAnimationFrame(function () {
                      updateThermalPageSize();
                      setTimeout(function () {
                        window.focus();
                        window.print();
                      }, 250);
                    });
                  });
                });
              }

              function updateThermalPageSize() {
                if (document.documentElement.dataset.printFormat !== "thermal") return;

                var paperWidth = document.documentElement.dataset.thermalWidth || "80mm";
                var paper = document.querySelector(".invoice-paper") || document.querySelector(".print-document");
                if (!paper) return;

                var probe = document.createElement("div");
                probe.style.position = "absolute";
                probe.style.visibility = "hidden";
                probe.style.pointerEvents = "none";
                probe.style.width = "100mm";
                probe.style.height = "0";
                document.body.appendChild(probe);
                var pxPerMm = probe.getBoundingClientRect().width / 100 || 96 / 25.4;
                probe.remove();

                var rect = paper.getBoundingClientRect();
                var contentHeightPx = Math.max(paper.scrollHeight, rect.height);
                var minHeightMm = paperWidth === "58mm" ? 45 : 55;
                var pageHeightMm = Math.max(minHeightMm, Math.ceil(contentHeightPx / pxPerMm) + 4);
                var style = document.getElementById("dynamic-thermal-page-size");

                if (!style) {
                  style = document.createElement("style");
                  style.id = "dynamic-thermal-page-size";
                  document.head.appendChild(style);
                }

                style.textContent =
                  "@page { size: " + paperWidth + " " + pageHeightMm + "mm; margin: 0; }" +
                  "@page thermal { size: " + paperWidth + " " + pageHeightMm + "mm; margin: 0; }" +
                  "html, body, .print-document { height: auto !important; min-height: 0 !important; }" +
                  ".print-thermal { min-height: 0 !important; }";
              }

              if (document.readyState === "complete") {
                printWhenReady();
              } else {
                window.addEventListener("load", printWhenReady, { once: true });
              }
            })();
          </script>
        </body>
      </html>`
  }

  function printFromHiddenFrame(html: string) {
    const frame = document.createElement("iframe")
    frame.setAttribute("title", "Invoice print")
    frame.style.position = "fixed"
    frame.style.right = "0"
    frame.style.bottom = "0"
    frame.style.width = "0"
    frame.style.height = "0"
    frame.style.border = "0"
    frame.style.opacity = "0"
    frame.style.pointerEvents = "none"

    document.body.appendChild(frame)
    const frameDocument = frame.contentDocument || frame.contentWindow?.document

    if (!frameDocument) {
      frame.remove()
      return false
    }

    frame.contentWindow?.addEventListener("afterprint", () => frame.remove(), { once: true })
    window.setTimeout(() => {
      if (frame.parentNode) frame.remove()
    }, 60000)

    frameDocument.open()
    frameDocument.write(html)
    frameDocument.close()
    return true
  }

  async function prepareCurrentDocumentForPrint() {
    const images = Array.from(document.images)
    await Promise.all(images.map((image) => {
      if (image.complete) return Promise.resolve()
      return new Promise<void>((resolve) => {
        image.addEventListener("load", () => resolve(), { once: true })
        image.addEventListener("error", () => resolve(), { once: true })
      })
    }))
    await document.fonts?.ready?.catch(() => undefined)

    if (format !== "thermal") return
    const paper = document.querySelector<HTMLElement>(".print-preview-stage .invoice-paper")
    if (!paper) return

    const probe = document.createElement("div")
    probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;width:100mm;height:0"
    document.body.appendChild(probe)
    const pixelsPerMm = probe.getBoundingClientRect().width / 100 || 96 / 25.4
    probe.remove()

    const thermalPaperWidth = settings.thermalWidth === "58mm" ? "58mm" : "80mm"
    const minimumHeightMm = thermalPaperWidth === "58mm" ? 45 : 55
    const contentHeight = Math.max(paper.scrollHeight, paper.getBoundingClientRect().height)
    const pageHeightMm = Math.max(minimumHeightMm, Math.ceil(contentHeight / pixelsPerMm) + 4)
    const style = document.createElement("style")
    style.id = "dynamic-thermal-page-size"
    style.textContent =
      `@page { size: ${thermalPaperWidth} ${pageHeightMm}mm; margin: 0; }` +
      "html, body, .print-document { height: auto !important; min-height: 0 !important; }" +
      ".print-thermal { min-height: 0 !important; }"
    document.getElementById(style.id)?.remove()
    document.head.appendChild(style)
  }

  async function printInvoice() {
    document.documentElement.dataset.printFormat = format
    rememberReprint(effectiveInvoice, format)
    setHistory(getReprintHistory().filter((entry) => entry.invoiceId === invoice.id))

    if (await isTauriRuntimeAsync()) {
      setPendingAction("Printing")
      setNotice("")
      try {
        await prepareCurrentDocumentForPrint()
        await invokeTauri<void>("desktop_print_current_webview")
        setNotice("System print dialog opened. Printing does not change the invoice.")
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "The system print dialog could not be opened.")
      } finally {
        setPendingAction("")
      }
      return
    }

    const printDocument = document.querySelector(".print-preview-stage .print-document")

    if (!printDocument) {
      requestAnimationFrame(() => window.print())
      return
    }

    const html = printableHtml(printDocument.innerHTML)
    if (printFromHiddenFrame(html)) {
      setNotice("Print dialog opened using the invoice stored on this device.")
      return
    }

    requestAnimationFrame(() => window.print())
  }

  function resultNotice(action: string, result: { filename: string; path?: string }) {
    return result.path
      ? `${action}: ${result.path}`
      : `${action}: ${result.filename}`
  }

  async function runAction(label: string, action: () => Promise<void>) {
    if (pendingAction) return
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
      setPendingAction("")
    }
  }

  function savePdf() {
    void runAction("Saving PDF", async () => {
      const result = await saveInvoicePdf(effectiveInvoice, settings, format)
      if (!result) return
      setNotice(resultNotice("PDF saved", result))
    })
  }

  function downloadPdf() {
    void runAction("Downloading PDF", async () => {
      const result = await downloadInvoicePdf(effectiveInvoice, settings, format)
      if (!result) return
      setNotice(resultNotice("PDF downloaded", result))
    })
  }

  function sharePdf() {
    void runAction("Sharing PDF", async () => {
      const result = await shareInvoicePdf(effectiveInvoice, settings, format)
      if (!result) return
      setNotice(
        result.shared
          ? "The system share sheet completed."
          : `${resultNotice("Direct file sharing is unavailable, so the PDF was saved", result)}.`
      )
    })
  }

  function prepareInvoiceShare(channel: ShareChannel) {
    void runAction(channel === "whatsapp" ? "Preparing WhatsApp" : "Preparing email", async () => {
      const bytes = await createInvoicePdfBytes(effectiveInvoice, settings, format)
      setShareDialog({
        channel,
        bytes,
        filename: invoicePdfFilename(effectiveInvoice),
        phone: normalizeWhatsAppPhone(invoice.customer.phone) || (invoice.customer.phone === "-" ? "" : invoice.customer.phone),
        email: validateCustomerEmail(invoice.customer.email) || (invoice.customer.email === "-" ? "" : invoice.customer.email),
        expiresInDays: 7,
        busy: false,
        offline: typeof navigator !== "undefined" && !navigator.onLine,
        error: "",
        result: null,
      })
      setNotice("Invoice PDF generated.")
    })
  }

  function emailInvoice() {
    prepareInvoiceShare("email")
  }

  function whatsappInvoice() {
    prepareInvoiceShare("whatsapp")
  }

  function preparedShareInput(dialog: ShareDialogState, secureInvoiceUrl?: string) {
    return {
      customerName: invoice.customer.name,
      customerPhone: dialog.phone,
      customerEmail: dialog.email,
      enterpriseName: invoice.enterprise.name,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      amount: invoice.totals.grandTotal,
      paidAmount: invoice.payment.paidAmount,
      dueAmount: invoice.payment.dueAmount,
      secureInvoiceUrl,
    }
  }

  async function copyPreparedMessage(dialog: ShareDialogState) {
    if (dialog.channel === "email") {
      const draft = createInvoiceEmailDraft(preparedShareInput(dialog, dialog.result?.url))
      await navigator.clipboard.writeText(`Subject: ${draft.subject}\n\n${draft.body}`)
      setNotice("Prepared email message copied.")
      return
    }
    await navigator.clipboard.writeText(createInvoiceShareText(preparedShareInput(dialog, dialog.result?.url)))
    setNotice("Prepared WhatsApp message copied.")
  }

  async function savePreparedPdf(dialog: ShareDialogState) {
    const result = await saveDesktopBytes(dialog.filename, dialog.bytes, "pdf")
    if (result) setNotice(resultNotice("PDF saved", result))
  }

  async function confirmSecureShare() {
    const dialog = shareDialog
    if (!dialog || dialog.busy) return
    const phone = normalizeWhatsAppPhone(dialog.phone)
    const email = validateCustomerEmail(dialog.email)
    if (dialog.channel === "whatsapp" && !phone) {
      setShareDialog({ ...dialog, error: "Enter a valid mobile number with country code.", offline: false })
      return
    }
    if (dialog.channel === "email" && !email) {
      setShareDialog({ ...dialog, error: "Enter a valid customer email address.", offline: false })
      return
    }
    setShareDialog({ ...dialog, phone: phone || dialog.phone, email: email || dialog.email, busy: true, error: "" })
    try {
      const result = await createSecureInvoiceShare({
        organizationId: invoice.enterprise.organizationId,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        customerName: invoice.customer.name,
        filename: dialog.filename,
        pdfBytes: dialog.bytes,
        expiresInDays: dialog.expiresInDays,
      })
      const nextDialog = { ...dialog, phone: phone || dialog.phone, email: email || dialog.email, busy: false, offline: false, error: "", result }
      setShareDialog(nextDialog)
      if (dialog.channel === "whatsapp") {
        const url = createWhatsAppInvoiceUrl(preparedShareInput(nextDialog, result.url))
        if (!url) throw new Error("The WhatsApp number is invalid.")
        await openExternalUrl(url)
        setNotice("Secure invoice link created. WhatsApp opened with the prepared message.")
      } else {
        const draft = createInvoiceEmailDraft(preparedShareInput(nextDialog, result.url))
        await openExternalUrl(draft.mailtoUrl)
        setNotice("Secure invoice link created. The email draft opened in your default email app.")
      }
    } catch (error) {
      const offline = error instanceof InvoiceShareOfflineError
      setShareDialog((current) => current ? {
        ...current,
        busy: false,
        offline,
        error: offline ? "Internet is required to create a mobile invoice link." : error instanceof Error ? error.message : "The secure invoice link could not be created.",
      } : null)
    }
  }

  async function revokeCurrentShare() {
    const dialog = shareDialog
    if (!dialog?.result || dialog.busy) return
    setShareDialog({ ...dialog, busy: true, error: "" })
    try {
      await revokeSecureInvoiceShare(invoice.enterprise.organizationId, dialog.result.id)
      setShareDialog({ ...dialog, busy: false, result: null, error: "" })
      setNotice("Secure invoice link revoked.")
    } catch (error) {
      setShareDialog({ ...dialog, busy: false, error: error instanceof Error ? error.message : "The secure invoice link could not be revoked." })
    }
  }

  useEffect(() => {
    if (requestedShareHandled.current || typeof window === "undefined") return
    const requested = new URLSearchParams(window.location.search).get("share")
    if (requested === "whatsapp") {
      requestedShareHandled.current = true
      queueMicrotask(whatsappInvoice)
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
    if (window.history.length > 1) {
      window.history.back()
      return
    }

    window.location.href = "/dashboard/invoices"
  }

  const template = useMemo(() => ({
    thermal: <ThermalTemplate invoice={effectiveInvoice} settings={settings} />,
    a4: <A4Template invoice={effectiveInvoice} settings={settings} />,
    "half-compact": <HalfCompactTemplate invoice={effectiveInvoice} settings={settings} />,
    "half-top": <HalfTopTemplate invoice={effectiveInvoice} settings={settings} />,
  }[format]), [effectiveInvoice, format, settings])

  return (
    <>
      <PrintEngineStyles format={format} thermalWidth={settings.thermalWidth} />
      <div className={`enterprise-print-shell ${publicMode ? "public-invoice-shell" : ""}`}>
        {!publicMode && <aside className="print-control-panel no-print">
          <div>
            <p className="panel-eyebrow">Enterprise Print Engine</p>
            <h1>{invoice.enterprise.name}</h1>
            <p>{invoice.invoiceNumber}</p>
          </div>

          <section>
            <p className="control-label">Template</p>
            <div className="template-grid">
              {(Object.keys(formatLabels) as PrintFormat[]).map((key) => (
                <button key={key} onClick={() => setFormat(key)} className={format === key ? "active" : ""}>
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
            <textarea
              className="terms-editor"
              value={termsText}
              onChange={(event) => setTermsText(event.target.value)}
              placeholder="Write invoice terms and conditions..."
              rows={5}
            />
          </section>

          {notice && <p className="print-notice">{notice}</p>}

          <section className="action-grid">
            <button onClick={printInvoice} disabled={Boolean(pendingAction)}>Print</button>
            <button onClick={savePdf} disabled={Boolean(pendingAction)}>{pendingAction === "Saving PDF" ? "Saving..." : "Save PDF"}</button>
            <button onClick={downloadPdf} disabled={Boolean(pendingAction)}>{pendingAction === "Downloading PDF" ? "Downloading..." : "Download PDF"}</button>
            <button onClick={sharePdf} disabled={Boolean(pendingAction)}>{pendingAction === "Sharing PDF" ? "Sharing..." : "Share PDF"}</button>
            <button onClick={whatsappInvoice} disabled={Boolean(pendingAction)}>{pendingAction === "Preparing WhatsApp" ? "Preparing..." : "WhatsApp"}</button>
            <button onClick={emailInvoice} disabled={Boolean(pendingAction)}>{pendingAction === "Preparing email" ? "Preparing..." : "Email"}</button>
            <button onClick={queueSharingReminder} disabled={Boolean(pendingAction)}>{pendingAction === "Queueing reminder" ? "Queueing..." : "Queue Share Reminder"}</button>
          </section>

          <section>
            <p className="control-label">Reprint History</p>
            <div className="history-list">
              {history.length === 0 ? <p>No reprints yet.</p> : history.slice(0, 5).map((entry) => (
                <p key={`${entry.printedAt}-${entry.format}`}>{formatLabels[entry.format]} - {new Date(entry.printedAt).toLocaleString()}</p>
              ))}
            </div>
          </section>
        </aside>}

        <main className={`print-preview-stage print-format-${format} font-${settings.fontSize} margin-${settings.margins} ${settings.blackAndWhite ? "bw-mode" : ""}`}>
          {!publicMode && <div className="mobile-toolbar no-print">
            <select className="mobile-format-select" value={format} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
              {(Object.keys(formatLabels) as PrintFormat[]).map((key) => <option key={key} value={key}>{formatLabels[key]}</option>)}
            </select>
            <div className="mobile-action-grid">
              <button onClick={goBack}>Back</button>
              <button onClick={downloadPdf}>Download PDF</button>
              <button onClick={printInvoice}>Print</button>
              <button onClick={whatsappInvoice}>WhatsApp</button>
            </div>
          </div>}
          <div className="preview-scroll">
            <div className="print-document" style={{ transform: publicMode ? undefined : `scale(${zoom})` }}>
              {template}
            </div>
          </div>
        </main>
      </div>
      {shareDialog && (
        <div className="share-modal-backdrop no-print" role="presentation">
          <section className="share-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title">
            <div>
              <p className="panel-eyebrow">{shareDialog.channel === "whatsapp" ? "WhatsApp Invoice" : "Email Invoice"}</p>
              <h2 id="share-dialog-title">Create secure share link</h2>
              <p className="share-modal-helper">Nothing is uploaded until you confirm.</p>
            </div>
            <dl className="share-summary-grid">
              <div><dt>Invoice</dt><dd>{invoice.invoiceNumber}</dd></div>
              <div><dt>Customer</dt><dd>{invoice.customer.name}</dd></div>
              <div><dt>File</dt><dd>{shareDialog.filename}</dd></div>
              <div><dt>Expiry</dt><dd>{shareDialog.expiresInDays} days</dd></div>
            </dl>
            {shareDialog.channel === "whatsapp" ? (
              <label className="share-field">
                <span>Customer phone</span>
                <input
                  value={shareDialog.phone}
                  onChange={(event) => setShareDialog({ ...shareDialog, phone: event.target.value, error: "" })}
                  inputMode="tel"
                  placeholder="9876543210 or country code + number"
                />
              </label>
            ) : (
              <label className="share-field">
                <span>Customer email</span>
                <input
                  value={shareDialog.email}
                  onChange={(event) => setShareDialog({ ...shareDialog, email: event.target.value, error: "" })}
                  inputMode="email"
                  placeholder="customer@example.com"
                />
              </label>
            )}
            <label className="share-field">
              <span>Link expiry</span>
              <select
                value={shareDialog.expiresInDays}
                onChange={(event) => setShareDialog({ ...shareDialog, expiresInDays: Number(event.target.value) as 7 | 30 })}
              >
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
              </select>
            </label>
            {shareDialog.result && (
              <div className="share-link-result">
                <strong>Secure invoice link created.</strong>
                <span>{shareDialog.result.url}</span>
                <small>Expires {new Date(shareDialog.result.expiresAt).toLocaleString("en-IN")}</small>
              </div>
            )}
            {(shareDialog.error || shareDialog.offline) && (
              <div className="share-offline-box">
                <strong>{shareDialog.error || "Internet is required to create a mobile invoice link."}</strong>
                {shareDialog.offline && <p>The PDF remains on this device unless you choose Save PDF.</p>}
              </div>
            )}
            <div className="share-modal-actions">
              {!shareDialog.result && (
                <button type="button" className="primary" onClick={() => void confirmSecureShare()} disabled={shareDialog.busy}>
                  {shareDialog.busy ? "Creating..." : shareDialog.offline ? "Try again" : "Create secure share link"}
                </button>
              )}
              {shareDialog.offline && (
                <>
                  <button type="button" onClick={() => void savePreparedPdf(shareDialog)} disabled={shareDialog.busy}>Save PDF</button>
                  <button type="button" onClick={() => void copyPreparedMessage(shareDialog)} disabled={shareDialog.busy}>
                    {shareDialog.channel === "email" ? "Copy Email Message" : "Copy prepared message"}
                  </button>
                </>
              )}
              {shareDialog.result && (
                <>
                  <button type="button" onClick={() => void copyPreparedMessage(shareDialog)} disabled={shareDialog.busy}>Copy link message</button>
                  <button type="button" className="danger" onClick={() => void revokeCurrentShare()} disabled={shareDialog.busy}>
                    {shareDialog.busy ? "Revoking..." : "Revoke link"}
                  </button>
                </>
              )}
              <button type="button" onClick={() => setShareDialog(null)} disabled={shareDialog.busy}>
                {shareDialog.result ? "Close" : "Cancel"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  )
}

function PrintEngineStyles({ format, thermalWidth }: { format: PrintFormat; thermalWidth: PrintSettings["thermalWidth"] }) {
  const thermalPaperWidth = thermalWidth === "58mm" ? "58mm" : "80mm"
  const printPageSize =
    format === "thermal"
      ? `${thermalPaperWidth} 160mm`
      : format === "half-top"
        ? "210mm 148.5mm"
        : format === "half-compact"
          ? "A5 portrait"
          : "A4 portrait"
  const printSafeMargin = format === "thermal" ? "0" : "7mm"
  const printPaperWidth = format === "thermal" ? thermalPaperWidth : format === "half-compact" ? "134mm" : "196mm"
  const printPaperHeight = format === "half-top" ? "134.5mm" : format === "half-compact" ? "196mm" : format === "thermal" ? "auto" : "283mm"

  return (
    <style jsx global>{`
      @page { size: A4 portrait; margin: 7mm; }
      @page half-compact { size: A5 portrait; margin: 7mm; }
      @page half-top { size: 210mm 148.5mm; margin: 7mm; }
      @page thermal { size: ${thermalPaperWidth} 160mm; margin: 0; }
      html[data-print-format="thermal"] { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .enterprise-print-shell { height: 100%; min-height: 0; min-width: 0; overflow: hidden; display: grid; grid-template-columns: 320px minmax(0, 1fr); background: #0a0d12; color: #f8fafc; }
      .print-control-panel { height: 100%; min-height: 0; overflow-y: auto; overscroll-behavior: contain; border-right: 1px solid rgba(255,255,255,.1); background: #070b12; padding: 22px; display: flex; flex-direction: column; gap: 20px; }
      .panel-eyebrow, .control-label, .print-eyebrow { color: #0891b2; font-size: 10px; font-weight: 900; letter-spacing: .18em; text-transform: uppercase; }
      .print-control-panel h1 { margin: 8px 0 2px; font-size: 24px; font-weight: 900; }
      .template-grid, .action-grid { display: grid; gap: 8px; }
      .template-grid button, .action-grid button, .print-control-panel select, .mobile-toolbar select, .mobile-toolbar button { min-height: 42px; border-radius: 12px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: #fff; padding: 0 12px; font-weight: 800; }
      .template-grid button.active, .action-grid button:first-child { background: #fff; color: #020617; }
      .action-grid button:disabled, .mobile-toolbar button:disabled { cursor: wait; opacity: .55; }
      .terms-editor { width: 100%; min-height: 118px; resize: vertical; border-radius: 12px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: #fff; padding: 12px; font: inherit; font-size: 13px; line-height: 1.45; outline: none; }
      .terms-editor:focus { border-color: rgba(34,211,238,.55); box-shadow: 0 0 0 3px rgba(34,211,238,.12); }
      .toggle-row { display: flex; justify-content: space-between; gap: 14px; align-items: center; min-height: 36px; font-size: 13px; color: #cbd5e1; }
      .print-notice { border: 1px solid rgba(251,191,36,.35); color: #fde68a; background: rgba(251,191,36,.1); border-radius: 12px; padding: 10px; font-size: 13px; }
      .history-list { color: #94a3b8; font-size: 12px; display: grid; gap: 7px; }
      .print-preview-stage { min-width: 0; min-height: 0; overflow: hidden; background: radial-gradient(circle at top left, rgba(34,211,238,.08), transparent 32%), #111827; }
      .mobile-toolbar { display: none; gap: 10px; padding: 12px; position: sticky; top: 0; z-index: 10; background: #070b12; border-bottom: 1px solid rgba(255,255,255,.1); }
      .mobile-format-select { width: 100%; min-width: 0; }
      .mobile-action-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      .preview-scroll { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 32px; display: flex; justify-content: center; align-items: flex-start; background: #111827; }
      .print-format-thermal .preview-scroll { background: #111827; justify-content: center; }
      .print-document { transform-origin: top center; transition: transform .18s ease; }
      .invoice-paper, .invoice-paper * { box-sizing: border-box; }
      .invoice-paper { position: relative; overflow: visible; background: #fff; color: #111827; font-family: Arial, Helvetica, sans-serif; box-shadow: 0 24px 90px rgba(0,0,0,.35); print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .public-invoice-shell { display: block; height: auto; min-height: 100dvh; overflow: visible; background: #f8fafc; color: #111827; }
      .public-invoice-shell .print-preview-stage { min-height: 100dvh; background: #f8fafc; }
      .public-invoice-shell .preview-scroll { height: auto; min-height: 100dvh; overflow: visible; padding: clamp(10px, 3vw, 28px); background: #f8fafc; align-items: flex-start; }
      .public-invoice-shell .print-document { width: min(100%, 210mm); transform: none !important; transition: none; }
      .public-invoice-shell .invoice-paper { width: 100%; max-width: 210mm; min-height: auto; margin: 0 auto; box-shadow: 0 14px 40px rgba(15,23,42,.12); }
      .print-a4 { width: 210mm; min-height: 297mm; padding: 10mm; display: flex; flex-direction: column; }
      .print-half-compact { page: half-compact; width: 148mm; min-height: 210mm; padding: 7mm; margin: 0 auto; display: flex; flex-direction: column; }
      .print-half-top { page: half-top; width: 210mm; min-height: 148.5mm; padding: 0; }
      .top-half-content { min-height: 148.5mm; overflow: visible; border: 1px solid #0f172a; padding: 5mm; background: #fff; display: flex; flex-direction: column; }
      .manual-notes-space { display: none; }
      .print-thermal { page: thermal; width: 80mm; min-height: auto; padding: 3mm 4mm; font-family: "Courier New", monospace; box-shadow: 0 20px 70px rgba(0,0,0,.28); background: #fff; color: #000; }
      .thermal-58 { width: 58mm; padding: 2mm; }
      .thermal-80, .thermal-auto { width: 80mm; }
      .print-header-block { display: grid; grid-template-columns: 1.45fr .75fr; gap: 12px; border-bottom: 2px solid #111827; padding-bottom: 10px; }
      .brand-block { display: flex; gap: 12px; min-width: 0; }
      .brand-logo { width: 46px; height: 46px; flex: none; border-radius: 10px; background: #e0f2fe; display: grid; place-items: center; font-weight: 900; color: #075985; overflow: hidden; }
      .brand-logo img { width: 100%; height: 100%; object-fit: contain; }
      .brand-block h1 { margin: 3px 0; font-size: 24px; line-height: 1; font-weight: 900; overflow-wrap: anywhere; }
      .brand-block p, .invoice-meta-card p, .info-card p, .terms-card p { margin: 2px 0; color: #475569; font-size: 10px; line-height: 1.35; }
      .invoice-meta-card, .info-card, .terms-card, .total-card { border: 1px solid #dbe3ee; background: #f8fafc; border-radius: 10px; padding: 8px; }
      .invoice-meta-card h2 { margin: 4px 0; color: #1d4ed8; font-size: 16px; line-height: 1.1; word-break: break-word; }
      .customer-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
      .info-card h3 { margin: 3px 0; font-size: 13px; }
      .item-table { width: 100%; max-width: 100%; margin-top: 9px; border-collapse: collapse; table-layout: fixed; page-break-inside: auto; }
      .item-table .col-sr { width: 5%; }
      .item-table .col-item { width: 17%; }
      .item-table .col-batch, .item-table .col-expiry, .item-table .col-hsn { width: 7%; }
      .item-table .col-qty, .item-table .col-free, .item-table .col-unit { width: 6%; }
      .item-table .col-mrp, .item-table .col-rate, .item-table .col-discAmount, .item-table .col-taxable { width: 8%; }
      .item-table .col-disc { width: 6%; }
      .item-table .col-cgst, .item-table .col-sgst, .item-table .col-igst { width: 7%; }
      .item-table .col-amount { width: 9%; }
      .item-table thead { display: table-header-group; }
      .item-table tr { page-break-inside: avoid; break-inside: avoid; }
      .item-table th { position: sticky; top: 0; background: #0f172a; color: #fff; font-size: 6.7px; letter-spacing: .03em; text-transform: uppercase; padding: 4px 3px; text-align: left; overflow-wrap: anywhere; word-break: break-word; }
      .item-table td { border: 1px solid #e2e8f0; padding: 4px 3px; font-size: 7.2px; line-height: 1.22; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
      .item-table .wrap { max-width: none; white-space: normal; word-break: break-word; overflow-wrap: anywhere; }
      .item-table .wrap span { display: block; color: #64748b; font-weight: 400; }
      .item-table.compact th, .item-table.compact td { padding: 2.5px; font-size: 6.4px; line-height: 1.15; }
      .mobile-item-cards { display: none; }
      .mobile-item-card { border: 1px solid #dbe3ee; border-radius: 14px; background: #fff; overflow: hidden; box-shadow: 0 8px 22px rgba(15,23,42,.06); }
      .mobile-item-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: start; background: #0f172a; color: #fff; padding: 12px; }
      .mobile-item-head span { color: #bae6fd; font-size: 11px; font-weight: 900; }
      .mobile-item-head strong { min-width: 0; font-size: 15px; line-height: 1.25; overflow-wrap: anywhere; }
      .mobile-item-head b { white-space: nowrap; color: #fff; font-size: 14px; }
      .mobile-item-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .mobile-item-facts div { min-width: 0; border-top: 1px solid #e5edf5; padding: 10px 12px; }
      .mobile-item-facts span { display: block; color: #64748b; font-size: 10px; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; }
      .mobile-item-facts strong { display: block; margin-top: 3px; color: #0f172a; font-size: 13px; overflow-wrap: anywhere; }
      .total-grid { display: grid; grid-template-columns: 1fr 64mm; gap: 8px; margin-top: 8px; }
      .total-card div { display: flex; justify-content: space-between; gap: 10px; font-size: 10px; line-height: 1.6; }
      .grand-total { margin-top: 5px; border-top: 1px solid #cbd5e1; padding-top: 6px; font-size: 15px !important; color: #1d4ed8; font-weight: 900; }
      .amount-words { margin-top: 8px !important; font-weight: 800; color: #0f172a !important; }
      .payment-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; margin-top: 8px; }
      .payment-grid div { border: 1px solid #dbe3ee; border-radius: 8px; padding: 6px; background: #fff; }
      .payment-grid span { display: block; color: #64748b; font-size: 8px; }
      .payment-grid strong { font-size: 10px; }
      .footer-row { display: flex; justify-content: space-between; gap: 12px; align-items: flex-end; margin-top: 9px; break-inside: avoid; page-break-inside: avoid; }
      .generated-by-footer { margin-top: auto; border-top: 1px dashed #cbd5e1; padding: 8px 0 5px; text-align: center; color: #64748b; font-size: 8px; letter-spacing: .02em; break-inside: avoid; page-break-inside: avoid; }
      .generated-by-footer strong, .generated-by-footer span { display: block; }
      .generated-by-footer strong { color: #111827; font-size: 10px; font-weight: 900; letter-spacing: .03em; }
      .generated-by-footer span { margin-top: 2px; font-weight: 500; }
      .generated-by-footer.compact { padding-top: 6px; font-size: 8px; }
      .codes-block { display: flex; gap: 16px; align-items: flex-end; max-width: 100%; overflow: visible; }
      .invoice-code { min-width: 0; margin: 0; display: grid; justify-items: center; gap: 4px; break-inside: avoid; page-break-inside: avoid; }
      .invoice-code svg { display: block; max-width: 100%; height: auto; color: #000; background: #fff; }
      .invoice-code figcaption { color: #475569; font-size: 7.5px; font-weight: 800; letter-spacing: .04em; text-align: center; }
      .invoice-barcode { width: 165px; }
      .invoice-qr { width: 68px; }
      .signature-grid { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
      .signature-grid div { height: 34px; border-bottom: 1px solid #64748b; display: flex; align-items: flex-end; justify-content: center; color: #64748b; font-size: 9px; }
      .page-number { position: absolute; bottom: 6mm; right: 12mm; color: #64748b; font-size: 9px; }
      .watermark { position: absolute; inset: 0; display: grid; place-items: center; font-size: 64px; font-weight: 900; color: rgba(15,23,42,.05); transform: rotate(-28deg); pointer-events: none; }
      .print-a4 .print-header-block { gap: 16px; padding-bottom: 12px; }
      .print-a4 .brand-block h1 { font-size: 31px; }
      .print-a4 .brand-block p, .print-a4 .invoice-meta-card p, .print-a4 .info-card p, .print-a4 .terms-card p { font-size: 11.5px; }
      .print-a4 .invoice-meta-card h2 { font-size: 20px; }
      .print-a4 .info-card h3 { font-size: 15px; }
      .print-a4 .item-table { margin-top: 12px; }
      .print-a4 .item-table th { font-size: 7.5px; padding: 5px 4px; }
      .print-a4 .item-table td { font-size: 8.5px; padding: 5px 4px; }
      .print-a4 .total-grid { margin-top: 12px; grid-template-columns: 1fr 62mm; }
      .print-a4 .total-card div { font-size: 11.5px; }
      .print-a4 .grand-total { font-size: 18px !important; }
      .print-a4 .payment-grid { margin-top: 12px; }
      .print-a4 .payment-grid span { font-size: 9.5px; }
      .print-a4 .payment-grid strong { font-size: 12px; }
      .print-a4 .terms-card { min-height: 82mm; }
      .print-half-compact .print-header-block,
      .print-half-compact .customer-grid,
      .print-half-compact .total-grid,
      .print-half-compact .payment-grid { grid-template-columns: 1fr; }
      .print-half-compact .print-header-block { gap: 8px; }
      .print-half-compact .brand-block h1 { font-size: 25px; }
      .print-half-compact .brand-block p,
      .print-half-compact .invoice-meta-card p,
      .print-half-compact .info-card p { font-size: 10.5px; }
      .print-half-compact .terms-card p { font-size: 10px; }
      .print-half-compact .info-card h3 { font-size: 14px; }
      .print-half-compact .invoice-meta-card h2 { font-size: 17px; }
      .print-half-compact .item-table { margin-top: 8px; }
      .print-half-compact .item-table th,
      .print-half-compact .item-table td { font-size: 7.8px; padding: 3.5px 2.5px; line-height: 1.22; }
      .print-half-compact .item-table .col-item { width: 22%; }
      .print-half-compact .item-table .col-sr { width: 5%; }
      .print-half-compact .item-table .col-amount { width: 12%; }
      .print-half-compact .total-card div { font-size: 11px; }
      .print-half-compact .grand-total { font-size: 16px !important; }
      .print-half-compact .payment-grid { gap: 6px; }
      .print-half-compact .payment-grid div { padding: 7px; }
      .print-half-compact .payment-grid span { font-size: 9px; }
      .print-half-compact .payment-grid strong { font-size: 11px; }
      .print-half-compact .footer-row { flex-direction: column; align-items: stretch; }
      .print-half-compact .signature-grid { grid-template-columns: 1fr; }
      .half-top-header { display: grid; grid-template-columns: minmax(0, 1fr) 64mm; gap: 8mm; border-bottom: 2px solid #0f172a; padding-bottom: 4mm; }
      .half-top-brand { display: flex; align-items: flex-start; gap: 3mm; min-width: 0; }
      .half-top-brand-logo { width: 11mm; height: 11mm; border-radius: 2.5mm; font-size: 16px; }
      .half-top-header h1 { margin: 1mm 0; font-size: 22px; line-height: 1.05; font-weight: 900; color: #0f172a; overflow-wrap: anywhere; }
      .half-top-header p { margin: 1mm 0; font-size: 9.5px; line-height: 1.25; color: #475569; overflow-wrap: anywhere; }
      .half-top-meta { border: 1px solid #dbe3ee; border-radius: 8px; background: #f8fafc; padding: 3mm; display: grid; gap: 1mm; }
      .half-top-meta strong { color: #1d4ed8; font-size: 15px; line-height: 1.12; overflow-wrap: anywhere; }
      .half-top-meta span { color: #334155; font-size: 9.5px; }
      .half-top-customer { display: grid; grid-template-columns: 64mm minmax(0, 1fr); gap: 3mm; margin-top: 3mm; }
      .half-top-customer div { border: 1px solid #dbe3ee; border-radius: 8px; background: #f8fafc; padding: 2.7mm; min-width: 0; }
      .half-top-customer span, .half-top-words span { display: block; color: #64748b; font-size: 8px; font-weight: 900; letter-spacing: .13em; text-transform: uppercase; }
      .half-top-customer strong { display: block; margin-top: 1mm; color: #0f172a; font-size: 13px; }
      .half-top-customer p { margin: 1mm 0 0; color: #475569; font-size: 9.5px; line-height: 1.25; overflow-wrap: anywhere; }
      .half-top-items { width: 100%; margin-top: 3mm; border-collapse: collapse; table-layout: fixed; }
      .half-top-items th { background: #0f172a; color: #fff; padding: 2mm 1.6mm; font-size: 8px; text-align: left; text-transform: uppercase; }
      .half-top-items td { border: 1px solid #dbe3ee; padding: 2mm 1.6mm; color: #0f172a; font-size: 9.2px; line-height: 1.2; vertical-align: top; overflow-wrap: anywhere; }
      .half-top-items th:first-child, .half-top-items td:first-child { width: 42%; }
      .half-top-items th:last-child, .half-top-items td:last-child { text-align: right; width: 20%; }
      .half-top-summary { display: grid; grid-template-columns: minmax(0, 1fr) 56mm; gap: 3mm; margin-top: 3mm; }
      .half-top-words, .half-top-totals { border: 1px solid #dbe3ee; border-radius: 8px; background: #f8fafc; padding: 3mm; min-width: 0; }
      .half-top-words strong { display: block; margin-top: 2mm; color: #0f172a; font-size: 11px; line-height: 1.25; }
      .half-top-totals p { display: flex; justify-content: space-between; gap: 4mm; margin: 0; color: #334155; font-size: 10px; line-height: 1.55; }
      .half-top-totals strong { color: #0f172a; }
      .half-top-grand { margin-top: 1mm !important; border-top: 1px solid #cbd5e1; padding-top: 1.8mm; color: #1d4ed8 !important; font-size: 15px !important; font-weight: 900; }
      .half-top-reference { display: flex; align-items: flex-end; gap: 4mm; margin-top: 2.5mm; break-inside: avoid; page-break-inside: avoid; }
      .half-top-reference .codes-block { flex: none; gap: 3mm; }
      .half-top-reference .invoice-barcode { width: 34mm; }
      .half-top-reference .invoice-qr { width: 15mm; }
      .half-top-reference .invoice-qr svg { width: 14mm; height: 14mm; }
      .half-top-reference .signature-grid { flex: 1; }
      .half-top-generated-footer { margin-top: auto; padding-top: 2mm; font-size: 8px; }
      .font-small .invoice-paper { font-size: 92%; }
      .font-large .invoice-paper { font-size: 108%; }
      .margin-compact .print-a4 { padding: 5mm; }
      .margin-wide .print-a4 { padding: 9mm; }
      .bw-mode .invoice-paper, .bw-mode .invoice-paper * { color: #000 !important; background-color: #fff !important; border-color: #000 !important; }
      .thermal-center { text-align: center; }
      .thermal-brand-logo { width: 36px; height: 36px; margin: 0 auto 5px; border: 1px solid #bae6fd; border-radius: 8px; font-family: Arial, Helvetica, sans-serif; font-size: 17px; }
      .print-thermal h1 { margin: 0 0 4px; font-size: 17px; line-height: 1.15; }
      .print-thermal p, .print-thermal td, .print-thermal th, .print-thermal span, .print-thermal strong { font-size: 11px; line-height: 1.28; }
      .thermal-58 p, .thermal-58 td, .thermal-58 th, .thermal-58 span, .thermal-58 strong { font-size: 9.5px; }
      .thermal-rule { border-top: 1px dashed #000; margin: 6px 0; }
      .thermal-row, .thermal-total { display: flex; justify-content: space-between; gap: 6px; }
      .thermal-row span, .thermal-row strong, .thermal-total span, .thermal-total strong { overflow-wrap: anywhere; }
      .thermal-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
      .thermal-table th:nth-child(1), .thermal-table td:nth-child(1) { width: 48%; }
      .thermal-table th:nth-child(2), .thermal-table td:nth-child(2) { width: 13%; }
      .thermal-table th:nth-child(3), .thermal-table td:nth-child(3) { width: 16%; }
      .thermal-table th:last-child, .thermal-table td:last-child { width: 23%; text-align: right; }
      .thermal-table th, .thermal-table td { border-bottom: 1px dotted #999; padding: 4px 2px; text-align: left; overflow-wrap: anywhere; word-break: break-word; }
      .thermal-total { border-top: 1px solid #000; margin-top: 6px; padding-top: 6px; font-size: 13px; font-weight: 900; }
      .thermal-codes { display: grid; justify-items: center; gap: 10px; padding: 4px 0 2px; }
      .thermal-codes figure { width: 100%; min-width: 0; margin: 0; display: grid; justify-items: center; gap: 4px; break-inside: avoid; page-break-inside: avoid; }
      .thermal-codes svg { display: block; max-width: 100%; height: auto; color: #000; background: #fff; }
      .thermal-barcode svg { width: 100%; max-height: 46px; }
      .thermal-codes figcaption { max-width: 100%; color: #111827; font-size: 8px !important; font-weight: 900; letter-spacing: .06em; text-align: center; overflow-wrap: anywhere; }
      .thermal-qr svg { width: 58px; height: 58px; }
      .thermal-generated-footer { margin-top: 9px; border-top: 1px dashed #000; border-bottom: 1px dashed #000; padding: 7px 0; text-align: center; color: #475569; font-size: 8px; font-weight: 500; letter-spacing: .02em; break-inside: avoid; page-break-inside: avoid; }
      .thermal-generated-footer span, .thermal-generated-footer strong { display: block; }
      .thermal-generated-footer strong { color: #111827; font-size: 10px; font-weight: 900; }
      .thermal-generated-footer span { margin-top: 2px; color: #64748b; font-size: 8px; }
      .print-thermal svg { max-width: 100%; height: auto; }
      .share-modal-backdrop { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; overflow-y: auto; padding: 20px; background: rgba(2,6,23,.78); backdrop-filter: blur(12px); }
      .share-confirm-modal { width: min(100%, 560px); border: 1px solid rgba(255,255,255,.14); border-radius: 24px; background: #080d16; color: #f8fafc; padding: 24px; box-shadow: 0 30px 100px rgba(0,0,0,.55); display: grid; gap: 18px; }
      .share-confirm-modal h2 { margin: 6px 0 0; font-size: 25px; font-weight: 900; }
      .share-modal-helper { margin-top: 5px; color: #94a3b8; font-size: 13px; }
      .share-summary-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; margin: 0; }
      .share-summary-grid div { min-width: 0; border: 1px solid rgba(255,255,255,.09); border-radius: 14px; background: rgba(255,255,255,.04); padding: 11px; }
      .share-summary-grid dt { color: #94a3b8; font-size: 10px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
      .share-summary-grid dd { margin: 4px 0 0; overflow-wrap: anywhere; font-size: 13px; font-weight: 800; }
      .share-field { display: grid; gap: 7px; color: #cbd5e1; font-size: 12px; font-weight: 800; }
      .share-field input, .share-field select { width: 100%; min-height: 45px; border: 1px solid rgba(255,255,255,.12); border-radius: 12px; background: rgba(255,255,255,.06); color: #fff; padding: 0 12px; outline: none; }
      .share-field input:focus, .share-field select:focus { border-color: rgba(34,211,238,.6); box-shadow: 0 0 0 3px rgba(34,211,238,.1); }
      .share-offline-box, .share-link-result { border: 1px solid rgba(251,191,36,.25); border-radius: 14px; background: rgba(251,191,36,.08); color: #fde68a; padding: 12px; font-size: 12px; line-height: 1.5; }
      .share-offline-box p { margin: 4px 0 0; color: #fef3c7; }
      .share-link-result { border-color: rgba(52,211,153,.28); background: rgba(16,185,129,.09); color: #d1fae5; display: grid; gap: 5px; }
      .share-link-result span { overflow-wrap: anywhere; color: #a7f3d0; }
      .share-link-result small { color: #6ee7b7; }
      .share-modal-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 9px; }
      .share-modal-actions button { min-height: 42px; border: 1px solid rgba(255,255,255,.12); border-radius: 12px; background: rgba(255,255,255,.06); color: #fff; padding: 0 14px; font-size: 12px; font-weight: 900; }
      .share-modal-actions button.primary { border-color: transparent; background: #fff; color: #020617; }
      .share-modal-actions button.danger { border-color: rgba(248,113,113,.3); background: rgba(239,68,68,.12); color: #fecaca; }
      .share-modal-actions button:disabled { cursor: wait; opacity: .55; }
      @media (max-width: 900px) {
        .enterprise-print-shell { grid-template-columns: 1fr; }
        .print-control-panel { display: none; }
        .mobile-toolbar { display: grid; grid-template-columns: 1fr; }
        .mobile-toolbar button { min-height: 44px; padding: 0 10px; font-size: 12px; white-space: normal; }
        .preview-scroll { height: calc(100% - 156px); overflow-x: auto; padding: 12px; justify-content: center; }
        .print-preview-stage:not(.print-format-thermal) .print-document { width: min(100%, 210mm); transform: none !important; transition: none; }
        .print-preview-stage:not(.print-format-thermal) .invoice-paper { width: 100%; max-width: 210mm; min-height: auto; margin: 0 auto; }
        .print-preview-stage .print-a4,
        .print-preview-stage .print-half-compact,
        .print-preview-stage .print-half-top { width: 100% !important; min-height: auto; padding: 14px !important; }
        .print-preview-stage .top-half-content { height: auto; min-height: auto; max-height: none; }
        .print-preview-stage .print-header-block,
        .print-preview-stage .customer-grid,
        .print-preview-stage .total-grid,
        .print-preview-stage .payment-grid { grid-template-columns: 1fr !important; }
        .print-preview-stage .brand-block h1 { font-size: 24px; }
        .print-preview-stage .invoice-meta-card h2 { font-size: 18px; }
        .print-preview-stage .item-table { display: none !important; }
        .print-preview-stage .mobile-item-cards { display: grid; gap: 10px; margin-top: 14px; }
        .public-invoice-shell .preview-scroll { height: auto; min-height: 100dvh; padding: 10px; justify-content: center; background: #f8fafc; }
        .public-invoice-shell .print-document { width: 100%; }
        .public-invoice-shell .print-a4 { width: 100% !important; min-height: auto; padding: 14px !important; }
        .public-invoice-shell .print-header-block,
        .public-invoice-shell .customer-grid,
        .public-invoice-shell .total-grid,
        .public-invoice-shell .payment-grid { grid-template-columns: 1fr !important; }
        .public-invoice-shell .brand-block h1 { font-size: 24px; }
        .public-invoice-shell .invoice-meta-card h2 { font-size: 18px; }
        .public-invoice-shell .item-table { display: none !important; }
        .public-invoice-shell .mobile-item-cards { display: grid; gap: 10px; margin-top: 14px; }
        .public-invoice-shell .item-table,
        .public-invoice-shell .item-table colgroup,
        .public-invoice-shell .item-table tbody,
        .public-invoice-shell .item-table tr,
        .public-invoice-shell .item-table td { display: block; width: 100%; }
        .public-invoice-shell .item-table { margin-top: 14px; border-collapse: separate; border-spacing: 0; }
        .public-invoice-shell .item-table thead { display: none; }
        .public-invoice-shell .item-table tr {
          border: 1px solid #dbe3ee;
          border-radius: 14px;
          background: #fff;
          overflow: hidden;
          box-shadow: 0 8px 22px rgba(15,23,42,.06);
        }
        .public-invoice-shell .item-table tr + tr { margin-top: 10px; }
        .public-invoice-shell .item-table td {
          min-height: 34px;
          display: grid;
          grid-template-columns: minmax(92px, 38%) minmax(0, 1fr);
          align-items: start;
          gap: 12px;
          border: 0;
          border-bottom: 1px solid #e5edf5;
          padding: 9px 12px;
          font-size: 13px;
          line-height: 1.35;
          text-align: right;
          word-break: normal;
          overflow-wrap: anywhere;
        }
        .public-invoice-shell .item-table td:last-child { border-bottom: 0; background: #f8fafc; font-size: 15px; }
        .public-invoice-shell .item-table td::before {
          content: attr(data-label);
          color: #475569;
          font-size: 11px;
          font-weight: 900;
          letter-spacing: .08em;
          text-align: left;
          text-transform: uppercase;
        }
        .public-invoice-shell .item-table td.wrap {
          grid-template-columns: 1fr;
          text-align: left;
          background: #0f172a;
          color: #fff;
          font-size: 15px;
          font-weight: 900;
        }
        .public-invoice-shell .item-table td.wrap::before { color: #bae6fd; }
        .public-invoice-shell .item-table td.wrap strong { color: #fff; }
        .public-invoice-shell .item-table td[data-label="Sr"],
        .public-invoice-shell .item-table td[data-label="Free"],
        .public-invoice-shell .item-table td[data-label="Unit"],
        .public-invoice-shell .item-table td[data-label="MRP"],
        .public-invoice-shell .item-table td[data-label="Discount %"],
        .public-invoice-shell .item-table td[data-label="Discount"],
        .public-invoice-shell .item-table td[data-label="Taxable"],
        .public-invoice-shell .item-table td[data-label="CGST"],
        .public-invoice-shell .item-table td[data-label="SGST"],
        .public-invoice-shell .item-table td[data-label="IGST"] { display: none; }
        .public-invoice-shell .item-table td[data-label="Qty"],
        .public-invoice-shell .item-table td[data-label="Rate"],
        .public-invoice-shell .item-table td[data-label="Amount"] { display: grid; }
        .public-invoice-shell .terms-card { min-height: 0; }
        .public-invoice-shell .payment-grid div { padding: 8px; }
        .share-summary-grid { grid-template-columns: 1fr; }
        .share-modal-actions { display: grid; grid-template-columns: 1fr; }
      }
      @media print {
        @page { size: ${printPageSize}; margin: ${printSafeMargin}; }
        @page half-compact { size: A5 portrait; margin: 7mm; }
        @page half-top { size: 210mm 148.5mm; margin: 7mm; }
        @page thermal { size: ${printPageSize}; margin: 0; }
        html, body { width: ${printPaperWidth} !important; max-width: ${printPaperWidth} !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; background: #fff !important; color: #000 !important; }
        body * { visibility: hidden !important; }
        .print-document, .print-document *, .invoice-paper, .invoice-paper * { visibility: visible !important; }
        .no-print { display: none !important; }
        .enterprise-print-shell, .print-preview-stage, .preview-scroll { position: static !important; display: block !important; width: ${printPaperWidth} !important; max-width: ${printPaperWidth} !important; min-width: 0 !important; height: auto !important; min-height: 0 !important; overflow: visible !important; padding: 0 !important; margin: 0 !important; background: #fff !important; color: #000 !important; transform: none !important; }
        .print-document { position: absolute !important; top: 0 !important; left: 0 !important; display: block !important; width: ${printPaperWidth} !important; max-width: ${printPaperWidth} !important; min-width: 0 !important; height: ${printPaperHeight} !important; min-height: 0 !important; overflow: visible !important; padding: 0 !important; margin: 0 !important; background: #fff !important; color: #000 !important; transform: none !important; transition: none !important; }
        .invoice-paper { box-shadow: none !important; margin: 0 !important; overflow: visible !important; background: #fff !important; color: #000 !important; break-inside: auto; page-break-inside: auto; }
        .print-a4 { page: auto !important; width: 196mm !important; max-width: 196mm !important; min-height: 283mm !important; padding: 6mm !important; }
        .print-a4 .total-grid { grid-template-columns: minmax(0, 1fr) 62mm !important; }
        .print-a4 .payment-grid { grid-template-columns: repeat(4, minmax(0, 1fr)) !important; }
        .print-half-compact { page: half-compact !important; width: 134mm !important; max-width: 134mm !important; min-height: 196mm !important; padding: 5mm !important; margin: 0 !important; }
        .print-half-compact .brand-block h1 { font-size: 24px !important; }
        .print-half-compact .invoice-meta-card h2 { font-size: 16px !important; }
        .print-half-compact .print-header-block,
        .print-half-compact .customer-grid,
        .print-half-compact .total-grid,
        .print-half-compact .payment-grid { grid-template-columns: 1fr !important; }
        .print-half-compact .item-table th,
        .print-half-compact .item-table td { font-size: 7.8px !important; padding: 3px 2px !important; }
        .print-half-top { page: half-top !important; width: 196mm !important; max-width: 196mm !important; min-height: 134.5mm !important; max-height: none !important; padding: 0 !important; margin: 0 !important; }
        .top-half-content { height: auto !important; min-height: 134.5mm !important; max-height: none !important; overflow: visible !important; padding: 4mm !important; background: #fff !important; display: flex !important; flex-direction: column !important; }
        .manual-notes-space { display: none !important; }
        .print-header-block, .customer-grid, .total-grid, .payment-grid, .footer-row, .generated-by-footer, .thermal-generated-footer, .codes-block, .signature-grid, .info-card, .invoice-meta-card, .terms-card, .total-card { break-inside: avoid !important; page-break-inside: avoid !important; }
        .item-table { width: 100% !important; max-width: 100% !important; table-layout: fixed !important; page-break-inside: auto !important; }
        .mobile-item-cards { display: none !important; }
        .item-table tr { break-inside: avoid !important; page-break-inside: avoid !important; }
        .item-table th { position: static !important; }
        html[data-print-format="thermal"], html[data-print-format="thermal"] body { width: ${thermalPaperWidth} !important; max-width: ${thermalPaperWidth} !important; height: auto !important; min-height: 0 !important; background: #fff !important; }
        html[data-print-format="thermal"] .invoice-paper { page: thermal !important; width: ${thermalPaperWidth} !important; max-width: ${thermalPaperWidth} !important; min-height: 0 !important; margin: 0 !important; padding: ${thermalWidth === "58mm" ? "2mm" : "3mm 4mm"} !important; box-shadow: none !important; background: #fff !important; color: #000 !important; }
        html[data-print-format="thermal"] .enterprise-print-shell,
        html[data-print-format="thermal"] .print-preview-stage,
        html[data-print-format="thermal"] .preview-scroll,
        html[data-print-format="thermal"] .print-document { width: ${thermalPaperWidth} !important; max-width: ${thermalPaperWidth} !important; height: auto !important; min-height: 0 !important; background: #fff !important; padding: 0 !important; margin: 0 !important; overflow: visible !important; justify-content: flex-start !important; }
        html[data-print-format="thermal"] .print-document { position: absolute !important; top: 0 !important; left: 0 !important; display: block !important; }
      }
    `}</style>
  )
}
