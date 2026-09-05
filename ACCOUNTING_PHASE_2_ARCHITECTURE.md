# Bezgrow Accounting Phase 2 Architecture

Status: source implementation and macOS packaged validation complete on public application version `0.3.0`.

Scope: purchases, suppliers, accounts payable, customer and supplier settlements, local bank books and reconciliation, GST preparation, and accounting hardening. This extends the Phase 1 journal authority; it does not introduce a second accounting engine or any GSTN/bank-feed integration.

## Reliability incident and fix

The intermittent Accounting recovery page was a deterministic production server-render defect, not a SQLite readiness failure. The packaged startup log at `~/Library/Application Support/com.bezgrow.erp/Logs/bezgrow-startup.log` recorded:

```text
TypeError: f.accountingViews.some is not a function
at .next/server/app/dashboard/accounting/[view]/page.js
```

The dynamic server route imported `accountingViews` from the `"use client"` `AccountingWorkspace` module and called `.some()` on it. In a production React Server Components build, that import is a client-module reference rather than the array value. SQLite startup stages in the same log completed successfully, including connection creation, migration, schema-version, integrity, and repository initialization.

The route now imports `isAccountingView` from the server-safe `lib/accounting/views.ts` module. Navigation metadata is shared from that module and the client workspace only re-exports it for compatibility. The macOS packaged lifecycle test requests `/dashboard/accounting/purchases` after every authenticated runtime launch and fails on a 5xx response or the recovery-page text.

## Authority and transaction boundary

SQLite remains authoritative for ERP and accounting data. Supabase remains limited to the existing Bezgrow control plane. Phase 2 routes execute through the packaged Tauri SQLite bridge; they do not fall through to remote ERP storage.

Every financial workflow resolves the organization and financial year, rejects closed years and locked periods, constructs exact minor-unit entries in the central accounting domain, and commits source document, journal, party balance, GST classification, audit evidence, and stock effects in one `BEGIN IMMEDIATE` transaction.

Posted vouchers are balanced and source-linked with organization, financial year, source type, source ID, voucher date, reference, and finalization metadata. Unique source and idempotency constraints prevent duplicate posting. Posted journal lines, purchase headers/items, and the exact tax fields of journal-backed sales invoices are protected by SQLite triggers. Commercial corrections use reversals, debit notes, or credit notes.

## Purchase document and stock flow

`createPurchase` normalizes each line once and stores authoritative integer minor-unit values for gross, discount, taxable value, CGST, SGST, IGST, cess, charges, round-off, total, paid, and outstanding. Supported classifications are inventory, expense, fixed asset, and other; a selected eligible Chart of Accounts ledger can override the classification default.

An inventory line creates a stock batch and inventory receipt using the existing inventory tables. The batch records warehouse, supplier, source purchase, source line, batch number, expiry, original quantity, and exact purchase cost. Product stock, inventory availability, batch quantity, and stock movement are updated exactly once inside the purchase transaction. Non-inventory classifications do not create stock.

An optional paid amount creates a separate supplier-payment voucher and allocation, but both the purchase and settlement are committed atomically. A purchase with no settlement credits Accounts Payable. A cash/bank settlement debits Accounts Payable and credits the selected asset account.

Purchase reversal is available only while its stock remains unconsumed and the invoice has no settlement or debit note. Otherwise the user must use a linked return/correction. A purchase return references original lines, enforces cumulative returned quantity, removes only available stock from the source lot, reverses the original selected purchase ledger and input tax, and reduces the supplier payable. Any excess becomes a supplier-recoverable advance asset rather than negative payable.

## Exact purchase posting

The purchase journal is generated in `lib/accounting/phase2.ts`, not in the UI:

- Inventory / Purchases / Fixed Asset / Other Asset: debit by line taxable value.
- Input CGST / SGST / IGST / Cess: debit from exact stored line components.
- Freight/other charges and round-off: posted to their configured system ledgers.
- Accounts Payable: credit by unpaid supplier-settlement value.
- Reverse charge: output tax liability is credited while the supplier settlement excludes the reverse-charge tax.

Debit notes reverse those directions. Reverse-charge debit notes also reverse the corresponding output liability so the correction remains balanced.

Money is converted at the input boundary and then retained as safe integer minor units. Percentage multiplication and allocation ratios use integer/`BigInt` rounding. Explicit line tax components and totals are accepted only when they reconcile exactly.

## Suppliers, payables, payments, and advances

The local supplier master includes contact, addresses, state/PIN, GSTIN, PAN, terms, credit days, opening balance/type, notes, status, and compact operational metrics.

Credit purchases create invoice-level outstanding amounts. Supplier payments allocate across one or many purchase invoices. The allocation rows are independent audit records; invoice outstanding, supplier current balance, payment voucher, and allocations update together.

Unallocated supplier payment is posted to Advances to Suppliers. It can later be applied to an invoice through a distinct advance-application journal. Supplier opening advances are also represented as reusable `party_advances`.

Phase 1 controlled-opening payable and receivable journal lines are exposed as settlement documents. Schema 21 expands payment and advance allocation document types to `supplier_opening` and `customer_opening`, allowing old balances to be settled without fabricating purchase or sales invoices. Their remaining amount is derived from the posted opening line less payment and advance allocations.

