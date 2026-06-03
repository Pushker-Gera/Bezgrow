-- ERP foundation tables for global inventory, billing, accounting, and procurement.
-- Safe to run after the enterprise hardening migration. It avoids destructive changes.

create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  email text,
  phone text,
  gstin text,
  tax_id text,
  address text,
  city text,
  state text,
  country text,
  opening_balance numeric default 0,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists financial_years (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  label text not null,
  starts_on date not null,
  ends_on date not null,
  is_active boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint financial_year_valid_dates check (ends_on >= starts_on)
);

create table if not exists invoice_series (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  document_type text not null,
  prefix text default '',
  next_number bigint default 1,
  padding integer default 4,
  financial_year_id uuid references financial_years(id) on delete set null,
  is_default boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint invoice_series_next_positive check (next_number > 0),
  constraint invoice_series_padding_positive check (padding >= 0)
);

create table if not exists quotations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  quote_number text not null,
  status text default 'draft',
  currency text default 'INR',
  subtotal numeric default 0,
  tax_total numeric default 0,
  discount_total numeric default 0,
  grand_total numeric default 0,
  valid_until date,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint quotations_totals_non_negative check (subtotal >= 0 and tax_total >= 0 and discount_total >= 0 and grand_total >= 0),
  constraint quotations_status_check check (status in ('draft','sent','accepted','rejected','expired','converted','cancelled'))
);

create table if not exists quotation_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  quotation_id uuid not null references quotations(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  description text,
  quantity numeric not null default 1,
  unit_price numeric not null default 0,
  tax_rate numeric default 0,
  tax_amount numeric default 0,
  line_total numeric not null default 0,
  created_at timestamptz default now(),
  constraint quotation_items_non_negative check (quantity >= 0 and unit_price >= 0 and tax_amount >= 0 and line_total >= 0)
);

create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  supplier_id uuid references suppliers(id) on delete set null,
  order_number text not null,
  status text default 'draft',
  currency text default 'INR',
  subtotal numeric default 0,
  tax_total numeric default 0,
  discount_total numeric default 0,
  grand_total numeric default 0,
  expected_date date,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint purchase_orders_totals_non_negative check (subtotal >= 0 and tax_total >= 0 and discount_total >= 0 and grand_total >= 0),
  constraint purchase_orders_status_check check (status in ('draft','sent','partially_received','received','cancelled','closed'))
);

create table if not exists purchase_order_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  description text,
  quantity numeric not null default 1,
  received_quantity numeric not null default 0,
  unit_cost numeric not null default 0,
  tax_rate numeric default 0,
  tax_amount numeric default 0,
  line_total numeric not null default 0,
  created_at timestamptz default now(),
  constraint purchase_order_items_non_negative check (quantity >= 0 and received_quantity >= 0 and unit_cost >= 0 and tax_amount >= 0 and line_total >= 0)
);

create table if not exists purchase_invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  supplier_id uuid references suppliers(id) on delete set null,
  purchase_order_id uuid references purchase_orders(id) on delete set null,
  bill_number text not null,
  status text default 'unpaid',
  currency text default 'INR',
  subtotal numeric default 0,
  tax_total numeric default 0,
  discount_total numeric default 0,
  grand_total numeric default 0,
  due_date date,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint purchase_invoices_totals_non_negative check (subtotal >= 0 and tax_total >= 0 and discount_total >= 0 and grand_total >= 0),
  constraint purchase_invoices_status_check check (status in ('unpaid','partial','paid','overdue','cancelled'))
);

create table if not exists payment_receipts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  invoice_id uuid references invoices(id) on delete set null,
  receipt_number text,
  amount numeric not null,
  payment_method text,
  reference_no text,
  received_at timestamptz default now(),
  notes text,
  created_at timestamptz default now(),
  constraint payment_receipts_amount_positive check (amount > 0)
);

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  supplier_id uuid references suppliers(id) on delete set null,
  category text,
  description text,
  amount numeric not null,
  tax_amount numeric default 0,
  expense_date date default current_date,
  payment_method text,
  reference_no text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint expenses_amount_positive check (amount >= 0 and tax_amount >= 0)
);

create table if not exists ledger_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  account_type text not null,
  account_id uuid,
  document_type text not null,
  document_id uuid,
  entry_date date default current_date,
  debit numeric default 0,
  credit numeric default 0,
  currency text default 'INR',
  description text,
  created_at timestamptz default now(),
  constraint ledger_entries_amounts_non_negative check (debit >= 0 and credit >= 0),
  constraint ledger_entries_account_type_check check (account_type in ('customer','supplier','cash','bank','tax','sales','purchase','expense','inventory','equity','liability','asset'))
);

create index if not exists suppliers_org_idx on suppliers(organization_id);
create unique index if not exists suppliers_org_email_unique on suppliers(organization_id, lower(email)) where email is not null;
create unique index if not exists suppliers_org_phone_unique on suppliers(organization_id, phone) where phone is not null;
create unique index if not exists financial_years_org_label_unique on financial_years(organization_id, label);
create unique index if not exists invoice_series_org_doc_unique on invoice_series(organization_id, document_type, prefix, financial_year_id);
create unique index if not exists quotations_org_number_unique on quotations(organization_id, quote_number);
create unique index if not exists purchase_orders_org_number_unique on purchase_orders(organization_id, order_number);
create unique index if not exists purchase_invoices_org_number_unique on purchase_invoices(organization_id, bill_number);
create index if not exists payment_receipts_org_invoice_idx on payment_receipts(organization_id, invoice_id);
create index if not exists expenses_org_date_idx on expenses(organization_id, expense_date desc);
create index if not exists ledger_entries_org_date_idx on ledger_entries(organization_id, entry_date desc);
create index if not exists ledger_entries_org_account_idx on ledger_entries(organization_id, account_type, account_id);

alter table suppliers enable row level security;
alter table financial_years enable row level security;
alter table invoice_series enable row level security;
alter table quotations enable row level security;
alter table quotation_items enable row level security;
alter table purchase_orders enable row level security;
alter table purchase_order_items enable row level security;
alter table purchase_invoices enable row level security;
alter table payment_receipts enable row level security;
alter table expenses enable row level security;
alter table ledger_entries enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'suppliers',
    'financial_years',
    'invoice_series',
    'quotations',
    'quotation_items',
    'purchase_orders',
    'purchase_order_items',
    'purchase_invoices',
    'payment_receipts',
    'expenses',
    'ledger_entries'
  ]
  loop
    execute format('drop policy if exists "%s_org_select" on %I', table_name, table_name);
    execute format('drop policy if exists "%s_org_insert" on %I', table_name, table_name);
    execute format('drop policy if exists "%s_org_update" on %I', table_name, table_name);
    execute format('create policy "%s_org_select" on %I for select to authenticated using (is_org_member(organization_id))', table_name, table_name);
    execute format('create policy "%s_org_insert" on %I for insert to authenticated with check (is_org_member(organization_id))', table_name, table_name);
    execute format('create policy "%s_org_update" on %I for update to authenticated using (is_org_member(organization_id)) with check (is_org_member(organization_id))', table_name, table_name);
  end loop;
end $$;
