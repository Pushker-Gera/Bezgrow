-- Add the Windows MSIX installer format without changing release trust or RLS policy.

begin;

alter table public.release_artifacts
  drop constraint if exists release_artifacts_artifact_type_check_v3;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'release_artifacts_artifact_type_check_v4'
      and conrelid = 'public.release_artifacts'::regclass
  ) then
    alter table public.release_artifacts
      add constraint release_artifacts_artifact_type_check_v4
      check (
        artifact_type is null
        or artifact_type in ('dmg', 'nsis', 'msi', 'msix', 'portable_exe', 'portable_zip')
      ) not valid;
  end if;
end
$$;

insert into public.admin_control_plane_schema_versions (version, description)
values (2026072702, 'Windows MSIX release artifact support')
on conflict (version) do nothing;

commit;
