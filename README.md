# Bezgrow Local-First Desktop ERP

Bezgrow is a Tauri desktop ERP whose customer business records live only in the per-user SQLite database. Supabase is the online control plane for platform-admin authentication, licenses/devices, releases, support, sanitized diagnostics, security logs, and customer-enabled backup metadata. It is not an ERP datastore or synchronization target.

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Required Environment Variables

Set these in `.env.local` and in Vercel production:

```bash
NEXT_PUBLIC_SITE_URL=https://bezgrow.com
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
# Optional for desktop builds. Defaults to NEXT_PUBLIC_SITE_URL.
NEXT_PUBLIC_DESKTOP_API_ORIGIN=https://www.bezgrow.com
```

`NEXT_PUBLIC_DESKTOP_API_ORIGIN` is used only for explicit control-plane actions such as license/device check-ins and update checks. The desktop bundle never contains the service-role key or license private signing key. Invoice PDFs, exports, logos, backups, and ERP records remain local.

Payments are not enabled for the current launch. Desktop access is license-based through admin-issued signed offline licenses. A valid locally stored license does not require Supabase authentication or a network connection during normal ERP use.

Never expose `SUPABASE_SERVICE_ROLE_KEY` or `BEZGROW_LICENSE_PRIVATE_KEY` to client-side code.

### Offline License Keys

Admin license generation is environment-only for serverless compatibility. Bezgrow never writes `.bezgrow`, `license-signing-key.json`, or any signing key file at runtime.

Generate an Ed25519 key pair with:

```bash
npm run generate-license-keys
```

The command prints two raw base64url Ed25519 values with no PEM headers:

```bash
BEZGROW_LICENSE_PRIVATE_KEY=
NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY=
```

Set the printed values exactly, without quotes:

- `BEZGROW_LICENSE_PRIVATE_KEY`: server/admin private signing key.
- `NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY`: app/client public verification key.

Server license generation uses only `BEZGROW_LICENSE_PRIVATE_KEY`. Desktop/client verification uses only `NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY`; generated license payloads do not carry a trusted public key.

If keys are missing, invalid format, or mismatched, `/admin/settings` shows a clear setup error instead of generating a license.

## Supabase Setup

Supabase migrations after the local-first cutover define only the platform control plane. Historical ERP migrations are legacy schema history and must not be used to restore cloud ERP routes. Before applying the guarded cloud-ERP cleanup migration, create and verify the protected export and confirm all required rows are present in SQLite.

The current Platform Administration schema version is `2026082102`. Starting
from the complete `2026072701` control plane, apply these additive migrations in
filename order:

```text
20260727010000_release_artifact_msix.sql
20260801090000_desktop_updater_delivery.sql
20260811000000_device_bound_platform_admin.sql
20260814090000_desktop_release_build_provenance.sql
20260821010000_current_admin_control_plane_readiness.sql
20260821020000_license_control_plane_runtime_compatibility.sql
```

`20260802000000_retire_cloud_erp.sql` is a separately gated, destructive legacy
ERP retirement operation. It is not a Platform Administration prerequisite and
must never be run as part of a control-plane repair. After applying the current
control-plane migrations, run `npm run test:live-control-plane`; it performs a
read-only service-role audit of schema readiness, authorization, Licences,
Devices, Businesses, Releases & Updates, Audit Logs, Backups and settings.

Required Supabase Auth URLs:

- Site URL: `https://bezgrow.com`
- Redirect URL: `https://bezgrow.com/auth/callback`
- Password reset redirect: `https://bezgrow.com/reset-password`
- Local redirect URL: `http://localhost:3000/auth/callback`
- Local password reset URL: `http://localhost:3000/reset-password`
- Desktop Google redirect URL: `http://127.0.0.1:43124/auth/callback`
- Optional desktop fallback redirect URL: `http://127.0.0.1:*/auth/callback`

For Google OAuth, configure the provider in Supabase and Google Cloud with the Supabase callback URL shown in the Supabase dashboard.

## Validation

```bash
npm run lint
npm run build
```

Both commands must pass before deployment.

## How to run Bezgrow Desktop

Bezgrow Desktop uses Tauri v2 around the existing Next.js UI and the native SQLite bridge. The hosted website provides downloads, documentation, account/license actions, support, and the platform-admin application; it does not expose desktop-local ERP records.

### Prerequisites

- Node.js and npm
- Rust/Cargo for Tauri
- macOS: Xcode command line tools
- Windows: Microsoft Visual Studio C++ build tools and WebView2 runtime

Install Rust:

