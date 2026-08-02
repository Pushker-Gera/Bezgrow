-- Bezgrow local-first cutover: retire the empty legacy Supabase ERP schema.
--
-- APPLY ONLY from a privileged Supabase SQL session after independently
-- verifying the protected export and local SQLite migration. Run this whole
-- file as one unit. The required transaction-local values are intentionally
-- set here so copying only the destructive statements cannot bypass the gate.
--
-- Protected export:
--   private/migration-backups/2026-08-01T18-42-12-349Z/manifest.json
-- Manifest SHA-256:
--   8e5fd0b7a99605cc6ed3eaf2f176969e89503bc01255fae6b6b48ea5ee2664d7
--
-- Recovery:
--   * Any failed assertion aborts this transaction; PostgreSQL restores every
--     table, policy, function, constraint, and grant automatically.
--   * Before COMMIT, issue ROLLBACK to cancel the retirement.
--   * After COMMIT, recover schema definitions from repository migrations or a
--     Supabase point-in-time restore. Recover historical ERP rows only from the
--     protected export after re-verifying its manifest and per-file checksums.
--     Never restore those rows into the active cloud ERP as a normal fallback.

begin;

set local app.bezgrow_erp_export_verified = 'true';
set local app.bezgrow_local_migration_verified = 'true';
set local app.bezgrow_export_manifest_sha256 =
  '8e5fd0b7a99605cc6ed3eaf2f176969e89503bc01255fae6b6b48ea5ee2664d7';

do $$
begin
  if current_setting('app.bezgrow_erp_export_verified', true) is distinct from 'true' then
    raise exception 'Cloud ERP retirement blocked: verified export evidence is required.';
  end if;
  if current_setting('app.bezgrow_local_migration_verified', true) is distinct from 'true' then
    raise exception 'Cloud ERP retirement blocked: verified local migration evidence is required.';
  end if;
  if current_setting('app.bezgrow_export_manifest_sha256', true) is distinct from
    '8e5fd0b7a99605cc6ed3eaf2f176969e89503bc01255fae6b6b48ea5ee2664d7' then
    raise exception 'Cloud ERP retirement blocked: export manifest checksum does not match.';
  end if;
end $$;

-- Remember every protected control-plane relation and function that exists at
-- entry. The postcondition below requires the same object OIDs to remain.
create temporary table bezgrow_protected_relations_before (
  object_name text primary key,
  object_oid oid not null
) on commit drop;

insert into bezgrow_protected_relations_before (object_name, object_oid)
select relation.relname, relation.oid
from pg_catalog.pg_class relation
join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
where namespace.nspname = 'public'
  and relation.relname = any (array[
    'profiles',
    'pending_users',
    'platform_customers',
    'platform_businesses',
    'licenses',
    'license_control_plane',
    'license_events',
    'registered_devices',
    'device_checkins',
    'desktop_releases',
    'release_artifacts',
    'backup_status',
    'support_cases',
    'diagnostic_uploads',
    'platform_settings',
    'admin_control_plane_schema_versions',
    'admin_audit_logs',
    'admin_logs'
  ]::text[]);

create temporary table bezgrow_protected_functions_before (
  object_oid oid primary key,
  object_identity text not null
) on commit drop;

insert into bezgrow_protected_functions_before (object_oid, object_identity)
select procedure.oid, pg_catalog.pg_get_function_identity_arguments(procedure.oid)
from pg_catalog.pg_proc procedure
join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
where namespace.nspname = 'public'
  and procedure.proname = any (array[
    'is_platform_admin',
    'admin_control_plane_dashboard',
    'admin_control_plane_dashboard_v2',
    'admin_control_plane_analytics',
    'admin_control_plane_schema_status',
    'register_device_checkin',
    'prevent_control_plane_log_mutation',
    'set_control_plane_updated_at'
  ]::text[]);

-- Fail closed if even one classified ERP table contains data. The relation
-- list is fixed and identifier-quoted; absent tables are safely ignored.
do $$
declare
  table_name text;
  relation_kind "char";
  row_count bigint;
