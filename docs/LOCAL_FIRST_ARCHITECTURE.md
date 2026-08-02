# Bezgrow local-first architecture

## Data authority

The packaged Bezgrow ERP has one authoritative business datastore: the per-user SQLite database opened by the Tauri Rust bridge. Local ERP modules do not import a Supabase client. A failed SQLite startup is a recovery condition, not a signal to use a hosted database or browser IndexedDB.

Normal desktop flow:

```text
Existing dashboard UI
  -> desktop API bridge / local request handler
  -> local ERP repository transaction
  -> Tauri native SQLite commands
  -> bezgrow-offline.db
```

Explicit online control-plane flow:

```text
License activation/check-in, update check, support or diagnostics action
  -> allow-listed desktop proxy endpoint
  -> server-only control-plane service
  -> Supabase control-plane table
```

The browser website cannot substitute Supabase records for desktop-local ERP data. Hosted ERP API routes return `410 LOCAL_ERP_DESKTOP_ONLY`, and protected browser ERP navigation is redirected to the desktop download flow.

## Previous architecture found

Before the cutover, the repository contained a mixed-authority design:

- offline bootstrap downloaded organizations, products, customers, invoices, orders, inventory and stock history from hosted APIs;
- a retrying sync engine uploaded queued local mutations when connectivity returned;
- product, customer, invoice, order, inventory, dashboard and settings API routes performed Supabase ERP CRUD;
- invoice detail/print/order-label screens could fall back directly to Supabase;
- SQLite/IndexedDB adapters exposed Supabase or hosted-API fallbacks;
- secure invoice/report sharing sent generated PDF contents to Supabase;
- browser workspace bootstrap presented hosted ERP records as a customer workspace;
- admin business screens retained synchronization/telemetry language and fields.

Those runtime paths are retired. Historical migrations remain as schema history; the guarded retirement migration removes their live ERP tables after export and local-migration evidence is supplied.

## Supabase classification

Retained control-plane data:

- `profiles` and Supabase Auth: platform administrator/account authentication;
- `pending_users`: minimal account registration state (no phone field after cleanup);
- `platform_customers`, `platform_businesses`: licensing registry metadata only;
- `licenses`, `license_events`, `registered_devices`, `device_checkins`;
- `desktop_releases`, `release_artifacts`;
- `backup_status`: metadata for a separately enabled customer-controlled backup service only;
- `support_cases`, `diagnostic_uploads`;
- `admin_audit_logs`, `admin_logs`, control-plane schema versions and platform settings;
- legacy subscription/payment control metadata where retained for platform licensing/account administration.

Retired customer ERP data:

- organizations, memberships and ERP feature/settings rows;
- products, customers, suppliers, warehouses, inventory and stock movements;
- invoices/items/payments/receipts, orders/items and quotations/items;
- purchase orders/items/invoices/items;
- expenses, ledgers and accounting records;
- invoice/report PDF share records;
- every similarly named customer-generated business table.

## Local database ownership

- macOS: Tauri `app_config_dir()/bezgrow-offline.db`, resolving to the per-user Application Support directory.
- Windows: `%LOCALAPPDATA%\\Bezgrow\\Database\\bezgrow-offline.db`.

The native database layer enables WAL, foreign keys, `synchronous=FULL`, a busy timeout, explicit transactions, schema versioning, integrity/foreign-key checks, and pre-migration backups. The database is not placed in the app bundle, install directory, project, downloads folder or a temporary directory.

Logout clears only the UI authentication marker. It does not remove the signed license, keychain secret, local database, business profile, logo, settings, invoices, products, customers, reports or backups.
After logout, the desktop login screen offers a verified-local-license continuation path. It rechecks the signed license locally before clearing the logout marker and does not contact the platform.

Release checks are user-triggered. The desktop coordinator does not poll on startup, on an interval, or when connectivity returns.

## Cloud retirement evidence

The live legacy ERP tables were exported before any cleanup. The protected package is intentionally gitignored and stores a manifest, per-table row counts, JSON read-back verification and SHA-256 checksums. A duplicate-aware comparison/import transaction preserves cloud IDs and relationships, creates a pre-migration SQLite backup, and rolls back if integrity or foreign-key checks fail.

`supabase/migrations/20260802000000_retire_cloud_erp.sql` refuses to run unless a privileged transaction supplies verified-export and verified-local-migration settings plus the expected manifest checksum. It drops ERP tables and their dependent RLS/API objects while preserving and locking down the control plane.

## Enforced invariants

`npm run test:architecture` fails when:

- a prohibited ERP module imports Supabase;
- runtime code queries a prohibited Supabase ERP table;
- a hosted ERP route does not fail closed;
- bootstrap/sync code makes ERP network calls;
- SQLite mutations write an upload queue;
- the local repository adapter exposes a Supabase fallback;
- invoice/report sharing uploads a PDF;
- the desktop proxy exposes an ERP API;
- license activation falls back to server verification;
- a client module references a service-role key or private license key;
- the guarded cleanup migration is absent or drops retained control-plane tables.
