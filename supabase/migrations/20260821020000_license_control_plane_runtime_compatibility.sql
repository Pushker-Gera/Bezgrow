-- Runtime compatibility for the Platform Administration licence list.
--
-- The corrective migration added licence columns after license_control_plane
-- had expanded `license.*`. PostgreSQL stores a view's expanded column list,
-- so later table columns were not automatically exposed through the view.
-- This migration appends those columns without changing or deleting licence
-- records, and advances the current readiness contract to the exact API shape.

begin;

create or replace view public.license_control_plane
with (security_invoker = true)
as
select
  license.id,
  license.platform_customer_id,
  license.platform_business_id,
  license.customer_name,
  license.customer_email,
  license.business_name,
  license.device_id,
  license.platform,
  license.app_version,
  license.plan_name,
  license.issue_date,
  license.expiry_date,
  license.grace_days,
  license.allowed_features,
  license.maximum_users,
  license.maximum_businesses,
  license.maximum_branches,
  license.internal_notes,
  license.status,
  license.signed_license_key,
  license.signature_algorithm,
  license.issuer_key_id,
  license.issued_by_admin_id,
  license.issued_by_admin_email,
  license.replaced_by_license_id,
  license.idempotency_key,
  license.created_at,
  license.updated_at,
  case
    when license.status in ('draft', 'suspended', 'revoked', 'replaced') then license.status
    when license.expiry_date + license.grace_days < current_date then 'expired'
    when license.expiry_date < current_date then 'grace_period'
    when license.expiry_date <= current_date + 30 then 'expiring'
    when license.status = 'trial' then 'trial'
    else 'active'
  end as effective_status,
  license.subject_customer_id,
  license.subject_business_id,
  license.activation_date,
  license.architecture,
  license.renewed_at,
  license.revoked_at,
  license.suspended_at
from public.licenses license;

revoke all on public.license_control_plane from public, anon, authenticated;
grant select on public.license_control_plane to service_role;

insert into public.admin_control_plane_schema_versions (version, description)
values (
  2026082102,
  'Licence control-plane runtime view compatibility and exact API readiness'
)
on conflict (version) do nothing;

-- Preserve the complete 2026082101 catalog audit, then wrap it with the exact
-- licence-view contract required by the current Platform Administration API.
do $$
begin
  if to_regprocedure('public.admin_control_plane_schema_status_2026082101()') is null then
    if to_regprocedure('public.admin_control_plane_current_schema_status()') is null then
      raise exception 'Current control-plane readiness function is missing';
    end if;

    alter function public.admin_control_plane_current_schema_status()
      rename to admin_control_plane_schema_status_2026082101;
  end if;
end;
$$;

revoke all on function public.admin_control_plane_schema_status_2026082101()
  from public, anon, authenticated;
grant execute on function public.admin_control_plane_schema_status_2026082101()
  to service_role;

create or replace function public.admin_control_plane_current_schema_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  expected_version constant bigint := 2026082102;
  actual_version bigint;
  previous_status jsonb;
  required_view_columns text[] := array[
    'license_control_plane.id',
    'license_control_plane.platform_customer_id',
    'license_control_plane.platform_business_id',
    'license_control_plane.customer_name',
    'license_control_plane.customer_email',
    'license_control_plane.business_name',
    'license_control_plane.device_id',
    'license_control_plane.platform',
    'license_control_plane.architecture',
    'license_control_plane.app_version',
    'license_control_plane.plan_name',
    'license_control_plane.issue_date',
    'license_control_plane.expiry_date',
    'license_control_plane.grace_days',
    'license_control_plane.allowed_features',
    'license_control_plane.maximum_users',
    'license_control_plane.maximum_businesses',
    'license_control_plane.maximum_branches',
    'license_control_plane.internal_notes',
    'license_control_plane.status',
    'license_control_plane.signed_license_key',
    'license_control_plane.issuer_key_id',
    'license_control_plane.signature_algorithm',
    'license_control_plane.issued_by_admin_id',
    'license_control_plane.issued_by_admin_email',
    'license_control_plane.created_at',
    'license_control_plane.updated_at',
    'license_control_plane.effective_status'
  ];
  missing_view_columns jsonb;
  ready boolean;
  result jsonb;
begin
  previous_status := public.admin_control_plane_schema_status_2026082101();

  select max(version)
  into actual_version
  from public.admin_control_plane_schema_versions;

  select coalesce(jsonb_agg(required_column order by required_column), '[]'::jsonb)
  into missing_view_columns
  from unnest(required_view_columns) required_column
  where not exists (
    select 1
    from information_schema.columns column_record
    where column_record.table_schema = 'public'
      and column_record.table_name = split_part(required_column, '.', 1)
      and column_record.column_name = split_part(required_column, '.', 2)
  );

  ready :=
    coalesce((previous_status ->> 'ready')::boolean, false)
    and actual_version >= expected_version
    and jsonb_array_length(missing_view_columns) = 0;

  result := jsonb_set(previous_status, '{ready}', to_jsonb(ready));
  result := jsonb_set(result, '{expectedVersion}', to_jsonb(expected_version));
  result := jsonb_set(result, '{actualVersion}', to_jsonb(actual_version));
  result := jsonb_set(
    result,
    '{missing,columns}',
    coalesce(previous_status #> '{missing,columns}', '[]'::jsonb) || missing_view_columns
  );
  return result;
end;
$$;

comment on function public.admin_control_plane_current_schema_status() is
  'Service-role-only readiness verification for the exact current Bezgrow control-plane API contract.';

revoke all on function public.admin_control_plane_current_schema_status()
  from public, anon, authenticated;
grant execute on function public.admin_control_plane_current_schema_status()
  to service_role;

notify pgrst, 'reload schema';

commit;
