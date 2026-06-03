-- Launch hardening: membership RLS recursion repair, tenant keys, indexes,
-- and subscription/payment foundation. Apply before public traffic.

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

alter table if exists public.organization_members enable row level security;

do $$
declare
  policy_row record;
begin
  for policy_row in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'organization_members'
  loop
    execute format('drop policy if exists %I on public.organization_members', policy_row.policyname);
  end loop;
end $$;

create policy "organization_members read own or admin"
  on public.organization_members
  for select
  to authenticated
  using (user_id = auth.uid() or public.is_platform_admin());

create policy "organization_members insert own or admin"
  on public.organization_members
  for insert
  to authenticated
  with check (user_id = auth.uid() or public.is_platform_admin());

create policy "organization_members update own or admin"
  on public.organization_members
  for update
  to authenticated
  using (user_id = auth.uid() or public.is_platform_admin())
  with check (user_id = auth.uid() or public.is_platform_admin());

create policy "organization_members delete admin"
  on public.organization_members
  for delete
  to authenticated
  using (public.is_platform_admin());

create unique index if not exists idx_organization_members_user_org_unique
  on public.organization_members (user_id, organization_id);
create index if not exists idx_organization_members_org_id on public.organization_members (organization_id);
create index if not exists idx_organization_members_user_id on public.organization_members (user_id);

alter table if exists public.order_items
  add column if not exists organization_id uuid;

update public.order_items oi
set organization_id = o.organization_id
from public.orders o
where oi.order_id = o.id
  and oi.organization_id is null;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'order_items' and column_name = 'organization_id'
  ) and not exists (
    select 1 from public.order_items where organization_id is null
  ) then
    alter table public.order_items alter column organization_id set not null;
  end if;
exception when others then
  null;
end $$;

do $$
begin
  alter table public.order_items
    add constraint order_items_organization_id_fkey
    foreign key (organization_id) references public.organizations(id) on delete cascade;
exception when duplicate_object then null;
end $$;

create index if not exists idx_order_items_organization_id on public.order_items (organization_id);
create index if not exists idx_order_items_order_id on public.order_items (order_id);
create index if not exists idx_invoice_items_organization_id on public.invoice_items (organization_id);
create index if not exists idx_invoice_items_invoice_id on public.invoice_items (invoice_id);
create index if not exists idx_products_organization_id on public.products (organization_id);
create index if not exists idx_customers_organization_id on public.customers (organization_id);
create index if not exists idx_invoices_organization_id_created_at on public.invoices (organization_id, created_at desc);
create index if not exists idx_orders_organization_id_created_at on public.orders (organization_id, created_at desc);
create index if not exists idx_stock_movements_organization_id_created_at on public.stock_movements (organization_id, created_at desc);
create unique index if not exists idx_organization_features_unique on public.organization_features (organization_id, feature_key);

do $$
begin
  alter table public.products
    add constraint products_stock_non_negative check (coalesce(stock, 0) >= 0);
exception when duplicate_object then null;
end $$;

create table if not exists public.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  price_minor integer not null default 0,
  currency text not null default 'INR',
  interval text not null default 'month',
  product_limit integer,
  invoice_limit integer,
  user_limit integer,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  plan_code text not null references public.subscription_plans(code),
  status text not null default 'trialing',
  current_period_start timestamptz not null default now(),
  current_period_end timestamptz not null default (now() + interval '14 days'),
  provider text,
  provider_subscription_id text,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  provider text not null,
  provider_payment_id text,
  amount_minor integer not null,
  currency text not null default 'INR',
  status text not null,
  verified_at timestamptz,
  raw_event jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  organization_id uuid references public.organizations(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(provider, event_id)
);

insert into public.subscription_plans (code, name, price_minor, currency, interval, product_limit, invoice_limit, user_limit)
values
  ('starter', 'Starter', 0, 'INR', 'month', 500, 500, 3),
  ('growth', 'Growth', 199900, 'INR', 'month', 5000, 5000, 10),
  ('enterprise', 'Enterprise', 999900, 'INR', 'month', null, null, null)
on conflict (code) do nothing;

insert into public.subscriptions (organization_id, plan_code, status, current_period_start, current_period_end)
select o.id, 'starter', 'trialing', now(), now() + interval '14 days'
from public.organizations o
where not exists (
  select 1
  from public.subscriptions s
  where s.organization_id = o.id
    and s.status in ('trialing', 'active', 'past_due')
);

create unique index if not exists idx_subscriptions_active_org
  on public.subscriptions (organization_id)
  where status in ('trialing', 'active', 'past_due');
create index if not exists idx_payments_organization_id on public.payments (organization_id);
create index if not exists idx_payment_events_organization_id on public.payment_events (organization_id);

alter table if exists public.subscriptions enable row level security;
alter table if exists public.payments enable row level security;
alter table if exists public.payment_events enable row level security;
alter table if exists public.subscription_plans enable row level security;

drop policy if exists "subscription plans readable" on public.subscription_plans;
create policy "subscription plans readable"
  on public.subscription_plans
  for select
  to authenticated
  using (is_active = true or public.is_platform_admin());

drop policy if exists "subscriptions tenant read" on public.subscriptions;
create policy "subscriptions tenant read"
  on public.subscriptions
  for select
  to authenticated
  using (public.is_org_member(organization_id) or public.is_platform_admin());

drop policy if exists "payments tenant read" on public.payments;
create policy "payments tenant read"
  on public.payments
  for select
  to authenticated
  using (public.is_org_member(organization_id) or public.is_platform_admin());

drop policy if exists "payment events admin read" on public.payment_events;
create policy "payment events admin read"
  on public.payment_events
  for select
  to authenticated
  using (public.is_platform_admin());
