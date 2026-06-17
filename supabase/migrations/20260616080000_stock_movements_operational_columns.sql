-- Adds operational stock movement fields used by invoice and inventory actions.
-- Safe to run multiple times.

alter table if exists public.stock_movements
  add column if not exists warehouse_id uuid,
  add column if not exists shipping_qr text,
  add column if not exists reason text,
  add column if not exists reference_no text,
  add column if not exists previous_stock numeric,
  add column if not exists new_stock numeric,
  add column if not exists created_at timestamptz default now();

create index if not exists idx_stock_movements_product_created_at
  on public.stock_movements (product_id, created_at desc);
