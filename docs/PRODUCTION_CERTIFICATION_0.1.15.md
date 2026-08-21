# Bezgrow 0.1.15 Production Certification

This release was certified with synthetic data in disposable SQLite databases under the operating-system temporary directory. No customer database, Supabase ERP table, or existing Bezgrow application-data directory was read or modified.

## Test environment

- Platform: macOS arm64 (Darwin 25.5.0)
- Node.js: 22.19.0
- Rust/Cargo: 1.96.0
- SQLite: Node 22 `node:sqlite`
- Local schema: version 14
- Acceptance ceiling: every interactive query/write p95 below 2,000 ms; repeated bounded reads below 96 MB RSS growth; `PRAGMA quick_check = ok`; zero foreign-key violations

Run with:

```bash
npm run test:large-scale
```

## Dataset matrix

| Dataset | Products | Customers | Invoices | Invoice items | Stock movements | SQLite bytes |
|---|---:|---:|---:|---:|---:|---:|
| A | 2,000 | 5,000 | 20,000 | 40,000 | 40,000 | 82,739,200 |
| B | 5,000 | 10,000 | 50,000 | 100,000 | 100,000 | 204,783,616 |
| C | 10,000 | 25,000 | 100,000 | 300,000 | 300,000 | 549,609,472 |

## Interactive latency (milliseconds)

| Dataset | Operation | p50 | p95 | Worst |
|---|---|---:|---:|---:|
| A | Product search + page | 0.150 | 0.189 | 0.309 |
| A | Product no-match search | 0.324 | 0.334 | 0.452 |
| A | Customer search + page metrics | 0.262 | 0.390 | 0.404 |
| A | Customer no-match search | 0.555 | 0.572 | 0.805 |
| A | Invoice search + page item metrics | 0.340 | 0.418 | 0.511 |
| A | Invoice no-match search | 10.113 | 11.133 | 11.489 |
| A | Dashboard aggregate | 2.048 | 2.226 | 2.413 |
| A | 24-month report aggregate | 4.527 | 4.798 | 4.944 |
| A | Atomic invoice write (rolled back) | 0.070 | 0.121 | 0.232 |
| A | Invoice status write (rolled back) | 0.021 | 0.030 | 0.054 |
| A | Invoice delete + stock restore (rolled back) | 0.254 | 0.387 | 0.531 |
| A | Cold database open + schema probe | 0.154 | 0.203 | 0.340 |
| B | Product search + page | 0.151 | 0.156 | 0.210 |
| B | Product no-match search | 0.784 | 0.902 | 1.123 |
| B | Customer search + page metrics | 0.272 | 0.383 | 0.536 |
| B | Customer no-match search | 1.058 | 1.158 | 1.677 |
| B | Invoice search + page item metrics | 0.498 | 0.512 | 0.966 |
| B | Invoice no-match search | 29.814 | 31.014 | 33.985 |
| B | Dashboard aggregate | 5.169 | 5.382 | 6.254 |
| B | 24-month report aggregate | 12.653 | 12.977 | 13.184 |
| B | Atomic invoice write (rolled back) | 0.065 | 0.092 | 0.232 |
| B | Invoice status write (rolled back) | 0.021 | 0.026 | 0.042 |
| B | Invoice delete + stock restore (rolled back) | 0.190 | 0.233 | 0.339 |
| B | Cold database open + schema probe | 0.154 | 0.278 | 0.293 |
| C | Product search + page | 0.152 | 0.160 | 0.490 |
| C | Product no-match search | 1.517 | 1.630 | 2.816 |
| C | Customer search + page metrics | 0.269 | 0.364 | 0.948 |
| C | Customer no-match search | 2.567 | 2.859 | 4.210 |
| C | Invoice search + page item metrics | 0.904 | 1.000 | 1.591 |
| C | Invoice no-match search | 64.897 | 67.468 | 73.396 |
| C | Dashboard aggregate | 10.630 | 11.510 | 12.698 |
| C | 24-month report aggregate | 28.265 | 28.847 | 29.121 |
| C | Atomic invoice write (rolled back) | 0.070 | 0.097 | 0.261 |
| C | Invoice status write (rolled back) | 0.021 | 0.022 | 0.043 |
| C | Invoice delete + stock restore (rolled back) | 0.240 | 0.273 | 0.418 |
| C | Cold database open + schema probe | 0.148 | 0.256 | 0.328 |

List, status, aggregate, and filtered-query figures use 35 measured iterations; no-match searches, invoice creation/deletion, and cold startup use 20. Combined product, customer, and invoice filters were also measured on every tier; the largest p95 values were 0.015 ms, 0.072 ms, and 0.139 ms respectively. The complete matrix took 25.20 seconds, including generation, integrity checks, backup/restore, and soak work.

