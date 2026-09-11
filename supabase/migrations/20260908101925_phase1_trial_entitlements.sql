-- Phase 1 self-service onboarding and server-authoritative trial entitlements.
-- The control plane stores only account, business, subscription, entitlement,
-- and device metadata. Operational ERP data remains in desktop SQLite.

begin;

alter table public.platform_customers
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null,
  add column if not exists identity_verification_status text not null default 'unverified',
  add column if not exists email_verified_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.platform_customers'::regclass
      and conname = 'platform_customers_identity_verification_status_check'
  ) then
    alter table public.platform_customers
      add constraint platform_customers_identity_verification_status_check
      check (identity_verification_status in ('unverified', 'email_verified', 'support_verified'));
  end if;
end $$;

create unique index if not exists platform_customers_auth_user_unique
  on public.platform_customers (auth_user_id)
  where auth_user_id is not null;

alter table public.platform_businesses
  add column if not exists business_type text,
  add column if not exists industry text,
  add column if not exists gst_registered boolean not null default false,
  add column if not exists registered_state text;

alter table public.registered_devices
  add column if not exists installation_public_key text;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.registered_devices'::regclass
      and conname = 'registered_devices_installation_public_key_check'
  ) then
    alter table public.registered_devices
      add constraint registered_devices_installation_public_key_check
      check (installation_public_key is null or installation_public_key ~ '^[0-9a-f]{64}$');
  end if;
end $$;

create table if not exists public.onboarding_device_nonces (
  nonce text primary key check (nonce ~ '^[0-9a-f]{48}$'),
  device_id text not null,
  public_key text not null check (public_key ~ '^[0-9a-f]{64}$'),
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  used_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > used_at)
);

insert into public.subscription_plans (
  code, name, price_minor, currency, interval, product_limit, invoice_limit, user_limit, is_active
)
values ('bezgrow_monthly', 'Bezgrow Monthly', 20000, 'INR', 'month', null, null, null, true)
on conflict (code) do update set
  name = excluded.name,
  price_minor = excluded.price_minor,
  currency = excluded.currency,
  interval = excluded.interval,
  is_active = true;

-- Legacy signed licences retain their existing commercial semantics. They are
-- not silently converted into the future paid monthly plan.
insert into public.subscription_plans (
  code, name, price_minor, currency, interval, product_limit, invoice_limit, user_limit, is_active
)
values ('legacy_license', 'Legacy signed licence', 0, 'INR', 'legacy', null, null, null, false)
on conflict (code) do nothing;

alter table public.subscriptions alter column organization_id drop not null;
alter table public.subscriptions
  add column if not exists platform_customer_id uuid references public.platform_customers(id) on delete restrict,
  add column if not exists platform_business_id uuid references public.platform_businesses(id) on delete restrict,
  add column if not exists trial_started_at timestamptz,
  add column if not exists trial_ends_at timestamptz,
  add column if not exists grace_until timestamptz,
  add column if not exists provider_customer_id text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancellation_reason text;

create unique index if not exists subscriptions_one_current_business
  on public.subscriptions (platform_business_id)
  where platform_business_id is not null
    and status in ('trialing', 'active', 'past_due');
create index if not exists subscriptions_customer_status
  on public.subscriptions (platform_customer_id, status, current_period_end desc);

create table if not exists public.entitlements (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid references public.subscriptions(id) on delete set null,
  platform_customer_id uuid references public.platform_customers(id) on delete restrict,
  platform_business_id uuid references public.platform_businesses(id) on delete restrict,
  license_id text references public.licenses(id) on delete set null,
  source text not null default 'self_service_trial'
    check (source in ('self_service_trial', 'legacy_license', 'paid_subscription', 'support_override')),
  status text not null default 'trialing'
    check (status in ('pending_signature', 'trialing', 'active', 'grace', 'expired', 'cancelled', 'revoked', 'suspended')),
  device_id text not null,
  plan_code text not null references public.subscription_plans(code),
  trial_started_at timestamptz,
  trial_ends_at timestamptz,
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  grace_until timestamptz not null,
  allowed_features jsonb not null default '[]'::jsonb,
  signed_entitlement text,
  signature_algorithm text,
  issuer_key_id text,
  server_verified_at timestamptz not null,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (valid_until >= valid_from),
  check (grace_until >= valid_until),
  check (
    source <> 'self_service_trial'
    or (trial_started_at is not null and trial_ends_at is not null and trial_ends_at = valid_until)
  )
);

