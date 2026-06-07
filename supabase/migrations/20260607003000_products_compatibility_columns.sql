-- Ensures the product master form and API have matching production columns.
-- Safe to run multiple times.

alter table if exists public.products
  add column if not exists description text,
  add column if not exists manufacturer text,
  add column if not exists sku text,
  add column if not exists barcode text,
  add column if not exists category text,
  add column if not exists unit text default 'pcs',
  add column if not exists supplier text,
  add column if not exists warehouse text default 'Main Warehouse',
  add column if not exists price numeric default 0,
  add column if not exists stock numeric default 0,
  add column if not exists min_stock numeric default 5,
  add column if not exists batch_no text,
  add column if not exists mrp numeric,
  add column if not exists purchase_rate numeric,
  add column if not exists sale_rate numeric,
  add column if not exists gst numeric,
  add column if not exists expiry_date date,
  add column if not exists purchase_date date,
  add column if not exists deleted_at timestamptz,
  add column if not exists updated_at timestamptz default now();

create index if not exists idx_products_organization_created_at
  on public.products (organization_id, created_at desc);

create index if not exists idx_products_organization_deleted_at
  on public.products (organization_id, deleted_at);
