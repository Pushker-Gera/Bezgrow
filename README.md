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
npm run desktop:build:windows
```

`desktop:prepare` runs a desktop-only Next standalone build and copies the runtime into `desktop-runtime/next-server` for Tauri bundling. Production desktop startup launches that bundled Next server on `127.0.0.1` inside the native window.

Generated desktop artifacts are written under:

```bash
src-tauri/target/release/bundle/
```

Packaging note: the current desktop bundle includes the Bezgrow standalone server resources, but it starts them with the system `node` executable. A fully self-contained public installer should add a signed, per-platform Node sidecar before distribution to machines that may not have Node installed.

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
