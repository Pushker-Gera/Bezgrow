"use client"

import type { PrintInvoice, PrintSettings } from "@/components/print/types"
import { formatDate, formatMoney } from "@/components/print/utils"

export function HalfTopTemplate({ invoice, settings }: { invoice: PrintInvoice; settings: PrintSettings }) {
  const gstTotal = invoice.totals.cgst + invoice.totals.sgst + invoice.totals.igst

  return (
    <article className="invoice-paper print-half-top">
      <div className="top-half-content">
        {settings.showWatermark && <div className="watermark">{invoice.watermark}</div>}
        <header className="half-top-header">
          <div>
            <p className="print-eyebrow">{invoice.enterprise.businessType}</p>
            <h1>{invoice.enterprise.name}</h1>
            <p>{invoice.enterprise.address}</p>
            <p>GST: {invoice.enterprise.gstNumber} | Phone: {invoice.enterprise.phone}</p>
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
            <p><span>GST</span><strong>{formatMoney(gstTotal)}</strong></p>
            <p className="half-top-grand"><span>Total</span><strong>{formatMoney(invoice.totals.grandTotal)}</strong></p>
          </div>
        </section>
      </div>
      <div className="manual-notes-space">
        <span>Manual notes / logistics / delivery record</span>
      </div>
    </article>
  )
}
