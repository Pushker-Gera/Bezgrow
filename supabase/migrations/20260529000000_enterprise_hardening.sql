-- Enterprise hardening for multi-tenant launch safety.
-- Run this in Supabase SQL editor or through the Supabase CLI before production launch.

alter table if exists public.profiles
  add column if not exists is_suspended boolean not null default false,
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_by uuid,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists last_login_at timestamptz;

alter table if exists public.admin_logs
  add column if not exists organization_id uuid,
  add column if not exists admin_user_id uuid,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists idx_admin_logs_organization_id on public.admin_logs (organization_id);
create index if not exists idx_admin_logs_admin_user_id on public.admin_logs (admin_user_id);
create index if not exists idx_admin_logs_action on public.admin_logs (action);
create index if not exists idx_admin_logs_created_at_desc on public.admin_logs (created_at desc);
create index if not exists idx_profiles_suspended on public.profiles (is_suspended);

create unique index if not exists idx_products_org_sku_unique
  on public.products (organization_id, sku)
  where sku is not null and sku <> '';

create unique index if not exists idx_products_org_barcode_unique
  on public.products (organization_id, barcode)
  where barcode is not null and barcode <> '';

create unique index if not exists idx_customers_org_email_unique
  on public.customers (organization_id, lower(email))
  where email is not null and email <> '';

create unique index if not exists idx_customers_org_phone_unique
  on public.customers (organization_id, phone)
  where phone is not null and phone <> '';

create unique index if not exists idx_invoices_org_number_unique
  on public.invoices (organization_id, invoice_number)
  where invoice_number is not null and invoice_number <> '';

create unique index if not exists idx_orders_org_number_unique
  on public.orders (organization_id, order_number)
  where order_number is not null and order_number <> '';

create unique index if not exists idx_organization_features_unique
  on public.organization_features (organization_id, feature_key);

create unique index if not exists idx_inventory_items_unique_location
  on public.inventory_items (organization_id, product_id, warehouse_id);

do $$
begin
  alter table public.products add constraint products_non_negative_stock check (coalesce(stock, 0) >= 0);
exception when duplicate_object then null;
end $$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'invoice_items' and column_name = 'line_total'
  ) then
    alter table public.invoice_items add constraint invoice_items_non_negative_amounts check (
      coalesce(quantity, 0) >= 0 and coalesce(unit_price, 0) >= 0 and coalesce(line_total, 0) >= 0
    );
  end if;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.invoice_payments add constraint invoice_payments_non_negative_amount check (coalesce(amount, 0) >= 0);
exception when duplicate_object then null;
end $$;

create or replace function public.is_org_member(target_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members om
    join public.profiles p on p.id = om.user_id
    where om.user_id = auth.uid()
      and om.organization_id = target_org_id
      and coalesce(p.approved, false) = true
      and coalesce(p.is_suspended, false) = false
  );
$$;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
      and coalesce(p.is_suspended, false) = false
  );
$$;

do $$
declare
  tenant_table text;
begin
  foreach tenant_table in array array[
    'products',
    'customers',
    'invoices',
    'invoice_items',
    'invoice_payments',
    'orders',
    'order_items',
    'inventory_items',
    'warehouses',
    'stock_movements',
    'organization_features'
  ]
  loop
    if to_regclass('public.' || tenant_table) is not null and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = tenant_table
        and column_name = 'organization_id'
    ) then
      execute format('alter table public.%I enable row level security', tenant_table);
      execute format('drop policy if exists "%s organization members can read" on public.%I', tenant_table, tenant_table);
      execute format('drop policy if exists "%s organization members can write" on public.%I', tenant_table, tenant_table);
      execute format(
        'create policy "%s organization members can read" on public.%I for select using (public.is_org_member(organization_id) or public.is_platform_admin())',
        tenant_table,
        tenant_table
      );
      execute format(
        'create policy "%s organization members can write" on public.%I for all using (public.is_org_member(organization_id) or public.is_platform_admin()) with check (public.is_org_member(organization_id) or public.is_platform_admin())',
        tenant_table,
        tenant_table
      );
    end if;
  end loop;
end $$;

alter table if exists public.admin_logs enable row level security;
drop policy if exists "admins can read admin logs" on public.admin_logs;
create policy "admins can read admin logs"
  on public.admin_logs
  for select
  using (public.is_platform_admin());

alter table if exists public.pending_users enable row level security;
drop policy if exists "public can request approval" on public.pending_users;
create policy "public can request approval"
  on public.pending_users
  for insert
  with check (status = 'pending');

drop policy if exists "admins can manage pending users" on public.pending_users;
create policy "admins can manage pending users"
  on public.pending_users
  for all
  using (public.is_platform_admin())
  with check (public.is_platform_admin());
