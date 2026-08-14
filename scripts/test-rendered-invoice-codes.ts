import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BinaryBitmap, Code39Reader, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from "@zxing/library"
import sharp from "sharp"
import { defaultPrintSettings } from "../components/print/settings/defaults"
import { createInvoicePdf } from "../lib/pdf-invoice"
import { invoice } from "./test-invoice-pdf-layout"

async function bitmap(path: string, region?: { left: number; top: number; width: number; height: number }) {
  const input = sharp(readFileSync(path))
  const source = region ? input.extract(region) : input
  const { data, info } = await source.greyscale().raw().toBuffer({ resolveWithObject: true })
  return new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(Uint8ClampedArray.from(data), info.width, info.height)))
}

async function run() {
  const work = mkdtempSync(join(tmpdir(), "bezgrow-rendered-codes-"))
  try {
    const sample = invoice(5, true)
    const pdfPath = join(work, "sample.pdf")
    const imagePrefix = join(work, "sample")
    writeFileSync(pdfPath, await createInvoicePdf(sample, {
      ...defaultPrintSettings,
      pharmaMode: true,
      showBarcode: true,
      showLogo: true,
      showQr: true,
      showWatermark: true,
    }, "a4"))
    execFileSync("pdftoppm", ["-f", "1", "-singlefile", "-png", "-r", "300", pdfPath, imagePrefix], { stdio: "ignore" })
    const renderedPath = `${imagePrefix}.png`
    const metadata = await sharp(readFileSync(renderedPath)).metadata()
    const pageWidth = metadata.width || 0
    const pageHeight = metadata.height || 0
    assert.ok(pageWidth > 1_000 && pageHeight > 1_000, "The 300-DPI rendered page is unexpectedly small")
    const decodedQr = new QRCodeReader().decode(await bitmap(renderedPath, {
      left: Math.floor(pageWidth * 0.31),
      top: Math.floor(pageHeight * 0.63),
      width: Math.floor(pageWidth * 0.22),
      height: Math.floor(pageHeight * 0.20),
    })).getText()
    const decodedBarcode = new Code39Reader().decode(await bitmap(renderedPath, {
      left: Math.floor(pageWidth * 0.03),
      top: Math.floor(pageHeight * 0.65),
      width: Math.floor(pageWidth * 0.37),
      height: Math.floor(pageHeight * 0.15),
    })).getText()

    assert.equal(decodedQr, sample.qrValue, "The QR rendered into the actual 300-DPI invoice page must decode exactly")
    assert.equal(decodedBarcode, sample.barcodeValue, "The barcode rendered into the actual invoice page must match its visible reference")
    assert.match(decodedQr, /BEZGROW INVOICE[\s\S]*Grand Total:[\s\S]*Payment Status:[\s\S]*Balance Due:/)
    assert.doesNotMatch(decodedQr, /licen[cs]e key|device id|token|password|secret|database id/i)

    console.log(`rendered-invoice-codes-ok qr_chars=${decodedQr.length} barcode=${decodedBarcode} dpi=300`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
