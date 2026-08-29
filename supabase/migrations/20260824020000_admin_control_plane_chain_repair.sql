-- Corrective readiness contract for production environments where a later
-- migration was applied while 20260822010000_atomic_license_mutations.sql was
-- skipped. This migration is additive and does not mutate licence/device rows.

begin;

insert into public.admin_control_plane_schema_versions (version, description)
values (
  2026082402,
  'Fail-closed control-plane migration-chain and atomic licence readiness repair'
)
on conflict (version) do nothing;

do $$
begin
  if to_regprocedure('public.admin_control_plane_schema_status_2026082401()') is null then
    if to_regprocedure('public.admin_control_plane_current_schema_status()') is null then
      raise exception 'Current control-plane readiness function is missing';
    end if;
    alter function public.admin_control_plane_current_schema_status()
      rename to admin_control_plane_schema_status_2026082401;
  end if;
end;
$$;

revoke all on function public.admin_control_plane_schema_status_2026082401()
  from public, anon, authenticated;
grant execute on function public.admin_control_plane_schema_status_2026082401()
  to service_role;

create or replace function public.admin_control_plane_current_schema_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  -- This repair strengthens verification without changing the 2026082401
  -- application-facing RPC shape. Keep the advertised contract compatible
  -- with the already-deployed 0.2.4 source while recording migration history
  -- at 2026082402.
  expected_version constant bigint := 2026082401;
  actual_version bigint;
  previous_status jsonb;
  missing jsonb;
  missing_relations jsonb := '[]'::jsonb;
  missing_functions jsonb := '[]'::jsonb;
  missing_indexes jsonb := '[]'::jsonb;
  missing_rls jsonb := '[]'::jsonb;
  missing_privileges jsonb := '[]'::jsonb;
  missing_columns jsonb := '[]'::jsonb;
  missing_constraints jsonb := '[]'::jsonb;
  mutation_relation regclass;
  release_relation regclass;
  ready boolean;
begin
  previous_status := public.admin_control_plane_schema_status_2026082401();
  select max(version) into actual_version
  from public.admin_control_plane_schema_versions;

  mutation_relation := to_regclass('public.admin_license_mutations');
  release_relation := to_regclass('public.desktop_releases');

  if mutation_relation is null then
    missing_relations := missing_relations || jsonb_build_array('admin_license_mutations');
  end if;

  if to_regprocedure(
    'public.admin_mutate_license(text,text,text,timestamp with time zone,timestamp with time zone,jsonb,jsonb,text,text,text,text,uuid,text,text,text,jsonb,jsonb)'
  ) is null then
    missing_functions := missing_functions || jsonb_build_array('public.admin_mutate_license(...)');
  end if;
  if to_regprocedure(
    'public.admin_reset_app_password(text,text,text,timestamp with time zone,timestamp with time zone,jsonb,jsonb,text,text,text,text,uuid,text,text,text,jsonb,jsonb)'
  ) is null then
    missing_functions := missing_functions || jsonb_build_array('public.admin_reset_app_password(...)');
  end if;

  if to_regclass('public.idx_admin_license_mutations_license_created') is null then
    missing_indexes := missing_indexes || jsonb_build_array('idx_admin_license_mutations_license_created');
  end if;
  if to_regclass('public.idx_licenses_status_platform_created') is null then
    missing_indexes := missing_indexes || jsonb_build_array('idx_licenses_status_platform_created');
  end if;
  if to_regclass('public.idx_desktop_releases_publication_cohort') is null then
    missing_indexes := missing_indexes || jsonb_build_array('idx_desktop_releases_publication_cohort');
  end if;

  if mutation_relation is null or not exists (
    select 1 from pg_catalog.pg_class relation
    where relation.oid = mutation_relation
      and relation.relrowsecurity
      and relation.relforcerowsecurity
  ) then
    missing_rls := missing_rls || jsonb_build_array('admin_license_mutations');
  end if;

  if mutation_relation is null
     or coalesce(pg_catalog.has_table_privilege('anon', mutation_relation, 'SELECT'), false)
     or coalesce(pg_catalog.has_table_privilege('authenticated', mutation_relation, 'SELECT'), false)
     or not coalesce(pg_catalog.has_table_privilege('service_role', mutation_relation, 'SELECT'), false)
     or not coalesce(pg_catalog.has_table_privilege('service_role', mutation_relation, 'INSERT'), false) then
    missing_privileges := missing_privileges || jsonb_build_array('admin_license_mutations');
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'desktop_releases'
      and column_name = 'publication_mode'
  ) then
    missing_columns := missing_columns || jsonb_build_array('desktop_releases.publication_mode');
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'desktop_releases'
      and column_name = 'trust_mode'
  ) then
    missing_columns := missing_columns || jsonb_build_array('desktop_releases.trust_mode');
  end if;

  if release_relation is null or not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = release_relation
      and conname = 'desktop_releases_status_check_v3'
  ) then
    missing_constraints := missing_constraints || jsonb_build_array('desktop_releases_status_check_v3');
  end if;
  if release_relation is null or not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = release_relation
      and conname = 'desktop_releases_publication_mode_check_v1'
  ) then
    missing_constraints := missing_constraints || jsonb_build_array('desktop_releases_publication_mode_check_v1');
  end if;
  if release_relation is null or not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = release_relation
      and conname = 'desktop_releases_trust_mode_check_v1'
  ) then
    missing_constraints := missing_constraints || jsonb_build_array('desktop_releases_trust_mode_check_v1');
  end if;

  missing := coalesce(previous_status -> 'missing', '{}'::jsonb);
  missing := jsonb_set(missing, '{relations}', coalesce(missing -> 'relations', '[]'::jsonb) || missing_relations, true);
  missing := jsonb_set(missing, '{functions}', coalesce(missing -> 'functions', '[]'::jsonb) || missing_functions, true);
  missing := jsonb_set(missing, '{indexes}', coalesce(missing -> 'indexes', '[]'::jsonb) || missing_indexes, true);
  missing := jsonb_set(missing, '{rls}', coalesce(missing -> 'rls', '[]'::jsonb) || missing_rls, true);
  missing := jsonb_set(missing, '{privileges}', coalesce(missing -> 'privileges', '[]'::jsonb) || missing_privileges, true);
  missing := jsonb_set(missing, '{columns}', coalesce(missing -> 'columns', '[]'::jsonb) || missing_columns, true);
  missing := jsonb_set(missing, '{constraints}', coalesce(missing -> 'constraints', '[]'::jsonb) || missing_constraints, true);

  ready := coalesce((previous_status ->> 'ready')::boolean, false)
    and actual_version >= expected_version
    and jsonb_array_length(missing_relations) = 0
    and jsonb_array_length(missing_functions) = 0
    and jsonb_array_length(missing_indexes) = 0
    and jsonb_array_length(missing_rls) = 0
    and jsonb_array_length(missing_privileges) = 0
    and jsonb_array_length(missing_columns) = 0
    and jsonb_array_length(missing_constraints) = 0;

  return jsonb_build_object(
    'ready', ready,
    'expectedVersion', expected_version,
    'actualVersion', actual_version,
    'missing', missing
  );
end;
$$;

comment on function public.admin_control_plane_current_schema_status() is
  'Fail-closed current readiness check that independently verifies atomic licence and release prerequisites.';

revoke all on function public.admin_control_plane_current_schema_status()
  from public, anon, authenticated;
grant execute on function public.admin_control_plane_current_schema_status()
  to service_role;

notify pgrst, 'reload schema';

commit;
