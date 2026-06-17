"use client"

import { useEffect, useMemo, useState } from "react"
import { createWhatsAppInvoiceUrl } from "@/lib/invoice-share"
import { defaultPrintSettings, saveStoredPrintSettings } from "@/components/print/settings/defaults"
import type { PrintFormat, PrintInvoice, PrintSettings } from "@/components/print/types"
import { getReprintHistory, rememberReprint } from "@/components/print/utils"
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
  const [termsText, setTermsText] = useState(invoice.terms.join("\n"))
  const [history, setHistory] = useState(() => getReprintHistory().filter((entry) => entry.invoiceId === invoice.id))

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
    return () => {
      delete document.documentElement.dataset.printFormat
    }
  }, [format])

  function updateSettings(next: Partial<PrintSettings>) {
    const updated = { ...settings, ...next }
    setSettings(updated)
    saveStoredPrintSettings(updated)
  }

  function printInvoice() {
    document.documentElement.dataset.printFormat = format
    rememberReprint(effectiveInvoice, format)
    setHistory(getReprintHistory().filter((entry) => entry.invoiceId === invoice.id))
    requestAnimationFrame(() => window.print())
  }

  function publicPdfUrl() {
    return `${window.location.origin}/public/invoices/${invoice.id}/pdf`
  }

  function savePdf() {
    window.open(publicPdfUrl(), "_blank", "noopener,noreferrer")
  }

  function downloadPdf() {
    const link = document.createElement("a")
    link.href = `${publicPdfUrl()}?download=1`
    link.download = `${invoice.invoiceNumber || "invoice"}.pdf`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  function sharePdf() {
    const shareUrl = publicPdfUrl()
    if (navigator.share) {
      void navigator.share({ title: invoice.invoiceNumber, text: "Invoice PDF", url: shareUrl })
    } else {
      void navigator.clipboard?.writeText(shareUrl)
      setNotice("Invoice PDF link copied.")
    }
  }

  function emailInvoice() {
    const recipient = invoice.customer.email?.trim()
    const validRecipient = recipient && recipient !== "-" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) ? recipient : ""

    const subject = encodeURIComponent(`Invoice ${invoice.invoiceNumber}`)
    const shareUrl = publicPdfUrl()
    const body = encodeURIComponent(
      `Hello ${invoice.customer.name},\n\nThank you for purchasing from ${invoice.enterprise.name}.\n\nInvoice Number: ${invoice.invoiceNumber}\nAmount: Rs ${invoice.totals.grandTotal.toLocaleString("en-IN")}\n\nDownload / view invoice PDF:\n${shareUrl}\n\nThank you for your business.`
    )
    if (!validRecipient) {
      setNotice("Customer email missing. Opening email composer without recipient.")
    }
    window.location.href = `mailto:${encodeURIComponent(validRecipient)}?subject=${subject}&body=${body}`
  }

  function whatsappInvoice() {
    const shareUrl = publicPdfUrl()
    const url = createWhatsAppInvoiceUrl({
      customerName: invoice.customer.name,
      customerPhone: invoice.customer.phone,
      enterpriseName: invoice.enterprise.name,
      invoiceNumber: invoice.invoiceNumber,
      amount: invoice.totals.grandTotal,
      invoiceUrl: shareUrl,
    })

    if (!url) {
      setNotice("Customer phone number required.")
      return
    }

    window.open(url, "_blank", "noopener,noreferrer")
  }

  const template = {
    thermal: <ThermalTemplate invoice={effectiveInvoice} settings={settings} />,
    a4: <A4Template invoice={effectiveInvoice} settings={settings} />,
    "half-compact": <HalfCompactTemplate invoice={effectiveInvoice} settings={settings} />,
    "half-top": <HalfTopTemplate invoice={effectiveInvoice} settings={settings} />,
  }[format]

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
            <button onClick={printInvoice}>Print</button>
            <button onClick={savePdf}>Save PDF</button>
            <button onClick={downloadPdf}>Download PDF</button>
            <button onClick={sharePdf}>Share PDF</button>
            <button onClick={whatsappInvoice}>WhatsApp</button>
            <button onClick={emailInvoice}>Email</button>
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
            <select value={format} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
              {(Object.keys(formatLabels) as PrintFormat[]).map((key) => <option key={key} value={key}>{formatLabels[key]}</option>)}
            </select>
            <button onClick={printInvoice}>Print</button>
            <button onClick={whatsappInvoice}>WhatsApp</button>
          </div>}
          <div className="preview-scroll">
            <div className="print-document" style={{ transform: publicMode ? undefined : `scale(${zoom})` }}>
              {template}
            </div>
          </div>
        </main>
      </div>
    </>
  )
}

