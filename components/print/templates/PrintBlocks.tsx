"use client"

import Image from "next/image"
import Barcode from "react-barcode"
import { QRCodeSVG } from "qrcode.react"
import type { PrintInvoice, PrintSettings } from "@/components/print/types"
import { formatDate, formatMoney } from "@/components/print/utils"

export function HeaderBlock({ invoice, settings, compact = false }: { invoice: PrintInvoice; settings: PrintSettings; compact?: boolean }) {
  return (
    <header className="print-header-block">
      <div className="brand-block">
        {settings.showLogo && (
          <div className="brand-logo">
            {invoice.enterprise.logoUrl ? <Image src={invoice.enterprise.logoUrl} alt="" width={46} height={46} unoptimized /> : invoice.enterprise.name.slice(0, 1)}
          </div>
        )}
        <div>
          <p className="print-eyebrow">{invoice.enterprise.businessType}</p>
          <h1>{invoice.enterprise.name}</h1>
          <p>{invoice.enterprise.address}</p>
          <p>GST: {invoice.enterprise.gstNumber} | Phone: {invoice.enterprise.phone} | Email: {invoice.enterprise.email}</p>
          {!compact && <p>Drug Lic: {invoice.enterprise.drugLicense} | FSSAI: {invoice.enterprise.fssai} | Website: {invoice.enterprise.website}</p>}
        </div>
      </div>
      <div className="invoice-meta-card">
        <p className="print-eyebrow">{invoice.invoiceTitle}</p>
        <h2>{invoice.invoiceNumber}</h2>
        <p>Date: {formatDate(invoice.invoiceDate)}</p>
        <p>Due: {formatDate(invoice.dueDate)}</p>
        <p>Branch: {invoice.enterprise.branchName}</p>
        <p>Salesperson: {invoice.salesperson}</p>
      </div>
    </header>
  )
}

export function CustomerBlock({ invoice }: { invoice: PrintInvoice }) {
  return (
    <section className="customer-grid">
      <div className="info-card">
        <p className="print-eyebrow">Customer</p>
        <h3>{invoice.customer.name}</h3>
        <p>Address: {invoice.customer.address}</p>
        <p>Phone: {invoice.customer.phone}</p>
      </div>
      <div className="info-card">
        <p className="print-eyebrow">Tax Identity</p>
        <p>GSTIN: {invoice.customer.gstin}</p>
        <p>State: {invoice.customer.state}</p>
        <p>State Code: {invoice.customer.stateCode}</p>
        <p>Customer ID: {invoice.customer.id}</p>
      </div>
    </section>
  )
}

