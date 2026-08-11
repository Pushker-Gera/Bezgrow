# Bezgrow Windows Final Test Checklist

Use this checklist on a Windows 10 (version 1809 or newer) or Windows 11 64-bit laptop. You do not need the source code.

Record the date, Windows version, Bezgrow version, installer filename, and any failed step. Keep one copy of your test backup on an external drive.

## 1. Download and verify

- Open `https://www.bezgrow.com/download`.
- Confirm the Windows card says `x64`, shows version `0.1.6`, an installer type, file size, checksum status, and signing status.
- Click **Download for Windows**. Confirm the downloaded filename is `Bezgrow_0.1.6_x64-setup.exe`.
- Confirm the download is an application, not a webpage. Its size should match the website.
- Open PowerShell in Downloads and run:

  ```powershell
  Get-FileHash .\Bezgrow_0.1.6_x64-setup.exe -Algorithm SHA256
  ```

- Compare every character with the SHA-256 shown on the download page or GitHub Release.
- If the release is unsigned, expect Microsoft Defender SmartScreen. Click **More info**, verify the app name is Bezgrow and the publisher is honestly shown as unknown, then choose **Run anyway** only for this expected internal test build. A signed release should show the configured Bezgrow publisher and a valid digital signature in file Properties.

## 2. Install and first launch

- Run the installer. Confirm Bezgrow installs under Program Files.
- Confirm the Bezgrow logo appears in the installer, Programs and Features, Start menu, desktop shortcut, taskbar, title bar, and Windows Search.
- Launch from the Start menu. Confirm no command window or normal browser opens.
- Confirm the app reaches setup/login without a “local database could not start” error.
- In Task Manager, confirm one Bezgrow app and its expected child runtime are present, not several duplicate groups.
- Complete first setup and create or select a local workspace.
- Activate using a valid Windows license by paste or imported license file. Restart Bezgrow and confirm it does not ask for the same license again.

## 3. Offline and persistence

- Close Bezgrow normally, turn off Wi-Fi and unplug Ethernet, then launch it again.
- Confirm the local workspace, active license, settings, and dashboard open offline.
- Confirm products, customers, invoices, stock, purchases, reports, search, filters, printing, PDF, CSV, local backup, and local restore remain available.
- Restart Windows while still offline, launch Bezgrow, and confirm the device/license and workspace remain valid.
- Log out and sign back into the local workspace. Confirm logout did not clear the license or business data.

## 4. Product, customer, stock, and invoice checks

- Create a product with SKU, category, supplier, unit, MRP, sale/purchase prices, quantity, low-stock threshold, GST, HSN, batch, expiry, and warehouse.
- Find it by search, edit its price and quantity, restart Bezgrow, and confirm the edit persisted.
- Archive the product if supported and confirm it is hidden from normal selection without damaging its history.
- Create a customer with phone, email, address, GSTIN, type, and credit information.
- Search for and edit the customer. Confirm ledger, purchase history, and outstanding balance screens load.
- Create a GST invoice with at least two line items, a discount, round-off, payment mode, partial paid amount, and due amount.
- Confirm invoice numbering is unique, totals/tax are correct, and stock is deducted once.
- Update the payment and confirm due/status, customer ledger, stock history, dashboard, and reports update correctly.
- Restart Bezgrow and reopen the historical invoice. Confirm all lines and totals persisted.
- Exercise supplier purchase/incoming stock, warehouse adjustment/transfer, batch/expiry, and return flows that are visible in your edition.
- Check sales, stock, GST/tax, outstanding, customer ledger, product movement, profit estimate, daily, and date-range reports.

## 5. Print and PDF

- Open Print Settings and test A4, Half A4 Compact, Half A4 Top, and 80 mm thermal.
- Test margins, font sizes, logo, QR, barcode, HSN, GST details, signature, watermark, black-and-white, pharma mode, and auto-print where available.
- Print Preview each format. Check there is no clipping, overlap, blank page, tiny text, or scrolling of the whole page.
- Print one A4 invoice to Microsoft Print to PDF or a real A4 printer.
- Print an 80 mm invoice to the actual thermal printer if available. Confirm width, page length, totals, and footer.
- Use **Save PDF** with the native dialog. Save once to Documents and once to a folder whose name contains spaces or non-English characters.
- Open both PDFs and confirm the logo, customer, products, GST, QR/barcode, totals, and page dimensions.
- Export the invoice register PDF with a date range and customer filter and confirm it opens and is not empty.

## 6. CSV, WhatsApp, email, and logo

- Open invoice CSV export, choose date, customer, status, payment, payment method, and GST filters, then save through the Windows dialog.
- Open the CSV in Excel. Confirm readable headings, correct filters/dates/amounts/GST, intact leading-zero values, and no shifted columns after commas, quotes, or line breaks.
- Upload a PNG/JPEG/WebP business logo through the native picker. Confirm preview/aspect ratio, replace, restart persistence, invoice/PDF/print display, and removal.
- Use WhatsApp for an invoice. Confirm the number and complete professional invoice summary are correct, with no manual file instructions.
- Use email for an invoice. Confirm recipient, subject, message, and PDF path/handoff. Do not mark it passed if the UI falsely claims an attachment was sent.

## 7. Backup and restore

- Create a backup through the native dialog in a folder with spaces.
- Create another backup directly on a USB/external drive.
- Confirm each `.bezgrow-backup` file is non-empty and has a manifest/version/checksum when inspected by Bezgrow.
- Add a clearly named test product after the backup, then restore the earlier backup.
- Confirm Bezgrow validates it, creates a safety backup, restores cleanly, and reloads safely. Confirm the pre-backup data returns and the active compatible license remains.
- Try restoring a copied backup with one byte deliberately changed. Confirm Bezgrow rejects it without changing the current database.
- Try a missing/incorrect file and confirm a clear error with no data loss.

## 8. Update, close, uninstall, and reinstall

- In Settings, click **Check for updates**. With no newer version, confirm there is no permanent update badge or false pending count.
- If a newer release exists, confirm version, notes, size, signing status, and correct Windows artifact. Start the update and confirm SHA-256 verification before the installer opens.
- Install the newer version. Confirm license, workspace, products, customers, invoices, logo, print settings, and backups persist.
- Export Desktop Diagnostics. Open the JSON and confirm it contains technical state only—no full license key, passwords, tokens, customers, products, invoices, or private business data.
- Close Bezgrow from the window and tray/menu if present. Wait 15 seconds and use Task Manager **Details** to confirm no Bezgrow or Bezgrow-bundled Node process remains.
- Repeat launch/close four times and confirm no duplicate server, random persistent port, or orphan process accumulates.
- Uninstall Bezgrow from Windows Settings. Confirm the app and shortcuts are removed. The user data should remain unless you explicitly chose a remove-data option.
- Reinstall the same genuine installer. Confirm the license, workspace, products, customers, invoices, settings, and logo return.

If any step fails, export Desktop Diagnostics before changing or reinstalling anything and record the exact step, message, and time.
