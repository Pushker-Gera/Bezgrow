"use client"

import type { PrintInvoice, PrintSettings } from "@/components/print/types"
import { formatMoney } from "@/components/print/utils"
import { BusinessLogo, CodesBlock, GeneratedByFooter, SignatureBlock } from "./PrintBlocks"

export function HalfCompactTemplate({ invoice, settings }: { invoice: PrintInvoice; settings: PrintSettings }) {
  return (
    <article className="invoice-paper print-half-compact">
      {settings.showWatermark && <div className="watermark" aria-hidden="true"><span>{invoice.watermark}</span></div>}
      <header className="compact-invoice-header">
        <div className="compact-invoice-brand">
          {settings.showLogo && <BusinessLogo invoice={invoice} className="compact-brand-logo" />}
          <div>
            <p className="print-eyebrow">{invoice.enterprise.businessType}</p>
            <h1>{invoice.enterprise.name}</h1>
            <p>{invoice.enterprise.address}</p>
            <p>GST: {invoice.enterprise.gstNumber} · {invoice.enterprise.phone}</p>
          </div>
        </div>
        <div className="compact-invoice-meta">
          <span>{invoice.invoiceTitle}</span>
          <strong>{invoice.invoiceNumber}</strong>
          <small>{invoice.invoiceDate} · {invoice.payment.mode}</small>
        </div>
      </header>
      <section className="compact-customer-strip">
        <p><span>Bill to</span><strong>{invoice.customer.name}</strong></p>
        <p><span>Phone</span><strong>{invoice.customer.phone}</strong></p>
        <p><span>GSTIN</span><strong>{invoice.customer.gstin}</strong></p>
        <p><span>Address</span><strong>{invoice.customer.address}</strong></p>
      </section>
      <table className="compact-item-table">
        <thead><tr><th>#</th><th>Item</th>{settings.showHsn && <th>HSN</th>}<th>Qty</th><th>Rate</th>{settings.showGstDetails && <th>GST</th>}<th>Amount</th></tr></thead>
        <tbody>{invoice.items.map((item, index) => (
          <tr key={item.id}>
            <td>{index + 1}</td><td><strong>{item.name}</strong>{settings.pharmaMode && <small>{item.batchNumber} · {item.expiryDate}</small>}</td>
            {settings.showHsn && <td>{item.hsnCode}</td>}<td>{item.quantity} {item.unit}</td><td>{formatMoney(item.rate)}</td>
            {settings.showGstDetails && <td>{item.cgstPercent + item.sgstPercent + item.igstPercent}%</td>}<td><strong>{formatMoney(item.finalAmount)}</strong></td>
          </tr>
        ))}</tbody>
      </table>
      <section className="compact-summary-grid">
        <div className="compact-terms">
          <span>Terms & amount in words</span>
          <strong>{invoice.totals.amountInWords}</strong>
          <small>{invoice.terms.join(" · ")}</small>
          <small>Paid {formatMoney(invoice.payment.paidAmount)} · Due {formatMoney(invoice.payment.dueAmount)}</small>
        </div>
        <div className="compact-totals">
          <p><span>Subtotal</span><strong>{formatMoney(invoice.totals.subtotal)}</strong></p>
          <p><span>Discount</span><strong>{formatMoney(invoice.totals.discount)}</strong></p>
          <p><span>Taxable</span><strong>{formatMoney(invoice.totals.taxableAmount)}</strong></p>
          {settings.showGstDetails && <><p><span>CGST</span><strong>{formatMoney(invoice.totals.cgst)}</strong></p><p><span>SGST</span><strong>{formatMoney(invoice.totals.sgst)}</strong></p><p><span>IGST</span><strong>{formatMoney(invoice.totals.igst)}</strong></p></>}
          <p className="compact-grand"><span>Total</span><strong>{formatMoney(invoice.totals.grandTotal)}</strong></p>
        </div>
      </section>
      <div className="compact-reference-row">
        <CodesBlock invoice={invoice} settings={settings} />
        <SignatureBlock settings={settings} />
      </div>
      <GeneratedByFooter compact />
    </article>
  )
}
