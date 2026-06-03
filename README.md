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
