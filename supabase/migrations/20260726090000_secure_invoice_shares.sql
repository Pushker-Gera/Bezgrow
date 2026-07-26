create table if not exists public.invoice_share_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  document_type text not null default 'invoice' check (document_type in ('invoice', 'report')),
  token_hash text not null unique check (length(token_hash) = 64),
  title text not null default 'Invoice',
  period text,
  invoice_number text not null,
  customer_name text not null,
  business_name text not null,
  filename text not null,
  content_type text not null default 'application/pdf' check (content_type = 'application/pdf'),
  pdf_base64 text not null,
  byte_size integer not null check (byte_size > 0 and byte_size <= 8388608),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (document_type = 'report' or invoice_id is not null)
);

create index if not exists idx_invoice_share_links_org_invoice
  on public.invoice_share_links (organization_id, invoice_id, created_at desc);

create index if not exists idx_invoice_share_links_expiry
  on public.invoice_share_links (expires_at)
  where revoked_at is null;

alter table public.invoice_share_links enable row level security;

revoke all on table public.invoice_share_links from anon, authenticated;

comment on table public.invoice_share_links is
  'Server-only, expiring invoice PDF shares. Public access is mediated by a hashed bearer token in the hosted API.';
