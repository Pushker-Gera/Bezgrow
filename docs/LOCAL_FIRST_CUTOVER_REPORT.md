# Bezgrow local-first cutover report

Completed 2026-08-02 IST. This report distinguishes verified results from work that still requires an external platform or credential.

## 1. Previous architecture found

The repository had a mixed-authority ERP: SQLite plus IndexedDB compatibility storage, hosted ERP API routes backed by Supabase, bootstrap hydration from hosted records, a retrying offline upload queue, direct Supabase detail-page fallbacks, browser workspace hydration, PDF/report uploads, and admin synchronization/telemetry language. A valid local license could still be followed by implicit update/check-in traffic.

## 2. Supabase ERP dependencies removed

- Hosted product, customer, invoice, order, inventory, dashboard, settings, workspace, invoice-share, and report-share routes now fail closed with `410 LOCAL_ERP_DESKTOP_ONLY`.
- Local bootstrap, synchronization, offline queue writes, cloud hydration, cloud fallback adapters, and automatic network-restoration uploads are retired.
- Invoice detail/print and order-label direct Supabase fallbacks are removed.
- Invoice and report PDF sharing no longer uploads document contents; exports remain local.
- The desktop proxy has a strict control-plane allow-list and cannot proxy ERP endpoints.
- Browser ERP navigation cannot masquerade as access to desktop SQLite data.
- Product, customer, invoice, order, stock, settings, report, and repository modules no longer import or query Supabase.
- Startup/interval/online-event update checks were removed after the packaged traffic audit found one implicit HTTPS release check. Update checks are user-triggered only.

## 3. Supabase table classification

Control plane retained:

- Supabase Auth, `profiles`, `pending_users`
- `platform_customers`, `platform_businesses`
- `licenses`, `license_events`, `registered_devices`, `device_checkins`
- `desktop_releases`, `release_artifacts`
- `backup_status`, `support_cases`, `diagnostic_uploads`
- `admin_audit_logs`, `admin_logs`, `admin_control_plane_schema_versions`, `platform_settings`
- empty legacy subscription/payment control metadata where the current platform still defines it

Customer ERP retired:

- `organizations`, `organization_members`, `organization_features`
- `products`, `customers`, `suppliers`, `warehouses`, `inventory_items`, `stock_movements`
- `invoices`, `invoice_items`, `invoice_payments`, `sales_invoices`, `sales_invoice_items`
- `orders`, `order_items`, `quotations`, `quotation_items`
- `purchase_orders`, `purchase_order_items`, `purchase_invoices`, `purchase_invoice_items`
- `payment_receipts`, `expenses`, `ledger_entries`, `financial_years`, `invoice_series`
- `chart_of_accounts`, `accounting_vouchers`, `accounting_voucher_entries`, `bank_accounts`, `invoice_share_links`

The Supabase `payments` relation is classified as platform subscription/payment metadata, not local invoice/payment ERP data. Local ERP payments use SQLite.

## 4. Existing cloud ERP row counts

The verified pre-cleanup export contained:

| Table | Rows |
| --- | ---: |
| organizations | 1 |
| organization_members | 1 |
| organization_features | 3 |
| products | 1 |
| customers | 1 |
| invoices | 1 |
| invoice_items | 1 |
| stock_movements | 2 |
| all other available exported ERP tables | 0 |
| total | 11 |

Eight additionally classified relations were absent from the PostgREST schema cache during export and were recorded as unavailable in the manifest. The final post-cleanup probe resolved all 32 classified relations and found every one empty.

## 5. Protected export and checksums

Protected directory (mode `0700`, files `0600`, gitignored):

`private/migration-backups/2026-08-01T18-42-12-349Z`

| Evidence | SHA-256 |
| --- | --- |
| `manifest.json` | `8e5fd0b7a99605cc6ed3eaf2f176969e89503bc01255fae6b6b48ea5ee2664d7` |
| `local-import.json` | `e7863ef0708dfaa6989ba0c27f1a806c3d80799b7137d2582228e16552cd6c68` |
| `local-comparison.json` | `a1eaea09aba5b9ad070951a22bdb2ba59bc3c976d0a76e34a0945243c876c51a` |
| `supabase-no-write-audit.json` | `13a48a4b85a90ab0dec3fa6c352439b54231802e2adbc7771b2e2e219c84a656` |
| `supabase-cleanup.json` | `acd8e5ae3f4c674ee2b23e1aeb50551d4053ae5eefc6810385ca7f8fecbf3ce8` |
| `network-traffic-audit.json` | `059e6e7dc42a8aa5614ee1285849e5664d8180bcfa6c48e55420e3b9378a2573` |
| `supabase-post-cleanup-no-write.json` | `7450ac98fe7102db730c1a402c4d798224c364bed89a5f390cbfba9abaa6ae95` |

Every exported JSON file was checksum-verified and parsed back before cleanup.

## 6. Local migration result

The importer created a live pre-migration backup at:

`~/Library/Application Support/com.bezgrow.erp/bezgrow-migration-backups/before-cloud-retirement-2026-08-01T18-58-54-002Z.db`