export function ItemTable({ invoice, settings, compact = false }: { invoice: PrintInvoice; settings: PrintSettings; compact?: boolean }) {
  const visibleColumns = [
    "sr",
    "item",
    ...(settings.pharmaMode ? ["batch", "expiry"] : []),
    ...(settings.showHsn ? ["hsn"] : []),
    "qty",
    "free",
    "unit",
    "mrp",
    "rate",
    "disc",
    "discAmount",
    "taxable",
    ...(settings.showGstDetails ? ["cgst", "sgst", "igst"] : []),
    "amount",
  ]

  return (
    <>
      <table className={`item-table ${compact ? "compact" : ""}`}>
        <colgroup>
          {visibleColumns.map((column) => (
            <col key={column} className={`col-${column}`} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th>Sr</th>
            <th>Item Name</th>
            {settings.pharmaMode && <th>Batch</th>}
            {settings.pharmaMode && <th>Expiry</th>}
            {settings.showHsn && <th>HSN/SAC</th>}
            <th>Qty</th>
            <th>Free</th>
            <th>Unit</th>
            <th>MRP</th>
            <th>Rate</th>
            <th>Disc %</th>
            <th>Disc Amt</th>
            <th>Taxable</th>
            {settings.showGstDetails && <th>CGST</th>}
            {settings.showGstDetails && <th>SGST</th>}
            {settings.showGstDetails && <th>IGST</th>}
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.items.map((item, index) => (
            <tr key={item.id}>
              <td data-label="Sr">{index + 1}</td>
              <td className="wrap" data-label="Item">
                <strong>{item.name}</strong>
                {settings.pharmaMode && item.scheduleType !== "-" && <span>Schedule: {item.scheduleType}</span>}
              </td>
              {settings.pharmaMode && <td data-label="Batch">{item.batchNumber}</td>}
              {settings.pharmaMode && <td data-label="Expiry">{item.expiryDate}</td>}
              {settings.showHsn && <td data-label="HSN/SAC">{item.hsnCode}</td>}
              <td data-label="Qty">{item.quantity}</td>
              <td data-label="Free">{item.freeQuantity}</td>
              <td data-label="Unit">{item.unit}</td>
              <td data-label="MRP">{formatMoney(item.mrp)}</td>
              <td data-label="Rate">{formatMoney(item.rate)}</td>
              <td data-label="Discount %">{item.discountPercent}%</td>
              <td data-label="Discount">{formatMoney(item.discountAmount)}</td>
              <td data-label="Taxable">{formatMoney(item.taxableValue)}</td>
              {settings.showGstDetails && <td data-label="CGST">{item.cgstPercent}%<br />{formatMoney(item.cgstAmount)}</td>}
              {settings.showGstDetails && <td data-label="SGST">{item.sgstPercent}%<br />{formatMoney(item.sgstAmount)}</td>}
              {settings.showGstDetails && <td data-label="IGST">{item.igstPercent}%<br />{formatMoney(item.igstAmount)}</td>}
              <td data-label="Amount"><strong>{formatMoney(item.finalAmount)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mobile-item-cards" aria-label="Invoice items">
        {invoice.items.map((item, index) => (
          <article className="mobile-item-card" key={`mobile-${item.id}`}>
            <div className="mobile-item-head">
              <span>#{index + 1}</span>
              <strong>{item.name}</strong>
              <b>{formatMoney(item.finalAmount)}</b>
            </div>
            <div className="mobile-item-facts">
              <div><span>Qty</span><strong>{item.quantity} {item.unit}</strong></div>
              <div><span>Rate</span><strong>{formatMoney(item.rate)}</strong></div>
              <div><span>Taxable</span><strong>{formatMoney(item.taxableValue)}</strong></div>
              <div><span>GST</span><strong>{item.cgstPercent + item.sgstPercent + item.igstPercent}%</strong></div>
              {settings.showHsn && <div><span>HSN/SAC</span><strong>{item.hsnCode}</strong></div>}
              {settings.pharmaMode && <div><span>Batch</span><strong>{item.batchNumber}</strong></div>}
              {settings.pharmaMode && <div><span>Expiry</span><strong>{item.expiryDate}</strong></div>}
            </div>
          </article>
        ))}
      </div>
    </>
  )
}

export function TotalsBlock({ invoice }: { invoice: PrintInvoice }) {
  const rows = [
    ["Subtotal", invoice.totals.subtotal],
    ["Discount", invoice.totals.discount],
    ["Taxable Amount", invoice.totals.taxableAmount],
    ["CGST", invoice.totals.cgst],
    ["SGST", invoice.totals.sgst],
    ["IGST", invoice.totals.igst],
    ["Round Off", invoice.totals.roundOff],
  ] as const

  return (
    <section className="total-grid">
      <div className="terms-card">
        <p className="print-eyebrow">Terms & Conditions</p>
        {invoice.terms.map((term) => <p key={term}>{term}</p>)}
        <p className="amount-words">{invoice.totals.amountInWords}</p>
      </div>
      <div className="total-card">
        {rows.map(([label, value]) => (
          <div key={label}><span>{label}</span><strong>{formatMoney(value)}</strong></div>
        ))}
        <div className="grand-total"><span>Grand Total</span><strong>{formatMoney(invoice.totals.grandTotal)}</strong></div>
      </div>
    </section>
  )
}

export function PaymentBlock({ invoice }: { invoice: PrintInvoice }) {
  return (
    <section className="payment-grid">
      <div><span>Payment Mode</span><strong>{invoice.payment.mode}</strong></div>
      <div><span>Paid Amount</span><strong>{formatMoney(invoice.payment.paidAmount)}</strong></div>
      <div><span>Due Amount</span><strong>{formatMoney(invoice.payment.dueAmount)}</strong></div>
      <div><span>Balance Amount</span><strong>{formatMoney(invoice.payment.balanceAmount)}</strong></div>
    </section>
  )
}

export function CodesBlock({ invoice, settings }: { invoice: PrintInvoice; settings: PrintSettings }) {
  return (
    <div className="codes-block">
      {settings.showBarcode && (
        <div>
          <Barcode value={invoice.barcodeValue} height={34} width={1.2} fontSize={9} margin={0} />
        </div>
      )}
      {settings.showQr && (
        <div>
          <QRCodeSVG value={invoice.qrValue} size={72} marginSize={1} />
        </div>
      )}
    </div>
  )
}

export function SignatureBlock({ settings }: { settings: PrintSettings }) {
  if (!settings.showSignature) return null
  return (
    <section className="signature-grid">
      <div><span>Customer Signature</span></div>
      <div><span>Authorized Signatory</span></div>
    </section>
  )
}
