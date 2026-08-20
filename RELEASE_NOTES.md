# Bezgrow 0.1.14

Pre-launch desktop hardening release.

- Reduced Platform Admin and license-page request latency while retaining bearer authentication, device proof, nonce replay protection, schema checks, and audit history.
- Added transactional native backup restore safeguards, checksum and extraction limits, relationship verification, post-restore validation, and automatic safety rollback while preserving the installation license and device identity.
- Added receipt-lot inventory costing, optional purchase and expiry dates, purchase-rate capture, FIFO batch consumption, and exact batch restoration when an invoice is deleted.
- Replaced tall invoice cards and readiness panels with compact, horizontally scrollable billing tables and focused operational controls.
- Added a stable Joined Bezgrow date for existing and new local workspaces.
- Hardened signed desktop updates with startup, periodic, and reconnect checks; strict OS/architecture matching; a 48-hour safe auto-install grace period; and launch-confirmed success reporting.

Public installers and updater metadata must be produced from the exact release commit by the signed macOS and Windows release workflows. Source version metadata alone does not publish or advertise an installer.