Backup SHA-256: `75c3fbd8f4af40d275e2a40b5bc6f48dd0e9e954b2bedc18cc72e7dff5ca8686`.

Eight missing local rows were imported in one transaction: one local-user scaffold, one membership, three feature rows, one invoice, one invoice item, and one stock movement. IDs, organization/customer/product references, dates, totals, and quantities were retained. Final comparison: 11 cloud rows compared, 11 matched locally, 0 missing, 0 duplicate IDs.

## 7. Supabase cleanup

The checksum-gated cleanup deleted all 11 exported ERP rows and verified every active ERP relation empty. A later post-packaged-use inspection checked 32 ERP relations: 0 contained rows and 0 rows had been recreated.

`supabase/migrations/20260802000000_retire_cloud_erp.sql` was created to drop the now-empty ERP tables and their ERP-only policies/functions. Its final audit removed broad `CASCADE` drops and unrelated retained-table cleanup. It now checksum-gates execution, counts every classified table, refuses any non-empty relation or retained organization reference, snapshots protected control-plane object OIDs, removes only explicit legacy ERP dependencies, verifies the result before commit, and documents rollback/recovery. The DDL migration was **not applied**: the Supabase browser session is signed out and this workspace has no PostgreSQL connection, Supabase CLI authentication, or Management API token. Row retirement is applied; physical table/policy retirement remains pending privileged SQL access.

## 8. SQLite integrity and authority

- Live path: `~/Library/Application Support/com.bezgrow.erp/bezgrow-offline.db`
- `PRAGMA quick_check`: `ok`
- `PRAGMA foreign_key_check`: 0 violations
- `PRAGMA user_version`: 8
- Final representative counts: organizations 4, products 2, customers 3, sales invoices 5, sales invoice items 5, stock movements 8, signed-license rows 2.
- Disposable-copy authority test created 11 unique ERP records covering product, customer, supplier, invoice/item, payment/receipt, purchase/item, expense, and stock movement. All survived restart and backup/restore, reports used them, duplicate IDs were 0, outbound requests were 0.

The native layer retains WAL, foreign keys, `synchronous=FULL`, busy timeout, prepared statements, transactions, safe versioned migrations, pre-migration backup, rollback, and startup integrity checks.

## 9. Packaged network traffic

The first packaged capture found one automatic release-check HTTPS connection to `76.76.21.93:443` eight seconds after startup. It carried no ERP payload, but it violated the explicit-action rule. Startup, interval, and online-event checks were removed.

The rebuilt `.app` was then observed for 18 seconds plus 20 `nettop` workflow samples. The only connection was between the Tauri WebView and bundled Next server at `127.0.0.1:43124`. External TCP connections: 0. Supabase connections: 0. Prohibited ERP payload requests: 0. The capture included packaged startup, dashboard/navigation gestures, logout, restart, verified-local-license continuation, and dashboard reopen.

## 10. Supabase no-write result

Before cleanup, all ERP row counts remained identical to the protected baseline after local ERP use. After cleanup and the final packaged workflows, all 32 classified ERP relations remained empty. A final live, read-only service-role inspection on 2026-08-02 checked all 32 again: every relation was still present, every row count was zero, and the DDL retirement was therefore still pending. Normal ERP operations created zero Supabase business-data writes in the tested build.

## 11. Allowed remaining Supabase calls

- explicit platform-admin/account authentication
- explicit initial license activation/renewal/revocation/status actions
- explicit minimal device/license check-in
- explicit update check and release metadata
- explicit support case or sanitized diagnostic upload
- customer-enabled backup metadata only; no backup contents
- platform security/admin audit logs

No automatic ERP request, PDF upload, logo upload, database metric, business count, revenue, invoice/customer/product detail, or local backup upload remains.

## 12. Windows result

The Windows contract, AppData path, SQLite bootstrap/regression, bundled-server startup, runtime configuration, icon, native printing, release-artifact, and offline behavior tests passed. The release workflow uses `windows-latest`, an explicit `x86_64-pc-windows-msvc` target, a downloaded native x64 Node runtime, and generates both NSIS and MSI installers. Installed-app QA covers local routing, SQLite CRUD, licence persistence, network isolation, update/reinstall preservation, printing/runtime recovery, and orphan-process checks. Publication now re-verifies each staged artifact against `windows-build.json` and `SHA256SUMS.txt`, requires both NSIS and MSI, and rejects unrecorded installer assets. A native Windows installer build and packet capture were not run on this macOS host.

## 13. macOS result

- Final app bundle built successfully at `src-tauri/target/release/bundle/macos/Bezgrow.app`.
- The exact packaged app launched, opened the existing local business, passed SQLite startup/integrity checks, and used loopback-only traffic after the fix.
- The DMG wrapper was rerun with native `hdiutil` access and completed successfully. The build script now requests both `app,dmg`, preventing Tauri from cleaning the standalone `.app` after DMG assembly.
- Retained app: `src-tauri/target/release/bundle/macos/Bezgrow.app` (ad-hoc signed, strict code-signature verification passed).
- Internal DMG: `src-tauri/target/release/bundle/dmg/Bezgrow_0.1.7_aarch64.dmg`; 102,585,695 bytes; SHA-256 `0dbd4fe69daa96cdc13ff7d8a238c0bce1503b55d6d6df52446ba980cf64b1f1`; `hdiutil verify` and release-byte validation passed.
- Public signing/notarization was not attempted because Apple signing/notarization credentials are absent.

