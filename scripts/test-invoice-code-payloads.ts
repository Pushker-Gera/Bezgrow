import assert from "node:assert/strict"
import {
  BarcodeFormat,
  BinaryBitmap,
  Code39Reader,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} from "@zxing/library"
import QRCode from "qrcode"
import sharp from "sharp"
import { code39Modules, code39Payload } from "../lib/pdf-invoice"
import { buildInvoiceQrPayload } from "../lib/print-invoice-builder"

function decodeLuminance(luminance: Uint8ClampedArray, width: number, height: number, format: BarcodeFormat) {
  const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(luminance, width, height)))
  return (format === BarcodeFormat.QR_CODE ? new QRCodeReader() : new Code39Reader()).decode(bitmap).getText()
}

async function decodeQrDataUrl(dataUrl: string) {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64")
  const { data, info } = await sharp(bytes).greyscale().raw().toBuffer({ resolveWithObject: true })
  return decodeLuminance(new Uint8ClampedArray(data), info.width, info.height, BarcodeFormat.QR_CODE)
}

function decodeCode39(value: string) {
  const modules = code39Modules(value)
  const moduleWidth = 4
  const quietModules = 12
  const width = (modules.length + quietModules * 2) * moduleWidth
  const height = 120
  const luminance = new Uint8ClampedArray(width * height).fill(255)
  modules.forEach((black, moduleIndex) => {
    if (!black) return
    const left = (quietModules + moduleIndex) * moduleWidth
    for (let y = 10; y < height - 10; y += 1) {
      luminance.fill(0, y * width + left, y * width + left + moduleWidth)
    }
  })
  return decodeLuminance(luminance, width, height, BarcodeFormat.CODE_39)
}

async function run() {
  const qrPayload = buildInvoiceQrPayload({
    business: "R & G Healthcare",
    gstin: "09ABCDE1234F1Z5",
    invoiceNumber: "INV-00003",
    invoiceDate: "2026-08-13",
    customer: "Sample Customer",
    subtotal: 1000,
    tax: 180,
    grandTotal: 1180,
    paymentStatus: "Partial",
    paid: 500,
    due: 680,
  })
  // Match the exact bitmap options embedded by the canonical PDF renderer.
  const qrDataUrl = await QRCode.toDataURL(qrPayload, { errorCorrectionLevel: "M", margin: 1, width: 220 })
  const decodedQr = await decodeQrDataUrl(qrDataUrl)
  assert.equal(decodedQr, qrPayload, "The generated QR bitmap must decode to its saved invoice summary")
  for (const expected of [
    "BEZGROW INVOICE",
    "Business: R & G Healthcare",
    "Invoice: INV-00003",
    "Grand Total: Rs 1180.00",
    "Payment Status: Partial",
    "Balance Due: Rs 680.00",
  ]) assert.match(decodedQr, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  for (const secret of ["licence", "license key", "device id", "token", "password", "secret", "internal database id"]) {
    assert.doesNotMatch(decodedQr, new RegExp(secret, "i"))
  }

  const barcodePayload = code39Payload("INV-00003")
  const decodedBarcode = decodeCode39(barcodePayload)
  assert.equal(decodedBarcode, barcodePayload, "The generated Code 39 bars must decode to the visible invoice reference")

  console.log(JSON.stringify({
    status: "invoice-code-payloads-ok",
    qrDecoded: decodedQr,
    barcodeDecoded: decodedBarcode,
    secretsPresent: false,
  }))
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
