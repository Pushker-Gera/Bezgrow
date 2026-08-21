-- Additive production updater metadata. This does not modify local ERP data,
-- licenses, authentication, RLS policy, or existing release artifacts.

begin;

alter table public.desktop_releases
  add column if not exists mandatory_after timestamptz;

alter table public.release_artifacts
  add column if not exists updater_url text,
  add column if not exists updater_size bigint,
  add column if not exists updater_sha256 text,
  add column if not exists updater_signature_status text not null default 'pending';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'release_artifacts_updater_size_check_v1'
      and conrelid = 'public.release_artifacts'::regclass
  ) then
    alter table public.release_artifacts add constraint release_artifacts_updater_size_check_v1
      check (updater_size is null or updater_size > 0) not valid;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'release_artifacts_updater_sha256_check_v1'
      and conrelid = 'public.release_artifacts'::regclass
  ) then
    alter table public.release_artifacts add constraint release_artifacts_updater_sha256_check_v1
      check (updater_sha256 is null or updater_sha256 ~ '^[0-9a-f]{64}$') not valid;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'release_artifacts_updater_signature_status_check_v1'
      and conrelid = 'public.release_artifacts'::regclass
  ) then
    alter table public.release_artifacts add constraint release_artifacts_updater_signature_status_check_v1
      check (updater_signature_status in ('pending', 'valid', 'invalid', 'missing')) not valid;
  end if;
end
$$;

create index if not exists idx_release_artifacts_updater_publication
  on public.release_artifacts (validation_status, updater_signature_status, validated_at desc);

insert into public.admin_control_plane_schema_versions (version, description)
values (2026080109, 'Cryptographically signed desktop updater delivery metadata')
on conflict (version) do nothing;

commit;
