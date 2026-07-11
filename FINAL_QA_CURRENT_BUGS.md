# Final QA Current Bugs

This file records current known or suspected failures before the final production implementation. Preparation did not mark any broad ERP issue as resolved.

## 1. Packaged Desktop App May Show SQLite Runtime Error

- Status: unverified in this preparation phase
- Affected runtime: packaged Tauri desktop app
- Reproduction steps: install/open packaged desktop app, activate or load offline workspace, attempt a local SQLite-backed action.
- Visible error: `SQLite is not available in this runtime.` or local-storage fallback/runtime storage failure.
- Suspected files/modules: `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `lib/offline/local/service.ts`, `lib/offline/sqlite.ts`, `lib/offline/local/api.ts`
- Severity: critical
- Required acceptance test: packaged macOS app opens offline, SQLite plugin loads, `sqlite:bezgrow-offline.db` is available, and database integrity check passes.

## 2. Customer Creation May Submit But Fail To Persist

- Status: unverified in this preparation phase
- Affected runtime: desktop offline and browser fallback
- Reproduction steps: go offline or use desktop local mode, create a customer, reload the customer list and app.
- Visible error: form may appear to submit while the new customer is missing after refresh/restart.
- Suspected files/modules: `app/dashboard/customers/page.tsx`, `lib/offline/db.ts`, `lib/offline/local/api.ts`, `lib/offline/local/repositories.ts`, `lib/offline/sync.ts`
- Severity: high
- Required acceptance test: create customer offline, confirm immediate list update, restart desktop app, confirm persistence, reconnect, and confirm sync.

## 3. Product Creation May Fail To Persist Locally

- Status: unverified in this preparation phase
- Affected runtime: desktop offline and browser fallback
- Reproduction steps: create product in offline/desktop mode, refresh/restart, inspect products and inventory.
- Visible error: product disappears or does not appear in product/inventory lists.
- Suspected files/modules: `app/dashboard/products/page.tsx`, `lib/offline/db.ts`, `lib/offline/local/api.ts`, `lib/offline/local/repositories.ts`, `lib/offline/sync.ts`
- Severity: high
- Required acceptance test: create product offline, confirm product and inventory rows persist after restart and sync after reconnect.

## 4. Invoice Creation May Show Bill Not Saved SQLite Error

- Status: unverified in this preparation phase
- Affected runtime: desktop offline and browser fallback
- Reproduction steps: create an invoice in offline/desktop mode with product/customer data.
- Visible error: `Bill Not Saved: SQLite is not available in this runtime.`
- Suspected files/modules: `app/dashboard/invoices/create/page.tsx`, `lib/offline/local/api.ts`, `lib/offline/local/service.ts`, `lib/offline/local/repositories.ts`
- Severity: critical
- Required acceptance test: create invoice offline, confirm stock movement, invoice, invoice items, customer balance, and print view persist after restart.

## 5. Desktop License And Safari/Browser Storage Are Separate

- Status: confirmed by code/UI copy, not runtime-tested in this preparation phase
- Affected runtime: desktop app plus Safari/browser
- Reproduction steps: activate license in browser, open desktop app, or activate desktop and open browser.
- Visible error: user may think license is missing in the other runtime.
- Suspected files/modules: `app/offline/page.tsx`, `lib/offline/local/license.ts`, `src-tauri/src/lib.rs`, `lib/desktop/session.ts`
- Severity: medium
- Required acceptance test: activate desktop license, confirm desktop-only persistence; activate browser separately if needed; verify explanatory copy appears.

## 6. Desktop License Persistence After Restart Must Be Verified

- Status: unverified in this preparation phase
- Affected runtime: packaged Tauri desktop app
- Reproduction steps: activate license, quit desktop app, reopen, navigate to dashboard offline.
- Visible error: license prompt returns or dashboard redirects to activation.
- Suspected files/modules: `lib/offline/local/license.ts`, `src-tauri/src/lib.rs`, `lib/offline/db.ts`
- Severity: critical
- Required acceptance test: license remains active after app restart, OS restart if practical, and network-off launch.

## 7. Offline Product/Customer/Invoice Creation Must Be Verified

- Status: unverified in this preparation phase
- Affected runtime: packaged desktop app
- Reproduction steps: disconnect network, create product, customer, invoice, then restart and reconnect.
- Visible error: missing records, failed sync, incorrect stock/customer balances.
- Suspected files/modules: `app/dashboard/products/page.tsx`, `app/dashboard/customers/page.tsx`, `app/dashboard/invoices/create/page.tsx`, `lib/offline/*`
- Severity: critical
- Required acceptance test: full offline create/read/update/sync workflow passes with durable local SQLite data.

## 8. Windows Installer Must Be Built And Verified On Windows

- Status: unverified
- Affected runtime: Windows desktop installer
- Reproduction steps: run Windows workflow/build, install MSI/NSIS on Windows, launch and verify.
- Visible error: unknown until Windows build/test runs.
- Suspected files/modules: `.github/workflows/desktop-release.yml`, `scripts/build-desktop.mjs`, `src-tauri/tauri.conf.json`
- Severity: high
- Required acceptance test: signed or expected unsigned Windows installer installs, launches, persists data, and uninstalls without data loss unless explicitly requested.

## 9. macOS Public Distribution Requires Signing And Notarization

- Status: unverified
- Affected runtime: public macOS distribution
- Reproduction steps: run public macOS desktop build with Apple credentials, notarize, staple, and Gatekeeper-verify DMG.
- Visible error: Gatekeeper rejection or unsigned/unnotarized app warning.
- Suspected files/modules: `scripts/build-desktop.mjs`, `.github/workflows/desktop-release.yml`, `src-tauri/tauri.conf.json`
- Severity: critical for public distribution
- Required acceptance test: `spctl`/Gatekeeper verification passes on a clean macOS machine.

## 10. Update Installation Preserving Data Requires Physical Upgrade Test

- Status: unverified
- Affected runtime: packaged desktop update/install path
- Reproduction steps: install old version with real-like local data/license/settings, install new version over it, reopen.
- Visible error: missing SQLite data, missing license, reset settings, or broken app launch.
- Suspected files/modules: `components/AppUpdateBanner.tsx`, `components/AppUpdatesPanel.tsx`, `scripts/build-desktop.mjs`, Tauri bundle config
- Severity: critical
- Required acceptance test: update preserves SQLite, license, settings, business data, and pending sync queue.

## 11. Full Disconnected Desktop Workflow With Realistic Seeded ERP Data Remains To Be Verified

- Status: unverified
- Affected runtime: packaged desktop app
- Reproduction steps: seed realistic ERP data, disconnect, run daily operations, restart, reconnect.
- Visible error: unknown until executed.
- Suspected files/modules: offline local repositories, sync queue, API fallback, and dashboard pages.
- Severity: high
- Required acceptance test: multi-entity workflow passes with realistic products, customers, suppliers, invoices, stock, orders, and reports.

## 12. Large-Data Performance Test Must Actually Execute

- Status: unverified
- Affected runtime: desktop SQLite and dashboard UI
- Reproduction steps: seed large product/customer/invoice/order datasets, measure list/filter/create/print/sync performance.
- Visible error: slow render, timeout, local DB lock, memory pressure, failed sync.
- Suspected files/modules: `lib/offline/local/repositories.ts`, dashboard list pages, sync queue, SQLite indexes.
- Severity: medium-high
- Required acceptance test: agreed large dataset sizes meet launch performance targets on representative hardware.
