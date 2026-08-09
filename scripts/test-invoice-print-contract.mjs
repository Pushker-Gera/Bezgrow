import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

const engine = read("components/print/PrintEngine.tsx")
const preview = read("components/print/InvoicePdfPreview.tsx")
const documentPipeline = read("lib/invoice-document.ts")
const pdfClient = read("lib/invoice-pdf-client.ts")
const pdfGenerator = read("lib/pdf-invoice.ts")
const desktopExport = read("lib/desktop-file-export.ts")
const builder = read("lib/print-invoice-builder.ts")
const printPage = read("app/dashboard/invoices/[id]/print/page.tsx")
const secureShareClient = read("lib/secure-invoice-share-client.ts")
const secureShareApi = read("app/api/invoice-shares/route.ts")
const cleanupMigration = read("supabase/migrations/20260802000000_retire_cloud_erp.sql")
const legacyPublicInvoice = read("app/public/invoices/[id]/page.tsx")
const legacyPublicPdf = read("app/public/invoices/[id]/pdf/route.ts")
const exportModal = read("components/invoices/InvoiceExportModal.tsx")
const rust = read("src-tauri/src/lib.rs")
const capability = read("src-tauri/capabilities/default.json")

for (const removedTemplate of [
  "components/print/templates/A4Template.tsx",
  "components/print/templates/HalfCompactTemplate.tsx",
  "components/print/templates/HalfTopTemplate.tsx",
  "components/print/templates/PrintBlocks.tsx",
  "components/print/templates/ThermalTemplate.tsx",
]) {
  assert.equal(existsSync(new URL(`../${removedTemplate}`, import.meta.url)), false, `${removedTemplate} must remain retired`)
}

