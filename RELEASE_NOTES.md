# Bezgrow 0.2.3

Windows local-database reliability, App Lock, and mutation UX hardening.

- Replaced destructive full-collection product and customer saves with row-level, atomic SQLite mutations so closed financial-year history and invoice foreign keys remain untouched.
- Kept product, opening-stock, and stock-movement changes in one native transaction and added actionable user-safe failure messages with technical diagnostics retained locally.
- Added a polished device App Lock that protects ERP content on launch, restart, meaningful backgrounding, minimize/restore, and sleep/resume, with Caps Lock feedback, password visibility, and escalating retry throttling.
- Added one-time initial app-password generation during licence creation, PBKDF2-SHA256 per-device verifiers, OS credential-store persistence, local password change, configurable background auto-lock, and Lock Now.
- Added an atomic, idempotent, audited, device-bound 30-minute password-reset authorization signed by the existing server-only licence trust system; no plaintext password is persisted or recoverable.
- Moved ordinary logout into Settings, removed duplicate sidebar/profile logout controls, and preserved the licence, Device ID, SQLite ERP records, backups, logo, print settings, and local configuration.
- Removed whole-list reloads after product/customer creation and editing; the affected row now appears immediately without route refresh, screen flash, scroll reset, or a browser-like loading line.
- Expanded Windows path/runtime, local-only CRUD, SQLite integrity, closed-year mutation, licence/App-Lock, admin reset, logout placement, no-cloud-write, pagination, and large-data regression coverage.

Public installer and updater metadata remains pinned to the genuine 0.2.2 artifacts until matching 0.2.3 Windows and macOS artifacts complete the release verification and publication gates.

## Previous 0.2.2 notes

Windows installer compatibility hardening.

- Added an installer-startup operating-system check that rejects Windows 7, Windows 8/8.1, 32-bit Windows, and Windows 10 builds older than version 1809 before Microsoft Edge WebView2 is launched.
- Replaced the low-level `KERNEL32.dll`/`MicrosoftEdgeUpdate.exe` failure on unsupported computers with a single clear message explaining the supported Windows versions.
- Applied the same minimum-system contract to the NSIS EXE, MSI, and portable Windows packages while preserving uninstall access for previously installed MSI builds.
- Updated the public download page to show the exact requirement: 64-bit Windows 10 version 1809 or newer, or Windows 11.
- Added packaging regression checks that keep the operating-system guard ahead of the WebView2 installer and keep the custom templates aligned with the pinned Tauri CLI.

Public installer and updater metadata remains pinned to the genuine 0.2.1 artifacts until 0.2.2 artifacts complete the release verification and publication gates.

## Previous 0.2.1 notes

Financial-year and billing integrity hardening.

- Made the India-local April–March calendar authoritative for financial-year creation, activation, and dated posting; future and historical postings are rejected in the local domain service.
- Added an automatic, backed-up SQLite v16 repair that restores the date-valid current year, archives empty premature years without deleting their audit data, and reclassifies only date-provable transaction assignments.
- Unified billing, purchase-return, and stock-out availability around physical product stock plus FIFO batch rows, including legacy product-level batches with no duplicated batch record.
- Kept invoice creation atomic under insufficient stock and made batch errors report the exact available quantity and warehouse.
- Preserved closed historical invoices while allowing their receivables to be settled in the current operational year.
- Reconciled legacy paid/partial/unpaid labels only when stored paid and outstanding amounts prove the correct state, and allowed current-year settlement of closed historical supplier bills without altering their accounting period.
- Added current-versus-historical read-only UI states, viewport-safe closing workflows, explicit physical-stock/report scopes, integrity guards, and expanded financial-year scale coverage.

Public installer and updater metadata remains pinned to the genuine 0.2.0 artifacts until 0.2.1 artifacts complete the release verification and publication gates.

## Previous 0.2.0 notes

Local-first Financial Year Management.

