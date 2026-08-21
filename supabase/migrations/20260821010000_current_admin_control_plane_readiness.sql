-- Current Bezgrow Platform Administration readiness contract.
--
-- This migration is additive and idempotent. It verifies the original and
-- corrective control-plane migrations plus the later updater, device-bound
-- authorization, and immutable release-provenance migrations. It never reads,
-- writes, alters, or drops customer ERP relations.

begin;

alter table public.platform_admin_request_nonces enable row level security;
alter table public.platform_admin_request_nonces force row level security;
revoke all on table public.platform_admin_request_nonces from public, anon, authenticated;
grant select, insert, delete on table public.platform_admin_request_nonces to service_role;

insert into public.admin_control_plane_schema_versions (version, description)
values (
  2026082101,
  'Current control-plane readiness: updater, device authorization, and release provenance'
)
on conflict (version) do nothing;

create or replace function public.admin_control_plane_current_schema_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  expected_version constant bigint := 2026082101;
  actual_version bigint;
  base_status jsonb;
  required_relations text[] := array[
    'platform_admin_request_nonces'
  ];
  required_columns text[] := array[
    'desktop_releases.mandatory_after',
    'desktop_releases.build_commit',
    'desktop_releases.build_timestamp',
    'release_artifacts.artifact_type',
    'release_artifacts.file_name',
    'release_artifacts.update_signature',
    'release_artifacts.updater_url',
    'release_artifacts.updater_size',
    'release_artifacts.updater_sha256',
    'release_artifacts.updater_signature_status',
    'registered_devices.platform_admin_allowed',
    'registered_devices.allowed_admin_user_id',
    'registered_devices.platform_admin_public_key',
    'registered_devices.platform_admin_enabled_at',
    'registered_devices.platform_admin_revoked_at',
    'registered_devices.platform_admin_last_verified_at',
    'platform_admin_request_nonces.nonce',
    'platform_admin_request_nonces.registered_device_id',
    'platform_admin_request_nonces.admin_user_id',
    'platform_admin_request_nonces.request_path',
    'platform_admin_request_nonces.used_at',
    'platform_admin_request_nonces.expires_at'
  ];
  required_functions text[] := array[
    'public.admin_control_plane_dashboard_v2(uuid,integer)',
    'public.register_device_checkin(text,text,text,uuid,uuid,text,text,text,text,text,text,text,text,text,boolean,timestamp with time zone,timestamp with time zone)'
  ];
  required_indexes text[] := array[
    'idx_release_artifacts_type',
    'idx_release_artifacts_updater_publication',
    'idx_registered_devices_single_platform_admin',
    'idx_registered_devices_platform_admin',
    'idx_platform_admin_request_nonces_expiry',
    'idx_desktop_releases_provenance'
  ];
  required_constraints text[] := array[
    'release_artifacts_artifact_type_check_v4',
    'release_artifacts_updater_size_check_v1',
    'release_artifacts_updater_sha256_check_v1',
    'release_artifacts_updater_signature_status_check_v1',
    'registered_devices_platform_admin_public_key_check',
    'desktop_releases_build_commit_check_v1'
  ];
  restricted_relations text[] := array[
    'admin_control_plane_schema_versions',
    'platform_customers',
    'platform_businesses',
    'licenses',
    'license_events',
    'registered_devices',
    'device_checkins',
    'desktop_releases',
    'release_artifacts',
    'backup_status',
    'support_cases',
    'diagnostic_uploads',
    'admin_audit_logs',
    'platform_settings',
    'platform_admin_request_nonces'
  ];
  missing_relations jsonb;
  missing_columns jsonb;
  missing_functions jsonb;
  missing_indexes jsonb;
  missing_constraints jsonb;
  missing_rls jsonb;
  missing_privileges jsonb;
  unexpected_policies jsonb;
  ready boolean;
