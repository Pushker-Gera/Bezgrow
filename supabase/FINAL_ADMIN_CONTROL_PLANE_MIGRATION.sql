-- Bezgrow platform administration control plane.
-- This migration is additive and idempotent. Customer ERP tables and historical
-- approval records are intentionally retained, but are not used by the new
-- licensed desktop access flow.

begin;

create extension if not exists pgcrypto;

do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'Required base table public.profiles is missing';
  end if;
  if to_regclass('public.organizations') is null then
    raise exception 'Required base table public.organizations is missing';
  end if;
  if to_regclass('public.organization_members') is null then
    raise exception 'Required base table public.organization_members is missing';
  end if;
end
$$;

create table if not exists public.admin_control_plane_schema_versions (
  version bigint primary key,
  description text not null,
  applied_at timestamptz not null default now()
);

-- One-time authoritative role repair for the existing Bezgrow platform owner.
-- Runtime authorization never trusts this email; it trusts this profiles row.
update public.profiles profile
set
  role = 'platform_admin',
  is_suspended = false,
  updated_at = now()
from auth.users auth_user
where profile.id = auth_user.id
  and lower(auth_user.email) = 'pushkergera@gmail.com'
  and (
    profile.role is distinct from 'platform_admin'
    or coalesce(profile.is_suspended, false)
  );

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('admin', 'platform_admin')
      and coalesce(p.is_suspended, false) = false
  );
$$;

revoke all on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated, service_role;

-- Licensed workspaces no longer depend on the legacy approved flag.
create or replace function public.is_org_member(target_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.organization_members om
    join public.profiles p on p.id = om.user_id
    where om.user_id = auth.uid()
      and om.organization_id = target_org_id
      and coalesce(p.is_suspended, false) = false
  );
$$;

revoke all on function public.is_org_member(uuid) from public, anon;
grant execute on function public.is_org_member(uuid) to authenticated, service_role;

-- Keep pending_users for historical migration, but disable new approval
-- requests and remove it from current access control.
do $$
begin
  if to_regclass('public.pending_users') is not null then
    drop policy if exists "public can request approval" on public.pending_users;
    revoke insert, update, delete on public.pending_users from anon, authenticated;
  end if;
end $$;

create table if not exists public.platform_customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  phone text,
  company text,
  country text,
  account_status text not null default 'active'
    check (account_status in ('active', 'suspended', 'closed')),
  support_status text not null default 'none'
    check (support_status in ('none', 'open', 'attention', 'resolved')),
  notes text,
  last_platform_activity_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.platform_customers
  add column if not exists name text,
  add column if not exists email text,
  add column if not exists phone text,
  add column if not exists company text,
  add column if not exists country text,
  add column if not exists account_status text not null default 'active',
  add column if not exists support_status text not null default 'none',
  add column if not exists notes text,
  add column if not exists last_platform_activity_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists platform_customers_email_unique
  on public.platform_customers (lower(email));
create index if not exists idx_platform_customers_status_created
  on public.platform_customers (account_status, created_at desc);
create index if not exists idx_platform_customers_company
  on public.platform_customers (company);

create table if not exists public.platform_businesses (
  id uuid primary key default gen_random_uuid(),
  platform_customer_id uuid references public.platform_customers(id) on delete set null,
  legacy_organization_id uuid references public.organizations(id) on delete set null,
  workspace_id text not null,
  business_name text not null,
  plan_name text,
  status text not null default 'active'
    check (status in ('active', 'suspended', 'closed')),
  platform text check (platform is null or platform in ('macos', 'windows')),
  app_version text,
  update_channel text not null default 'stable',
  cloud_mode text not null default 'local_only'
    check (cloud_mode in ('local_only', 'cloud_backup', 'metadata_sync')),
  cloud_backup_enabled boolean not null default false,
  last_sync_at timestamptz,
  last_backup_at timestamptz,
  telemetry_reported_at timestamptz,
  telemetry_summary jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.platform_businesses
  add column if not exists platform_customer_id uuid references public.platform_customers(id) on delete set null,
  add column if not exists legacy_organization_id uuid references public.organizations(id) on delete set null,
  add column if not exists workspace_id text,
  add column if not exists business_name text,
  add column if not exists plan_name text,
  add column if not exists status text not null default 'active',
  add column if not exists platform text,
  add column if not exists app_version text,
  add column if not exists update_channel text not null default 'stable',
  add column if not exists cloud_mode text not null default 'local_only',
  add column if not exists cloud_backup_enabled boolean not null default false,
  add column if not exists last_sync_at timestamptz,
  add column if not exists last_backup_at timestamptz,
  add column if not exists telemetry_reported_at timestamptz,
  add column if not exists telemetry_summary jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists platform_businesses_workspace_id_unique
  on public.platform_businesses (workspace_id);
create unique index if not exists platform_businesses_legacy_org_unique
  on public.platform_businesses (legacy_organization_id)
  where legacy_organization_id is not null;
create index if not exists idx_platform_businesses_customer_status
  on public.platform_businesses (platform_customer_id, status);
create index if not exists idx_platform_businesses_cloud_platform
  on public.platform_businesses (cloud_mode, platform, update_channel);
create index if not exists idx_platform_businesses_app_version
  on public.platform_businesses (app_version);

-- Preserve existing platform accounts and organization metadata without
-- importing retail customers, invoices, products, or other ERP records.
insert into public.platform_customers (
  id,
  name,
  email,
  account_status,
  last_platform_activity_at,
  created_at,
  updated_at
)
select
  p.id,
  coalesce(nullif(p.full_name, ''), p.email),
  p.email,
  case when coalesce(p.is_suspended, false) then 'suspended' else 'active' end,
  p.last_login_at,
  coalesce(p.created_at, now()),
  coalesce(p.updated_at, p.created_at, now())
from public.profiles p
where p.email is not null
  and coalesce(p.role, 'user') not in ('admin', 'platform_admin')
  and not exists (
    select 1
    from public.platform_customers existing_customer
    where existing_customer.id = p.id
       or lower(existing_customer.email) = lower(p.email)
  )
on conflict (id) do nothing;

insert into public.platform_businesses (
  platform_customer_id,
  legacy_organization_id,
  workspace_id,
  business_name,
  plan_name,
  status,
  cloud_mode,
  cloud_backup_enabled,
  created_at,
  updated_at
)
select
  coalesce(owner_customer.id, email_customer.id),
  organization.id,
  organization.id::text,
  organization.name,
  organization.plan,
  case when coalesce(organization.is_suspended, false) then 'suspended' else 'active' end,
  'local_only',
  false,
  coalesce(organization.created_at, now()),
  coalesce(organization.updated_at, organization.created_at, now())
from public.organizations organization
left join public.profiles owner_profile on owner_profile.id = organization.owner_id
left join public.platform_customers owner_customer on owner_customer.id = organization.owner_id
left join public.platform_customers email_customer
  on owner_profile.email is not null
 and lower(email_customer.email) = lower(owner_profile.email)
where not exists (
  select 1
  from public.platform_businesses existing_business
  where existing_business.legacy_organization_id = organization.id
     or existing_business.workspace_id = organization.id::text
)
on conflict (workspace_id) do nothing;

create table if not exists public.licenses (
  id text primary key,
  platform_customer_id uuid references public.platform_customers(id) on delete set null,
  platform_business_id uuid references public.platform_businesses(id) on delete set null,
  customer_name text not null,
  customer_email text,
  business_name text not null,
  device_id text not null,
  platform text not null check (platform in ('macos', 'windows')),
  app_version text,
  plan_name text not null,
  issue_date date not null default current_date,
  expiry_date date not null,
  grace_days integer not null default 7 check (grace_days between 0 and 365),
  allowed_features jsonb not null default '[]'::jsonb,
  maximum_users integer not null default 1 check (maximum_users > 0),
  maximum_businesses integer not null default 1 check (maximum_businesses > 0),
  maximum_branches integer not null default 1 check (maximum_branches > 0),
  internal_notes text,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'expiring', 'grace_period', 'expired', 'suspended', 'revoked', 'replaced', 'trial')),
  signed_license_key text,
  signature_algorithm text,
  issuer_key_id text,
  issued_by_admin_id uuid,
  issued_by_admin_email text,
  replaced_by_license_id text references public.licenses(id) on delete set null,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.licenses
  add column if not exists platform_customer_id uuid references public.platform_customers(id) on delete set null,
  add column if not exists platform_business_id uuid references public.platform_businesses(id) on delete set null,
  add column if not exists customer_name text,
  add column if not exists customer_email text,
  add column if not exists business_name text,
  add column if not exists device_id text,
  add column if not exists platform text,
  add column if not exists app_version text,
  add column if not exists plan_name text,
  add column if not exists issue_date date not null default current_date,
  add column if not exists expiry_date date,
  add column if not exists grace_days integer not null default 7,
  add column if not exists allowed_features jsonb not null default '[]'::jsonb,
  add column if not exists maximum_users integer not null default 1,
  add column if not exists maximum_businesses integer not null default 1,
  add column if not exists maximum_branches integer not null default 1,
  add column if not exists internal_notes text,
  add column if not exists status text not null default 'draft',
  add column if not exists signed_license_key text,
  add column if not exists signature_algorithm text,
  add column if not exists issuer_key_id text,
  add column if not exists issued_by_admin_id uuid,
  add column if not exists issued_by_admin_email text,
  add column if not exists replaced_by_license_id text references public.licenses(id) on delete set null,
  add column if not exists idempotency_key text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists licenses_idempotency_key_unique
  on public.licenses (idempotency_key)
  where idempotency_key is not null;
