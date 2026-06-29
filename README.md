# Bezgrow SaaS ERP

Production Next.js + Supabase workspace for admin approval, multi-tenant ERP dashboards, inventory, customers, invoices, and orders.

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
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
# Optional for desktop builds. Defaults to NEXT_PUBLIC_SITE_URL.
NEXT_PUBLIC_DESKTOP_API_ORIGIN=https://www.bezgrow.com
```

Payments are not enabled for the current launch. Access is approval-based through admin approval, suspension, business creation, and organization membership checks.

Never expose `SUPABASE_SERVICE_ROLE_KEY` to client-side code.

## Supabase Setup

Apply every migration in `supabase/migrations` before launch. The launch hardening migration repairs recursive `organization_members` RLS, backfills `order_items.organization_id`, creates tenant indexes, and keeps future subscription/payment tables available without enforcing payments in the app.

Required Supabase Auth URLs:

- Site URL: `https://bezgrow.com`
- Redirect URL: `https://bezgrow.com/auth/callback`
- Password reset redirect: `https://bezgrow.com/reset-password`
- Local redirect URL: `http://localhost:3000/auth/callback`
- Local password reset URL: `http://localhost:3000/reset-password`
- Desktop Google redirect URL: `http://127.0.0.1:43123/auth/callback`
- Optional desktop fallback redirect URL: `http://127.0.0.1:*/auth/callback`

For Google OAuth, configure the provider in Supabase and Google Cloud with the Supabase callback URL shown in the Supabase dashboard.

## Validation

```bash
npm run lint
npm run build
```

Both commands must pass before deployment.

## How to run Bezgrow Desktop

Bezgrow Desktop uses Tauri v2 around the existing Next.js app. The web app, PWA, and Vercel deployment continue to use the same Next/Supabase codebase.

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

`desktop:prepare` runs a desktop-only Next standalone build, copies the runtime into `desktop-runtime/next-server`, and copies the current platform's Node executable into `desktop-runtime/node` for Tauri bundling. Production desktop startup launches that bundled Next server on `127.0.0.1:43123` when available, with a random local fallback if the fixed port is already occupied.

Generated desktop artifacts are written under:

```bash
src-tauri/target/release/bundle/
```

Packaging note: desktop installers include a Node runtime generated on the build machine, so installed users are not asked to install Node manually. Build macOS installers on macOS and Windows installers on Windows so the bundled runtime matches the target platform.

macOS signing note: local macOS builds are ad-hoc signed only for testing. Do not upload a local `npm run desktop:build:mac` DMG to the website because Chrome quarantine will make macOS show `"Bezgrow" is damaged and can't be opened.` Public website distribution must be built with:

```bash
BEZGROW_MAC_SIGNING_IDENTITY="Developer ID Application: Your Company (TEAMID)" \
APPLE_ID="apple-id@example.com" \
APPLE_PASSWORD="app-specific-password" \
APPLE_TEAM_ID="TEAMID" \
npm run desktop:build:mac:public
```

Alternatively provide `APPLE_CERTIFICATE`/`APPLE_CERTIFICATE_PASSWORD` plus App Store Connect API notarization variables (`APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`). The public build mode enables hardened runtime, requires signing/notarization credentials, verifies the DMG with Gatekeeper, copies the notarized installer to `public/downloads/Bezgrow-mac.dmg`, and writes release metadata.

The permanent release path is the manual GitHub Actions workflow **Desktop Release**. Configure these repository secrets before running it:

```text
BEZGROW_MAC_SIGNING_IDENTITY
BEZGROW_MAC_PROVIDER_SHORT_NAME optional
APPLE_CERTIFICATE and APPLE_CERTIFICATE_PASSWORD, or a Developer ID identity already available on the runner
APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
or APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH
BEZGROW_WINDOWS_SIGNED optional, set to true/1 after adding Windows code signing
```

The workflow builds a notarized Mac DMG on macOS, builds the Windows NSIS installer on Windows, uploads both installers to a GitHub Release, and commits `public/downloads/desktop-release.json` with the download URLs, file sizes, hashes, and trust flags. The `/download` page enables the Mac button only when the manifest says the Mac installer is notarized. Installer binaries are ignored by git; do not commit `.dmg`, `.exe`, or `.msi` files directly.

### Offline-first desktop behavior

- First login requires internet and Supabase authentication.
- The Supabase refresh/session data is stored through the Tauri Rust keychain bridge when running as desktop. Passwords are never stored.
- Workspace, profile, organization, membership, features, products, customers, invoices, invoice items, orders, settings, inventory items, and stock movements are cached locally.
- Desktop uses SQLite through `@tauri-apps/plugin-sql`; web/PWA falls back to IndexedDB.
- Offline records are written locally first and queued in `sync_queue`.
- When internet returns, the sync engine retries queued work through existing authenticated APIs using the logged-in user's access token.
- Admin approval, signup, password reset, cloud sync, email/WhatsApp sending, and server-side admin actions require internet.

The local SQLite database creates these tables:

```text
local_workspace
local_profiles
local_organizations
local_organization_members
local_products
local_inventory_items
local_customers
local_invoices
local_invoice_items
local_orders
local_order_items
local_settings
local_stock_movements
sync_queue
sync_conflicts
sync_logs
```

Do not put `SUPABASE_SERVICE_ROLE_KEY` in any desktop or public environment variable. Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are available to the desktop client.
