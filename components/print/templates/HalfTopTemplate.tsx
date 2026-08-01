"use client"

import type { PrintInvoice, PrintSettings } from "@/components/print/types"
import { formatDate, formatMoney } from "@/components/print/utils"
import { BusinessLogo, CodesBlock, GeneratedByFooter, SignatureBlock } from "./PrintBlocks"

function joinFilled(parts: string[]) {
  return parts.filter((part) => part.trim() && !part.endsWith(": -")).join(" | ")
}

export function HalfTopTemplate({ invoice, settings }: { invoice: PrintInvoice; settings: PrintSettings }) {
  const businessDetails = joinFilled([
    `GST: ${invoice.enterprise.gstNumber}`,
    `Phone: ${invoice.enterprise.phone}`,
    `Email: ${invoice.enterprise.email}`,
  ])

  return (
    <article className="invoice-paper print-half-top">
      <div className="top-half-content">
        {settings.showWatermark && <div className="watermark">{invoice.watermark}</div>}
        <header className="half-top-header">
          <div className="half-top-brand">
            {settings.showLogo && <BusinessLogo invoice={invoice} className="half-top-brand-logo" />}
            <div>
              <p className="print-eyebrow">{invoice.enterprise.businessType}</p>
              <h1>{invoice.enterprise.name}</h1>
              {invoice.enterprise.address !== "-" && <p>{invoice.enterprise.address}</p>}
              {businessDetails && <p>{businessDetails}</p>}
            </div>
          </div>
          <div className="half-top-meta">
            <p className="print-eyebrow">{invoice.invoiceTitle}</p>
            <strong>{invoice.invoiceNumber}</strong>
            <span>Date: {formatDate(invoice.invoiceDate)}</span>
            <span>Payment: {invoice.payment.mode}</span>
          </div>
        </header>

        <section className="half-top-customer">
          <div>
            <span>Bill To</span>
            <strong>{invoice.customer.name}</strong>
            <p>{invoice.customer.phone !== "-" ? invoice.customer.phone : ""}</p>
          </div>
          <div>
            <span>Address</span>
            <p>{invoice.customer.address}</p>
          </div>
        </section>

        <table className="half-top-items">
          <thead>
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th>Rate</th>
              <th>GST</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.items.map((item) => (
              <tr key={item.id}>
                <td><strong>{item.name}</strong></td>
                <td>{item.quantity} {item.unit}</td>
                <td>{formatMoney(item.rate)}</td>
                <td>{item.cgstPercent + item.sgstPercent + item.igstPercent}%</td>
                <td><strong>{formatMoney(item.finalAmount)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>

        <section className="half-top-summary">
          <div className="half-top-words">
            <span>Amount in Words</span>
            <strong>{invoice.totals.amountInWords}</strong>
          </div>
          <div className="half-top-totals">
            <p><span>Subtotal</span><strong>{formatMoney(invoice.totals.subtotal)}</strong></p>
            <p><span>Discount</span><strong>{formatMoney(invoice.totals.discount)}</strong></p>
            {settings.showGstDetails && <p><span>CGST / SGST / IGST</span><strong>{formatMoney(invoice.totals.cgst)} / {formatMoney(invoice.totals.sgst)} / {formatMoney(invoice.totals.igst)}</strong></p>}
            <p className="half-top-grand"><span>Total</span><strong>{formatMoney(invoice.totals.grandTotal)}</strong></p>
          </div>
        </section>
        <div className="half-top-reference">
          <CodesBlock invoice={invoice} settings={settings} />
          <SignatureBlock settings={settings} />
        </div>
        <GeneratedByFooter compact />
      </div>
      <div className="manual-notes-space">
        <span>Manual notes / logistics / delivery record</span>
      </div>
    </article>
  )
}