create index if not exists idx_licenses_status_expiry
  on public.licenses (status, expiry_date);
create index if not exists idx_licenses_device
  on public.licenses (device_id, created_at desc);
create index if not exists idx_licenses_customer
  on public.licenses (platform_customer_id, created_at desc);
create index if not exists idx_licenses_business
  on public.licenses (platform_business_id, created_at desc);
create index if not exists idx_licenses_plan_platform
  on public.licenses (plan_name, platform);

create or replace view public.license_control_plane
with (security_invoker = true)
as
select
  license.*,
  case
    when license.status in ('draft', 'suspended', 'revoked', 'replaced') then license.status
    when license.expiry_date + license.grace_days < current_date then 'expired'
    when license.expiry_date < current_date then 'grace_period'
    when license.expiry_date <= current_date + 30 then 'expiring'
    when license.status = 'trial' then 'trial'
    else 'active'
  end as effective_status
from public.licenses license;

revoke all on public.license_control_plane from public, anon, authenticated;
grant select on public.license_control_plane to service_role;

create table if not exists public.license_events (
  id uuid primary key default gen_random_uuid(),
  license_id text not null references public.licenses(id) on delete restrict,
  action text not null,
  admin_user_id uuid,
  admin_email text,
  previous_values jsonb,
  new_values jsonb,
  notes text,
  request_id text,
  created_at timestamptz not null default now()
);

alter table public.license_events
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists license_id text,
  add column if not exists action text,
  add column if not exists admin_user_id uuid,
  add column if not exists admin_email text,
  add column if not exists previous_values jsonb,
  add column if not exists new_values jsonb,
  add column if not exists notes text,
  add column if not exists request_id text,
  add column if not exists created_at timestamptz not null default now();

create index if not exists idx_license_events_license_created
  on public.license_events (license_id, created_at desc);
create index if not exists idx_license_events_admin_created
  on public.license_events (admin_user_id, created_at desc);