assert.match(engine, /getCanonicalInvoiceDocument\(effectiveInvoice, settings, format\)/, "Every invoice action must resolve the canonical PDF artifact.")
assert.match(engine, /PDF_REGENERATION_DEBOUNCE_MS = 180/, "PDF preview regeneration must be debounced.")
assert.match(engine, /renderSequence\.current !== sequence/, "Stale PDF renders must not replace a newer artifact.")
assert.match(engine, /actionInFlight\.current/, "Native document actions must reject rapid duplicate invocations.")
assert.match(engine, /<InvoicePdfPreview artifact=\{artifact\}/, "The embedded preview must render the canonical PDF artifact.")
assert.match(engine, /openPdfForNativePrinting\(document\.filename, document\.bytes, document\.pageCount\)/, "Print must open the canonical PDF bytes.")
assert.match(engine, /settings\.autoPrintAfterSave[\s\S]*openPdfForNativePrinting\(document\.filename, document\.bytes, document\.pageCount\)/, "Auto Print After Save must open the same canonical PDF bytes.")
assert.match(engine, /saveInvoicePdf\(document\)/, "Save PDF must consume the canonical artifact.")
assert.match(engine, /downloadInvoicePdf\(document\)/, "Download must consume the canonical artifact.")
assert.match(engine, /shareInvoicePdf\(document,/, "Generic share must consume the canonical artifact.")
assert.match(engine, /prepareDesktopInvoiceShare\(dialog\.artifact\.filename, dialog\.artifact\.bytes\)/, "WhatsApp and email must prepare the canonical bytes.")
assert.match(engine, /WhatsApp opened on the correct customer with the prepared message/, "WhatsApp must use the supported local-file fallback honestly.")
assert.match(engine, /Bezgrow did not upload/, "Local sharing must state its no-upload boundary.")
assert.doesNotMatch(engine, /createSecureInvoiceShare|revokeSecureInvoiceShare|Sign in while online before creating a secure invoice link/i, "Ordinary invoice actions must not require or invoke cloud sharing.")
assert.doesNotMatch(engine, /window\.print|printFromHiddenFrame|prepareDedicatedPrintRoot|<iframe|createPortal|html2canvas|jsPDF/, "Invoice printing must not retain an alternate HTML/canvas print tree.")

assert.match(preview, /import\("pdfjs-dist"\)/, "The embedded preview must render PDF bytes with PDF.js.")
assert.match(preview, /pdfjs\.getDocument\(\{ data: artifact\.bytes\.slice\(\) \}\)/, "PDF.js must receive a copy of the canonical bytes.")
assert.match(preview, /pdfDocument\.numPages !== artifact\.pageCount/, "Preview must verify its page count against the canonical artifact.")
assert.match(preview, /renderTasks\.forEach\(\(task\) => task\.cancel\(\)\)/, "Stale preview work must be cancelled.")

assert.match(documentPipeline, /createInvoicePdf\(invoice, settings, format\)/, "The canonical pipeline must have one invoice PDF renderer.")
assert.match(documentPipeline, /bytes\.byteLength < MINIMUM_INVOICE_PDF_BYTES/, "Blank/tiny PDFs must be rejected.")
assert.match(documentPipeline, /PDFDocument\.load\(bytes/, "Every canonical PDF must be reopened before use.")
assert.match(documentPipeline, /blank or contains no visible drawing operations/, "Every page must contain decoded drawing content.")
assert.match(documentPipeline, /A4 210mm x 297mm page contract/, "Full A4 geometry must be explicit.")
assert.match(documentPipeline, /148mm x 210mm page contract/, "Compact geometry must be explicit.")
assert.match(documentPipeline, /continuous-paper contract/, "Thermal width and continuous height must be explicit.")
assert.match(documentPipeline, /documentCache\.get\(key\)/, "Identical render requests must share cached work.")

assert.match(pdfClient, /saveDesktopBytes\(artifact\.filename, artifact\.bytes, "pdf"\)/, "Save must write the exact canonical bytes.")
assert.match(pdfClient, /new File\(\[createInvoicePdfBlob\(artifact\)\]/, "Native share must receive the canonical PDF file.")
assert.doesNotMatch(pdfClient, /createInvoicePdf\(/, "Save/share helpers must not invoke a second renderer.")
assert.match(desktopExport, /desktop_open_pdf_for_print/, "Desktop print must cross a dedicated validated PDF boundary.")
assert.doesNotMatch(pdfGenerator, /\bBuffer\b/, "The invoice renderer must remain browser-safe.")
assert.match(pdfGenerator, /"Thank you"/, "Generated PDFs need the exact primary footer.")
assert.match(pdfGenerator, /"Generated by Bezgrow"/, "Generated PDFs need the Bezgrow attribution.")
assert.doesNotMatch(pdfGenerator, /brandInitial|artificial logo|generated logo/i, "Generated PDFs must not invent a business logo.")

assert.match(builder, /resolvePrintOrganization/, "Invoice branding must resolve the best cached business record.")
assert.doesNotMatch(builder, /\/brand\/bezgrow-logo-3d\.png/, "A missing business logo must not be replaced by the Bezgrow product logo.")
assert.match(builder, /logoUrl: stringFrom\(organization/, "The invoice must use only the business's own uploaded logo.")
assert.match(printPage, /cachedSettings\.organization/, "Offline print branding must read locally saved business settings.")
assert.match(printPage, /cachedWorkspace\?\.organization/, "Offline print branding must use the licensed workspace identity.")

assert.doesNotMatch(secureShareClient, /fetch\s*\(|pdfBase64|NEXT_PUBLIC_DESKTOP_API_ORIGIN/, "Retired compatibility code must never upload a PDF.")
assert.doesNotMatch(secureShareClient, /SUPABASE_SERVICE_ROLE_KEY/, "The sharing client must never reference the service-role key.")
assert.match(secureShareApi, /localErpOnly/, "Hosted invoice sharing must fail closed.")
assert.match(cleanupMigration, /drop table if exists public\.invoice_share_links;/, "Cloud PDF share records must remain retired.")
assert.doesNotMatch(cleanupMigration, /drop table if exists public\.invoice_share_links cascade/, "Cloud share retirement must fail closed on unexpected dependencies.")
assert.match(legacyPublicInvoice, /notFound\(\)/, "Raw invoice-id public routes must stay disabled.")
assert.doesNotMatch(legacyPublicPdf, /adminSupabase|from\("invoices"\)/, "Raw public PDF routes must not query private invoice data.")
assert.match(legacyPublicPdf, /status: 404/, "Raw invoice-id PDF routes must stay disabled.")

assert.match(exportModal, /openPdfForNativePrinting\(result\.filename, result\.bytes, result\.pageCount\)/, "Invoice reports must print their already-generated PDF.")
assert.doesNotMatch(exportModal, /ReportPrintSheet|window\.print|createPortal/, "Reports must not retain a separate HTML printing tree.")
assert.match(exportModal, /The report remains on this device\. Bezgrow does not upload it\./, "Report sharing must state the local-only boundary.")

assert.match(rust, /fn validate_pdf_for_native_open/, "Native PDF opening must have a validation boundary.")
assert.match(rust, /bytes\.len\(\) < 1_500 \|\| !bytes\.starts_with\(b"%PDF-"\)/, "Native code must reject blank/invalid PDF bytes.")
assert.match(rust, /windows\(5\).*b"%%EOF"/s, "Native code must reject incomplete PDFs.")
assert.match(rust, /written != bytes/, "The application-owned temporary PDF must equal the canonical bytes.")
assert.match(rust, /saved file bytes do not match the generated document/, "Save PDF must reopen and byte-compare the chosen destination.")
assert.match(rust, /prepared invoice PDF bytes do not match the validated document/, "Local share preparation must reopen and byte-compare its attachment.")
assert.match(rust, /managed_data_directory\(&app, "Temp"\)\?\.join\("PDF Print"\)/, "Temporary print files must use an application-owned directory.")
assert.match(rust, /cfg\(target_os = "macos"\)[\s\S]*Command::new\("open"\)/, "macOS must open the validated PDF with an OS-supported application.")
assert.match(rust, /cfg\(target_os = "windows"\)[\s\S]*windows_hidden_command\("rundll32\.exe"\)/, "Windows must open the PDF without a visible console.")
assert.doesNotMatch(rust, /desktop_print_current_webview|desktop_finish_print|desktop_open_invoice_print_window|printOperationWithPrintInfo|window\.print\(\)|\blpr\b|\blp\b/, "Legacy custom invoice print backends must be removed.")
assert.doesNotMatch(rust, /desktop_save_invoice_pdf/, "The obsolete invoice-only save command must be removed.")
assert.match(capability, /allow-desktop-open-pdf-for-print/, "The validated native PDF command must be granted.")
assert.doesNotMatch(capability, /invoice-print|desktop-print-current-webview|desktop-save-invoice-pdf/, "Retired print windows and commands must not retain capability access.")

console.log("invoice-print-contract-ok canonical_pdf=true legacy_print=false cloud_upload=false")
