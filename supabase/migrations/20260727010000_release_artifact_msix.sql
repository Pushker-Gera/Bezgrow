-- Add the Windows MSIX installer format without changing release trust or RLS policy.

begin;

alter table public.release_artifacts
  drop constraint if exists release_artifacts_artifact_type_check_v3;

alter table public.release_artifacts
  add constraint release_artifacts_artifact_type_check_v4
  check (
    artifact_type is null
    or artifact_type in ('dmg', 'nsis', 'msi', 'msix', 'portable_exe', 'portable_zip')
  ) not valid;

commit;
