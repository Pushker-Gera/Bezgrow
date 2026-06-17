import type { Metadata } from "next"
import { FeaturePage } from "@/components/marketing/FeaturePage"

export const metadata: Metadata = {
  title: "GST Billing Software | Bezgrow",
  description: "Create GST invoices, A4 bills, thermal receipts, payment records, and professional billing workflows with Bezgrow.",
  alternates: { canonical: "https://www.bezgrow.com/billing" },
}

export default function BillingPage() {
  return (
    <FeaturePage
      eyebrow="GST billing"
      title="Professional billing software for GST invoices, payments, and print-ready bills."
      description="Generate GST-ready invoices, retail bills, wholesale invoices, A4 prints, compact bills, thermal receipts, and payment tracking for modern businesses."
      highlights={["GST invoices", "A4 printing", "Thermal receipts", "Payment tracking", "Customer billing", "Invoice sharing"]}
      workflows={["Create invoices", "Collect payments", "Print and share bills"]}
      metrics={[["GST", "Ready"], ["Prints", "4 formats"], ["Payments", "Tracked"]]}
    />
  )
}
