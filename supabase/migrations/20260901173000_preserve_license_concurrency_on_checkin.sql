-- Routine device check-ins update registered_devices and device_checkins, but
-- the legacy RPC also issues an UPDATE against licenses on every heartbeat.
-- Once activation metadata is stable that UPDATE changes only updated_at,
-- invalidating an administrator's optimistic-concurrency token while a dialog
-- is open. Preserve the token for those no-op licence updates without changing
-- the device check-in, audit, or licence-signing contracts.

begin;

create or replace function public.set_control_plane_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_table_name = 'licenses'
     and (to_jsonb(new) - 'updated_at') is not distinct from
         (to_jsonb(old) - 'updated_at') then
    new.updated_at := old.updated_at;
  else
    new.updated_at := now();
  end if;
  return new;
end;
$$;

comment on function public.set_control_plane_updated_at() is
  'Maintains control-plane update timestamps while preserving the licence concurrency token for no-op device check-ins.';

insert into public.admin_control_plane_schema_versions (version, description)
values (
  2026090117,
  'Preserve licence optimistic-concurrency tokens across routine device check-ins'
)
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
