"use client"

import { useEffect, useState } from "react"
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
}: {
  invoice: PrintInvoice
  initialSettings?: PrintSettings
}) {
  const [settings, setSettings] = useState<PrintSettings>(initialSettings)
  const [format, setFormat] = useState<PrintFormat>(initialSettings.defaultFormat)
  const [zoom, setZoom] = useState(1)
  const [notice, setNotice] = useState("")
  const [history, setHistory] = useState(() => getReprintHistory().filter((entry) => entry.invoiceId === invoice.id))

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
    rememberReprint(invoice, format)
    setHistory(getReprintHistory().filter((entry) => entry.invoiceId === invoice.id))
    requestAnimationFrame(() => window.print())
  }

  function sharePdf() {
    const url = `${window.location.origin}/dashboard/invoices/${invoice.id}/print`
    if (navigator.share) {
      void navigator.share({ title: invoice.invoiceNumber, text: "Invoice PDF / print link", url })
    } else {
      void navigator.clipboard?.writeText(url)
      setNotice("Invoice link copied. Use browser print to save as PDF.")
    }
  }

  function emailInvoice() {
    const recipient = invoice.customer.email?.trim()
    if (!recipient || recipient === "-" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      setNotice("Customer email address required.")
      return
    }

    const subject = encodeURIComponent(`Invoice ${invoice.invoiceNumber}`)
    const body = encodeURIComponent(
      `Hello ${invoice.customer.name},\n\nThank you for purchasing from ${invoice.enterprise.name}.\n\nInvoice Number: ${invoice.invoiceNumber}\nAmount: Rs ${invoice.totals.grandTotal.toLocaleString("en-IN")}\n\nView / print invoice:\n${window.location.origin}/dashboard/invoices/${invoice.id}/print\n\nThank you for your business.`
    )
    window.location.href = `mailto:${encodeURIComponent(recipient)}?subject=${subject}&body=${body}`
  }

  function whatsappInvoice() {
    const url = createWhatsAppInvoiceUrl({
      customerName: invoice.customer.name,
      customerPhone: invoice.customer.phone,
      enterpriseName: invoice.enterprise.name,
      invoiceNumber: invoice.invoiceNumber,
      amount: invoice.totals.grandTotal,
      invoiceUrl: `${window.location.origin}/dashboard/invoices/${invoice.id}/print`,
    })

    if (!url) {
      setNotice("Customer phone number required.")
      return
    }

    window.open(url, "_blank", "noopener,noreferrer")
  }

  const template = {
    thermal: <ThermalTemplate invoice={invoice} settings={settings} />,
    a4: <A4Template invoice={invoice} settings={settings} />,
    "half-compact": <HalfCompactTemplate invoice={invoice} settings={settings} />,
    "half-top": <HalfTopTemplate invoice={invoice} settings={settings} />,
  }[format]

  return (
    <>
      <PrintEngineStyles />
      <div className="enterprise-print-shell">
        <aside className="print-control-panel no-print">
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

          {notice && <p className="print-notice">{notice}</p>}

          <section className="action-grid">
            <button onClick={printInvoice}>Print</button>
            <button onClick={printInvoice}>Save PDF</button>
            <button onClick={printInvoice}>Download PDF</button>
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
        </aside>

        <main className={`print-preview-stage print-format-${format} font-${settings.fontSize} margin-${settings.margins} ${settings.blackAndWhite ? "bw-mode" : ""}`}>
          <div className="mobile-toolbar no-print">
            <select value={format} onChange={(event) => setFormat(event.target.value as PrintFormat)}>
              {(Object.keys(formatLabels) as PrintFormat[]).map((key) => <option key={key} value={key}>{formatLabels[key]}</option>)}
            </select>
            <button onClick={printInvoice}>Print</button>
            <button onClick={whatsappInvoice}>WhatsApp</button>
          </div>
          <div className="preview-scroll">
            <div className="print-document" style={{ transform: `scale(${zoom})` }}>
              {template}
            </div>
          </div>
        </main>
      </div>
    </>
  )
}