- Added first-class April–March financial years, deterministic legacy transaction migration, historical selection, closed-year viewing, and business-scoped SQLite relationships.
- Added a guided five-step year transition that records exact batch, expiry, warehouse, purchase-cost, stock, receivable, and payable opening snapshots without duplicating physical inventory, invoices, revenue, or GST.
- Added continuous and per-year invoice numbering modes while preserving existing installations in continuous mode and retaining globally unique database invoice numbers.
- Added transaction-date/FY validation and database-level closed-year protection across invoices, purchases, stock, payments, accounting, GST summaries, and their child rows.
- Added verified pre-close local backup, integrity checks, typed closing confirmation, controlled audited reopening, year-end summaries, and proactive year-end guidance.
- Added FY-scoped dashboard, billing, customer metrics, local reports, GST, stock history, and customer ledgers with opening balances shown separately.
- Extended full local backup/export coverage to financial years, opening records, numbering sequences, close metadata, and audit history.
- Added upgrade, boundary, leap-year, carry-forward, numbering, mutation-protection, backup/restore, privacy, integrity, and 2,000-product/5,000-customer/20,000-invoice performance tests.
- Decoupled the development/source version from the latest published desktop release so future source bumps cannot disable the previous integrity-verified Mac or Windows download.
- Added explicit draft/building/validating/ready/published/failed release states, internal versus stable trust policy, cross-platform atomic publication gates, and exact per-platform availability.
- Added `release:verify` and `release:publish` commands, immutable artifact/provenance validation, published-only updater discovery, and transition regressions for incomplete or failed releases.

The checked-in 0.2.0 public download manifests describe the last genuinely published artifact cohort and remain the fallback for newer source builds.

## Previous 0.1.16 notes

Platform Administration licence-management production fix.

- Replaced WebView-dependent blocking prompts with compact, keyboard-accessible licence action dialogs and explicit native no-drag interaction surfaces.
- Added complete Renew, Extend, Grace, Plan/features, Replace Device, Transfer, Suspend, Reactivate, and Revoke workflows with pending/error states and immediate row updates.
- Added a service-role-only, row-locked, idempotent Supabase mutation transaction covering licence state, signed payloads, device binding, immutable history, and admin audit records.
- Enforced terminal licence transitions server-side, including protection against reactivating revoked or replaced licences and against assigning an already licensed target device.
- Added authoritative delivery and local signature verification of refreshed signed licence keys after renewal, extension, grace, or feature changes.
- Kept suspended, revoked, replaced, and expired desktop enforcement local-data-safe and offline-capable, with authoritative restrictions applied on the next legitimate online check.
- Made Copy Key and Download retrieve the current server artifact on demand, added native clipboard and save-dialog support to the admin window, and removed signed blobs from licence list queries.
- Made control-plane readiness fail closed when the deployed Supabase readiness RPC is older than the application schema contract.
- Made Return to local ERP close the Rust-created Platform Administration window through a narrow native capability.
- Added real rendered click coverage for all licence controls plus mutation, lifecycle, authorization, atomicity, state-machine, and scale regressions.

Public 0.1.16 installer/update metadata was not published because corresponding integrity-verified artifacts were not produced. The checked-in public download manifests continue to describe the genuine 0.1.15 artifacts.

## Previous 0.1.15 notes

Large-dataset desktop production certification release.

- Added indexed, bounded SQLite search and pagination for product, customer, and invoice histories at 10,000 products, 25,000 customers, 100,000 invoices, and hundreds of thousands of detail rows.
- Replaced full-table dashboard, billing, and report reads with database-side aggregates and bounded recent activity queries.
- Made invoice creation idempotent and transactional, with database-level stock-underflow protection and direct status updates.
- Added debounced database-backed billing search with keyboard-selectable product suggestions.
- Hardened PDF preview cleanup and corrected thermal logo/business-name spacing for wide, square, tall, and absent logos.
- Added explicit offline-cached, grace, expired, revoked, cancelled, invalid, tampered, device-mismatch, and clock-rollback licence states plus periodic online revocation checks.
- Added isolated A/B/C scale certification, query-plan capture, backup/restore verification, integrity checks, and repeated-load memory soak coverage.

Public installers and updater metadata must be produced from an exact clean release commit and pass binary, version, architecture, size, URL, and SHA-256 validation. A genuine unsigned artifact may be published as a clearly labelled manual installation release; it must never be represented as production signed or notarized.
