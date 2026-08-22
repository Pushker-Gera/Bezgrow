-- Atomic desktop release lifecycle and explicit trust/publication policy.
-- This affects only online release-control metadata and never local ERP data.

begin;

alter table public.desktop_releases
  add column if not exists publication_mode text not null default 'cross-platform',
  add column if not exists trust_mode text not null default 'internal';

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_catalog.pg_constraint
    where conrelid = 'public.desktop_releases'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%release_status%'
  loop
    execute format('alter table public.desktop_releases drop constraint %I', constraint_name);
  end loop;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'desktop_releases_status_check_v3'
      and conrelid = 'public.desktop_releases'::regclass
  ) then
    alter table public.desktop_releases
      add constraint desktop_releases_status_check_v3
      check (release_status in ('draft', 'building', 'validating', 'ready', 'published', 'failed', 'paused', 'retired'));
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'desktop_releases_publication_mode_check_v1'
      and conrelid = 'public.desktop_releases'::regclass
  ) then
    alter table public.desktop_releases
      add constraint desktop_releases_publication_mode_check_v1
      check (publication_mode in ('cross-platform', 'staged'));
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'desktop_releases_trust_mode_check_v1'
      and conrelid = 'public.desktop_releases'::regclass
  ) then
    alter table public.desktop_releases
      add constraint desktop_releases_trust_mode_check_v1
      check (trust_mode in ('internal', 'stable'));
  end if;
end
$$;

create index if not exists idx_desktop_releases_publication_cohort
  on public.desktop_releases (
    version,
    build_number,
    release_channel,
    publication_mode,
    release_status,
    platform,
    architecture
  );

insert into public.admin_control_plane_schema_versions (version, description)
values (2026082203, 'Atomic cross-platform desktop release lifecycle and trust policy')
on conflict (version) do nothing;

do $$
begin
  if to_regprocedure('public.admin_control_plane_schema_status_2026082201()') is null then
    if to_regprocedure('public.admin_control_plane_current_schema_status()') is null then
      raise exception 'Current control-plane readiness function is missing';
    end if;
    alter function public.admin_control_plane_current_schema_status()
      rename to admin_control_plane_schema_status_2026082201;
  end if;
end;
$$;

revoke all on function public.admin_control_plane_schema_status_2026082201()
  from public, anon, authenticated;
grant execute on function public.admin_control_plane_schema_status_2026082201()
  to service_role;

create or replace function public.admin_control_plane_current_schema_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  expected_version constant bigint := 2026082203;
  actual_version bigint;
  previous_status jsonb;
  missing_columns jsonb := '[]'::jsonb;
  missing_indexes jsonb := '[]'::jsonb;
  missing_constraints jsonb := '[]'::jsonb;
  ready boolean;
  result jsonb;
begin
  previous_status := public.admin_control_plane_schema_status_2026082201();
  select max(version) into actual_version from public.admin_control_plane_schema_versions;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'desktop_releases' and column_name = 'publication_mode'
  ) then missing_columns := missing_columns || jsonb_build_array('desktop_releases.publication_mode'); end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'desktop_releases' and column_name = 'trust_mode'
  ) then missing_columns := missing_columns || jsonb_build_array('desktop_releases.trust_mode'); end if;

  if to_regclass('public.idx_desktop_releases_publication_cohort') is null then
    missing_indexes := jsonb_build_array('idx_desktop_releases_publication_cohort');
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.desktop_releases'::regclass and conname = 'desktop_releases_status_check_v3'
  ) then missing_constraints := missing_constraints || jsonb_build_array('desktop_releases_status_check_v3'); end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.desktop_releases'::regclass and conname = 'desktop_releases_publication_mode_check_v1'
  ) then missing_constraints := missing_constraints || jsonb_build_array('desktop_releases_publication_mode_check_v1'); end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.desktop_releases'::regclass and conname = 'desktop_releases_trust_mode_check_v1'
  ) then missing_constraints := missing_constraints || jsonb_build_array('desktop_releases_trust_mode_check_v1'); end if;

  ready :=
    coalesce((previous_status ->> 'ready')::boolean, false)
    and actual_version >= expected_version
    and jsonb_array_length(missing_columns) = 0
    and jsonb_array_length(missing_indexes) = 0
    and jsonb_array_length(missing_constraints) = 0;

  result := jsonb_set(previous_status, '{ready}', to_jsonb(ready));
  result := jsonb_set(result, '{expectedVersion}', to_jsonb(expected_version));
  result := jsonb_set(result, '{actualVersion}', to_jsonb(actual_version));
  result := jsonb_set(result, '{missing,columns}', coalesce(previous_status #> '{missing,columns}', '[]'::jsonb) || missing_columns);
  result := jsonb_set(result, '{missing,indexes}', coalesce(previous_status #> '{missing,indexes}', '[]'::jsonb) || missing_indexes);
  result := jsonb_set(result, '{missing,constraints}', coalesce(previous_status #> '{missing,constraints}', '[]'::jsonb) || missing_constraints);
  return result;
end;
$$;

comment on function public.admin_control_plane_current_schema_status() is
  'Service-role-only readiness verification including atomic desktop release publication state.';
revoke all on function public.admin_control_plane_current_schema_status()
  from public, anon, authenticated;
grant execute on function public.admin_control_plane_current_schema_status()
  to service_role;

notify pgrst, 'reload schema';

commit;