create unique index if not exists entitlements_idempotency_unique
  on public.entitlements (idempotency_key)
  where idempotency_key is not null;
create unique index if not exists entitlements_one_self_service_trial_per_device
  on public.entitlements (device_id)
  where source = 'self_service_trial';
create unique index if not exists entitlements_one_self_service_trial_per_customer
  on public.entitlements (platform_customer_id)
  where source = 'self_service_trial' and platform_customer_id is not null;
create unique index if not exists entitlements_one_self_service_trial_per_business
  on public.entitlements (platform_business_id)
  where source = 'self_service_trial' and platform_business_id is not null;
create index if not exists entitlements_business_status
  on public.entitlements (platform_business_id, status, valid_until desc);
create index if not exists entitlements_customer_status
  on public.entitlements (platform_customer_id, status, valid_until desc);

alter table public.entitlements enable row level security;
alter table public.entitlements force row level security;
alter table public.subscriptions enable row level security;
alter table public.subscriptions force row level security;
alter table public.platform_customers enable row level security;
alter table public.platform_customers force row level security;
alter table public.platform_businesses enable row level security;
alter table public.platform_businesses force row level security;
alter table public.onboarding_device_nonces enable row level security;
alter table public.onboarding_device_nonces force row level security;

revoke all on table public.entitlements from public, anon, authenticated;
revoke all on table public.subscriptions from public, anon, authenticated;
revoke all on table public.platform_customers from public, anon, authenticated;
revoke all on table public.platform_businesses from public, anon, authenticated;
revoke all on table public.onboarding_device_nonces from public, anon, authenticated;
grant select, insert, update, delete on table public.entitlements to service_role;
grant select, insert, update, delete on table public.subscriptions to service_role;
grant select, insert, update, delete on table public.platform_customers to service_role;
grant select, insert, update, delete on table public.platform_businesses to service_role;
grant select, insert, delete on table public.onboarding_device_nonces to service_role;

-- Existing server-issued signed licences become legacy entitlements. This is
-- deliberately not a new trial. Draft/replaced rows and incomplete signature
-- metadata are excluded: SQL cannot cryptographically verify an arbitrary key,
-- and the desktop must still verify every signature before granting access.
insert into public.entitlements (
  platform_customer_id, platform_business_id, license_id, source, status,
  device_id, plan_code, valid_from, valid_until, grace_until,
  allowed_features, signed_entitlement, signature_algorithm, issuer_key_id,
  server_verified_at, idempotency_key, created_at, updated_at
)
select
  license.platform_customer_id,
  license.platform_business_id,
  license.id,
  'legacy_license',
  case
    when license.status in ('revoked', 'suspended') then license.status
    when license.status = 'expired' or license.expiry_date + license.grace_days < current_date then 'expired'
    when license.expiry_date < current_date then 'grace'
    when license.status = 'trial' then 'trialing'
    else 'active'
  end,
  license.device_id,
  'legacy_license',
  least(
    coalesce(license.activation_date, license.created_at, now()),
    (license.expiry_date::text || 'T23:59:59.999Z')::timestamptz
  ),
  (license.expiry_date::text || 'T23:59:59.999Z')::timestamptz,
  ((license.expiry_date + license.grace_days)::text || 'T23:59:59.999Z')::timestamptz,
  coalesce(license.allowed_features, '[]'::jsonb),
  license.signed_license_key,
  license.signature_algorithm,
  license.issuer_key_id,
  coalesce(license.updated_at, now()),
  'legacy:' || license.id,
  coalesce(license.created_at, now()),
  coalesce(license.updated_at, now())
