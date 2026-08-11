-- Device-bound Platform Administration.
-- Customer ERP data remains local SQLite data; this migration changes only
-- control-plane authorization metadata.

begin;

alter table public.registered_devices
  add column if not exists platform_admin_allowed boolean not null default false,
  add column if not exists allowed_admin_user_id uuid references public.profiles(id) on delete set null,
  add column if not exists platform_admin_public_key text,
  add column if not exists platform_admin_enabled_at timestamptz,
  add column if not exists platform_admin_revoked_at timestamptz,
  add column if not exists platform_admin_last_verified_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'registered_devices_platform_admin_public_key_check'
      and conrelid = 'public.registered_devices'::regclass
  ) then
    alter table public.registered_devices
      add constraint registered_devices_platform_admin_public_key_check
      check (
        platform_admin_public_key is null
        or platform_admin_public_key ~ '^[0-9a-f]{64}$'
      );
  end if;
end;
$$;

update public.registered_devices
set
  platform_admin_allowed = false,
  allowed_admin_user_id = null,
  platform_admin_enabled_at = null,
  platform_admin_revoked_at = coalesce(platform_admin_revoked_at, now())
where device_id <> 'BZG-23D76F50F880422489AF152B'
  and platform_admin_allowed = true;

create unique index if not exists idx_registered_devices_single_platform_admin
  on public.registered_devices ((platform_admin_allowed))
  where platform_admin_allowed = true and platform_admin_revoked_at is null;

create index if not exists idx_registered_devices_platform_admin
  on public.registered_devices (platform_admin_allowed, allowed_admin_user_id)
  where platform_admin_allowed = true and platform_admin_revoked_at is null;

create table if not exists public.platform_admin_request_nonces (
  nonce text primary key check (nonce ~ '^[0-9a-f]{48}$'),
  registered_device_id uuid not null references public.registered_devices(id) on delete cascade,
  admin_user_id uuid references public.profiles(id) on delete cascade,
  request_path text not null,
  used_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_platform_admin_request_nonces_expiry
  on public.platform_admin_request_nonces (expires_at);

alter table public.platform_admin_request_nonces enable row level security;
revoke all on table public.platform_admin_request_nonces from public, anon, authenticated;
grant select, insert, delete on table public.platform_admin_request_nonces to service_role;

-- Platform administration now crosses only the device-proof server API. An
-- admin JWT in a normal browser must not retain direct PostgREST table access.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
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
    'platform_settings'
  ]
  loop
    execute format('revoke all on public.%I from authenticated', table_name);
    execute format('grant select, insert, update, delete on public.%I to service_role', table_name);
  end loop;
end;
$$;

-- This is the single owner-authorized installation. The public key is enrolled
-- once by this exact licensed desktop and cannot subsequently be replaced by
-- the enrollment endpoint. Revocation clears access without affecting SQLite.
update public.registered_devices as device
set
  platform_admin_allowed = true,
  allowed_admin_user_id = profile.id,
  platform_admin_enabled_at = coalesce(device.platform_admin_enabled_at, now()),
  platform_admin_revoked_at = null,
  updated_at = now()
from public.profiles as profile
where device.device_id = 'BZG-23D76F50F880422489AF152B'
  and profile.id = '58dc79eb-9d86-4f50-9cb1-fea6c5470fd4'::uuid
  and lower(profile.email) = 'pushkergera@gmail.com'
  and profile.role in ('admin', 'platform_admin')
  and profile.is_suspended = false;

comment on column public.registered_devices.platform_admin_public_key is
  'Ed25519 public key for native proof-of-possession. The private key never leaves the authorized desktop credential store.';
comment on table public.platform_admin_request_nonces is
  'Single-use replay protection for device-signed Platform Admin API requests.';

insert into public.admin_control_plane_schema_versions (version, description)
values (
  2026081100,
  'Device-bound, desktop-only Platform Administration with replay-protected native proof'
)
on conflict (version) do nothing;

commit;
