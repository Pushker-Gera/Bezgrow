import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { defaultPrintSettings } from "../components/print/settings/defaults"
import type { PrintFormat, PrintInvoice, PrintSettings } from "../components/print/types"
import { createInvoicePdf } from "../lib/pdf-invoice"
import { invoice } from "./test-invoice-pdf-layout"

const outputDirectory = process.argv[2] || "/private/tmp/bezgrow-production-polish-qa"
mkdirSync(outputDirectory, { recursive: true })

const representative = invoice(8, true)
representative.invoiceNumber = "QA-PREMIUM-0008"
representative.enterprise.name = "Aarogya Lifecare Pharmaceuticals Wholesale and Retail Private Limited"
representative.enterprise.address = "Plot 128, Industrial Health District, Sector 44, Gurugram, Haryana 122003, India"
representative.customer.name = "Shree Balaji Medical and General Stores"
representative.customer.address = "Shop 18, Ground Floor, Central Market Complex, Near District Hospital, Old Railway Road, Gurugram, Haryana 122001"
representative.customer.state = "Haryana"
representative.customer.stateCode = "06"
representative.customer.gstin = "06ABCDE1234F1Z5"
representative.payment = {
  ...representative.payment,
  paidAmount: 0,
  dueAmount: representative.totals.grandTotal,
  balanceAmount: representative.totals.grandTotal,
}
representative.notes = "Medicines are supplied against the customer order. Please retain this invoice for batch traceability."
representative.terms = ["Payment is due by the stated due date.", "Returns are subject to batch and expiry verification."]

const fullyPaid: PrintInvoice = {
  ...representative,
  id: "qa-fully-paid",
  invoiceNumber: "QA-PAID-0008",
  payment: {
    ...representative.payment,
    paidAmount: representative.totals.grandTotal,
    dueAmount: 0,
    balanceAmount: 0,
  },
}

const scenarios: Array<{
  name: string
  invoice: PrintInvoice
  format: PrintFormat
  settings: Partial<PrintSettings>
}> = [
  { name: "a4-logo-gst-state-unpaid", invoice: representative, format: "a4", settings: {} },
  { name: "a4-no-logo", invoice: representative, format: "a4", settings: { showLogo: false } },
  { name: "a4-fully-paid", invoice: fullyPaid, format: "a4", settings: {} },
  { name: "half-compact-multiple-lines", invoice: representative, format: "half-compact", settings: {} },
  { name: "half-top-multiple-lines", invoice: representative, format: "half-top", settings: {} },
  { name: "thermal-80-logo-unpaid", invoice: representative, format: "thermal", settings: { thermalWidth: "80mm" } },
  { name: "thermal-58-paid", invoice: fullyPaid, format: "thermal", settings: { thermalWidth: "58mm" } },
]

async function run() {
  for (const scenario of scenarios) {
    const bytes = await createInvoicePdf(scenario.invoice, {
      ...defaultPrintSettings,
      ...scenario.settings,
      showQr: true,
      showBarcode: true,
      showHsn: true,
      showGstDetails: true,
      showSignature: true,
      showWatermark: true,
      pharmaMode: true,
    }, scenario.format)
    writeFileSync(path.join(outputDirectory, `${scenario.name}.pdf`), bytes)
  }

  console.log(JSON.stringify({ outputDirectory, files: scenarios.map((scenario) => `${scenario.name}.pdf`) }, null, 2))
}

void run()
