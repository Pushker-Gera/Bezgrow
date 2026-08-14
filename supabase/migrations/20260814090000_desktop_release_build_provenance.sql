-- Immutable desktop build provenance. This migration affects only the online
-- release control plane; it never reads or modifies local ERP/customer data.

begin;

alter table public.desktop_releases
  add column if not exists build_commit text,
  add column if not exists build_timestamp timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'desktop_releases_build_commit_check_v1'
      and conrelid = 'public.desktop_releases'::regclass
  ) then
    alter table public.desktop_releases
      add constraint desktop_releases_build_commit_check_v1
      check (build_commit is null or build_commit ~ '^[0-9a-f]{40}$') not valid;
  end if;
end
$$;

create index if not exists idx_desktop_releases_provenance
  on public.desktop_releases (version, build_commit, build_timestamp desc)
  where release_status = 'published' and active;

commit;
