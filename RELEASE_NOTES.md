# Bezgrow 0.1.15

Large-dataset desktop production certification release.

- Added indexed, bounded SQLite search and pagination for product, customer, and invoice histories at 10,000 products, 25,000 customers, 100,000 invoices, and hundreds of thousands of detail rows.
- Replaced full-table dashboard, billing, and report reads with database-side aggregates and bounded recent activity queries.
- Made invoice creation idempotent and transactional, with database-level stock-underflow protection and direct status updates.
- Added debounced database-backed billing search with keyboard-selectable product suggestions.
- Hardened PDF preview cleanup and corrected thermal logo/business-name spacing for wide, square, tall, and absent logos.
- Added explicit offline-cached, grace, expired, revoked, cancelled, invalid, tampered, device-mismatch, and clock-rollback licence states plus periodic online revocation checks.
- Added isolated A/B/C scale certification, query-plan capture, backup/restore verification, integrity checks, and repeated-load memory soak coverage.

Public installers and updater metadata must be produced from an exact clean release commit and pass binary, version, architecture, size, URL, and SHA-256 validation. A genuine unsigned artifact may be published as a clearly labelled manual installation release; it must never be represented as production signed or notarized.
