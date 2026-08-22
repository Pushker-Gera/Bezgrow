# Bezgrow 0.1.16

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

Public 0.1.16 installer/update metadata must not be published until corresponding integrity-verified artifacts exist. The checked-in public download manifests therefore continue to describe the genuine 0.1.15 artifacts.

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