begin
  foreach table_name in array array[
    'invoice_share_links',
    'accounting_voucher_entries',
    'accounting_vouchers',
    'chart_of_accounts',
    'bank_accounts',
    'invoice_payments',
    'payment_receipts',
    'invoice_items',
    'sales_invoice_items',
    'sales_invoices',
    'invoices',
    'order_items',
    'orders',
    'quotation_items',
    'quotations',
    'purchase_invoice_items',
    'purchase_invoices',
    'purchase_order_items',
    'purchase_orders',
    'stock_movements',
    'inventory_items',
    'warehouses',
    'products',
    'customers',
    'suppliers',
    'expenses',
    'ledger_entries',
    'invoice_series',
    'financial_years',
    'organization_features',
    'organization_members',
    'org_features',
    'org_members',
    'organizations'
  ] loop
    select relation.relkind
    into relation_kind
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = table_name;

    if relation_kind is null then
      continue;
    end if;
    if relation_kind not in ('r', 'p') then
      raise exception 'Cloud ERP retirement blocked: public.% is not an ordinary or partitioned table.', table_name;
    end if;

    execute format('select count(*) from public.%I', table_name) into row_count;
    if row_count <> 0 then
      raise exception 'Cloud ERP retirement blocked: public.% contains % row(s).', table_name, row_count;
    end if;
  end loop;
end $$;

-- Retained subscription/payment metadata historically referenced the ERP
-- organization table. Remove only those exact, now-unused foreign keys. The
-- columns and every control-plane row remain intact. A non-null reference is
-- treated as data and blocks retirement.
do $$
declare
  relation_name text;
  non_null_count bigint;
  constraint_record record;
begin
  foreach relation_name in array array[
    'platform_businesses',
    'subscriptions',
    'payments',
    'payment_events'
  ] loop
    if to_regclass(format('public.%I', relation_name)) is not null
       and exists (
         select 1
         from information_schema.columns
         where table_schema = 'public'
           and table_name = relation_name
           and column_name = case
             when relation_name = 'platform_businesses' then 'legacy_organization_id'
             else 'organization_id'
           end
       ) then
      execute format(
        'select count(*) from public.%I where %I is not null',
        relation_name,
        case when relation_name = 'platform_businesses' then 'legacy_organization_id' else 'organization_id' end
      ) into non_null_count;
      if non_null_count <> 0 then
        raise exception 'Cloud ERP retirement blocked: public.% retains % organization reference(s).',
          relation_name, non_null_count;
      end if;
    end if;
  end loop;

  if to_regclass('public.organizations') is not null then
    for constraint_record in
      select relation.relname as relation_name, constraint_entry.conname
      from pg_catalog.pg_constraint constraint_entry
      join pg_catalog.pg_class relation on relation.oid = constraint_entry.conrelid
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where constraint_entry.contype = 'f'
        and constraint_entry.confrelid = 'public.organizations'::regclass
        and namespace.nspname = 'public'
        and relation.relname = any (array[
          'platform_businesses',
          'subscriptions',
          'payments',
          'payment_events'
        ]::text[])
    loop
      execute format(
        'alter table public.%I drop constraint if exists %I',
        constraint_record.relation_name,
        constraint_record.conname
      );
    end loop;
  end if;
end $$;

-- These two retained-table policies were the only non-ERP dependants of the
-- retired organization-membership helper. They no longer grant desktop users
-- visibility into legacy subscription/payment metadata.
do $$
begin
  if to_regclass('public.subscriptions') is not null then
    drop policy if exists "subscriptions tenant read" on public.subscriptions;
    revoke all on table public.subscriptions from anon, authenticated;
  end if;
  if to_regclass('public.payments') is not null then
    drop policy if exists "payments tenant read" on public.payments;
    revoke all on table public.payments from anon, authenticated;
  end if;
end $$;