Customer receipts use the same multi-allocation service. Excess receipts credit Advances from Customers and can later be applied to receivables. Receipts remain accounting transactions rather than invoice-status mutations.

## Sales credit notes

A sales credit note references the original invoice and selected original lines. It enforces cumulative return quantities and uses the original line's proportional exact taxable/tax components. It debits sales and output tax, credits Accounts Receivable up to the open amount, and credits Customer Advances for any excess. For stock items it restores the source batch/product availability and reverses COGS against inventory.

## Banking

Bank masters create a linked Chart of Accounts asset ledger and retain full identifiers only locally. Operational lists return a masked identifier. Opening balances create immutable opening vouchers.

Cash Book and Bank Book are queried from posted journal entries and include voucher metadata, debit, credit, and window-function running balance. They are paginated and CSV-exportable. Deposits, withdrawals, charges, interest, loans, receipts, payments, and contra movements continue to use the existing journal/voucher semantics.

Manual bank reconciliation stores status, cleared date, bank reference, notes, and actor against a bank ledger entry. It never changes journal amounts. No automatic bank feed is claimed.

## GST preparation

Sales, purchases, returns, credit notes, and GST-enabled expenses store reporting classification and exact tax fields. Purchase ITC defaults to `REVIEW_REQUIRED`; only `ELIGIBLE` amounts enter the GSTR-3B input-credit estimate. `EXEMPT`, `NIL_RATED`, and `NON_GST` values are not counted as taxable supplies.

Available local reports include GST Overview, Sales Register, Purchase Register, GSTR-1 preparation, GSTR-3B preparation, HSN/SAC summary, and GST Data Quality. GSTR workspaces are labelled “GST Return Preparation” and exports are not represented as directly uploadable GSTN filings.

GSTIN validation checks the local structure and checksum and reports “Format valid (registration status not checked).” Data-quality warnings cover missing/invalid GSTIN, missing state/HSN, missing classifications, interstate CGST/SGST, intrastate IGST, tax/rate mismatch, and duplicate supplier references. Warnings link to source IDs and never mutate posted records.

Expense GST supports supplier details, bill reference, HSN/SAC, taxable value, exact CGST/SGST/IGST/cess, place/supply classification, reverse charge, and ITC review status. Eligible tax uses input ledgers; ineligible tax remains in the expense cost. Reverse-charge output liabilities are posted separately.

## Reporting and navigation

Accounting navigation is grouped into Overview, Books, Sales & Receivables, Purchases & Payables, Banking, Tax, Reports, and Setup. The main application sidebar is unchanged.

Purchase and settlement reports are SQLite-paginated. Purchase Register returns supplier/product/GST-rate summaries; Payables and Receivables Aging include current, 1–30, 31–60, 61–90, and 90+ buckets and include unsettled controlled-opening balances. Supplier metrics include purchases, returns, paid, current/overdue payable, last purchase, and count.

General Ledger, Trial Balance, Profit & Loss, Balance Sheet, Cash Flow, party balances, stock cost, and GST reports continue to derive from their existing authoritative sources. Phase 2 does not maintain competing financial totals.

## Local schema and migration

The final local schema is 21:

- Schema 20 adds exact purchase fields, item tax/cost/source fields, exact sales fields, expense GST fields, five additional system ledgers, indexes, period guards, and posted-document immutability.
- It adds `payment_allocations`, `party_advances`, `advance_allocations`, `bank_reconciliations`, `accounting_period_locks`, `gst_transaction_classifications`, and `purchase_attachments`.
- Schema 21 safely rebuilds the two allocation tables to support controlled-opening settlement while copying all schema-20 allocation records and recreating their indexes.

The migration backfills only representable exact values from legacy documents, does not invent tax classifications, does not back-post historical invoices, and preserves closed-year guards. Migration runs transactionally, records `schema_migrations`, and is idempotent on later starts.

## Attachments, backup, privacy, and security

The native attachment picker accepts signature-validated PDF, PNG, JPEG, and WebP files up to 20 MB. Files are copied atomically into the managed `business-assets/purchase-attachments` directory; SQLite stores local relative path, MIME type, byte size, and SHA-256. The files never upload to Supabase.

Native backups already snapshot the authoritative SQLite database plus managed business assets. Restore verification now requires the Phase 2 relationships, checks SQLite integrity and foreign keys before replacement, and continues preserving license, App Lock, device identity, logos, settings, and business assets under the existing lifecycle policy.

No signing private key, service-role secret, platform-admin credential, supplier data, bank transaction, ledger, GST register, or purchase document was added to a client-to-Supabase data path.

## Verification boundary

Executed locally on macOS: lint, typecheck, the full `npm test` matrix, production Next build, desktop preparation, Rust formatting/checks, tracked Rust tests, Phase 1-to-Phase 2 migrations and backup copies, large-data benchmarks, macOS app/DMG packaging, a 20-cycle packaged lifecycle matrix, and 20 packaged Accounting purchase-route probes.

The repository's Windows source/installer contract passes and its Windows smoke harness now requires schema 21. An actual Windows MSI/NSIS install and runtime smoke cannot be executed on this macOS host; public release remains gated on that real Windows run, signing/notarization, and release publication checks.

Phase 3 items—GSTN filing, IRP/e-way bill, TDS, depreciation schedules, payroll, CA portal, bank APIs/feeds, and statutory automation—are intentionally absent.
