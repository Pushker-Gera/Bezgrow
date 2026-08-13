import assert from "node:assert/strict"
import { PDFDocument } from "pdf-lib"
import { createInvoicePdf } from "../lib/pdf-invoice"
import { defaultPrintSettings } from "../components/print/settings/defaults"
import type { PrintFormat, PrintSettings } from "../components/print/types"
import { invoice } from "./test-invoice-pdf-layout"

const PT_PER_MM = 72 / 25.4
const toggles = [
  "showLogo",
  "showQr",
  "showBarcode",
  "showHsn",
  "showGstDetails",
  "showSignature",
  "showWatermark",
  "pharmaMode",
] as const

const targets: Array<{ label: string; format: PrintFormat; widthMm: number; heightMm?: number; thermalWidth: "58mm" | "80mm" }> = [
  { label: "a4", format: "a4", widthMm: 210, heightMm: 297, thermalWidth: "80mm" },
  { label: "half-compact", format: "half-compact", widthMm: 148, heightMm: 210, thermalWidth: "80mm" },
  { label: "half-top", format: "half-top", widthMm: 210, heightMm: 297, thermalWidth: "80mm" },
  { label: "thermal-58", format: "thermal", widthMm: 58, thermalWidth: "58mm" },
  { label: "thermal-80", format: "thermal", widthMm: 80, thermalWidth: "80mm" },
]

async function run() {
  let rendered = 0
  for (let mask = 0; mask < 2 ** toggles.length; mask += 1) {
    const options = Object.fromEntries(toggles.map((key, index) => [key, Boolean(mask & (1 << index))]))
    for (const target of targets) {
      const settings = {
        ...defaultPrintSettings,
        ...options,
        thermalWidth: target.thermalWidth,
      } as PrintSettings
      const bytes = await createInvoicePdf(invoice(3, true), settings, target.format)
      assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-", `${target.label}/mask-${mask} was not a PDF`)
      assert.ok(bytes.byteLength > 1_500, `${target.label}/mask-${mask} was unexpectedly empty`)
      const document = await PDFDocument.load(bytes)
      assert.equal(document.getPageCount(), 1, `${target.label}/mask-${mask} added an accidental page`)
      const page = document.getPage(0)
      assert.ok(page.node.Contents(), `${target.label}/mask-${mask} produced a blank first page`)
      assert.ok(Math.abs(page.getWidth() - target.widthMm * PT_PER_MM) < 0.3, `${target.label}/mask-${mask} used the wrong width`)
      if (target.heightMm) {
        assert.ok(Math.abs(page.getHeight() - target.heightMm * PT_PER_MM) < 0.3, `${target.label}/mask-${mask} used the wrong height`)
      } else {
        assert.ok(page.getHeight() > 100 * PT_PER_MM, `${target.label}/mask-${mask} did not grow with receipt content`)
      }
      rendered += 1
    }
  }
  assert.equal(rendered, 1_280)
  console.log(`invoice-pdf-options-ok combinations=${2 ** toggles.length} rendered=${rendered}`)
}

void run()
