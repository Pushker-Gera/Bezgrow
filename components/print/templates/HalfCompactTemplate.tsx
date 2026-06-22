"use client"

import type { PrintInvoice, PrintSettings } from "@/components/print/types"
import { CodesBlock, CustomerBlock, GeneratedByFooter, HeaderBlock, ItemTable, PaymentBlock, SignatureBlock, TotalsBlock } from "./PrintBlocks"

export function HalfCompactTemplate({ invoice, settings }: { invoice: PrintInvoice; settings: PrintSettings }) {
  return (
    <article className="invoice-paper print-half-compact">
      {settings.showWatermark && <div className="watermark">{invoice.watermark}</div>}
      <HeaderBlock invoice={invoice} settings={settings} compact />
      <CustomerBlock invoice={invoice} />
      <ItemTable invoice={invoice} settings={settings} compact />
      <TotalsBlock invoice={invoice} />
      <PaymentBlock invoice={invoice} />
      <div className="footer-row compact-footer">
        <CodesBlock invoice={invoice} settings={settings} />
        <SignatureBlock settings={settings} />
      </div>
      <GeneratedByFooter compact />
    </article>
  )
}
