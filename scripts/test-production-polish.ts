import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
// @ts-expect-error node:sqlite ships with Node 22; the project keeps Node 20 declarations for Next compatibility.
import { DatabaseSync } from "node:sqlite"
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib"
import { defaultPrintSettings } from "../components/print/settings/defaults"
import type { PrintFormat } from "../components/print/types"
import { INDIA_GST_STATES, formatIndiaState, gstStateFromGstin, stateCodeForName } from "../lib/india-gst-states"
import { formatExactIndianMoney, moneyDisplay } from "../lib/money-format"
import { containedImageDimensions, createInvoicePdf } from "../lib/pdf-invoice"
import { buildPrintInvoice } from "../lib/print-invoice-builder"
import { LOCAL_DB_VERSION, localMigrations } from "../lib/offline/local/schema"
import { invoice } from "./test-invoice-pdf-layout"

async function pdfText(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const standardFontDataUrl = decodeURIComponent(new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).pathname)
  const loading = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl })
  try {
    const document = await loading.promise
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "))
    }
    return pages.join(" ").replace(/\s+/g, " ")
  } finally {
    await loading.destroy()
  }
}

async function paintedRasterImageCount(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const standardFontDataUrl = decodeURIComponent(new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).pathname)
  const loading = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl })
  try {
    const document = await loading.promise
    let count = 0
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const operators = await page.getOperatorList()
      count += operators.fnArray.filter((operator) =>
        operator === pdfjs.OPS.paintImageXObject ||
        operator === pdfjs.OPS.paintInlineImageXObject ||
        operator === pdfjs.OPS.paintImageMaskXObject
      ).length
    }
    return count
  } finally {
    await loading.destroy()
  }
}

async function pdfTextBaselines(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const standardFontDataUrl = decodeURIComponent(new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).pathname)
  const loading = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl })
  try {
    const page = await (await loading.promise).getPage(1)
    const content = await page.getTextContent()
    return content.items.flatMap((item) => "transform" in item ? [item.transform[5]] : [])
  } finally {
    await loading.destroy()
  }
}

function embeddedImages(bytes: Uint8Array) {
  return PDFDocument.load(bytes).then((document) => document.context.enumerateIndirectObjects().flatMap(([, object]) => {
    if (!(object instanceof PDFRawStream) || String(object.dict.get(PDFName.of("Subtype"))) !== "/Image") return []
    const width = object.dict.lookup(PDFName.of("Width"), PDFNumber).asNumber()
    const height = object.dict.lookup(PDFName.of("Height"), PDFNumber).asNumber()
    return [{ width, height, bytes: object.getContents().byteLength }]
  }))
}

function verifyStatePersistence() {
  const directory = mkdtempSync(path.join(tmpdir(), "bezgrow-state-persistence-"))
  const databasePath = path.join(directory, "state.db")
  let database = new DatabaseSync(databasePath)
  try {
    database.exec("PRAGMA foreign_keys = ON")
    for (const migration of localMigrations) {
      for (const statement of migration.sql) {
        try {
          database.exec(statement)
        } catch (error) {
          const duplicateColumn = /^\s*ALTER\s+TABLE/i.test(statement) && error instanceof Error && /duplicate column name/i.test(error.message)
          if (!duplicateColumn) throw error
        }
      }
      database.prepare("INSERT OR REPLACE INTO schema_migrations (version, name) VALUES (?, ?)").run(migration.version, migration.name)
      database.exec(`PRAGMA user_version = ${migration.version}`)
    }
    database.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").run("state-test-org", "State Test")
    database.prepare("INSERT INTO customers (id, organization_id, name, state, state_code) VALUES (?, ?, ?, ?, ?)")
      .run("state-test-customer", "state-test-org", "Local Customer", "Haryana", "06")
    database.close()
    database = new DatabaseSync(databasePath)
    const restored = database.prepare("SELECT state, state_code FROM customers WHERE id = ?").get("state-test-customer") as { state?: string; state_code?: string }
    assert.equal(restored.state, "Haryana")
    assert.equal(restored.state_code, "06")
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, LOCAL_DB_VERSION)
  } finally {
    try { database.close() } catch {}
    rmSync(directory, { recursive: true, force: true })
  }
}

