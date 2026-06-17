import type { Metadata } from "next"
import { FeaturePage } from "@/components/marketing/FeaturePage"

export const metadata: Metadata = {
  title: "Retail POS Software | Bezgrow",
  description: "Fast retail POS billing with barcode scanning, customer management, payment tracking, and thermal receipt printing.",
  alternates: { canonical: "https://www.bezgrow.com/pos" },
}

export default function PosPage() {
  return (
    <FeaturePage
      eyebrow="Retail POS"
      title="Fast retail POS software for barcode billing, receipts, and customer checkout."
      description="Run quick billing counters with barcode-friendly workflows, customer lookup, payment status, thermal receipts, and sales visibility."
      highlights={["Barcode billing", "Quick checkout", "Thermal receipt", "Customer lookup", "Payment modes", "Retail analytics"]}
      workflows={["Scan products", "Bill customers", "Print receipts"]}
      metrics={[["Checkout", "Fast"], ["Receipts", "80mm"], ["Customers", "Linked"]]}
    />
  )
}