function PrintEngineStyles({ format, thermalWidth }: { format: PrintFormat; thermalWidth: PrintSettings["thermalWidth"] }) {
  const thermalPaperWidth = thermalWidth === "58mm" ? "58mm" : "80mm"
  const printPageSize =
    format === "thermal"
      ? `${thermalPaperWidth} 297mm`
      : format === "half-top"
        ? "210mm 148.5mm"
        : "A4 portrait"
  const printPaperWidth = format === "thermal" ? thermalPaperWidth : "210mm"
  const printPaperHeight = format === "half-top" ? "148.5mm" : format === "thermal" ? "auto" : "297mm"

  return (
    <style jsx global>{`
      @page { size: A4 portrait; margin: 0; }
      @page half-compact { size: A4 portrait; margin: 0; }
      @page half-top { size: 210mm 148.5mm; margin: 0; }
      @page thermal { size: 80mm 297mm; margin: 0; }
      html[data-print-format="thermal"] { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .enterprise-print-shell { min-height: 100dvh; display: grid; grid-template-columns: 320px 1fr; background: #0a0d12; color: #f8fafc; }
      .print-control-panel { height: 100dvh; overflow-y: auto; border-right: 1px solid rgba(255,255,255,.1); background: #070b12; padding: 22px; display: flex; flex-direction: column; gap: 20px; }
      .panel-eyebrow, .control-label, .print-eyebrow { color: #0891b2; font-size: 10px; font-weight: 900; letter-spacing: .18em; text-transform: uppercase; }
      .print-control-panel h1 { margin: 8px 0 2px; font-size: 24px; font-weight: 900; }
      .template-grid, .action-grid { display: grid; gap: 8px; }
      .template-grid button, .action-grid button, .print-control-panel select, .mobile-toolbar select, .mobile-toolbar button { min-height: 42px; border-radius: 12px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: #fff; padding: 0 12px; font-weight: 800; }
      .template-grid button.active, .action-grid button:first-child { background: #fff; color: #020617; }
      .terms-editor { width: 100%; min-height: 118px; resize: vertical; border-radius: 12px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: #fff; padding: 12px; font: inherit; font-size: 13px; line-height: 1.45; outline: none; }
      .terms-editor:focus { border-color: rgba(34,211,238,.55); box-shadow: 0 0 0 3px rgba(34,211,238,.12); }
      .toggle-row { display: flex; justify-content: space-between; gap: 14px; align-items: center; min-height: 36px; font-size: 13px; color: #cbd5e1; }
      .print-notice { border: 1px solid rgba(251,191,36,.35); color: #fde68a; background: rgba(251,191,36,.1); border-radius: 12px; padding: 10px; font-size: 13px; }
      .history-list { color: #94a3b8; font-size: 12px; display: grid; gap: 7px; }
      .print-preview-stage { min-width: 0; background: radial-gradient(circle at top left, rgba(34,211,238,.08), transparent 32%), #111827; }
      .mobile-toolbar { display: none; gap: 8px; padding: 12px; position: sticky; top: 0; z-index: 10; background: #070b12; }
      .preview-scroll { height: 100dvh; overflow: auto; padding: 32px; display: flex; justify-content: center; align-items: flex-start; background: #111827; }
      .print-format-thermal .preview-scroll { background: #111827; justify-content: center; }
      .print-document { transform-origin: top center; transition: transform .18s ease; }
      .invoice-paper, .invoice-paper * { box-sizing: border-box; }
      .invoice-paper { position: relative; overflow: visible; background: #fff; color: #111827; font-family: Arial, Helvetica, sans-serif; box-shadow: 0 24px 90px rgba(0,0,0,.35); print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .public-invoice-shell { display: block; min-height: 100dvh; background: #f8fafc; color: #111827; }
      .public-invoice-shell .print-preview-stage { min-height: 100dvh; background: #f8fafc; }
      .public-invoice-shell .preview-scroll { height: auto; min-height: 100dvh; overflow: visible; padding: clamp(10px, 3vw, 28px); background: #f8fafc; align-items: flex-start; }
      .public-invoice-shell .print-document { width: min(100%, 210mm); transform: none !important; transition: none; }
      .public-invoice-shell .invoice-paper { width: 100%; max-width: 210mm; min-height: auto; margin: 0 auto; box-shadow: 0 14px 40px rgba(15,23,42,.12); }
      .print-a4 { width: 210mm; min-height: 297mm; padding: 10mm; display: flex; flex-direction: column; }
      .print-half-compact { page: half-compact; width: 156mm; min-height: 297mm; padding: 8mm; margin: 0 auto; display: flex; flex-direction: column; }
      .print-half-top { page: half-top; width: 210mm; min-height: 148.5mm; padding: 0; }
      .top-half-content { height: 148.5mm; overflow: hidden; border: 1px solid #0f172a; padding: 5mm; background: #fff; }
      .manual-notes-space { display: none; }
      .print-thermal { page: thermal; width: 80mm; min-height: auto; padding: 3mm 4mm; font-family: "Courier New", monospace; box-shadow: 0 20px 70px rgba(0,0,0,.28); background: #fff; color: #000; }
      .thermal-58 { width: 58mm; padding: 2mm; }
      .thermal-80, .thermal-auto { width: 80mm; }
      .print-header-block { display: grid; grid-template-columns: 1.45fr .75fr; gap: 12px; border-bottom: 2px solid #111827; padding-bottom: 10px; }
      .brand-block { display: flex; gap: 12px; min-width: 0; }
      .brand-logo { width: 46px; height: 46px; flex: none; border-radius: 10px; background: #e0f2fe; display: grid; place-items: center; font-weight: 900; color: #075985; overflow: hidden; }
      .brand-logo img { width: 100%; height: 100%; object-fit: cover; }
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
      .codes-block { display: flex; gap: 10px; align-items: center; max-width: 100%; overflow: visible; }
      .codes-block svg { max-width: 100%; height: auto; }
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
      .font-small .invoice-paper { font-size: 92%; }
      .font-large .invoice-paper { font-size: 108%; }
      .margin-compact .print-a4 { padding: 5mm; }
      .margin-wide .print-a4 { padding: 9mm; }
      .bw-mode .invoice-paper, .bw-mode .invoice-paper * { color: #000 !important; background-color: #fff !important; border-color: #000 !important; }
      .thermal-center { text-align: center; }
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
      .print-thermal svg { max-width: 100%; height: auto; }
      @media (max-width: 900px) {
        .enterprise-print-shell { grid-template-columns: 1fr; }
        .print-control-panel { display: none; }
        .mobile-toolbar { display: grid; grid-template-columns: 1fr auto auto; }
        .preview-scroll { height: calc(100dvh - 66px); padding: 18px; justify-content: flex-start; }
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
      }
      @media print {
        @page { size: ${printPageSize}; margin: 0; }
        @page half-compact { size: A4 portrait; margin: 0; }
        @page half-top { size: 210mm 148.5mm; margin: 0; }
        @page thermal { size: ${printPageSize}; margin: 0; }
        html, body { width: ${printPaperWidth} !important; max-width: ${printPaperWidth} !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; background: #fff !important; color: #000 !important; }
        body * { visibility: hidden !important; }
        .print-document, .print-document *, .invoice-paper, .invoice-paper * { visibility: visible !important; }
        .no-print { display: none !important; }
        .enterprise-print-shell, .print-preview-stage, .preview-scroll { position: static !important; display: block !important; width: ${printPaperWidth} !important; max-width: ${printPaperWidth} !important; min-width: 0 !important; height: auto !important; min-height: 0 !important; overflow: visible !important; padding: 0 !important; margin: 0 !important; background: #fff !important; color: #000 !important; transform: none !important; }
        .print-document { position: absolute !important; top: 0 !important; left: 0 !important; display: block !important; width: ${printPaperWidth} !important; max-width: ${printPaperWidth} !important; min-width: 0 !important; height: ${printPaperHeight} !important; min-height: 0 !important; overflow: visible !important; padding: 0 !important; margin: 0 !important; background: #fff !important; color: #000 !important; transform: none !important; transition: none !important; }
        .invoice-paper { box-shadow: none !important; margin: 0 !important; overflow: visible !important; background: #fff !important; color: #000 !important; break-inside: auto; page-break-inside: auto; }
        .print-a4 { page: auto !important; width: 210mm !important; max-width: 210mm !important; min-height: 297mm !important; padding: 8mm !important; }
        .print-a4 .total-grid { grid-template-columns: minmax(0, 1fr) 62mm !important; }
        .print-a4 .payment-grid { grid-template-columns: repeat(4, minmax(0, 1fr)) !important; }
        .print-half-compact { page: half-compact !important; width: 210mm !important; max-width: 210mm !important; min-height: 297mm !important; padding: 8mm !important; margin: 0 !important; }
        .print-half-compact .brand-block h1 { font-size: 24px !important; }
        .print-half-compact .invoice-meta-card h2 { font-size: 16px !important; }
        .print-half-compact .print-header-block,
        .print-half-compact .customer-grid,
        .print-half-compact .total-grid,
        .print-half-compact .payment-grid { grid-template-columns: 1fr !important; }
        .print-half-compact .item-table th,
        .print-half-compact .item-table td { font-size: 7.8px !important; padding: 3px 2px !important; }
        .print-half-top { page: half-top !important; width: 210mm !important; max-width: 210mm !important; min-height: 148.5mm !important; max-height: 148.5mm !important; padding: 0 !important; margin: 0 !important; }
        .top-half-content { height: 148.5mm !important; min-height: 148.5mm !important; max-height: 148.5mm !important; overflow: hidden !important; padding: 5mm !important; background: #fff !important; }
        .manual-notes-space { display: none !important; }
        .print-header-block, .customer-grid, .total-grid, .payment-grid, .footer-row, .codes-block, .signature-grid, .info-card, .invoice-meta-card, .terms-card, .total-card { break-inside: avoid !important; page-break-inside: avoid !important; }
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