```bash
# macOS Homebrew
brew install rust

# or the Rust project installer
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Install project dependencies:

```bash
npm install
```

### Desktop development

```bash
npm run desktop:dev
```

This starts `next dev`, compiles the Tauri shell, and opens Bezgrow in a native desktop window titled `Bezgrow ERP`.

### Desktop installer builds

```bash
npm run desktop:prepare
npm run desktop:build
npm run desktop:build:mac
npm run desktop:build:mac:public
npm run desktop:build:windows
npm run desktop:build:windows:public
```

`desktop:prepare` runs a desktop-only Next standalone build, copies the runtime into `desktop-runtime/next-server`, and copies the current platform's Node executable into `desktop-runtime/node` for Tauri bundling. Production desktop startup launches that bundled Next server on `127.0.0.1:43124` when available, with a random local fallback if the fixed port is already occupied.

Generated desktop artifacts are written under:

```bash
src-tauri/target/release/bundle/
```

Packaging note: desktop installers include a Node runtime generated on the build machine, so installed users are not asked to install Node manually. Build macOS installers on macOS and Windows installers on Windows so the bundled runtime matches the target platform.

macOS signing note: temporary manual-install builds may use only Tauri's ad-hoc bundle signature and are explicitly recorded as not Developer ID signed and not notarized. They may be published only with the visible manual-install warning; users may use macOS's supported right-click → Open approval when offered. A production-recommended website distribution must be built with:

```bash
BEZGROW_MAC_SIGNING_IDENTITY="Developer ID Application: Your Company (TEAMID)" \
APPLE_ID="apple-id@example.com" \
APPLE_PASSWORD="app-specific-password" \
APPLE_TEAM_ID="TEAMID" \
npm run desktop:build:mac:public
```

Alternatively provide `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD` plus App Store Connect API notarization variables (`APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`). The public build mode enables hardened runtime, requires signing/notarization credentials, verifies the DMG with Gatekeeper, copies it under an immutable version-and-architecture filename such as `public/downloads/Bezgrow-0.1.15-arm64.dmg`, and writes checksum-pinned release metadata.

The permanent release path is the manual GitHub Actions workflow **Desktop Release**. Configure these repository secrets before running it:

```text
BEZGROW_MAC_SIGNING_IDENTITY
BEZGROW_MAC_PROVIDER_SHORT_NAME optional
APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD, or a Developer ID identity already available on the runner
APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
or APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH
BEZGROW_WINDOWS_CERTIFICATE_BASE64 and BEZGROW_WINDOWS_CERTIFICATE_PASSWORD
BEZGROW_WINDOWS_TIMESTAMP_URL optional
SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY optional for control-plane metadata publication
```

The workflow builds the Mac DMG on macOS and Windows NSIS/MSI installers on `windows-latest`, verifies artifact provenance and bytes, calculates SHA-256, uploads artifacts to a GitHub Release, and commits `public/downloads/desktop-release.json` with download URLs and independent integrity/trust flags. Missing production signing credentials produce a clearly labelled manual installation release instead of discarding a genuine installer. Each platform publishes independently after its artifact passes type, non-zero-size, installer-magic, architecture/version/commit metadata, trusted-URL, and checksum checks. Signing and notarization affect OS trust, warnings, and `productionRecommended`, not basic download availability or ERP features.

The release trust states are `signed-production`, `unsigned-manual-install`, and `invalid`. The internal release mode for a valid unsigned artifact is `UNSIGNED_MANUAL_RELEASE`. Tauri updater signatures are evaluated independently of Apple and Windows platform signatures. When a cryptographically verified Tauri updater package is present, the normal in-app updater can install it. Otherwise Update Now downloads the installer only from Bezgrow's trusted release endpoint, verifies version, platform, architecture, size, and SHA-256 natively, opens the installer through the normal OS path, and closes Bezgrow cleanly. It does not alter Gatekeeper, SIP, SmartScreen, Defender, quarantine attributes, or machine-wide security policy.

Windows installers must be built on Windows. From a Windows machine, run `npm run desktop:build:windows` to generate artifacts under `src-tauri/target/release/bundle/`, or run `npm run desktop:build:windows:public` to copy versioned artifacts such as `Bezgrow-Setup-0.1.15-x64.exe` and `Bezgrow-0.1.15-x64.msi` and write release metadata. From macOS, use the **Desktop Release** GitHub Actions workflow; macOS cannot produce the Windows `.exe`/`.msi` installer for this Tauri app. Installer binaries are ignored by git; do not commit `.dmg`, `.exe`, or `.msi` files directly.

### Offline-first desktop behavior

- Initial license issuance or activation may require internet, but signature verification and reopening use the signed license stored locally.
- SQLite is the sole authoritative datastore for organizations, users, products, inventory, customers, suppliers, invoices, purchases, payments, expenses, ledgers, reports, settings, templates, audit history, and backup/import/export history.
- Normal ERP reads, writes, reports, printing, PDF/CSV export, backup, and restore do not call Supabase or a hosted ERP API.
- If the native SQLite bridge cannot start, the packaged desktop fails closed and presents database diagnostics/recovery. It never falls back to Supabase or IndexedDB for ERP writes.
- Device check-ins and update checks are explicit, best-effort control-plane operations and send only license/device/platform/version metadata. Normal startup, navigation, network restoration, and ERP actions do not trigger them.
- After an explicit logout, a desktop user can reopen offline through the verified local-license action; the app re-verifies the signed license before restoring access.
- Cloud backup is disabled by default and is not implemented or enabled by normal ERP workflows.

The local SQLite database contains normalized domain tables, including:

```text
organizations, local_users, organization_members
products, categories, units, warehouses, inventory_items, stock_batches, stock_movements
customers, suppliers, sales_invoices, sales_invoice_items, orders (historical archive), order_items (historical archive)
quotations, purchase_invoices, payments, payment_receipts, expenses, ledger_entries
business_settings, print_templates, feature_flags, local_audit_logs, backup_manifest
```

The Tauri Rust layer stores the database in the stable per-user application-data directory, enables WAL, foreign keys, a busy timeout, atomic transactions, schema versioning, integrity checks, and pre-migration backups. Logout, restart, reinstall, and app updates do not delete this database or the stored license.

Do not put `SUPABASE_SERVICE_ROLE_KEY` or `BEZGROW_LICENSE_PRIVATE_KEY` in any desktop or public environment variable. Public Supabase values are present only for hosted/control-plane authentication; local ERP modules must not import a Supabase client.