from public.licenses license
where license.signed_license_key is not null
  and license.signed_license_key like 'BZG-LIC-v1.%'
  and license.signature_algorithm in ('ed25519', 'rsa-pss-sha256')
  and license.issuer_key_id is not null
  and license.expiry_date is not null
  and license.device_id is not null
  and license.status not in ('draft', 'replaced')
on conflict (idempotency_key) where idempotency_key is not null do nothing;

create or replace function public.begin_phase1_trial(
  p_auth_user_id uuid,
  p_owner_name text,
  p_email text,
  p_phone text,
  p_workspace_id text,
  p_business_name text,
  p_business_type text,
  p_industry text,
  p_gst_registered boolean,
  p_registered_state text,
  p_device_id text,
  p_platform text,
  p_architecture text,
  p_app_version text,
  p_idempotency_key text,
  p_device_public_key text,
  p_email_verified boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  authoritative_now timestamptz := clock_timestamp();
  trial_end timestamptz;
  customer_record public.platform_customers%rowtype;
  business_record public.platform_businesses%rowtype;
  entitlement_record public.entitlements%rowtype;
  subscription_record public.subscriptions%rowtype;
  device_record public.registered_devices%rowtype;
  plan_record public.subscription_plans%rowtype;
  license_record public.licenses%rowtype;
  license_identifier text;
  features jsonb := '["accounting","backups","billing","customers","inventory","invoices","reports","suppliers"]'::jsonb;
begin
  if p_auth_user_id is null
     or nullif(btrim(p_owner_name), '') is null
     or nullif(btrim(p_email), '') is null
     or nullif(btrim(p_workspace_id), '') is null
     or nullif(btrim(p_business_name), '') is null
     or nullif(btrim(p_device_id), '') is null
     or nullif(btrim(p_idempotency_key), '') is null
     or p_device_public_key !~ '^[0-9a-f]{64}$' then
    raise exception 'phase1_trial_input_invalid';
  end if;
  if p_platform not in ('macos', 'windows') then
    raise exception 'phase1_trial_platform_invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('phase1-trial-device:' || p_device_id, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('phase1-trial-account:' || p_auth_user_id::text, 0));

  select * into entitlement_record
  from public.entitlements
  where idempotency_key = p_idempotency_key
  limit 1
  for update;

  if entitlement_record.id is not null then
    select * into customer_record from public.platform_customers where id = entitlement_record.platform_customer_id;
    select * into business_record from public.platform_businesses where id = entitlement_record.platform_business_id;
    select * into device_record from public.registered_devices
      where device_id = p_device_id for update;
    if entitlement_record.source <> 'self_service_trial'
       or entitlement_record.device_id is distinct from p_device_id
       or customer_record.auth_user_id is distinct from p_auth_user_id
       or business_record.workspace_id is distinct from p_workspace_id
       or device_record.id is null
       or device_record.installation_public_key is distinct from p_device_public_key
       or device_record.platform_customer_id is distinct from customer_record.id
       or device_record.platform_business_id is distinct from business_record.id
       or device_record.license_id is distinct from entitlement_record.license_id
       or device_record.device_status in ('revoked', 'replaced') then
      raise exception 'phase1_trial_idempotency_conflict';
    end if;
    if authoritative_now >= entitlement_record.valid_until
       and entitlement_record.status not in ('expired', 'cancelled', 'revoked', 'suspended') then
      update public.entitlements set status = 'expired', server_verified_at = authoritative_now,
        updated_at = authoritative_now where id = entitlement_record.id returning * into entitlement_record;
      update public.subscriptions set status = 'payment_required', updated_at = authoritative_now
        where id = entitlement_record.subscription_id and status = 'trialing';
      update public.licenses set status = 'expired', updated_at = authoritative_now
        where id = entitlement_record.license_id and status = 'trial';
    end if;
    select * into subscription_record from public.subscriptions where id = entitlement_record.subscription_id;
    select * into plan_record from public.subscription_plans where code = entitlement_record.plan_code;
    select * into license_record from public.licenses where id = entitlement_record.license_id;
    return jsonb_build_object(
      'customer', to_jsonb(customer_record), 'business', to_jsonb(business_record),
      'subscription', to_jsonb(subscription_record), 'entitlement', to_jsonb(entitlement_record),
      'plan', to_jsonb(plan_record), 'license', to_jsonb(license_record),
      'server_time', authoritative_now, 'resumed', true
    );
  end if;

  select * into entitlement_record
  from public.entitlements
  where device_id = p_device_id and source = 'self_service_trial'
  limit 1
  for update;
  if entitlement_record.id is not null then
    select * into customer_record from public.platform_customers where id = entitlement_record.platform_customer_id;
    select * into business_record from public.platform_businesses where id = entitlement_record.platform_business_id;
    select * into device_record from public.registered_devices
      where device_id = p_device_id for update;
    if customer_record.auth_user_id is distinct from p_auth_user_id
       or business_record.workspace_id is distinct from p_workspace_id
       or device_record.id is null
       or device_record.installation_public_key is distinct from p_device_public_key
       or device_record.platform_customer_id is distinct from customer_record.id
       or device_record.platform_business_id is distinct from business_record.id
       or device_record.license_id is distinct from entitlement_record.license_id
       or device_record.device_status in ('revoked', 'replaced') then
      raise exception 'phase1_trial_device_already_used';
    end if;
    if authoritative_now >= entitlement_record.valid_until
       and entitlement_record.status not in ('expired', 'cancelled', 'revoked', 'suspended') then
      update public.entitlements set status = 'expired', server_verified_at = authoritative_now,
        updated_at = authoritative_now where id = entitlement_record.id returning * into entitlement_record;
      update public.subscriptions set status = 'payment_required', updated_at = authoritative_now
        where id = entitlement_record.subscription_id and status = 'trialing';
      update public.licenses set status = 'expired', updated_at = authoritative_now
        where id = entitlement_record.license_id and status = 'trial';
    end if;
    select * into subscription_record from public.subscriptions where id = entitlement_record.subscription_id;
    select * into plan_record from public.subscription_plans where code = entitlement_record.plan_code;
    select * into license_record from public.licenses where id = entitlement_record.license_id;
    return jsonb_build_object(
      'customer', to_jsonb(customer_record), 'business', to_jsonb(business_record),
      'subscription', to_jsonb(subscription_record), 'entitlement', to_jsonb(entitlement_record),
      'plan', to_jsonb(plan_record), 'license', to_jsonb(license_record),
      'server_time', authoritative_now, 'resumed', true
    );
  end if;

  -- A device with any older entitlement or licence must use recovery/device
  -- transfer. Self-service onboarding may never replace or revive it.
  if exists (select 1 from public.entitlements where device_id = p_device_id)
     or exists (select 1 from public.licenses where device_id = p_device_id) then
    raise exception 'phase1_trial_legacy_entitlement_exists';
  end if;

  select * into device_record
  from public.registered_devices
  where device_id = p_device_id
  for update;
  if device_record.id is not null then
    if device_record.device_status in ('revoked', 'replaced')
       or device_record.installation_public_key is distinct from p_device_public_key
       or device_record.platform_customer_id is not null
       or device_record.platform_business_id is not null
       or device_record.license_id is not null then
      raise exception 'phase1_trial_device_already_registered';
    end if;
  end if;

  select * into customer_record
  from public.platform_customers
  where auth_user_id = p_auth_user_id or lower(email) = lower(p_email)
  order by (auth_user_id = p_auth_user_id) desc
  limit 1;

  if customer_record.id is null then
    insert into public.platform_customers (
      auth_user_id, name, email, phone, company, country,
      identity_verification_status, email_verified_at
    ) values (
      p_auth_user_id, btrim(p_owner_name), lower(btrim(p_email)), nullif(btrim(p_phone), ''),
      btrim(p_business_name), 'India',
      case when coalesce(p_email_verified, false) then 'email_verified' else 'unverified' end,
      case when coalesce(p_email_verified, false) then authoritative_now else null end
    )
    returning * into customer_record;
  elsif customer_record.auth_user_id is not null and customer_record.auth_user_id <> p_auth_user_id then
    raise exception 'phase1_trial_account_conflict';
  else
    update public.platform_customers set
      auth_user_id = p_auth_user_id,
      name = btrim(p_owner_name),
      phone = nullif(btrim(p_phone), ''),
      company = btrim(p_business_name),
      identity_verification_status = case
        when coalesce(p_email_verified, false) then 'email_verified'
        else customer_record.identity_verification_status
      end,
      email_verified_at = case
        when coalesce(p_email_verified, false) then coalesce(customer_record.email_verified_at, authoritative_now)
        else customer_record.email_verified_at
      end,
      updated_at = authoritative_now
    where id = customer_record.id returning * into customer_record;
  end if;

  if exists (
    select 1 from public.entitlements
    where platform_customer_id = customer_record.id
  ) or exists (
    select 1 from public.licenses
    where platform_customer_id = customer_record.id
      and status not in ('draft', 'replaced')
  ) then
    raise exception 'phase1_trial_account_already_used';
  end if;

  select * into plan_record
  from public.subscription_plans
  where code = 'bezgrow_monthly' and is_active = true;
  if plan_record.id is null then
    raise exception 'phase1_trial_plan_unavailable';
  end if;

  select * into business_record
  from public.platform_businesses
  where workspace_id = btrim(p_workspace_id)
  for update;
  if business_record.id is not null then
    raise exception 'phase1_trial_workspace_already_registered';
  end if;

  insert into public.platform_businesses (
    platform_customer_id, workspace_id, business_name, plan_name, status,
    platform, app_version, cloud_mode, cloud_backup_enabled,
    business_type, industry, gst_registered, registered_state
  ) values (
    customer_record.id, btrim(p_workspace_id), btrim(p_business_name), plan_record.name, 'active',
    p_platform, nullif(btrim(p_app_version), ''), 'local_only', false,
    nullif(btrim(p_business_type), ''), nullif(btrim(p_industry), ''), coalesce(p_gst_registered, false), nullif(btrim(p_registered_state), '')
  ) returning * into business_record;

  trial_end := authoritative_now + interval '30 days';
  insert into public.subscriptions (
    organization_id, platform_customer_id, platform_business_id, plan_code, status,
    current_period_start, current_period_end, trial_started_at, trial_ends_at, grace_until,
    provider, provider_customer_id, provider_subscription_id, cancel_at_period_end
  ) values (
    null, customer_record.id, business_record.id, plan_record.code, 'trialing',
    authoritative_now, trial_end, authoritative_now, trial_end, trial_end,
    null, null, null, false
  ) returning * into subscription_record;

  license_identifier := 'trial_' || gen_random_uuid()::text;
  insert into public.licenses (
    id, platform_customer_id, platform_business_id, subject_customer_id, subject_business_id,
    customer_name, customer_email, business_name, device_id, platform, architecture, app_version,
    plan_name, issue_date, expiry_date, grace_days, allowed_features,
    maximum_users, maximum_businesses, maximum_branches, status,
    signature_algorithm, issuer_key_id, issued_by_admin_email, activation_date,
    idempotency_key, created_at, updated_at
  ) values (
    license_identifier, customer_record.id, business_record.id, p_auth_user_id::text, p_workspace_id,
    customer_record.name, customer_record.email, business_record.business_name, p_device_id, p_platform,
    case when p_architecture = 'x86_64' then 'x64' else nullif(p_architecture, '') end,
    nullif(btrim(p_app_version), ''), plan_record.name, authoritative_now::date, trial_end::date, 0, features,
    1, 1, 1, 'trial', 'ed25519', null, 'self-service-trial', authoritative_now,
    'phase1:' || p_idempotency_key, authoritative_now, authoritative_now
  ) returning * into license_record;

  insert into public.entitlements (
    subscription_id, platform_customer_id, platform_business_id, license_id, source, status,
    device_id, plan_code, trial_started_at, trial_ends_at, valid_from, valid_until, grace_until,
    allowed_features, server_verified_at, idempotency_key, created_at, updated_at
  ) values (
    subscription_record.id, customer_record.id, business_record.id, license_identifier,
    'self_service_trial', 'pending_signature', p_device_id, plan_record.code,
    authoritative_now, trial_end, authoritative_now, trial_end, trial_end,
    features, authoritative_now, p_idempotency_key, authoritative_now, authoritative_now
  ) returning * into entitlement_record;

  if device_record.id is null then
    insert into public.registered_devices (
    device_id, platform_customer_id, platform_business_id, license_id, platform, architecture,
    app_version, activation_date, last_reported_at, device_status, installation_public_key, created_at, updated_at
  ) values (
    p_device_id, customer_record.id, business_record.id, license_identifier, p_platform,
    case when p_architecture = 'x86_64' then 'x64' else nullif(p_architecture, '') end,
    nullif(btrim(p_app_version), ''), authoritative_now, authoritative_now, 'active', p_device_public_key,
    authoritative_now, authoritative_now
    );
  else
    update public.registered_devices set
      platform_customer_id = customer_record.id,
      platform_business_id = business_record.id,
      license_id = license_identifier,
      platform = p_platform,
      architecture = case when p_architecture = 'x86_64' then 'x64' else nullif(p_architecture, '') end,
      app_version = nullif(btrim(p_app_version), ''),
      activation_date = authoritative_now,
      last_reported_at = authoritative_now,
      device_status = 'active',
      updated_at = authoritative_now
    where id = device_record.id
      and device_status = 'registered'
      and platform_customer_id is null
      and platform_business_id is null
      and license_id is null;
    if not found then raise exception 'phase1_trial_device_concurrent_change'; end if;
  end if;

  return jsonb_build_object(
    'customer', to_jsonb(customer_record), 'business', to_jsonb(business_record),
    'subscription', to_jsonb(subscription_record), 'entitlement', to_jsonb(entitlement_record),
    'plan', to_jsonb(plan_record), 'license', to_jsonb(license_record),
    'server_time', authoritative_now, 'resumed', false
  );
end;
$$;

revoke all on function public.begin_phase1_trial(uuid,text,text,text,text,text,text,text,boolean,text,text,text,text,text,text,text,boolean)
  from public, anon, authenticated;
grant execute on function public.begin_phase1_trial(uuid,text,text,text,text,text,text,text,boolean,text,text,text,text,text,text,text,boolean)
  to service_role;

create or replace function public.finalize_phase1_trial_entitlement(
  p_entitlement_id uuid,
  p_signed_entitlement text,
  p_signature_algorithm text,
  p_issuer_key_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  authoritative_now timestamptz := clock_timestamp();
  entitlement_record public.entitlements%rowtype;
  license_record public.licenses%rowtype;
  canonical_key text;
  effective_status text;
begin
  if p_entitlement_id is null
     or p_signed_entitlement not like 'BZG-LIC-v1.%'
     or p_signature_algorithm <> 'ed25519'
     or nullif(btrim(p_issuer_key_id), '') is null then
    raise exception 'phase1_entitlement_signature_invalid';
  end if;

  select * into entitlement_record from public.entitlements
    where id = p_entitlement_id for update;
  if entitlement_record.id is null or entitlement_record.source <> 'self_service_trial' then
    raise exception 'phase1_entitlement_not_found';
  end if;
  select * into license_record from public.licenses
    where id = entitlement_record.license_id for update;
  if license_record.id is null then raise exception 'phase1_entitlement_license_missing'; end if;

  if entitlement_record.signed_entitlement is not null
     and license_record.signed_license_key is not null
     and entitlement_record.signed_entitlement <> license_record.signed_license_key then
    raise exception 'phase1_entitlement_mirror_conflict';
  end if;
  canonical_key := coalesce(
    entitlement_record.signed_entitlement,
    license_record.signed_license_key,
    p_signed_entitlement
  );
  effective_status := case
    when entitlement_record.status in ('cancelled', 'revoked', 'suspended') then entitlement_record.status
    when authoritative_now >= entitlement_record.valid_until then 'expired'
    else 'trialing'
  end;

  update public.entitlements set
    status = effective_status,
    signed_entitlement = canonical_key,
    signature_algorithm = p_signature_algorithm,
    issuer_key_id = p_issuer_key_id,
    server_verified_at = greatest(server_verified_at, authoritative_now),
    updated_at = authoritative_now
  where id = entitlement_record.id
  returning * into entitlement_record;

  update public.licenses set
    signed_license_key = canonical_key,
    signature_algorithm = p_signature_algorithm,
    issuer_key_id = p_issuer_key_id,
    status = case
      when effective_status = 'expired' then 'expired'
      when effective_status = 'revoked' then 'revoked'
      when effective_status in ('cancelled', 'suspended') then 'suspended'
      else 'trial'
    end,
    updated_at = authoritative_now
  where id = license_record.id
  returning * into license_record;

  if effective_status = 'expired' then
    update public.subscriptions set status = 'payment_required', updated_at = authoritative_now
      where id = entitlement_record.subscription_id and status = 'trialing';
  end if;

  return jsonb_build_object(
    'entitlement', to_jsonb(entitlement_record),
    'license', to_jsonb(license_record),
    'signed_entitlement', canonical_key,
    'server_time', authoritative_now
  );
end;
$$;

revoke all on function public.finalize_phase1_trial_entitlement(uuid,text,text,text)
  from public, anon, authenticated;
grant execute on function public.finalize_phase1_trial_entitlement(uuid,text,text,text)
  to service_role;

insert into public.admin_control_plane_schema_versions (version, description)
values (2026090810, 'Phase 1 self-service account, business, subscription, trial entitlement, and device control plane')
on conflict (version) do nothing;

do $$
begin
  if to_regprocedure('public.admin_control_plane_schema_status_pre_phase1()') is null then
    if to_regprocedure('public.admin_control_plane_current_schema_status()') is null then
      raise exception 'Current control-plane readiness function is missing';
    end if;
    alter function public.admin_control_plane_current_schema_status()
      rename to admin_control_plane_schema_status_pre_phase1;
  end if;
end $$;

revoke all on function public.admin_control_plane_schema_status_pre_phase1()
  from public, anon, authenticated;
grant execute on function public.admin_control_plane_schema_status_pre_phase1()
  to service_role;

create or replace function public.admin_control_plane_current_schema_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  expected_version constant bigint := 2026090810;
  actual_version bigint;
  previous_status jsonb;
  missing jsonb;
  missing_relations jsonb := '[]'::jsonb;
  missing_functions jsonb := '[]'::jsonb;
  missing_indexes jsonb := '[]'::jsonb;
  missing_columns jsonb := '[]'::jsonb;
  missing_rls jsonb := '[]'::jsonb;
  missing_privileges jsonb := '[]'::jsonb;
  entitlement_relation regclass := to_regclass('public.entitlements');
  nonce_relation regclass := to_regclass('public.onboarding_device_nonces');
  ready boolean;
begin
  previous_status := public.admin_control_plane_schema_status_pre_phase1();
  select max(version) into actual_version from public.admin_control_plane_schema_versions;

  if entitlement_relation is null then
    missing_relations := missing_relations || jsonb_build_array('entitlements');
  end if;
  if nonce_relation is null then
    missing_relations := missing_relations || jsonb_build_array('onboarding_device_nonces');
  end if;
  if to_regprocedure('public.begin_phase1_trial(uuid,text,text,text,text,text,text,text,boolean,text,text,text,text,text,text,text,boolean)') is null then
    missing_functions := missing_functions || jsonb_build_array('public.begin_phase1_trial(...)');
  end if;
  if to_regprocedure('public.finalize_phase1_trial_entitlement(uuid,text,text,text)') is null then
    missing_functions := missing_functions || jsonb_build_array('public.finalize_phase1_trial_entitlement(...)');
  end if;
  if to_regclass('public.entitlements_one_self_service_trial_per_device') is null then
    missing_indexes := missing_indexes || jsonb_build_array('entitlements_one_self_service_trial_per_device');
  end if;
  if to_regclass('public.entitlements_one_self_service_trial_per_customer') is null then
    missing_indexes := missing_indexes || jsonb_build_array('entitlements_one_self_service_trial_per_customer');
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'registered_devices'
      and column_name = 'installation_public_key'
  ) then
    missing_columns := missing_columns || jsonb_build_array('registered_devices.installation_public_key');
  end if;
  if entitlement_relation is null or not exists (
    select 1 from pg_catalog.pg_class where oid = entitlement_relation
      and relrowsecurity and relforcerowsecurity
  ) then
    missing_rls := missing_rls || jsonb_build_array('entitlements');
  end if;
  if nonce_relation is null or not exists (
    select 1 from pg_catalog.pg_class where oid = nonce_relation
      and relrowsecurity and relforcerowsecurity
  ) then
    missing_rls := missing_rls || jsonb_build_array('onboarding_device_nonces');
  end if;
  if entitlement_relation is null
     or coalesce(pg_catalog.has_table_privilege('anon', entitlement_relation, 'SELECT'), false)
     or coalesce(pg_catalog.has_table_privilege('authenticated', entitlement_relation, 'SELECT'), false)
     or not coalesce(pg_catalog.has_table_privilege('service_role', entitlement_relation, 'SELECT'), false)
     or not coalesce(pg_catalog.has_table_privilege('service_role', entitlement_relation, 'INSERT'), false) then
    missing_privileges := missing_privileges || jsonb_build_array('entitlements');
  end if;

  missing := coalesce(previous_status -> 'missing', '{}'::jsonb);
  missing := jsonb_set(missing, '{relations}', coalesce(missing -> 'relations', '[]'::jsonb) || missing_relations, true);
  missing := jsonb_set(missing, '{functions}', coalesce(missing -> 'functions', '[]'::jsonb) || missing_functions, true);
  missing := jsonb_set(missing, '{indexes}', coalesce(missing -> 'indexes', '[]'::jsonb) || missing_indexes, true);
  missing := jsonb_set(missing, '{columns}', coalesce(missing -> 'columns', '[]'::jsonb) || missing_columns, true);
  missing := jsonb_set(missing, '{rls}', coalesce(missing -> 'rls', '[]'::jsonb) || missing_rls, true);
  missing := jsonb_set(missing, '{privileges}', coalesce(missing -> 'privileges', '[]'::jsonb) || missing_privileges, true);

  ready := coalesce((previous_status ->> 'ready')::boolean, false)
    and actual_version >= expected_version
    and jsonb_array_length(missing_relations) = 0
    and jsonb_array_length(missing_functions) = 0
    and jsonb_array_length(missing_indexes) = 0
    and jsonb_array_length(missing_columns) = 0
    and jsonb_array_length(missing_rls) = 0
    and jsonb_array_length(missing_privileges) = 0;

  return jsonb_build_object(
    'ready', ready,
    'expectedVersion', expected_version,
    'actualVersion', actual_version,
    'missing', missing
  );
end;
$$;

revoke all on function public.admin_control_plane_current_schema_status()
  from public, anon, authenticated;
grant execute on function public.admin_control_plane_current_schema_status()
  to service_role;

notify pgrst, 'reload schema';

commit;