create table if not exists public.registered_devices (
  id uuid primary key default gen_random_uuid(),
  device_id text not null unique,
  platform_customer_id uuid references public.platform_customers(id) on delete set null,
  platform_business_id uuid references public.platform_businesses(id) on delete set null,
  license_id text references public.licenses(id) on delete set null,
  platform text check (platform is null or platform in ('macos', 'windows')),
  operating_system text,
  architecture text,
  app_version text,
  activation_date timestamptz,
  last_reported_at timestamptz,
  last_update_check_at timestamptz,
  release_channel text not null default 'stable',
  device_status text not null default 'registered'
    check (device_status in ('registered', 'active', 'revoked', 'replaced')),
  diagnostics_available boolean not null default false,
  diagnostic_requested_at timestamptz,
  online_session_version integer not null default 1,
  replaced_by_device_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.registered_devices
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists device_id text,
  add column if not exists platform_customer_id uuid,
  add column if not exists platform_business_id uuid,
  add column if not exists license_id text,
  add column if not exists platform text,
  add column if not exists operating_system text,
  add column if not exists architecture text,
  add column if not exists app_version text,
  add column if not exists activation_date timestamptz,
  add column if not exists last_reported_at timestamptz,
  add column if not exists last_update_check_at timestamptz,
  add column if not exists release_channel text not null default 'stable',
  add column if not exists device_status text not null default 'registered',
  add column if not exists diagnostics_available boolean not null default false,
  add column if not exists diagnostic_requested_at timestamptz,
  add column if not exists online_session_version integer not null default 1,
  add column if not exists replaced_by_device_id text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_registered_devices_status_reported
  on public.registered_devices (device_status, last_reported_at desc);
create index if not exists idx_registered_devices_customer
  on public.registered_devices (platform_customer_id);
create index if not exists idx_registered_devices_license
  on public.registered_devices (license_id);
create index if not exists idx_registered_devices_platform_version
  on public.registered_devices (platform, architecture, app_version);

create table if not exists public.device_checkins (
  id bigint generated by default as identity primary key,
  registered_device_id uuid not null references public.registered_devices(id) on delete cascade,
  app_version text,
  release_channel text,
  update_check_result text,
  license_status text,
  request_id text,
  reported_at timestamptz not null default now()
);

alter table public.device_checkins
  add column if not exists id bigint generated by default as identity,
  add column if not exists registered_device_id uuid,
  add column if not exists app_version text,
  add column if not exists release_channel text,
  add column if not exists update_check_result text,
  add column if not exists license_status text,
  add column if not exists request_id text,
  add column if not exists reported_at timestamptz not null default now();

create index if not exists idx_device_checkins_device_reported
  on public.device_checkins (registered_device_id, reported_at desc);
create index if not exists idx_device_checkins_update_result
  on public.device_checkins (update_check_result, reported_at desc);

create table if not exists public.desktop_releases (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  build_number text not null,
  platform text not null check (platform in ('macos', 'windows')),
  architecture text not null check (architecture in ('arm64', 'x64')),
  release_channel text not null default 'stable',
  release_status text not null default 'draft'
    check (release_status in ('draft', 'published', 'paused', 'retired')),
  minimum_supported_version text,
  release_notes text,
  rollout_percentage integer not null default 100 check (rollout_percentage between 0 and 100),
  mandatory boolean not null default false,
  active boolean not null default false,
  published_at timestamptz,
  created_by_admin_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (version, build_number, platform, architecture, release_channel)
);

alter table public.desktop_releases
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists version text,
  add column if not exists build_number text,
  add column if not exists platform text,
  add column if not exists architecture text,
  add column if not exists release_channel text not null default 'stable',
  add column if not exists release_status text not null default 'draft',
  add column if not exists minimum_supported_version text,
  add column if not exists release_notes text,
  add column if not exists rollout_percentage integer not null default 100,
  add column if not exists mandatory boolean not null default false,
  add column if not exists active boolean not null default false,
  add column if not exists published_at timestamptz,
  add column if not exists created_by_admin_id uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists desktop_releases_identity_unique
  on public.desktop_releases (version, build_number, platform, architecture, release_channel);

create index if not exists idx_desktop_releases_lookup
  on public.desktop_releases (platform, architecture, release_channel, release_status, published_at desc);

create table if not exists public.release_artifacts (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.desktop_releases(id) on delete cascade,
  file_url text not null,
  file_size bigint check (file_size is null or file_size >= 0),
  sha256 text,
  signature_status text not null default 'pending'
    check (signature_status in ('pending', 'valid', 'invalid', 'not_applicable')),
  notarization_status text not null default 'pending'
    check (notarization_status in ('pending', 'valid', 'invalid', 'not_applicable')),
  code_signing_status text not null default 'pending'
    check (code_signing_status in ('pending', 'valid', 'invalid', 'not_applicable')),
  validation_status text not null default 'pending'
    check (validation_status in ('pending', 'valid', 'invalid', 'missing')),
  validated_at timestamptz,
  validation_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (release_id, file_url)
);

alter table public.release_artifacts
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists release_id uuid,
  add column if not exists file_url text,
  add column if not exists file_size bigint,
  add column if not exists sha256 text,
  add column if not exists signature_status text not null default 'pending',
  add column if not exists notarization_status text not null default 'pending',
  add column if not exists code_signing_status text not null default 'pending',
  add column if not exists validation_status text not null default 'pending',
  add column if not exists validated_at timestamptz,
  add column if not exists validation_error text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists release_artifacts_release_url_unique
  on public.release_artifacts (release_id, file_url);

create index if not exists idx_release_artifacts_validation
  on public.release_artifacts (validation_status, signature_status);

create table if not exists public.backup_status (
  id uuid primary key default gen_random_uuid(),
  platform_business_id uuid not null references public.platform_businesses(id) on delete cascade,
  cloud_backup_enabled boolean not null default false,
  last_successful_backup_at timestamptz,
  last_failed_backup_at timestamptz,
  last_failure_code text,
  backup_size bigint check (backup_size is null or backup_size >= 0),
  encryption_status text,
  retention_policy text,
  restore_request_status text,
  sync_conflict_count integer check (sync_conflict_count is null or sync_conflict_count >= 0),
  updated_at timestamptz not null default now(),
  unique (platform_business_id)
);

alter table public.backup_status
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists platform_business_id uuid,
  add column if not exists cloud_backup_enabled boolean not null default false,
  add column if not exists last_successful_backup_at timestamptz,
  add column if not exists last_failed_backup_at timestamptz,
  add column if not exists last_failure_code text,
  add column if not exists backup_size bigint,
  add column if not exists encryption_status text,
  add column if not exists retention_policy text,
  add column if not exists restore_request_status text,
  add column if not exists sync_conflict_count integer,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists backup_status_business_unique
  on public.backup_status (platform_business_id);

create index if not exists idx_backup_status_enabled_updated
  on public.backup_status (cloud_backup_enabled, updated_at desc);

create table if not exists public.support_cases (
  id uuid primary key default gen_random_uuid(),
  case_number text not null unique,
  subject text not null,
  description text,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'waiting_customer', 'resolved')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  platform_customer_id uuid references public.platform_customers(id) on delete set null,
  registered_device_id uuid references public.registered_devices(id) on delete set null,
  license_id text references public.licenses(id) on delete set null,
  private_admin_notes text,
  diagnostic_requested_at timestamptz,
  assigned_admin_id uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.support_cases
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists case_number text,
  add column if not exists subject text,
  add column if not exists description text,
  add column if not exists status text not null default 'open',
  add column if not exists priority text not null default 'normal',
  add column if not exists platform_customer_id uuid,
  add column if not exists registered_device_id uuid,
  add column if not exists license_id text,
  add column if not exists private_admin_notes text,
  add column if not exists diagnostic_requested_at timestamptz,
  add column if not exists assigned_admin_id uuid,
  add column if not exists resolved_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists support_cases_case_number_unique
  on public.support_cases (case_number);

create index if not exists idx_support_cases_attention
  on public.support_cases (status, priority, updated_at desc);
create index if not exists idx_support_cases_customer
  on public.support_cases (platform_customer_id);

create table if not exists public.diagnostic_uploads (
  id uuid primary key default gen_random_uuid(),
  support_case_id uuid references public.support_cases(id) on delete set null,
  registered_device_id uuid references public.registered_devices(id) on delete set null,
  app_version text,
  operating_system text,
  platform text,
  device_id text,
  database_integrity_result text,
  migration_version text,
  license_status text,
  update_status text,
  sanitized_error_codes jsonb not null default '[]'::jsonb,
  startup_timing_ms integer,
  last_backup_result text,
  storage_path text,
  requested_at timestamptz,
  uploaded_at timestamptz not null default now(),
  expires_at timestamptz
);

alter table public.diagnostic_uploads
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists support_case_id uuid,
  add column if not exists registered_device_id uuid,
  add column if not exists app_version text,
  add column if not exists operating_system text,
  add column if not exists platform text,
  add column if not exists device_id text,
  add column if not exists database_integrity_result text,
  add column if not exists migration_version text,
  add column if not exists license_status text,
  add column if not exists update_status text,
  add column if not exists sanitized_error_codes jsonb not null default '[]'::jsonb,
  add column if not exists startup_timing_ms integer,
  add column if not exists last_backup_result text,
  add column if not exists storage_path text,
  add column if not exists requested_at timestamptz,
  add column if not exists uploaded_at timestamptz not null default now(),
  add column if not exists expires_at timestamptz;

create index if not exists idx_diagnostic_uploads_device_uploaded
  on public.diagnostic_uploads (registered_device_id, uploaded_at desc);
create index if not exists idx_diagnostic_uploads_case
  on public.diagnostic_uploads (support_case_id);

create table if not exists public.admin_audit_logs (
  id bigint generated by default as identity primary key,
  admin_user_id uuid,
  admin_email text,
  action text not null,
  target_type text,
  target_id text,
  ip_address inet,
  user_agent text,
  previous_values jsonb,
  new_values jsonb,
  request_id text not null,
  result text not null check (result in ('success', 'failure')),
  created_at timestamptz not null default now()
);

alter table public.admin_audit_logs
  add column if not exists id bigint generated by default as identity,
  add column if not exists admin_user_id uuid,
  add column if not exists admin_email text,
  add column if not exists action text,
  add column if not exists target_type text,
  add column if not exists target_id text,
  add column if not exists ip_address inet,
  add column if not exists user_agent text,
  add column if not exists previous_values jsonb,
  add column if not exists new_values jsonb,
  add column if not exists request_id text,
  add column if not exists result text,
  add column if not exists created_at timestamptz not null default now();

create index if not exists idx_admin_audit_logs_created
  on public.admin_audit_logs (created_at desc);
create index if not exists idx_admin_audit_logs_admin_created
  on public.admin_audit_logs (admin_user_id, created_at desc);
create index if not exists idx_admin_audit_logs_action_target
  on public.admin_audit_logs (action, target_type, target_id);
create index if not exists idx_admin_audit_logs_request
  on public.admin_audit_logs (request_id);

create table if not exists public.platform_settings (
  id uuid primary key default gen_random_uuid(),
  platform_name text not null default 'Bezgrow',
  support_email text,
  updated_at timestamptz not null default now()
);

alter table public.platform_settings
  add column if not exists platform_name text not null default 'Bezgrow',
  add column if not exists support_email text,
  add column if not exists default_license_duration_days integer not null default 365,
  add column if not exists default_grace_days integer not null default 7,
  add column if not exists default_allowed_features jsonb not null default '["billing","customers","inventory","products","reports"]'::jsonb,
  add column if not exists license_plans jsonb not null default '[]'::jsonb,
  add column if not exists update_channels jsonb not null default '["stable"]'::jsonb,
  add column if not exists minimum_supported_version text,
  add column if not exists backup_policies jsonb not null default '{}'::jsonb,
  add column if not exists diagnostic_upload_enabled boolean not null default true,
  add column if not exists diagnostic_retention_days integer not null default 30,
  add column if not exists maintenance_message text,
  add column if not exists customer_download_urls jsonb not null default '{}'::jsonb,
  add column if not exists mac_release_status text not null default 'not_configured',
  add column if not exists windows_release_status text not null default 'not_configured',
  add column if not exists updated_by_admin_id uuid,
  add column if not exists updated_at timestamptz not null default now();

insert into public.platform_settings (platform_name, support_email)
select 'Bezgrow', null
where not exists (select 1 from public.platform_settings);

-- Named compatibility constraints are added as NOT VALID so pre-existing
-- records are never deleted or rewritten. They still protect all new writes.
do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select *
    from (
      values
        ('platform_customers', 'platform_customers_account_status_check_v2', 'account_status in (''active'', ''suspended'', ''closed'')'),
        ('platform_customers', 'platform_customers_support_status_check_v2', 'support_status in (''none'', ''open'', ''attention'', ''resolved'')'),
        ('platform_businesses', 'platform_businesses_status_check_v2', 'status in (''active'', ''suspended'', ''closed'')'),
        ('platform_businesses', 'platform_businesses_platform_check_v2', 'platform is null or platform in (''macos'', ''windows'')'),
        ('platform_businesses', 'platform_businesses_cloud_mode_check_v2', 'cloud_mode in (''local_only'', ''cloud_backup'', ''metadata_sync'')'),
        ('licenses', 'licenses_platform_check_v2', 'platform in (''macos'', ''windows'')'),
        ('licenses', 'licenses_grace_days_check_v2', 'grace_days between 0 and 365'),
        ('licenses', 'licenses_maximum_users_check_v2', 'maximum_users > 0'),
        ('licenses', 'licenses_maximum_businesses_check_v2', 'maximum_businesses > 0'),
        ('licenses', 'licenses_maximum_branches_check_v2', 'maximum_branches > 0'),
        ('licenses', 'licenses_status_check_v2', 'status in (''draft'', ''active'', ''expiring'', ''grace_period'', ''expired'', ''suspended'', ''revoked'', ''replaced'', ''trial'')'),
        ('registered_devices', 'registered_devices_platform_check_v2', 'platform is null or platform in (''macos'', ''windows'')'),
        ('registered_devices', 'registered_devices_status_check_v2', 'device_status in (''registered'', ''active'', ''revoked'', ''replaced'')'),
        ('desktop_releases', 'desktop_releases_platform_check_v2', 'platform in (''macos'', ''windows'')'),
        ('desktop_releases', 'desktop_releases_architecture_check_v2', 'architecture in (''arm64'', ''x64'')'),
        ('desktop_releases', 'desktop_releases_status_check_v2', 'release_status in (''draft'', ''published'', ''paused'', ''retired'')'),
        ('desktop_releases', 'desktop_releases_rollout_check_v2', 'rollout_percentage between 0 and 100'),
        ('release_artifacts', 'release_artifacts_file_size_check_v2', 'file_size is null or file_size >= 0'),
        ('release_artifacts', 'release_artifacts_signature_check_v2', 'signature_status in (''pending'', ''valid'', ''invalid'', ''not_applicable'')'),
        ('release_artifacts', 'release_artifacts_notarization_check_v2', 'notarization_status in (''pending'', ''valid'', ''invalid'', ''not_applicable'')'),
        ('release_artifacts', 'release_artifacts_code_signing_check_v2', 'code_signing_status in (''pending'', ''valid'', ''invalid'', ''not_applicable'')'),
        ('release_artifacts', 'release_artifacts_validation_check_v2', 'validation_status in (''pending'', ''valid'', ''invalid'', ''missing'')'),
        ('backup_status', 'backup_status_size_check_v2', 'backup_size is null or backup_size >= 0'),
        ('backup_status', 'backup_status_conflicts_check_v2', 'sync_conflict_count is null or sync_conflict_count >= 0'),
        ('support_cases', 'support_cases_status_check_v2', 'status in (''open'', ''in_progress'', ''waiting_customer'', ''resolved'')'),
        ('support_cases', 'support_cases_priority_check_v2', 'priority in (''low'', ''normal'', ''high'', ''urgent'')'),
        ('diagnostic_uploads', 'diagnostic_uploads_startup_timing_check_v2', 'startup_timing_ms is null or startup_timing_ms >= 0'),
        ('admin_audit_logs', 'admin_audit_logs_result_check_v2', 'result in (''success'', ''failure'')'),
        ('platform_settings', 'platform_settings_license_duration_check_v2', 'default_license_duration_days between 1 and 3650'),
        ('platform_settings', 'platform_settings_grace_days_check_v2', 'default_grace_days between 0 and 365'),
        ('platform_settings', 'platform_settings_diagnostic_retention_check_v2', 'diagnostic_retention_days between 1 and 3650'),
        ('platform_settings', 'platform_settings_mac_release_status_check_v2', 'mac_release_status in (''not_configured'', ''internal_testing'', ''ready'', ''paused'')'),
        ('platform_settings', 'platform_settings_windows_release_status_check_v2', 'windows_release_status in (''not_configured'', ''internal_testing'', ''ready'', ''paused'')')
    ) as required_constraint(table_name, constraint_name, expression)
  loop
    if not exists (
      select 1
      from pg_catalog.pg_constraint constraint_record
      join pg_catalog.pg_class relation on relation.oid = constraint_record.conrelid
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = constraint_row.table_name
        and constraint_record.conname = constraint_row.constraint_name
    ) then
      execute format(
        'alter table public.%I add constraint %I check (%s) not valid',
        constraint_row.table_name,
        constraint_row.constraint_name,
        constraint_row.expression
      );
    end if;
  end loop;
end
$$;

-- Admin control-plane tables remain invisible to anonymous and normal customer
-- accounts. Authenticated DML privileges are useful only when the RLS role
-- predicate succeeds; server routes still authorize before using service_role.
do $$
declare
  table_name text;
  policy_name text;
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
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on public.%I to service_role', table_name);
    execute format('grant select on public.%I to authenticated', table_name);

    for policy_name in
      select policy_record.policyname
      from pg_catalog.pg_policies policy_record
      where policy_record.schemaname = 'public'
        and policy_record.tablename = table_name
    loop
      execute format('drop policy if exists %I on public.%I', policy_name, table_name);
    end loop;

    execute format(
      'create policy "platform admins select %s" on public.%I for select to authenticated using (public.is_platform_admin())',
      table_name,
      table_name
    );
  end loop;
end
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'platform_customers',
    'platform_businesses',
    'registered_devices',
    'desktop_releases',
    'release_artifacts',
    'backup_status',
    'support_cases',
    'diagnostic_uploads'
  ]
  loop
    execute format('grant insert, update, delete on public.%I to authenticated', table_name);
    execute format('drop policy if exists "platform admins insert %s" on public.%I', table_name, table_name);
    execute format('drop policy if exists "platform admins update %s" on public.%I', table_name, table_name);
    execute format('drop policy if exists "platform admins delete %s" on public.%I', table_name, table_name);
    execute format(
      'create policy "platform admins insert %s" on public.%I for insert to authenticated with check (public.is_platform_admin())',
      table_name,
      table_name
    );
    execute format(
      'create policy "platform admins update %s" on public.%I for update to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin())',
      table_name,
      table_name
    );
    execute format(
      'create policy "platform admins delete %s" on public.%I for delete to authenticated using (public.is_platform_admin())',
      table_name,
      table_name
    );
  end loop;
