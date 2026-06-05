-- Align sales invoice tables with the production invoice creation API.
-- This is safe to run repeatedly and only adds missing columns/indexes.

alter table if exists public.invoices
  add column if not exists customer_name text,
  add column if not exists subtotal numeric default 0,
  add column if not exists tax_amount numeric default 0,
  add column if not exists total_amount numeric default 0,
  add column if not exists grand_total numeric default 0,
  add column if not exists total numeric default 0,
  add column if not exists payment_status text default 'unpaid',
  add column if not exists status text default 'unpaid',
  add column if not exists payment_method text default 'cash',
  add column if not exists date date default current_date,
  add column if not exists due_date date,
  add column if not exists notes text,
  add column if not exists invoice_type text default 'standard',
  add column if not exists shipping_code text,
  add column if not exists courier_name text,
  add column if not exists tracking_number text,
  add column if not exists updated_at timestamptz default now();

update public.invoices
set
  customer_name = coalesce(customer_name, 'Customer'),
  subtotal = coalesce(subtotal, 0),
  tax_amount = coalesce(tax_amount, 0),
  total_amount = coalesce(total_amount, grand_total, 0),
  grand_total = coalesce(grand_total, total_amount, 0),
  total = coalesce(total, grand_total, total_amount, 0),
  payment_status = coalesce(payment_status, 'unpaid'),
  status = coalesce(status, payment_status, 'unpaid'),
  payment_method = coalesce(payment_method, 'cash'),
  date = coalesce(date, created_at::date, current_date),
  invoice_type = coalesce(invoice_type, 'standard'),
  updated_at = coalesce(updated_at, now())
where
  customer_name is null
  or subtotal is null
  or tax_amount is null
  or total_amount is null
  or grand_total is null
  or total is null
  or payment_status is null
  or status is null
  or payment_method is null
  or date is null
  or invoice_type is null
  or updated_at is null;

alter table if exists public.invoice_items
  add column if not exists organization_id uuid,
  add column if not exists product_name text,
  add column if not exists quantity numeric default 0,
  add column if not exists unit_price numeric default 0,
  add column if not exists tax_percent numeric default 0,
  add column if not exists discount_percent numeric default 0,
  add column if not exists line_total numeric default 0,
  add column if not exists gst_amount numeric default 0;

update public.invoice_items ii
set organization_id = i.organization_id
from public.invoices i
where ii.invoice_id = i.id
  and ii.organization_id is null;

alter table if exists public.stock_movements
  add column if not exists reference_no text,
  add column if not exists previous_stock numeric,
  add column if not exists new_stock numeric;

create index if not exists idx_invoices_organization_created_at
  on public.invoices (organization_id, created_at desc);

create index if not exists idx_invoice_items_invoice_organization
  on public.invoice_items (invoice_id, organization_id);

create index if not exists idx_stock_movements_reference_no
  on public.stock_movements (organization_id, reference_no);
