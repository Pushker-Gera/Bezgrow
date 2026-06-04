"use client"

import type { PrintInvoice, PrintSettings } from "@/components/print/types"
import { CodesBlock, CustomerBlock, HeaderBlock, ItemTable, PaymentBlock, TotalsBlock } from "./PrintBlocks"

export function HalfTopTemplate({ invoice, settings }: { invoice: PrintInvoice; settings: PrintSettings }) {
  return (
    <article className="invoice-paper print-half-top">
      <div className="top-half-content">
        {settings.showWatermark && <div className="watermark">{invoice.watermark}</div>}
        <HeaderBlock invoice={invoice} settings={settings} compact />
        <CustomerBlock invoice={invoice} />
        <ItemTable invoice={invoice} settings={settings} compact />
        <TotalsBlock invoice={invoice} />
        <PaymentBlock invoice={invoice} />
        <CodesBlock invoice={invoice} settings={settings} />
      </div>
      <div className="manual-notes-space">
        <span>Manual notes / logistics / delivery record</span>
      </div>
    </article>
  )
}