## 14. License persistence

Two stored licenses were verified locally: 2 valid Ed25519 signatures, 0 invalid. Logout did not delete the license or database. After restart, the packaged app exposed a desktop-only “Continue with Verified Local License” action; activating it re-verified the local signature and reopened the dashboard without external traffic. Private signing material remains server-only.

## 15. Update system

Update signature tests passed: Ed25519/minisign valid, SHA-256 valid, tampering rejected, safe install delay retained. Update checks now occur only through the explicit settings action. Update preparation still checks SQLite and creates a backup; no updater action removes the database or local license.

## 16. Files changed

Core additions:

- `lib/api/local-erp-only.ts`
- `lib/license/verification.ts`
- `docs/LOCAL_FIRST_ARCHITECTURE.md`
- `docs/LOCAL_FIRST_CUTOVER_REPORT.md`
- `scripts/export-supabase-erp-data.mjs`
- `scripts/compare-supabase-erp-export.mjs`
- `scripts/import-supabase-erp-export.mjs`
- `scripts/cleanup-supabase-erp-data.mjs`
- `scripts/audit-supabase-erp-no-write.mjs`
- `scripts/audit-local-license-signatures.ts`
- `scripts/test-local-first-architecture.mjs`
- `scripts/test-local-first-data-authority.mjs`
- `scripts/test-local-first-data-authority-ci.ts`
- `scripts/verify-supabase-erp-export.mjs`
- `scripts/verify-release-publication-inputs.mjs`
- `scripts/test-release-publication-gates.mjs`
- `supabase/migrations/20260802000000_retire_cloud_erp.sql`

Modified runtime groups:

- all active ERP routes under `app/api/{customers,dashboard,inventory,invoice-shares,invoices,products,report-shares,settings,workspace}` and `app/api/[...erp]`; the ordinary Orders routes were retired later while their SQLite tables remained archived
- desktop proxy, license check-in, auth/login/callback/startup, browser gates, dashboard layout/detail/print/label pages
- `lib/offline/*`, `lib/api/{professional-erp,stock-movements,tenant}.ts`, invoice-share helpers, workspace bootstrap, app updates, proxy
- desktop API/update coordinator, invoice export, and print engine components
- admin business/backup wording and control-plane projections
- desktop build retention, Windows release workflow, installer provenance/checksum publication gates, and CI-safe SQLite authority fixtures
- README, `.gitignore`, `package.json`, and affected contract tests

Pre-existing user modifications and untracked duplicate `* 2.*`/`* 3.*` files were preserved and not folded into this pass.

## 17. Commands executed

High-signal commands included:

- repository-wide `rg` audits for Supabase imports, `.from`, RPC, fetch, sync, fallback, secret, and table references
- protected export, compare, preview/import, final compare, pre/post no-write audit, and gated cleanup scripts
- SQLite `quick_check`, `foreign_key_check`, schema version/count checks, backup read-back, and data-authority tests
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run desktop:prepare`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `npm run desktop:build:mac` (initial sandboxed attempt reached `bundle_dmg.sh` but could not use native disk-image services)
- `npm run test:release-gates`
- `npm run migration:verify-supabase-erp-export -- --backup=private/migration-backups/2026-08-01T18-42-12-349Z`
- `npm run migration:inspect-supabase-erp-empty -- --backup=private/migration-backups/2026-08-01T18-42-12-349Z` (live, read-only; all 32 classified relations empty)
- `npm run desktop:build:mac` (two-bundle app + DMG success after the focused wrapper fix)
- `hdiutil verify`, DMG mount/read-back, `codesign --verify --deep --strict`, and release artifact byte validation
- `npx tauri build --bundles app` (success)
- packaged app launches plus `lsof`, `nettop`, and accessibility-driven logout/reopen validation
- anonymous and temporary normal/platform-admin live RLS probes

## 18. Remaining external blockers

1. Apply exactly `supabase/migrations/20260802000000_retire_cloud_erp.sql` from a privileged Supabase SQL session, then confirm its zero/zero/zero verification row and verify normal users receive SQL permission denial rather than only empty RLS-filtered results. It has not been applied by this workspace.
2. Run the guarded `Desktop Release` workflow on GitHub to produce and smoke-test genuine Windows x64 NSIS/MSI installers and capture Windows network traffic. The browser session is signed out, so it could not be dispatched here.
3. Provide Apple Developer ID/notarization credentials only when a public-trusted Mac release is required. The unsigned internal `.app` and genuine DMG are complete and verified.
4. Commit and push the prepared repository changes after Git metadata writes are available. This session could edit source files but could not create `.git/index.lock`; the required approval was rejected because the approval service usage allowance was exhausted. GitHub and Supabase browser sessions were both signed out, so no browser-side mutation was possible.

No local SQLite database, active license, business record, logo, backup, print setting, or existing release artifact was deleted by this pass.
