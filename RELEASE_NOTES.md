# Bezgrow 0.1.14

Pre-launch desktop hardening release.

- Reduced Platform Admin and license-page request latency while retaining bearer authentication, device proof, nonce replay protection, schema checks, and audit history.
- Added transactional native backup restore safeguards, checksum and extraction limits, relationship verification, post-restore validation, and automatic safety rollback while preserving the installation license and device identity.
- Added receipt-lot inventory costing, optional purchase and expiry dates, purchase-rate capture, FIFO batch consumption, and exact batch restoration when an invoice is deleted.
- Replaced tall invoice cards and readiness panels with compact, horizontally scrollable billing tables and focused operational controls.
- Added a stable Joined Bezgrow date for existing and new local workspaces.
- Added explicit `signed-production`, `unsigned-manual-install`, and `invalid` release trust states so platform signing affects OS trust without disabling Bezgrow.
- Kept Tauri updater signatures independent of Apple Developer ID/notarization and Windows Authenticode. When no signed updater package is available, Update Now uses a Bezgrow-hosted assisted installer flow with strict platform, architecture, size, URL, and SHA-256 verification.
- Hardened desktop updates with startup, periodic, and reconnect checks; strict OS/architecture matching; a 48-hour safe automatic-update grace period where a signed updater package exists; pre-update SQLite backup; and launch-confirmed success reporting.

Public installers and updater metadata must be produced from an exact clean release commit and pass binary, version, architecture, size, URL, and SHA-256 validation. A genuine unsigned artifact may be published as a clearly labelled manual installation release; it must never be represented as production signed or notarized.