## Query-plan evidence

- Product search uses `idx_products_org_name` for workspace scoping.
- Invoice history uses `idx_sales_invoices_org_date_active` for the bounded page.
- Current-page item aggregation uses `idx_sales_items_invoice_active (organization_id, invoice_id, deleted_at)` with an `invoice_page` list subquery and Bloom filter; it does not aggregate all 300,000 item rows.
- Customer invoice metrics are restricted to IDs in the bounded customer page.
- Invoice status writes use the primary invoice identifier instead of rewriting invoice history.
- Migration 14 repairs each workspace's next-invoice counter once; normal invoice creation then reads that constant-time counter instead of scanning historical invoice numbers.
- Invoice deletion/reversal uses `idx_movements_org_reference_active (organization_id, reference_type, reference_id, deleted_at)` and updates only the selected invoice, its line items, allocated batches, accounting documents, and customer balance in one transaction.
- The slowest measured interactive query was a deliberately absent invoice search at the largest tier: p95 67.468 ms and worst 73.396 ms. No query approached the 500 ms local-search target.

## Integrity, backup, and soak

| Dataset | 500-cycle RSS growth | Backup copy | Restore + quick check | Result |
|---|---:|---:|---:|---|
| A | 13.813 MB | 42.797 ms | 96.111 ms | quick check ok; 0 FK violations |
| B | 0.484 MB | 119.143 ms | 247.692 ms | quick check ok; 0 FK violations |
| C | 5.563 MB | 312.207 ms | 2,364.570 ms | quick check ok; 0 FK violations |

Restored databases retained the exact invoice count for each tier. The certification also proves that the database trigger rejects product stock underflow and that all measured invoice writes roll back cleanly.

## Print and licence matrices

- Invoice PDF layouts: GST and non-GST invoices with 1, 10, 30, 50, and 100 line items across A4, half-compact, half-top, 80 mm thermal, and 58 mm thermal (50 documents), plus wide, square, tall, and no-logo thermal variants. Continuous thermal output remained one page; paper formats used controlled continuation pages without blank pages.
- The four thermal logo variants were rendered to PNG and visually inspected. Logos remained contain-fitted and the business name stayed separated below the logo box.
- Licence tests cover initial activation, pasted keys, signature tampering, wrong device/single-device binding, valid offline cache, grace, expiry, renewal, revoked, cancelled/suspended, replaced, invalid, tampered, missing activation, malformed expiry, and clock rollback.
- Updater tests cover N→N+1 comparison/state, 48-hour safe delay, Remind Later, strict OS/CPU selection, launch confirmation, SHA-256 mismatch, and Minisign Ed25519 verification. Native/installer lifecycle coverage runs again on the platform-specific release builders.

## Isolated admin/control-plane scale fixture

The admin route contract was also exercised against disposable relational fixtures with matching licences, customers, businesses, and registered devices. No Supabase production rows were created. The route contract requires exact-count server pagination with a 50-row range, bounded search, idempotent generation, and indexed device/business lookups.

| Licences / customers / businesses / devices | Fixture size | Operation | p50 ms | p95 ms | Worst ms |
|---:|---:|---|---:|---:|---:|
| 1,000 each | 1,277,952 bytes | Search + exact count | 0.347 | 0.358 | 0.420 |
| 5,000 each | 6,234,112 bytes | Search + exact count | 1.677 | 1.724 | 1.870 |
| 10,000 each | 12,500,992 bytes | Search + exact count | 3.909 | 4.209 | 4.697 |
| 10,000 each | 12,500,992 bytes | Paginated list | 0.034 | 0.039 | 0.221 |
| 10,000 each | 12,500,992 bytes | Generate transaction (rolled back) | 0.035 | 0.048 | 0.100 |
| 10,000 each | 12,500,992 bytes | Revoke transaction (rolled back) | 0.011 | 0.012 | 0.025 |
| 10,000 each | 12,500,992 bytes | Renew transaction (rolled back) | 0.008 | 0.009 | 0.010 |
| 10,000 each | 12,500,992 bytes | Device lookup | 0.002 | 0.003 | 0.011 |
| 10,000 each | 12,500,992 bytes | Business lookup | 0.002 | 0.002 | 0.007 |

These figures certify bounded query/transaction behavior without touching the live control plane; they deliberately exclude real Internet and hosted PostgreSQL latency. The one-device binding test rejects a second registered device for the same licence, while the main licence matrix covers wrong-device rejection and authorized replacement/reactivation policy.

## Architecture outcome

SQLite remains the authoritative ERP datastore. Supabase remains limited to the control plane (authentication, signed licence metadata, device reporting, release/update metadata, optional consented backup metadata, support, and audit records). The scale generator and benchmark do not add demo rows to production or customer databases.
