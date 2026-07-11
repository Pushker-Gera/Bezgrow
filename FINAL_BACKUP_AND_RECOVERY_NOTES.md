# Final Backup And Recovery Notes

Preparation date: 2026-07-12 00:25 IST

## Repository-Level Backup

- Active repository: `/Users/pushkergera/Desktop/saas-project`
- Filesystem backup created at: `/Users/pushkergera/Desktop/saas-project-backup-before-final-hardening`
- Backup excludes regenerable build/cache folders and secret-style files.
- Backup includes source, configuration, package lock, migrations, Tauri files, public assets, tests, documentation, and `.git` metadata.

## Supabase Production Backup

MANUAL ACTION REQUIRED: create a Supabase production backup from the Supabase dashboard before final implementation.

Repository inspection can identify migrations and API usage, but it cannot safely create or verify the live production database backup without dashboard access and explicit authorization.

Safe manual Supabase backup checklist:

1. Open the Supabase project dashboard for the production Bezgrow project.
2. Confirm you are in the production project, not a preview or local project.
3. Create/download a full database backup using Supabase's dashboard backup tooling.
4. Store the backup outside the application repository in an encrypted or access-controlled location.
5. Record the backup timestamp, Supabase project id, and restore target, but do not store credentials in this repository.
6. Do not run destructive migrations until the backup has been created and restore-tested in an isolated environment.

## Cloud Tables And Migrations

Detected migration directory: `supabase/migrations`

Detected migration files:

- `20260529000000_enterprise_hardening.sql`
- `20260529001000_erp_foundation.sql`
- `20260603000000_fix_organization_members_rls.sql`
- `20260603001000_launch_hardening.sql`
- `20260605002000_invoice_create_schema_compatibility.sql`
- `20260606172000_signup_approval_columns.sql`
- `20260607003000_products_compatibility_columns.sql`
- `20260616073000_organization_invoice_identity.sql`
- `20260616080000_stock_movements_operational_columns.sql`
- `20260616083000_invoice_discount_totals.sql`

Latest repository migration version detected: `20260616083000_invoice_discount_totals`

Tables created or materially managed by migrations include suppliers, financial years, invoice series, quotations, quotation items, purchase orders, purchase order items, purchase invoices, payment receipts, expenses, ledger entries, pending users, subscription plans, subscriptions, payments, and payment events. Existing core tables altered or indexed include profiles, admin logs, products, invoices, invoice items, order items, stock movements, organizations, and organization members.

## Local SQLite Backup Readiness

- Local SQLite logical URL: `sqlite:bezgrow-offline.db`
- Tauri SQL preload: `src-tauri/tauri.conf.json` -> `plugins.sql.preload`
- Local SQLite schema version: `LOCAL_DB_VERSION = 6` in `lib/offline/local/schema.ts`
- Local SQLite storage is handled through `@tauri-apps/plugin-sql`; physical storage is in the Tauri app data area for `com.bezgrow.erp`, commonly under the macOS application support profile. Verify the exact path from the running app profile before copying.

Safe local SQLite export checklist:

1. Quit the packaged desktop app before copying raw SQLite files.
2. Copy `bezgrow-offline.db` plus any WAL/SHM sidecar files from the same app data directory.
3. Keep the copied database outside the active repository.
4. Treat the database as sensitive business data.
5. Restore only into an isolated test profile or a separate app data directory.

## App Backup Feature

Detected backup/export code:

- `exportOfflineBackup()` in `lib/offline/db.ts`
- `restoreOfflineBackup()` in `lib/offline/db.ts`
- Normalized SQLite backup export in `lib/offline/local/repositories.ts`
- UI backup controls in `components/offline/OfflineStatusBar.tsx` and `app/dashboard/settings/page.tsx`

The app backup feature exports offline business data, pending actions, conflicts, logs, metadata, and integrity information. It does not intentionally export `.env` files, service-role keys, license-signing private keys, Apple credentials, keychain secrets, or session files. It may contain customer, invoice, product, supplier, and business data, so backup files must still be handled as sensitive private data.

Current safe test backup generation status: unverified. No destructive or production backup generation was run during this preparation phase.

## Restore In An Isolated Test Profile

1. Create a separate OS user, separate Tauri app identifier, or isolated test app data directory.
2. Install or run a non-production build pointed at the test profile only.
3. Confirm the target business name starts with `E2E-TEST-`.
4. Import the Bezgrow backup through the Settings or Offline backup restore UI.
5. Verify products, customers, invoices, license state, and pending actions.
6. Do not restore production data over the active production desktop profile.

## Must Never Be Deleted Without Backup And Approval

- Organizations and businesses
- Users, admin accounts, memberships, and approvals
- Licenses and device activations
- Products, customers, suppliers, invoices, orders, inventory, stock movements, payments, ledgers, and backups
- Production Supabase data
- Local SQLite desktop data
- Application support settings, licenses, and keychain-backed session material

## Backup/Export Scripts

Repository scripts do not include a production Supabase backup command. App-level backup/export is implemented in application code and UI. Production database backup remains a manual dashboard action.
