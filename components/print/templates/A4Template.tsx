"use client"

import type { PrintInvoice, PrintSettings } from "@/components/print/types"
import { CodesBlock, CustomerBlock, GeneratedByFooter, HeaderBlock, ItemTable, PaymentBlock, SignatureBlock, TotalsBlock } from "./PrintBlocks"

export function A4Template({ invoice, settings }: { invoice: PrintInvoice; settings: PrintSettings }) {
  return (
    <article className="invoice-paper print-a4">
      {settings.showWatermark && <div className="watermark">{invoice.watermark}</div>}
      <HeaderBlock invoice={invoice} settings={settings} />
      <CustomerBlock invoice={invoice} />
      <ItemTable invoice={invoice} settings={settings} />
      <TotalsBlock invoice={invoice} />
      <PaymentBlock invoice={invoice} />
      <div className="footer-row">
        <CodesBlock invoice={invoice} settings={settings} />
        <SignatureBlock settings={settings} />
      </div>
      <GeneratedByFooter />
      <div className="page-number">Page 1</div>
    </article>
  )
}
