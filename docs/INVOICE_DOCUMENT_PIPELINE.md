# Invoice Document Pipeline

## Canonical flow

```text
local SQLite invoice data
  -> PrintInvoice render model
  -> one pdf-lib invoice renderer
  -> validated CanonicalInvoiceDocument bytes
     -> PDF.js embedded preview
     -> Save PDF / Download PDF
     -> operating-system PDF application for printing
     -> OS share sheet / WhatsApp / email delivery
```

The `Uint8Array` in `CanonicalInvoiceDocument` is the invoice document source of truth. Preview, Save, Download, Print, generic Share, WhatsApp, and Email receive that same artifact. Actions do not create a second HTML, canvas, screenshot, or PDF render.

## Runtime validation

`lib/invoice-document.ts` reopens every generated PDF before it can be used. It verifies:

- `%PDF-` header and a sensible minimum byte size;
- expected page count for representative one-page invoices;
- non-empty decoded drawing streams on every page;
- invoice metadata identity;
- exact A4, A5/half-A4, half-top, or selected thermal-width page geometry.

The desktop boundary validates the header, EOF marker, page objects, content streams, expected page count, exact written bytes, and the final application-owned temporary file before the operating system opens it.

## Preview and regeneration

PDF.js renders the validated bytes into the existing invoice preview area. A template or invoice-affecting setting change invalidates the document key. Regeneration is debounced, stale requests are ignored, and identical requests share an in-memory promise/cache. Logo and QR source bytes are cached separately by the renderer.

## Page contracts

- Full A4: 210mm x 297mm portrait. Ordinary invoices remain one page; unusually long invoices use controlled continuation pages instead of microscopic type.
- Half A4 Compact: 148mm x 210mm portrait, recomposed for the smaller geometry and paginated when required.
- Half A4 Top: A4 pages with every invoice page constrained to the intended top half and the lower physical half blank.
- Thermal: selected 58mm or 80mm width with content-driven height. Thermal output is never placed on A4.

Uploaded PNG, JPEG, and supported WebP logos are local business data. Invoice rendering uses contain-fit geometry so square, portrait, and wide logos retain their aspect ratio. Watermarks are centered, diagonal, low-opacity drawing operations behind invoice content.

The QR bitmap contains a deterministic, compact summary from the saved invoice snapshot: business, invoice reference/date, customer name, subtotal, tax, grand total, payment status, paid, and due. It never contains licence keys, device identifiers, authentication tokens, internal database IDs, or application secrets. The Code 39 barcode contains only the human-readable invoice reference printed below it. Automated tests decode both generated symbols.

## Save and print

Save writes the already-validated artifact through the native save dialog and checks the returned byte count before reporting success.

Print writes the same bytes atomically to Bezgrow's managed `Temp/PDF Print` directory, reopens and revalidates the file, then opens it in the platform's registered PDF application. The user invokes that application's normal Print command and operating-system print dialog. Bezgrow does not use printer drivers, CUPS, `lp`/`lpr`, shell print verbs, silent spoolers, synthetic keyboard shortcuts, hidden frames, HTML print CSS, or WebView print operations. Because Bezgrow does not wait on a browser `afterprint` event, cancelling the OS dialog cannot leave an application spinner active.

## Local-first sharing

Ordinary WhatsApp and Email actions require no Bezgrow cloud session. They:

1. use the same validated local PDF artifact;
2. prepare it in Bezgrow's managed `Exports/Invoice Shares` directory;
3. use an OS file share sheet when supported; otherwise reveal/select the file;
4. open the normalized WhatsApp customer chat or default email composer with the prepared message;
5. leave the final delivery and Send action under the user's control when direct file sharing is unavailable.

No normal invoice action uploads PDF bytes or ERP records to Supabase. Legacy cloud share endpoints remain fail-closed after the local-first cutover. A future online link service must be a separate explicit opt-in action with upload consent; it must never block local printing, saving, or sharing.

## Retired invoice print paths

The invoice-specific cloned DOM root, temporary HTML document, hidden iframe, isolated `invoice-print` Tauri WebView, `window.print()` script, WKWebView print operation, `afterprint` timeout, and dynamic print CSS page sizing were removed. The old React/HTML invoice template tree was also removed so it cannot drift from or be invoked instead of the canonical PDF renderer.

Invoice reports now also open their already-generated PDF artifact instead of printing a separate hidden HTML report. `ShippingLabel.tsx` remains a separate non-invoice label feature and is not part of the invoice document pipeline.
