# Bezgrow Phase 1 accounting architecture

## Production audit and preserved authority

- The desktop database remains `sqlite:bezgrow-offline.db`, opened by the existing Tauri/SQLite startup manager in the existing application-data root. Application identity, device identity, licence, app lock, admin-device policy, updater, printing, and asset paths are unchanged.
- `organizations`, `financial_years`, products, inventory rows, batches, stock movements, customers, suppliers, invoices/items, payments/receipts, expenses, settings, and backup manifests remain the operational model. Invoice `grand_total`/`total_amount`, recorded GST components, `paid_amount`, and `outstanding_amount` remain the sale authority.
- Physical cost uses consumed batch `purchase_rate`, with the product's recorded `purchase_rate` only when no batch-specific rate exists. MRP and selling price are never cost inputs. Unknown cost creates a local accounting warning and contributes no fabricated COGS.
- Native writes use the existing single-connection `BEGIN IMMEDIATE` transaction batch. Invoice, items, stock, payment state, accounting journal, and warnings are committed or rolled back together.
- Native backups are exact SQLite snapshots plus the existing asset payload. Restore preserves installation-scoped licence/device records and verifies `quick_check`, foreign keys, and the accounting invariants before accepting restored data.

## Journal model (schema version 19)

`chart_of_accounts` is the local ledger master. Phase 1 adds protected system/tax roles and optional customer/supplier links. Custom accounts can be created and renamed; accounts with posted history retain their classification, and system accounts cannot be deactivated or deleted.

`accounting_vouchers` is the journal header. It stores organization, financial year, date, voucher/source identities, exact integer-minor totals, reversal links, origin metadata, status, and finalization time. A partial unique index makes each posted operational `(organization, source_type, source_id)` idempotent.

`accounting_voucher_entries` is the journal line table. Exact debit/credit minor units, account, customer/supplier dimensions, and references are stored on each line. SQLite triggers reject zero-sided, double-sided, negative, cross-business, closed-year, out-of-year, incomplete, or unbalanced postings. Posted headers and lines are immutable; corrections append linked reversal journals.

`accounting_settings`, `accounting_sequences`, and `accounting_warnings` store the activation boundary, voucher numbering, schema/accounting version, and disclosed cost-quality issues. Existing expense, payment, invoice-item, and stock-movement rows carry links/exact cost fields needed for reconciliation.

## Existing-business activation

Historical invoices are deliberately **not back-posted**. Older data may lack a complete deterministic cost trail, so synthesizing historical COGS would make formal reports misleading. Accounting starts at a controlled opening date in an open financial year:

1. Default accounts are created idempotently.
2. Current customer receivables and supplier payables are posted by party.
3. Physical stock is valued only from genuine recorded batch/product purchase cost.
4. Cash, bank, capital, loans/liabilities, and other ledgers can be added through a balanced opening voucher.
5. Inventory/AR/AP cannot be entered as undimensioned manual openings; inventory is tied to physical quantity and party balances are tied to customer/supplier records.
6. Unknown inventory cost remains visible as a warning and is never guessed.

This preserves operational history while ensuring every formal report is meaningful from the activation boundary onward.

## Posting rules

- Sale: debit Cash/Bank and/or Accounts Receivable; debit Sales Discount when present; credit Sales and exact Output CGST/SGST/IGST; use Round Off for the exact grand-total difference. Stocked cost adds debit COGS / credit Inventory.
- Receipt: debit Cash/Bank and credit Accounts Receivable. Multiple and partial receipts remain separate source-linked journals.
- Expense: debit the expense and any explicit Input GST; credit Cash/Bank when paid or Accounts Payable/Other Liability when unpaid.
- Contra/payment/journal/opening: use the same multi-line validator and journal writer.
- Cancellation/correction: append an exact inverse journal linked to its original. Invoice cancellation restores physical stock and reverses sale, tax, receivable/cash, COGS, inventory, and subsequent linked receipts in one transaction.

## Reports and financial years

General Ledger, Trial Balance, Profit & Loss, Balance Sheet, Cash Flow, dashboard balances, expenses, and post-activation customer statements read posted journal data. Queries are organization/year/date scoped and indexed; journal, ledger, and expense lists are paginated. Trial Balance and the Balance Sheet expose integrity failures rather than adding arbitrary plugs.

Closing checks include SQLite integrity, foreign keys, journal balance/header totals, line validity, financial-year mapping, and orphan detection. Starting the next year creates one idempotent `YEAR_OPENING` journal for asset, liability, and equity balances, preserving customer/supplier dimensions. Income and expenses restart at zero and the completed result flows to retained/opening equity.

## Phase boundary and privacy

This phase does not add purchase/GRN/return workflows, GST-return filing or reconciliation, banking reconciliation/import, CA workspace, TDS/TCS, e-invoice/e-way-bill, cost centres, budgets, or compliance integrations. No accounting module imports Supabase and no ERP accounting CRUD path leaves the local computer.