end
$$;

grant insert, update on public.licenses to authenticated;
drop policy if exists "platform admins insert licenses" on public.licenses;
create policy "platform admins insert licenses"
  on public.licenses for insert to authenticated
  with check (public.is_platform_admin());
drop policy if exists "platform admins update licenses" on public.licenses;
create policy "platform admins update licenses"
  on public.licenses for update to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

grant insert on public.license_events to authenticated;
drop policy if exists "platform admins insert license_events" on public.license_events;
create policy "platform admins insert license_events"
  on public.license_events for insert to authenticated
  with check (public.is_platform_admin());

grant insert on public.admin_audit_logs to authenticated;
drop policy if exists "platform admins insert admin_audit_logs" on public.admin_audit_logs;
create policy "platform admins insert admin_audit_logs"
  on public.admin_audit_logs for insert to authenticated
  with check (
    public.is_platform_admin()
    and (
      admin_user_id is null
      or admin_user_id = auth.uid()
    )
  );

grant insert, update on public.platform_settings to authenticated;
drop policy if exists "platform admins insert platform_settings" on public.platform_settings;
create policy "platform admins insert platform_settings"
  on public.platform_settings for insert to authenticated
  with check (public.is_platform_admin());
drop policy if exists "platform admins update platform_settings" on public.platform_settings;
create policy "platform admins update platform_settings"
  on public.platform_settings for update to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

