# BezGrow Accounting Phase 3 Architecture

## Scope and authority

Phase 3 extends the existing Phase 1 and Phase 2 local accounting book. It does not create a second ledger. Local SQLite remains authoritative for accounts, vouchers, tax records, assets, dimensions, budgets, reconciliations, and reports. Supabase remains outside the accounting data path.

All authoritative money is posted and reported in integer minor units. Every posted voucher must have at least two non-zero one-sided lines, equal debit and credit totals, organization and financial-year scope, a unique source identity, and a unique voucher number. Posted voucher headers and lines are immutable. Corrections use linked reversals, returns, notes, or replacement transactions.

## Verified Phase 1/2 baseline and Phase 3 action matrix

| Area | Phase 1/2 evidence | Correctness state before Phase 3 | Phase 3 action |
| --- | --- | --- | --- |
| Double-entry journal | `journal-posting.ts`, accounting core/integration tests | Present and exact | Preserved; expanded native and health diagnostics |
| Posted immutability/reversal | schema triggers and reversal builders | Present | Preserved; audit events expanded |
| Historical activation/opening | `initializeAccounting` | Present | Preserved; local business-date default fixed |
| Sales/COGS/output GST | normalized invoice atomic repository | Present | Preserved; professional voucher series integrated |
| Purchases/AP/inventory | `accounting-phase2.ts` | Present | Preserved; rollback tests and voucher series added |
| Receipts/payments/advances | Phase 2 settlement journals | Present | Preserved; voucher series and allocation rollback coverage added |
| GST registers/preparation | Phase 2 GST reports | Present but preparation-focused | Extended with return states, preflight, imports, and reconciliation |
| Bank books/reconciliation | Phase 2 bank services | Present | Extended with structured import and confirm-only match suggestions |
| Period lock/year close | service and database enforcement | Present | Audit trail and professional health workspace integrated |
| P&L custom period | report query | Defective: closing balances leaked into custom periods | Fixed to use period movements while Balance Sheet retains cumulative closing balances |
| Cash flow | journal-derived query | Defective: ambiguous cash movements defaulted to operating | Fixed; ambiguous mappings are reported as `UNCLASSIFIED` |
| Voucher numbering | mixed sequences and source numbers | Incomplete across workflows | One financial-year/business/voucher-type series engine |
| Fixed assets | Not present | Missing | Asset master, acquisition, SLM/WDV schedules, depreciation, disposal/write-off |
| TDS/TCS | Not present | Missing | Effective-dated configurable rules, journals, registers, payment/challan tracking |
| Dimensions/budgets | Not present | Missing | Optional exact allocations and ledger/dimension budgets |
| Audit/CA workflows | Partial local audit logs | Incomplete | Immutable accounting audit stream, auditor, health, CA, search, comparative and insight views |

## Schema 21 to 22

Schema 22 adds voucher-series fields and cash-flow classification to existing accounting tables and adds these organization-scoped tables:

- `accounting_voucher_series`
- `accounting_dimensions`
- `accounting_dimension_allocations`
- `accounting_budgets`
- `fixed_asset_categories`
- `fixed_assets`
- `fixed_asset_depreciation`
- `fixed_asset_disposals`
- `tax_rules`
- `tax_transactions`
- `gst_return_periods`
- `gst_import_batches`
- `gst_import_records`
- `gst_reconciliations`
- `statutory_integrations`
- `e_invoice_preparations`
- `e_way_bill_preparations`
- `bank_statement_imports`
- `bank_statement_lines`
- `bank_statement_matches`
- `accounting_audit_events`

The migration adds indexes for report/search paths and database triggers for immutable audit events, closed-year/locked-period enforcement, posted/reversed voucher events, GST classification changes, bank reconciliation changes, and year closing. It is transactional and idempotent; production-like schema 21 data is verified by counts and checksum before and after upgrade.

## Posting architecture

Normal user actions remain source-document workflows:

```text
Sale / Purchase / Receive / Pay / Expense / Return / Asset / Tax
                              |
                              v
                    validate business input
                              |
                              v
                 one local SQLite transaction
                    /         |          \
             source rows  subledger    balanced voucher
                    \         |          /
                              v
                    immutable audit event
```

If any required statement fails, the whole transaction rolls back. Source and idempotency uniqueness prevent duplicate posting. Voucher series advance inside the same transaction as the posted journal.

## Phase 3 subsystems

### Fixed assets

Assets retain original cost, residual value, useful life, configurable SLM/WDV policy, category account mappings, gross cost, accumulated depreciation, written-down value, source purchase/supplier, optional dimensions, and lifecycle state. Acquisition, depreciation, disposal, and write-off each post a balanced voucher. Schedules distinguish posted rows from `PROJECTED_NOT_POSTED` rows. Disposal removes gross cost and accumulated depreciation and posts the genuine gain or loss.

### TDS and TCS

Rates, thresholds, sections, PAN requirements, and effective dates are configuration data, not hard-coded statutory claims. TDS expense accrual separates gross expense, supplier liability, and TDS payable. TCS increases customer receivable and TCS payable. Tax settlement debits the payable and credits the selected cash/bank account, then records the challan/reference and linked payment voucher.

### GST and statutory preparation

Existing CGST/SGST/IGST/cess and ITC accounting is retained. Return preparation uses truthful states (`DRAFT`, `NEEDS_REVIEW`, `READY_FOR_EXPORT`, `EXPORTED`, `FILED_EXTERNALLY`) and does not claim GSTN filing. Structured GSTR-2A/2B imports are hashed, validated, deduplicated, and reconciled without mutating books. E-Invoice and E-Way Bill modules validate and store preparation data behind provider boundaries; absent credentials remain explicitly `NOT_CONFIGURED` and no IRN/E-Way number is fabricated.

### Dimensions and budgets

Cost centres, departments, and projects are optional. Every allocation group must reconcile exactly to the allocated journal-line amount. Budgets may be scoped by financial year, period, ledger, and optional dimension. Actuals are read from posted journals in set-based queries; exceeding a budget warns but never blocks valid accounting.

### Professional reporting

The P&L is period-movement based. The Balance Sheet is cumulative through the selected date and exposes any equation difference as a critical integrity error. Cash Flow is journal-derived and preserves unclassified movements. Trial Balance, General Ledger, party statements, asset/tax registers, GST preparation, comparative reports, deterministic insights, audit trail, auditor mode, accountant workspace, and accounting search are financial-year scoped and exportable. CSV metadata includes business, GSTIN, year, report, period, and generation timestamp.

### Health and recovery

Accounting Health reports, but never silently repairs, unbalanced journals, orphan lines, duplicate source postings, invalid financial-year mappings, invalid minor-unit lines, dimension mismatches, GST review items, bank reconciliation backlog, overdue parties, fixed-asset-to-GL differences, AR/AP-to-subledger differences, inventory-to-GL valuation differences, missing inventory cost, and negative inventory state.

Native backup/restore integrity includes Phase 3 foreign-key relationships. Restore still follows the existing installation identity, license, and App Lock preservation architecture.

## Test evidence

Permanent tests cover exact minor-unit calculations, generated invariants, schema 21 to 22 migration preservation, immutable audit events, posting integration, injected transaction failures, GST reconciliation, statutory-preparation truthfulness, asset lifecycle, TDS/TCS, dimensions, budgets, custom-period P&L, and a deterministic golden company with exact Trial Balance and Balance Sheet expectations. Release/package evidence is reported separately because source completeness does not imply platform or signing readiness.