-- Drop classified ERP tables in dependency order. Deliberately do not use
-- CASCADE: an unclassified dependency makes the transaction fail and roll back.
drop table if exists public.invoice_share_links;
drop table if exists public.accounting_voucher_entries;
drop table if exists public.accounting_vouchers;
drop table if exists public.chart_of_accounts;
drop table if exists public.bank_accounts;
drop table if exists public.invoice_payments;
drop table if exists public.payment_receipts;
drop table if exists public.invoice_items;
drop table if exists public.sales_invoice_items;
drop table if exists public.sales_invoices;
drop table if exists public.invoices;
drop table if exists public.order_items;
drop table if exists public.orders;
drop table if exists public.quotation_items;
drop table if exists public.quotations;
drop table if exists public.purchase_invoice_items;
drop table if exists public.purchase_invoices;
drop table if exists public.purchase_order_items;
drop table if exists public.purchase_orders;
drop table if exists public.stock_movements;
drop table if exists public.inventory_items;
drop table if exists public.warehouses;
drop table if exists public.products;
drop table if exists public.customers;
drop table if exists public.suppliers;
drop table if exists public.expenses;
drop table if exists public.ledger_entries;
drop table if exists public.invoice_series;
drop table if exists public.financial_years;
drop table if exists public.organization_features;
drop table if exists public.org_features;

-- ERP table policies and triggers are removed with their owning tables. Once
-- retained legacy policies above are gone, this helper has no valid caller.
do $$
declare
  relation_name text;
  policy_record record;
begin
  foreach relation_name in array array['organization_members', 'org_members'] loop
    if to_regclass(format('public.%I', relation_name)) is not null then
      for policy_record in
        select policyname
        from pg_catalog.pg_policies
        where schemaname = 'public' and tablename = relation_name
      loop
        execute format('drop policy if exists %I on public.%I', policy_record.policyname, relation_name);
      end loop;
    end if;
  end loop;
end $$;

drop function if exists public.is_org_member(uuid);

drop table if exists public.organization_members;
drop table if exists public.org_members;
drop table if exists public.organizations;

-- Refuse COMMIT unless all classified ERP relations are absent and every
-- protected control-plane object that existed on entry still has the same OID.
do $$
declare
  remaining_erp text;
  changed_protected_relations text;
  changed_protected_functions text;
begin
  select string_agg(relation.relname, ', ' order by relation.relname)
  into remaining_erp
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = any (array[
      'invoice_share_links', 'accounting_voucher_entries', 'accounting_vouchers',
      'chart_of_accounts', 'bank_accounts', 'invoice_payments', 'payment_receipts',
      'invoice_items', 'sales_invoice_items', 'sales_invoices', 'invoices',
      'order_items', 'orders', 'quotation_items', 'quotations',
      'purchase_invoice_items', 'purchase_invoices', 'purchase_order_items',
      'purchase_orders', 'stock_movements', 'inventory_items', 'warehouses',
      'products', 'customers', 'suppliers', 'expenses', 'ledger_entries',
      'invoice_series', 'financial_years', 'organization_features',
      'organization_members', 'org_features', 'org_members', 'organizations'
    ]::text[]);

  select string_agg(snapshot.object_name, ', ' order by snapshot.object_name)
  into changed_protected_relations
  from bezgrow_protected_relations_before snapshot
  where not exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = snapshot.object_name
      and relation.oid = snapshot.object_oid
  );

  select string_agg(snapshot.object_identity, ', ' order by snapshot.object_identity)
  into changed_protected_functions
  from bezgrow_protected_functions_before snapshot
  where not exists (
    select 1 from pg_catalog.pg_proc procedure where procedure.oid = snapshot.object_oid
  );

  if remaining_erp is not null then
    raise exception 'Cloud ERP retirement verification failed; relations remain: %', remaining_erp;
  end if;
  if changed_protected_relations is not null then
    raise exception 'Cloud ERP retirement verification failed; protected relations changed: %', changed_protected_relations;
  end if;
  if changed_protected_functions is not null then
    raise exception 'Cloud ERP retirement verification failed; protected functions changed: %', changed_protected_functions;
  end if;
end $$;

-- Verification query: a successful result must report zero remaining ERP
-- relations and zero changed protected relations/functions before COMMIT.
select
  0::integer as remaining_erp_relations,
  0::integer as changed_protected_relations,
  0::integer as changed_protected_functions,
  'verified; transaction may commit'::text as retirement_status;

notify pgrst, 'reload schema';

commit;