do $$
begin
  if to_regclass('public.admin_audit_logs_id_seq') is not null then
    grant usage, select on sequence public.admin_audit_logs_id_seq to authenticated, service_role;
  end if;
  if to_regclass('public.device_checkins_id_seq') is not null then
    grant usage, select on sequence public.device_checkins_id_seq to service_role;
  end if;
end
$$;

create or replace function public.prevent_control_plane_log_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Control-plane history records are append-only';
end;
$$;

drop trigger if exists admin_audit_logs_append_only on public.admin_audit_logs;
create trigger admin_audit_logs_append_only
before update or delete on public.admin_audit_logs
for each row execute function public.prevent_control_plane_log_mutation();

drop trigger if exists license_events_append_only on public.license_events;
create trigger license_events_append_only
before update or delete on public.license_events
for each row execute function public.prevent_control_plane_log_mutation();

create or replace function public.set_control_plane_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'platform_customers',
    'platform_businesses',
    'licenses',
    'registered_devices',
    'desktop_releases',
    'release_artifacts',
    'backup_status',
    'support_cases',
    'platform_settings'
  ]
  loop
    execute format('drop trigger if exists set_control_plane_updated_at on public.%I', table_name);
    execute format(
      'create trigger set_control_plane_updated_at before update on public.%I for each row execute function public.set_control_plane_updated_at()',
      table_name
    );
  end loop;
end
$$;

comment on table public.platform_customers is
  'Bezgrow purchasers/users. Never contains retail customers from local ERP databases.';
comment on table public.platform_businesses is
  'Cloud-known workspace metadata only. Local ERP business data is unavailable unless explicitly synchronized.';
comment on column public.platform_businesses.telemetry_summary is
  'Optional authenticated telemetry only; null means not synchronized and must not be displayed as zero.';
comment on table public.admin_audit_logs is
  'Append-only platform administrator audit history.';

