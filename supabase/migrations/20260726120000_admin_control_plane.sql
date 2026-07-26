-- Bezgrow platform administration control plane.
-- This migration is additive and idempotent. Customer ERP tables and historical
-- approval records are intentionally retained, but are not used by the new
-- licensed desktop access flow.

create extension if not exists pgcrypto;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('admin', 'platform_admin')
      and coalesce(p.is_suspended, false) = false
  );
$$;

-- Licensed workspaces no longer depend on the legacy approved flag.
create or replace function public.is_org_member(target_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
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
  add column if not exists diagnostic_requested_at timestamptz;

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
  add column if not exists diagnostic_requested_at timestamptz;

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

-- Admin control-plane tables are invisible to customer accounts. The service
-- role is used only by server routes after an authenticated role check.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
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
    execute format('drop policy if exists "platform admins read %s" on public.%I', table_name, table_name);
    execute format(
      'create policy "platform admins read %s" on public.%I for select to authenticated using (public.is_platform_admin())',
      table_name,
      table_name
    );
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
  end loop;
end $$;

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