async function run() {
  assert.ok(INDIA_GST_STATES.length >= 36, "The India state selector must include states and union territories")
  assert.equal(stateCodeForName("Haryana"), "06")
  assert.equal(stateCodeForName("Delhi"), "07")
  assert.equal(stateCodeForName("Rajasthan"), "08")
  assert.equal(stateCodeForName("Punjab"), "03")
  assert.equal(stateCodeForName("Maharashtra"), "27")
  assert.deepEqual(gstStateFromGstin("06ABCDE1234F1Z5"), { name: "Haryana", code: "06" })
  assert.equal(formatIndiaState("Haryana", "06"), "Haryana (06)")
  assert.equal(formatIndiaState("-", "-"), "-")
  verifyStatePersistence()

  const built = buildPrintInvoice({
    invoice: { id: "state-invoice", invoice_number: "INV-STATE", grand_total: 118, paid_amount: 18, due_date: "2026-08-31" },
    items: [],
    organization: { id: "state-test-org", name: "Local Business" },
    customer: { id: "state-test-customer", name: "Local Customer", state: "Haryana" },
    products: [],
    origin: "http://localhost",
  })
  assert.equal(built.customer.stateCode, "06", "Invoice construction must use the reusable GST-state mapping")
  assert.equal(built.payment.dueAmount, 100, "Balance due must be max(grand total - paid, 0)")
  const credited = buildPrintInvoice({
    invoice: { id: "credit-invoice", invoice_number: "INV-CREDIT", grand_total: 118, paid_amount: 150, outstanding_amount: -32 },
    items: [],
    organization: { id: "state-test-org", name: "Local Business" },
    customer: { id: "state-test-customer", name: "Local Customer" },
    products: [],
    origin: "http://localhost",
  })
  assert.equal(credited.payment.dueAmount, 0, "Balance due must not become negative")

  const representative = invoice(5, true)
  representative.watermark = "LOCAL WATERMARK"
  const paid = {
    ...representative,
    dueDate: "-",
    payment: { ...representative.payment, paidAmount: representative.totals.grandTotal, dueAmount: 0, balanceAmount: 0 },
  }
  const formats: PrintFormat[] = ["a4", "half-compact", "half-top", "thermal"]
  const packagedWebKitLogo = representative.enterprise.logoUrl.replace(",", ",\n")
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("data:")) {
      throw new Error("Packaged WebKit blocks fetch(data:...) in this regression fixture.")
    }
    return originalFetch(input, init)
  }) as typeof fetch
  try {
    const packagedBytes = await createInvoicePdf(
      { ...representative, enterprise: { ...representative.enterprise, logoUrl: packagedWebKitLogo } },
      { ...defaultPrintSettings, showLogo: true, showQr: false, showBarcode: false },
      "a4"
    )
    assert.ok(await paintedRasterImageCount(packagedBytes) > 0, "Saved data-URL logos must render when packaged WebKit blocks fetch(data:...)")
  } finally {
    globalThis.fetch = originalFetch
  }

  for (const format of formats) {
    const settings = {
      ...defaultPrintSettings,
      thermalWidth: "80mm" as const,
      pharmaMode: true,
      showLogo: true,
      showQr: false,
      showBarcode: false,
      showWatermark: true,
    }
    const bytes = await createInvoicePdf(paid, settings, format)
    const images = await embeddedImages(bytes)
    assert.ok(images.some((image) => image.width === 900 && image.height === 180 && image.bytes > 0), `${format} must embed non-empty saved logo image data`)
    assert.ok(await paintedRasterImageCount(bytes) > 0, `${format} must paint the saved logo into rendered page content`)
    const text = await pdfText(bytes)
    assert.match(text, /Due Date: -/, `${format} must render a clean missing due-date fallback`)
    assert.match(text, /Balance Due:? Rs 0\.00/, `${format} must render a fully-paid balance of zero`)
    assert.match(text, /State: Delhi \(07\)/, `${format} must render the customer state cleanly`)
    assert.doesNotMatch(text, /State: - \(-\)/, `${format} must never render empty state parentheses`)
    assert.match(text, /30049099/, `${format} must preserve HSN in pharma fixtures`)
    assert.match(text, /B-1/, `${format} must preserve pharma batch data`)
    assert.match(text, /LOCAL WATERMARK/, `${format} must preserve the low-opacity business watermark`)

    const unpaidBytes = await createInvoicePdf(representative, settings, format)
    const unpaidText = await pdfText(unpaidBytes)
    assert.match(unpaidText, /Due Date:? 8\/8\/2026/, `${format} must render the formatted due date`)
    assert.match(unpaidText, /Balance Due:? Rs \d+\.\d{2}/, `${format} must render the monetary balance with distinct terminology`)
    if (format === "half-top") {
      const halfTop = await PDFDocument.load(unpaidBytes)
      const firstPage = halfTop.getPage(0)
      const baselines = await pdfTextBaselines(unpaidBytes)
      assert.ok(baselines.length > 0 && Math.min(...baselines) >= firstPage.getHeight() / 2, "Half A4 Top text must stay entirely inside the upper 50% print area")
    }
  }
  const contained = containedImageDimensions(900, 180, 86, 54)
  assert.equal(contained.width / contained.height, 5, "Rectangular logos must preserve their aspect ratio")
  assert.ok(contained.width <= 86 && contained.height <= 54, "Logo dimensions must remain inside the format-specific bounds")

  const noLogo = await embeddedImages(await createInvoicePdf(representative, {
    ...defaultPrintSettings,
    showLogo: false,
    showQr: false,
    showBarcode: false,
  }, "a4"))
  assert.equal(noLogo.length, 0, "No substitute logo may be generated when the saved logo is disabled")
  const missingStateText = await pdfText(await createInvoicePdf({
    ...representative,
    customer: { ...representative.customer, state: "-", stateCode: "-" },
  }, { ...defaultPrintSettings, showQr: false, showBarcode: false }, "a4"))
  assert.match(missingStateText, /State: -/)
  assert.doesNotMatch(missingStateText, /State: - \(-\)/)

  assert.equal(formatExactIndianMoney(0), "₹0")
  assert.equal(formatExactIndianMoney(-125000), "-₹1,25,000")
  const representativeMoney = [
    [999, "exact"],
    [9_999, "exact"],
    [99_999, "exact"],
    [9_99_999, "compact"],
    [1_23_45_678, "compact"],
    [9_99_99_99_999, "compact"],
    [1_00_00_00_00_00_000, "compact"],
    [Number.MAX_SAFE_INTEGER, "compact"],
  ] as const
  for (const [value, expectedMode] of representativeMoney) {
    const formatted = moneyDisplay(value)
    assert.equal(formatted.compact ? "compact" : "exact", expectedMode, `${value} must use ${expectedMode} KPI formatting`)
    assert.equal(formatted.exact, formatExactIndianMoney(value), `${value} must preserve its exact accounting value`)
    if (formatted.compact) assert.match(formatted.display, /(?:L|Cr)$/, `${value} must use an Indian compact-money suffix`)
  }

  const enterpriseAmount = moneyDisplay(12_333_432_060_0)
  assert.equal(enterpriseAmount.compact, true)
  assert.match(enterpriseAmount.display, /(?:Cr|L Cr)$/)
  assert.equal(enterpriseAmount.exact, "₹1,23,33,43,20,600")

  const moneyComponent = readFileSync(new URL("../components/MoneyValue.tsx", import.meta.url), "utf8")
  assert.match(moneyComponent, /title=\{formatted\.exact\}/, "Exact KPI money must be available by tooltip")
  assert.match(moneyComponent, /aria-label=\{formatted\.exact\}/, "Exact KPI money must be exposed accessibly")
  assert.match(moneyComponent, /min-w-0/, "Money values must be allowed to shrink inside grid and flex cards")
  assert.match(moneyComponent, /overflow-hidden/, "Money values must never paint outside their KPI card")
  for (const source of [
    "app/dashboard/page.tsx",
    "app/dashboard/inventory/page.tsx",
    "app/dashboard/products/page.tsx",
    "app/dashboard/charts/page.tsx",
    "app/dashboard/billing/page.tsx",
    "app/dashboard/invoices/page.tsx",
  ]) {
    const text = readFileSync(new URL(`../${source}`, import.meta.url), "utf8")
    assert.match(text, /<MoneyValue/, `${source} must use the reusable monetary KPI component`)
    assert.match(text, /min-w-0/, `${source} KPI cards must prevent grid overflow`)
  }

  console.log(`production-polish-ok formats=${formats.length} states=${INDIA_GST_STATES.length} logo=900x180 exact=${enterpriseAmount.exact}`)
}

void run()