function PrintEngineStyles() {
  return (
    <style jsx global>{`
      @page { size: A4 portrait; margin: 8mm; }
      @page half-compact { size: A4 portrait; margin: 8mm; }
      @page half-top { size: 210mm 148mm; margin: 4mm; }
      @page thermal { size: 80mm 200mm; margin: 0; }
      html[data-print-format="thermal"] { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .enterprise-print-shell { min-height: 100dvh; display: grid; grid-template-columns: 320px 1fr; background: #0a0d12; color: #f8fafc; }
      .print-control-panel { height: 100dvh; overflow-y: auto; border-right: 1px solid rgba(255,255,255,.1); background: #070b12; padding: 22px; display: flex; flex-direction: column; gap: 20px; }
      .panel-eyebrow, .control-label, .print-eyebrow { color: #0891b2; font-size: 10px; font-weight: 900; letter-spacing: .18em; text-transform: uppercase; }
      .print-control-panel h1 { margin: 8px 0 2px; font-size: 24px; font-weight: 900; }
      .template-grid, .action-grid { display: grid; gap: 8px; }
      .template-grid button, .action-grid button, .print-control-panel select, .mobile-toolbar select, .mobile-toolbar button { min-height: 42px; border-radius: 12px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.06); color: #fff; padding: 0 12px; font-weight: 800; }
      .template-grid button.active, .action-grid button:first-child { background: #fff; color: #020617; }
      .toggle-row { display: flex; justify-content: space-between; gap: 14px; align-items: center; min-height: 36px; font-size: 13px; color: #cbd5e1; }
      .print-notice { border: 1px solid rgba(251,191,36,.35); color: #fde68a; background: rgba(251,191,36,.1); border-radius: 12px; padding: 10px; font-size: 13px; }
      .history-list { color: #94a3b8; font-size: 12px; display: grid; gap: 7px; }
      .print-preview-stage { min-width: 0; background: radial-gradient(circle at top left, rgba(34,211,238,.08), transparent 32%), #111827; }
      .mobile-toolbar { display: none; gap: 8px; padding: 12px; position: sticky; top: 0; z-index: 10; background: #070b12; }
      .preview-scroll { height: 100dvh; overflow: auto; padding: 32px; display: flex; justify-content: center; align-items: flex-start; background: #111827; }
      .print-format-thermal .preview-scroll { background: #111827; }
      .print-document { transform-origin: top center; transition: transform .18s ease; }
      .invoice-paper, .invoice-paper * { box-sizing: border-box; }
      .invoice-paper { position: relative; overflow: visible; background: #fff; color: #111827; font-family: Arial, Helvetica, sans-serif; box-shadow: 0 24px 90px rgba(0,0,0,.35); print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .print-a4 { width: 194mm; min-height: 281mm; padding: 8mm; display: flex; flex-direction: column; }
      .print-half-compact { page: half-compact; width: 126mm; min-height: 281mm; padding: 6mm; margin: 0 auto; display: flex; flex-direction: column; }
      .print-half-top { page: half-top; width: 202mm; min-height: 140mm; padding: 0; }
      .top-half-content { min-height: 140mm; overflow: visible; border: 1px solid #0f172a; padding: 4mm; background: #fff; }
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
      .item-table thead { display: table-header-group; }
      .item-table tr { page-break-inside: avoid; break-inside: avoid; }
      .item-table th { position: sticky; top: 0; background: #0f172a; color: #fff; font-size: 6.7px; letter-spacing: .03em; text-transform: uppercase; padding: 4px 3px; text-align: left; overflow-wrap: anywhere; word-break: break-word; }
      .item-table td { border: 1px solid #e2e8f0; padding: 4px 3px; font-size: 7.2px; line-height: 1.22; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
      .item-table .wrap { max-width: none; white-space: normal; word-break: break-word; overflow-wrap: anywhere; }
      .item-table .wrap span { display: block; color: #64748b; font-weight: 400; }
      .item-table.compact th, .item-table.compact td { padding: 2.5px; font-size: 6.4px; line-height: 1.15; }
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
      .print-a4 .terms-card { min-height: 62mm; }
      .print-half-compact .print-header-block,
      .print-half-compact .customer-grid,
      .print-half-compact .total-grid,
      .print-half-compact .payment-grid { grid-template-columns: 1fr; }
      .print-half-compact .print-header-block { gap: 8px; }
      .print-half-compact .brand-block h1 { font-size: 22px; }
      .print-half-compact .brand-block p,
      .print-half-compact .invoice-meta-card p,
      .print-half-compact .info-card p,
      .print-half-compact .terms-card p { font-size: 9.2px; }
      .print-half-compact .invoice-meta-card h2 { font-size: 15px; }
      .print-half-compact .item-table { margin-top: 7px; }
      .print-half-compact .item-table th,
      .print-half-compact .item-table td { font-size: 5.8px; padding: 2px; line-height: 1.15; }
      .print-half-compact .total-card div { font-size: 9.5px; }
      .print-half-compact .grand-total { font-size: 14px !important; }
      .print-half-compact .payment-grid { gap: 5px; }
      .print-half-compact .footer-row { flex-direction: column; align-items: stretch; }
      .print-half-compact .signature-grid { grid-template-columns: 1fr; }
      .print-half-top .brand-block h1 { font-size: 20px; }
      .print-half-top .brand-block p,
      .print-half-top .invoice-meta-card p,
      .print-half-top .info-card p,
      .print-half-top .terms-card p { font-size: 8px; }
      .print-half-top .invoice-meta-card h2 { font-size: 14px; }
      .print-half-top .item-table th,
      .print-half-top .item-table td { font-size: 5.5px; padding: 1.8px; line-height: 1.1; }
      .print-half-top .total-grid { grid-template-columns: 1fr 50mm; }
      .print-half-top .payment-grid div { padding: 4px; }
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
      .thermal-table th, .thermal-table td { border-bottom: 1px dotted #999; padding: 4px 2px; text-align: left; overflow-wrap: anywhere; word-break: break-word; }
      .thermal-total { border-top: 1px solid #000; margin-top: 6px; padding-top: 6px; font-size: 13px; font-weight: 900; }
      .print-thermal svg { max-width: 100%; height: auto; }
      @media (max-width: 900px) {
        .enterprise-print-shell { grid-template-columns: 1fr; }
        .print-control-panel { display: none; }
        .mobile-toolbar { display: grid; grid-template-columns: 1fr auto auto; }
        .preview-scroll { height: calc(100dvh - 66px); padding: 18px; justify-content: flex-start; }
      }
      @media print {
        html, body { width: auto !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; overflow: visible !important; background: #fff !important; color: #000 !important; }
        body * { visibility: hidden !important; }
        .print-document, .print-document *, .invoice-paper, .invoice-paper * { visibility: visible !important; }
        .no-print { display: none !important; }
        .enterprise-print-shell, .print-preview-stage, .preview-scroll, .print-document { display: block !important; width: auto !important; min-width: 0 !important; height: auto !important; min-height: 0 !important; overflow: visible !important; padding: 0 !important; margin: 0 !important; background: #fff !important; color: #000 !important; transform: none !important; }
        .print-document { position: static !important; transform: none !important; transition: none !important; }
        .invoice-paper { box-shadow: none !important; margin: 0 auto !important; overflow: visible !important; background: #fff !important; color: #000 !important; break-inside: auto; page-break-inside: auto; }
        .print-a4 { page: auto !important; width: 194mm !important; min-height: 281mm !important; padding: 7mm !important; }
        .print-half-compact { page: half-compact !important; width: 126mm !important; min-height: 281mm !important; padding: 5mm !important; margin: 0 auto !important; }
        .print-half-top { page: half-top !important; width: 202mm !important; min-height: 140mm !important; padding: 0 !important; margin: 0 !important; }
        .top-half-content { min-height: 140mm !important; max-height: 140mm !important; overflow: hidden !important; padding: 4mm !important; background: #fff !important; }
        .manual-notes-space { display: none !important; }
        .print-header-block, .customer-grid, .total-grid, .payment-grid, .footer-row, .codes-block, .signature-grid, .info-card, .invoice-meta-card, .terms-card, .total-card { break-inside: avoid !important; page-break-inside: avoid !important; }
        .item-table { width: 100% !important; max-width: 100% !important; table-layout: fixed !important; page-break-inside: auto !important; }
        .item-table tr { break-inside: avoid !important; page-break-inside: avoid !important; }
        .item-table th { position: static !important; }
        html[data-print-format="thermal"], html[data-print-format="thermal"] body { width: 80mm !important; max-width: 80mm !important; height: auto !important; min-height: 0 !important; background: #fff !important; }
        html[data-print-format="thermal"] .invoice-paper { page: thermal !important; width: 80mm !important; min-height: auto !important; margin: 0 !important; padding: 3mm 4mm !important; box-shadow: none !important; background: #fff !important; color: #000 !important; }
        html[data-print-format="thermal"] .enterprise-print-shell,
        html[data-print-format="thermal"] .print-preview-stage,
        html[data-print-format="thermal"] .preview-scroll,
        html[data-print-format="thermal"] .print-document { width: 80mm !important; max-width: 80mm !important; height: auto !important; min-height: 0 !important; background: #fff !important; padding: 0 !important; margin: 0 !important; overflow: visible !important; }
        html[data-print-format="thermal"] .print-document { position: absolute !important; inset: 0 auto auto 0 !important; }
      }
    `}</style>
  )
}