begin
  base_status := public.admin_control_plane_schema_status();

  select max(version)
  into actual_version
  from public.admin_control_plane_schema_versions;

  select coalesce(jsonb_agg(required_relation order by required_relation), '[]'::jsonb)
  into missing_relations
  from unnest(required_relations) required_relation
  where to_regclass(format('public.%I', required_relation)) is null;

  select coalesce(jsonb_agg(required_column order by required_column), '[]'::jsonb)
  into missing_columns
  from unnest(required_columns) required_column
  where not exists (
    select 1
    from information_schema.columns column_record
    where column_record.table_schema = 'public'
      and column_record.table_name = split_part(required_column, '.', 1)
      and column_record.column_name = split_part(required_column, '.', 2)
  );

  select coalesce(jsonb_agg(required_function order by required_function), '[]'::jsonb)
  into missing_functions
  from unnest(required_functions) required_function
  where to_regprocedure(required_function) is null;

  select coalesce(jsonb_agg(required_index order by required_index), '[]'::jsonb)
  into missing_indexes
  from unnest(required_indexes) required_index
  where to_regclass(format('public.%I', required_index)) is null;

  select coalesce(jsonb_agg(required_constraint order by required_constraint), '[]'::jsonb)
  into missing_constraints
  from unnest(required_constraints) required_constraint
  where not exists (
    select 1
    from pg_catalog.pg_constraint constraint_record
    join pg_catalog.pg_class relation on relation.oid = constraint_record.conrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and constraint_record.conname = required_constraint
  );

  select case
    when relation.oid is null or not relation.relrowsecurity or not relation.relforcerowsecurity
      then jsonb_build_array('platform_admin_request_nonces')
    else '[]'::jsonb
  end
  into missing_rls
  from (select to_regclass('public.platform_admin_request_nonces') as oid) target
  left join pg_catalog.pg_class relation on relation.oid = target.oid;

  select coalesce(jsonb_agg(relation_name order by relation_name), '[]'::jsonb)
  into missing_privileges
  from unnest(restricted_relations) relation_name
  where
    pg_catalog.has_table_privilege('anon', format('public.%I', relation_name), 'SELECT')
    or pg_catalog.has_table_privilege('anon', format('public.%I', relation_name), 'INSERT')
    or pg_catalog.has_table_privilege('anon', format('public.%I', relation_name), 'UPDATE')
    or pg_catalog.has_table_privilege('anon', format('public.%I', relation_name), 'DELETE')
    or pg_catalog.has_table_privilege('authenticated', format('public.%I', relation_name), 'SELECT')
    or pg_catalog.has_table_privilege('authenticated', format('public.%I', relation_name), 'INSERT')
    or pg_catalog.has_table_privilege('authenticated', format('public.%I', relation_name), 'UPDATE')
    or pg_catalog.has_table_privilege('authenticated', format('public.%I', relation_name), 'DELETE')
    or not (
      pg_catalog.has_table_privilege('service_role', format('public.%I', relation_name), 'SELECT')
      and pg_catalog.has_table_privilege('service_role', format('public.%I', relation_name), 'INSERT')
      and pg_catalog.has_table_privilege('service_role', format('public.%I', relation_name), 'DELETE')
    );

  select coalesce(
    jsonb_agg(format('%s.%s', policy_record.tablename, policy_record.policyname)
      order by policy_record.policyname),
    '[]'::jsonb
  )
  into unexpected_policies
  from pg_catalog.pg_policies policy_record
  where policy_record.schemaname = 'public'
    and policy_record.tablename = 'platform_admin_request_nonces';

  ready :=
    coalesce((base_status ->> 'ready')::boolean, false)
    and actual_version >= expected_version
    and jsonb_array_length(missing_relations) = 0
    and jsonb_array_length(missing_columns) = 0
    and jsonb_array_length(missing_functions) = 0
    and jsonb_array_length(missing_indexes) = 0
    and jsonb_array_length(missing_constraints) = 0
    and jsonb_array_length(missing_rls) = 0
    and jsonb_array_length(missing_privileges) = 0
    and jsonb_array_length(unexpected_policies) = 0;

  return jsonb_build_object(
    'ready', ready,
    'expectedVersion', expected_version,
    'actualVersion', actual_version,
    'missing', jsonb_build_object(
      'relations', coalesce(base_status #> '{missing,relations}', '[]'::jsonb) || missing_relations,
      'columns', coalesce(base_status #> '{missing,columns}', '[]'::jsonb) || missing_columns,
      'functions', coalesce(base_status #> '{missing,functions}', '[]'::jsonb) || missing_functions,
      'indexes', coalesce(base_status #> '{missing,indexes}', '[]'::jsonb) || missing_indexes,
      'constraints', coalesce(base_status #> '{missing,constraints}', '[]'::jsonb) || missing_constraints,
      'triggers', coalesce(base_status #> '{missing,triggers}', '[]'::jsonb),
      'rls', coalesce(base_status #> '{missing,rls}', '[]'::jsonb) || missing_rls,
      'policies', coalesce(base_status #> '{missing,policies}', '[]'::jsonb),
      'privileges', missing_privileges,
      'unexpectedPolicies', unexpected_policies
    )
  );
end;
$$;

comment on function public.admin_control_plane_current_schema_status() is
  'Service-role-only readiness verification for every current Bezgrow control-plane migration.';

revoke all on function public.admin_control_plane_current_schema_status()
  from public, anon, authenticated;
grant execute on function public.admin_control_plane_current_schema_status()
  to service_role;

notify pgrst, 'reload schema';

commit;
