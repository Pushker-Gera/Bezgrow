"use client"

import Barcode from "react-barcode"
import { QRCodeSVG } from "qrcode.react"
import type { PrintInvoice, PrintSettings } from "@/components/print/types"
import { formatDate, formatMoney } from "@/components/print/utils"

export function ThermalTemplate({ invoice, settings }: { invoice: PrintInvoice; settings: PrintSettings }) {
  return (
    <article className={`invoice-paper print-thermal thermal-${settings.thermalWidth.replace("mm", "")}`}>
      <header className="thermal-center">
        <h1>{invoice.enterprise.name}</h1>
        <p>{invoice.enterprise.address}</p>
        <p>GST: {invoice.enterprise.gstNumber}</p>
        <p>Phone: {invoice.enterprise.phone}</p>
      </header>

      <div className="thermal-rule" />
      <div className="thermal-row"><span>Invoice</span><strong>{invoice.invoiceNumber}</strong></div>
      <div className="thermal-row"><span>Date</span><strong>{formatDate(invoice.invoiceDate)}</strong></div>
      <div className="thermal-row"><span>Customer</span><strong>{invoice.customer.name}</strong></div>
      <div className="thermal-row"><span>Phone</span><strong>{invoice.customer.phone}</strong></div>
      <div className="thermal-row"><span>Payment</span><strong>{invoice.payment.mode}</strong></div>
      <div className="thermal-rule" />

      <table className="thermal-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            {settings.showGstDetails && <th>GST</th>}
            <th>Amt</th>
          </tr>
        </thead>
        <tbody>
          {invoice.items.map((item) => (
            <tr key={item.id}>
              <td>{item.name}<br /><span>{item.hsnCode} {item.batchNumber !== "-" ? `B:${item.batchNumber}` : ""}</span></td>
              <td>{item.quantity}</td>
              {settings.showGstDetails && <td>{item.cgstPercent + item.sgstPercent + item.igstPercent}%</td>}
              <td>{formatMoney(item.finalAmount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="thermal-rule" />
      <div className="thermal-row"><span>Subtotal</span><strong>{formatMoney(invoice.totals.subtotal)}</strong></div>
      <div className="thermal-row"><span>Discount</span><strong>{formatMoney(invoice.totals.discount)}</strong></div>
      <div className="thermal-row"><span>GST</span><strong>{formatMoney(invoice.totals.cgst + invoice.totals.sgst + invoice.totals.igst)}</strong></div>
      <div className="thermal-total"><span>Total</span><strong>{formatMoney(invoice.totals.grandTotal)}</strong></div>
      <div className="thermal-row"><span>Cash Received</span><strong>{formatMoney(invoice.payment.cashReceived)}</strong></div>
      <div className="thermal-row"><span>Balance</span><strong>{formatMoney(invoice.payment.balanceAmount)}</strong></div>

      <div className="thermal-rule" />
      {settings.showBarcode && <Barcode value={invoice.barcodeValue} height={34} width={1} fontSize={8} margin={0} />}
      {settings.showQr && <div className="thermal-center"><QRCodeSVG value={invoice.qrValue} size={82} /></div>}
      <p className="thermal-center">{invoice.notes}</p>
      <p className="thermal-center">Thank you for your business.</p>
    </article>
  )
}