create or replace function public.admin_control_plane_dashboard(requesting_admin_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not exists (
    select 1
    from public.profiles
    where id = requesting_admin_id
      and role in ('admin', 'platform_admin')
      and coalesce(is_suspended, false) = false
  ) then
    raise exception 'platform admin authorization required';
  end if;

  select jsonb_build_object(
    'licenses', jsonb_build_object(
      'active', count(*) filter (
        where status = 'active'
          and expiry_date >= current_date
      ),
      'expiring7', count(*) filter (
        where status in ('active', 'trial', 'expiring')
          and expiry_date between current_date and current_date + 7
      ),
      'expiring30', count(*) filter (
        where status in ('active', 'trial', 'expiring')
          and expiry_date between current_date and current_date + 30
      ),
      'expiring90', count(*) filter (
        where status in ('active', 'trial', 'expiring')
          and expiry_date between current_date and current_date + 90
      ),
      'expired', count(*) filter (
        where status = 'expired'
          or (
            status in ('active', 'trial', 'expiring', 'grace_period')
            and expiry_date + grace_days < current_date
          )
      ),
      'gracePeriod', count(*) filter (
        where status not in ('suspended', 'revoked', 'replaced', 'draft')
          and expiry_date < current_date
          and expiry_date + grace_days >= current_date
      ),
      'revoked', count(*) filter (where status = 'revoked'),
      'suspended', count(*) filter (where status = 'suspended'),
      'trial', count(*) filter (where status = 'trial')
    )
  )
  into result
  from public.licenses;

  result := result || jsonb_build_object(
    'devices', jsonb_build_object(
      'total', (select count(*) from public.registered_devices),
      'activatedToday', (
        select count(*) from public.registered_devices
        where activation_date >= date_trunc('day', now())
      ),
      'active30Days', (
        select count(*) from public.registered_devices
        where last_reported_at >= now() - interval '30 days'
      ),
      'failedUpdateChecks', (
        select count(*) from public.device_checkins
        where update_check_result = 'failed'
          and reported_at >= now() - interval '30 days'
      )
    ),
    'customers', (select count(*) from public.platform_customers),
    'businesses', (select count(*) from public.platform_businesses),
    'backup', jsonb_build_object(
      'enabled', (select count(*) from public.backup_status where cloud_backup_enabled),
      'failed', (
        select count(*) from public.backup_status
        where last_failed_backup_at is not null
          and (
            last_successful_backup_at is null
            or last_failed_backup_at > last_successful_backup_at
          )
      )
    ),
    'supportAttention', (
      select count(*) from public.support_cases
      where status <> 'resolved' and priority in ('high', 'urgent')
    ),
    'latestMacRelease', (
      select to_jsonb(release_row)
      from (
        select r.id, r.version, r.build_number, r.architecture, r.release_channel,
          r.release_status, r.published_at, r.mandatory
        from public.desktop_releases r
        where r.platform = 'macos' and r.release_status = 'published' and r.active
        order by r.published_at desc nulls last, r.created_at desc
        limit 1
      ) release_row
    ),
    'latestWindowsRelease', (
      select to_jsonb(release_row)
      from (
        select r.id, r.version, r.build_number, r.architecture, r.release_channel,
          r.release_status, r.published_at, r.mandatory
        from public.desktop_releases r
        where r.platform = 'windows' and r.release_status = 'published' and r.active
        order by r.published_at desc nulls last, r.created_at desc
        limit 1
      ) release_row
    ),
    'recentAdminActions', coalesce((
      select jsonb_agg(to_jsonb(audit_row))
      from (
        select id, admin_email, action, target_type, target_id, result, request_id, created_at
        from public.admin_audit_logs
        order by created_at desc
        limit 8
      ) audit_row
    ), '[]'::jsonb),
    'recentActivationFailures', coalesce((
      select jsonb_agg(to_jsonb(failure_row))
      from (
        select id, admin_email, action, target_type, target_id, result, request_id, created_at
        from public.admin_audit_logs
        where action in ('LICENSE_ACTIVATION_FAILED', 'ADMIN_LOGIN_FAILED')
          and result = 'failure'
        order by created_at desc
        limit 8
      ) failure_row
    ), '[]'::jsonb),
    'recentSecurityEvents', coalesce((
      select jsonb_agg(to_jsonb(security_row))
      from (
        select id, admin_email, action, target_type, target_id, result, request_id, created_at
        from public.admin_audit_logs
        where action in (
          'ADMIN_LOGIN_FAILED',
          'LICENSE_REVOKED',
          'DEVICE_REVOKED',
          'INTEGRITY_EVENT'
        )
        order by created_at desc
        limit 8
      ) security_row
    ), '[]'::jsonb),
    'supportCases', coalesce((
      select jsonb_agg(to_jsonb(support_row))
      from (
        select id, case_number, subject, status, priority, updated_at
        from public.support_cases
        where status <> 'resolved'
        order by
          case priority when 'urgent' then 1 when 'high' then 2 when 'normal' then 3 else 4 end,
          updated_at desc
        limit 8
      ) support_row
    ), '[]'::jsonb)
  );

  return result;
end;
$$;

revoke all on function public.admin_control_plane_dashboard(uuid) from public, anon, authenticated;
grant execute on function public.admin_control_plane_dashboard(uuid) to service_role;

create or replace function public.admin_control_plane_analytics(
  requesting_admin_id uuid,
  range_days integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  since_at timestamptz;
begin
  if range_days < 7 or range_days > 365 then
    raise exception 'analytics range must be between 7 and 365 days';
  end if;
  if not exists (
    select 1
    from public.profiles
    where id = requesting_admin_id
      and role in ('admin', 'platform_admin')
      and coalesce(is_suspended, false) = false
  ) then
    raise exception 'platform admin authorization required';
  end if;

  since_at := now() - make_interval(days => range_days);
  return jsonb_build_object(
    'rangeDays', range_days,
    'licenseGrowth', coalesce((
      select jsonb_agg(to_jsonb(series_row) order by series_row.label)
      from (
        select created_at::date::text as label, count(*)::integer as value
        from public.licenses
        where created_at >= since_at
        group by created_at::date
      ) series_row
    ), '[]'::jsonb),
    'activationsByDay', coalesce((
      select jsonb_agg(to_jsonb(series_row) order by series_row.label)
      from (
        select activation_date::date::text as label, count(*)::integer as value
        from public.registered_devices
        where activation_date >= since_at
        group by activation_date::date
      ) series_row
    ), '[]'::jsonb),
    'activationsByPlatform', coalesce((
      select jsonb_agg(to_jsonb(series_row) order by series_row.label)
      from (
        select coalesce(platform, 'unknown') as label, count(*)::integer as value
        from public.registered_devices
        where activation_date >= since_at
        group by coalesce(platform, 'unknown')
      ) series_row
    ), '[]'::jsonb),
    'devicePlatforms', coalesce((
      select jsonb_agg(to_jsonb(series_row) order by series_row.label)
      from (
        select coalesce(platform, 'unknown') as label, count(*)::integer as value
        from public.registered_devices
        group by coalesce(platform, 'unknown')
      ) series_row
    ), '[]'::jsonb),
    'licenseRenewals', coalesce((
      select jsonb_agg(to_jsonb(series_row) order by series_row.label)
      from (
        select created_at::date::text as label, count(*)::integer as value
        from public.license_events
        where created_at >= since_at
          and action in ('LICENSE_RENEWED', 'LICENSE_EXTENDED')
        group by created_at::date
      ) series_row
    ), '[]'::jsonb),
    'licenseOutcomes', coalesce((
      select jsonb_agg(to_jsonb(series_row) order by series_row.label)
      from (
        select effective_status as label, count(*)::integer as value
        from (
          select case
            when status in ('draft', 'suspended', 'revoked', 'replaced') then status
            when expiry_date + grace_days < current_date then 'expired'
            when expiry_date < current_date then 'grace_period'
            when expiry_date <= current_date + 30 then 'expiring'
            else status
          end as effective_status
          from public.licenses
        ) license_status
        group by effective_status
      ) series_row
    ), '[]'::jsonb),
    'versionAdoption', coalesce((
      select jsonb_agg(to_jsonb(series_row) order by series_row.value desc, series_row.label)
      from (
        select coalesce(app_version, 'Not reported') as label, count(*)::integer as value
        from public.registered_devices
        group by coalesce(app_version, 'Not reported')
      ) series_row
    ), '[]'::jsonb),
    'updateOutcomes', coalesce((
      select jsonb_agg(to_jsonb(series_row) order by series_row.label)
      from (
        select coalesce(update_check_result, 'Not reported') as label, count(*)::integer as value
        from public.device_checkins
        where reported_at >= since_at
        group by coalesce(update_check_result, 'Not reported')
      ) series_row
    ), '[]'::jsonb),
    'backupUsage', jsonb_build_object(
      'enabled', (select count(*) from public.backup_status where cloud_backup_enabled),
      'disabled', (select count(*) from public.backup_status where not cloud_backup_enabled)
    ),
    'supportVolume', coalesce((
      select jsonb_agg(to_jsonb(series_row) order by series_row.label)
      from (
        select created_at::date::text as label, count(*)::integer as value
        from public.support_cases
        where created_at >= since_at
        group by created_at::date
      ) series_row
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.admin_control_plane_analytics(uuid, integer) from public, anon, authenticated;
grant execute on function public.admin_control_plane_analytics(uuid, integer) to service_role;

insert into public.admin_control_plane_schema_versions (version, description)
values (2026072601, 'Complete Bezgrow admin control plane')
on conflict (version) do nothing;

create or replace function public.admin_control_plane_schema_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  expected_version constant bigint := 2026072601;
  actual_version bigint;
  required_relations text[] := array[
    'admin_control_plane_schema_versions',
    'platform_customers',
    'platform_businesses',
    'licenses',
    'license_control_plane',
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
  ];
  required_columns text[] := array[
    'platform_customers.id',
    'platform_customers.name',
    'platform_customers.email',
    'platform_customers.phone',
    'platform_customers.company',
    'platform_customers.country',
    'platform_customers.account_status',
    'platform_customers.support_status',
    'platform_customers.notes',
    'platform_customers.last_platform_activity_at',
    'platform_customers.created_at',
    'platform_customers.updated_at',
    'platform_businesses.id',
    'platform_businesses.platform_customer_id',
    'platform_businesses.legacy_organization_id',
    'platform_businesses.workspace_id',
    'platform_businesses.business_name',
    'platform_businesses.plan_name',
    'platform_businesses.status',
    'platform_businesses.platform',
    'platform_businesses.app_version',
    'platform_businesses.update_channel',
    'platform_businesses.cloud_mode',
    'platform_businesses.cloud_backup_enabled',
    'platform_businesses.last_sync_at',
    'platform_businesses.last_backup_at',
    'platform_businesses.telemetry_reported_at',
    'platform_businesses.telemetry_summary',
    'platform_businesses.created_at',
    'platform_businesses.updated_at',
    'licenses.id',
    'licenses.platform_customer_id',
    'licenses.platform_business_id',
    'licenses.customer_name',
    'licenses.customer_email',
    'licenses.business_name',
    'licenses.device_id',
    'licenses.platform',
    'licenses.app_version',
    'licenses.plan_name',
    'licenses.issue_date',
    'licenses.expiry_date',
    'licenses.grace_days',
    'licenses.allowed_features',
    'licenses.maximum_users',
    'licenses.maximum_businesses',
    'licenses.maximum_branches',
    'licenses.internal_notes',
    'licenses.status',
    'licenses.signed_license_key',
    'licenses.signature_algorithm',
    'licenses.issuer_key_id',
    'licenses.issued_by_admin_id',
    'licenses.issued_by_admin_email',
    'licenses.replaced_by_license_id',
    'licenses.idempotency_key',
    'licenses.created_at',
    'licenses.updated_at',
    'license_events.id',
    'license_events.license_id',
    'license_events.action',
    'license_events.admin_user_id',
    'license_events.admin_email',
    'license_events.previous_values',
    'license_events.new_values',
    'license_events.notes',
    'license_events.request_id',
    'license_events.created_at',
    'registered_devices.id',
    'registered_devices.device_id',
    'registered_devices.platform_customer_id',
    'registered_devices.platform_business_id',
    'registered_devices.license_id',
    'registered_devices.platform',
    'registered_devices.operating_system',
    'registered_devices.architecture',
    'registered_devices.app_version',
    'registered_devices.activation_date',
    'registered_devices.last_reported_at',
    'registered_devices.last_update_check_at',
    'registered_devices.release_channel',
    'registered_devices.device_status',
    'registered_devices.diagnostics_available',
    'registered_devices.diagnostic_requested_at',
    'registered_devices.online_session_version',
    'registered_devices.replaced_by_device_id',
    'registered_devices.created_at',
    'registered_devices.updated_at',
    'device_checkins.id',
    'device_checkins.registered_device_id',
    'device_checkins.app_version',
    'device_checkins.release_channel',
    'device_checkins.update_check_result',
    'device_checkins.license_status',
    'device_checkins.request_id',
    'device_checkins.reported_at',
    'desktop_releases.id',
    'desktop_releases.version',
    'desktop_releases.build_number',
    'desktop_releases.platform',
    'desktop_releases.architecture',
    'desktop_releases.release_channel',
    'desktop_releases.release_status',
    'desktop_releases.minimum_supported_version',
    'desktop_releases.release_notes',
    'desktop_releases.rollout_percentage',
    'desktop_releases.mandatory',
    'desktop_releases.active',
    'desktop_releases.published_at',
    'desktop_releases.created_by_admin_id',
    'desktop_releases.created_at',
    'desktop_releases.updated_at',
    'release_artifacts.id',
    'release_artifacts.release_id',
    'release_artifacts.file_url',
    'release_artifacts.file_size',
    'release_artifacts.sha256',
    'release_artifacts.signature_status',
    'release_artifacts.notarization_status',
    'release_artifacts.code_signing_status',
    'release_artifacts.validation_status',
    'release_artifacts.validated_at',
    'release_artifacts.validation_error',
    'release_artifacts.created_at',
    'release_artifacts.updated_at',
    'backup_status.id',
    'backup_status.platform_business_id',
    'backup_status.cloud_backup_enabled',
    'backup_status.last_successful_backup_at',
    'backup_status.last_failed_backup_at',
    'backup_status.last_failure_code',
    'backup_status.backup_size',
    'backup_status.encryption_status',
    'backup_status.retention_policy',
    'backup_status.restore_request_status',
    'backup_status.sync_conflict_count',
    'backup_status.updated_at',
    'support_cases.id',
    'support_cases.case_number',
    'support_cases.subject',
    'support_cases.description',
    'support_cases.status',
    'support_cases.priority',
    'support_cases.platform_customer_id',
    'support_cases.registered_device_id',
    'support_cases.license_id',
    'support_cases.private_admin_notes',
    'support_cases.diagnostic_requested_at',
    'support_cases.assigned_admin_id',
    'support_cases.resolved_at',
    'support_cases.created_at',
    'support_cases.updated_at',
    'diagnostic_uploads.id',
    'diagnostic_uploads.support_case_id',
    'diagnostic_uploads.registered_device_id',
    'diagnostic_uploads.app_version',
    'diagnostic_uploads.operating_system',
    'diagnostic_uploads.platform',
    'diagnostic_uploads.device_id',
    'diagnostic_uploads.database_integrity_result',
    'diagnostic_uploads.migration_version',
    'diagnostic_uploads.license_status',
    'diagnostic_uploads.update_status',
    'diagnostic_uploads.sanitized_error_codes',
    'diagnostic_uploads.startup_timing_ms',
    'diagnostic_uploads.last_backup_result',
    'diagnostic_uploads.storage_path',
    'diagnostic_uploads.requested_at',
    'diagnostic_uploads.uploaded_at',
    'diagnostic_uploads.expires_at',
    'admin_audit_logs.id',
    'admin_audit_logs.admin_user_id',
    'admin_audit_logs.admin_email',
    'admin_audit_logs.action',
    'admin_audit_logs.target_type',
    'admin_audit_logs.target_id',
    'admin_audit_logs.ip_address',
    'admin_audit_logs.user_agent',
    'admin_audit_logs.previous_values',
    'admin_audit_logs.new_values',
    'admin_audit_logs.request_id',
    'admin_audit_logs.result',
    'admin_audit_logs.created_at',
    'platform_settings.id',
    'platform_settings.platform_name',
    'platform_settings.support_email',
    'platform_settings.default_license_duration_days',
    'platform_settings.default_grace_days',
    'platform_settings.default_allowed_features',
    'platform_settings.license_plans',
    'platform_settings.update_channels',
    'platform_settings.minimum_supported_version',
    'platform_settings.backup_policies',
    'platform_settings.diagnostic_upload_enabled',
    'platform_settings.diagnostic_retention_days',
    'platform_settings.maintenance_message',
    'platform_settings.customer_download_urls',
    'platform_settings.mac_release_status',
    'platform_settings.windows_release_status',
    'platform_settings.updated_by_admin_id',
    'platform_settings.updated_at'
  ];
  required_functions text[] := array[
    'public.is_platform_admin()',
    'public.admin_control_plane_dashboard(uuid)',
    'public.admin_control_plane_analytics(uuid,integer)',
    'public.admin_control_plane_schema_status()',
    'public.prevent_control_plane_log_mutation()',
    'public.set_control_plane_updated_at()'
  ];
  required_indexes text[] := array[
    'platform_customers_email_unique',
    'platform_businesses_workspace_id_unique',
    'licenses_idempotency_key_unique',
    'idx_licenses_status_expiry',
    'idx_registered_devices_status_reported',
    'idx_device_checkins_device_reported',
    'idx_desktop_releases_lookup',
    'idx_release_artifacts_validation',
    'idx_backup_status_enabled_updated',
    'idx_support_cases_attention',
    'idx_diagnostic_uploads_device_uploaded',
    'idx_admin_audit_logs_created'
  ];
  required_constraints text[] := array[
    'platform_customers_account_status_check_v2',
    'platform_businesses_cloud_mode_check_v2',
    'licenses_status_check_v2',
    'registered_devices_status_check_v2',
    'desktop_releases_architecture_check_v2',
    'desktop_releases_rollout_check_v2',
    'release_artifacts_validation_check_v2',
    'support_cases_status_check_v2',
    'admin_audit_logs_result_check_v2',
    'platform_settings_license_duration_check_v2'
  ];
  required_triggers text[] := array[
    'admin_audit_logs.admin_audit_logs_append_only',
    'license_events.license_events_append_only',
    'platform_customers.set_control_plane_updated_at',
    'platform_businesses.set_control_plane_updated_at',
    'licenses.set_control_plane_updated_at',
    'registered_devices.set_control_plane_updated_at',
    'desktop_releases.set_control_plane_updated_at',
    'release_artifacts.set_control_plane_updated_at',
    'backup_status.set_control_plane_updated_at',
    'support_cases.set_control_plane_updated_at',
    'platform_settings.set_control_plane_updated_at'
  ];
  missing_relations jsonb;
  missing_columns jsonb;
  missing_functions jsonb;
  missing_indexes jsonb;
  missing_constraints jsonb;
  missing_triggers jsonb;
  missing_rls jsonb;
  missing_policies jsonb;
  ready boolean;
begin
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

  select coalesce(jsonb_agg(required_trigger order by required_trigger), '[]'::jsonb)
  into missing_triggers
  from unnest(required_triggers) required_trigger
  where not exists (
    select 1
    from pg_catalog.pg_trigger trigger_record
    join pg_catalog.pg_class relation on relation.oid = trigger_record.tgrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = split_part(required_trigger, '.', 1)
      and trigger_record.tgname = split_part(required_trigger, '.', 2)
      and not trigger_record.tgisinternal
  );

  select coalesce(jsonb_agg(required_relation order by required_relation), '[]'::jsonb)
  into missing_rls
  from unnest(array_remove(required_relations, 'license_control_plane')) required_relation
  where not exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = required_relation
      and relation.relrowsecurity
      and relation.relforcerowsecurity
  );

  select coalesce(jsonb_agg(required_relation order by required_relation), '[]'::jsonb)
  into missing_policies
  from unnest(array_remove(required_relations, 'license_control_plane')) required_relation
  where not exists (
    select 1
    from pg_catalog.pg_policies policy_record
    where policy_record.schemaname = 'public'
      and policy_record.tablename = required_relation
      and policy_record.policyname = format('platform admins select %s', required_relation)
  );

  ready :=
    actual_version = expected_version
    and jsonb_array_length(missing_relations) = 0
    and jsonb_array_length(missing_columns) = 0
    and jsonb_array_length(missing_functions) = 0
    and jsonb_array_length(missing_indexes) = 0
    and jsonb_array_length(missing_constraints) = 0
    and jsonb_array_length(missing_triggers) = 0
    and jsonb_array_length(missing_rls) = 0
    and jsonb_array_length(missing_policies) = 0;

  return jsonb_build_object(
    'ready', ready,
    'expectedVersion', expected_version,
    'actualVersion', actual_version,
    'missing', jsonb_build_object(
      'relations', missing_relations,
      'columns', missing_columns,
      'functions', missing_functions,
      'indexes', missing_indexes,
      'constraints', missing_constraints,
      'triggers', missing_triggers,
      'rls', missing_rls,
      'policies', missing_policies
    )
  );
end;
$$;

revoke all on function public.admin_control_plane_schema_status() from public, anon, authenticated;
grant execute on function public.admin_control_plane_schema_status() to service_role;

notify pgrst, 'reload schema';

commit;
