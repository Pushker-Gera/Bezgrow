-- Atomic, idempotent Platform Administration licence mutations.
-- Additive only: no licence, device, business, customer, or local ERP data is deleted.

begin;

create table if not exists public.admin_license_mutations (
  idempotency_key text primary key,
  license_id text not null references public.licenses(id) on delete restrict,
  action text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  constraint admin_license_mutations_key_check
    check (char_length(idempotency_key) between 8 and 160)
);

alter table public.admin_license_mutations enable row level security;
alter table public.admin_license_mutations force row level security;
revoke all on public.admin_license_mutations from public, anon, authenticated;
grant select, insert on public.admin_license_mutations to service_role;

create index if not exists idx_admin_license_mutations_license_created
  on public.admin_license_mutations (license_id, created_at desc);
create index if not exists idx_licenses_status_platform_created
  on public.licenses (status, platform, created_at desc);

create or replace function public.admin_mutate_license(
  p_license_id text,
  p_action text,
  p_action_name text,
  p_expected_updated_at timestamptz,
  p_changed_at timestamptz,
  p_updates jsonb,
  p_replacement jsonb,
  p_new_device_id text,
  p_reason text,
  p_idempotency_key text,
  p_request_id text,
  p_admin_user_id uuid,
  p_admin_email text,
  p_ip_address text,
  p_user_agent text,
  p_previous_values jsonb,
  p_new_values jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  current_license public.licenses%rowtype;
  changed_license public.licenses%rowtype;
  replacement_license public.licenses%rowtype;
  target_device public.registered_devices%rowtype;
  existing_mutation public.admin_license_mutations%rowtype;
  mutation_response jsonb;
  safe_ip inet;
begin
  if p_action not in (
    'renew', 'extend', 'change_grace', 'update_features', 'suspend',
    'reactivate', 'revoke', 'replace_device', 'transfer', 'notes'
  ) then
    raise exception 'invalid licence mutation action';
  end if;
  if p_action_name is null or p_action_name = '' then
    raise exception 'licence audit action is required';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 160 then
    raise exception 'valid licence mutation idempotency key is required';
  end if;
  if p_request_id is null or p_admin_user_id is null then
    raise exception 'licence mutation audit identity is required';
  end if;

  -- Serialize identical idempotency keys before consulting their ledger. This
  -- makes both same-licence retries and cross-licence key reuse deterministic.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('bezgrow-license-mutation:' || p_idempotency_key, 0)
  );

  select * into existing_mutation
  from public.admin_license_mutations mutation
  where mutation.idempotency_key = p_idempotency_key;
  if found then
    if existing_mutation.license_id <> p_license_id or existing_mutation.action <> p_action then
      raise exception 'idempotency key was already used for another licence action';
    end if;
    return existing_mutation.response || jsonb_build_object('duplicate', true);
  end if;

  select * into current_license
  from public.licenses license
  where license.id = p_license_id
  for update;
  if not found then
    raise exception 'licence was not found';
  end if;

  -- A parallel first request may have committed while this transaction waited
  -- for the licence row lock. Return that exact result instead of applying twice.
  select * into existing_mutation
  from public.admin_license_mutations mutation
  where mutation.idempotency_key = p_idempotency_key;
  if found then
    if existing_mutation.license_id <> p_license_id or existing_mutation.action <> p_action then
      raise exception 'idempotency key was already used for another licence action';
    end if;
    return existing_mutation.response || jsonb_build_object('duplicate', true);
  end if;

  if current_license.updated_at <> p_expected_updated_at then
    raise exception 'licence changed concurrently';
  end if;
  if current_license.status = 'revoked' and p_action not in ('revoke', 'notes') then
    raise exception 'licence is already revoked';
  end if;
  if current_license.status = 'replaced' and p_action <> 'notes' then
    raise exception 'invalid licence transition from replaced';
  end if;
  if p_action = 'suspend' and current_license.status = 'suspended' then
    raise exception 'licence is already suspended';
  end if;
  if p_action = 'reactivate' and current_license.status <> 'suspended' then
    raise exception 'invalid licence transition to active';
  end if;
  if p_action = 'revoke' and current_license.status = 'revoked' then
    raise exception 'licence is already revoked';
  end if;
  if current_license.status = 'draft' and p_action not in ('notes', 'revoke') then
    raise exception 'invalid licence transition from draft';
  end if;
  if p_action in ('renew', 'extend', 'change_grace', 'update_features')
     and coalesce(p_updates ->> 'signed_license_key', '') = '' then
    raise exception 'signed licence state is required for this mutation';
  end if;

  if p_ip_address ~ '^[0-9a-fA-F:.]+$' then
    begin
      safe_ip := p_ip_address::inet;
    exception when others then
      safe_ip := null;
    end;
  end if;

  if p_action in ('replace_device', 'transfer') then
    if p_replacement is null or p_new_device_id is null or p_new_device_id = '' then
      raise exception 'replacement licence and target device are required';
    end if;
    if p_new_device_id = current_license.device_id then
      raise exception 'target device must differ from the current device';
    end if;

    -- A target that is not registered yet has no row to lock. Serialize all
    -- claims for the same Device ID before checking/inserting its row so two
    -- concurrent transfers cannot both observe it as unassigned.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('bezgrow-license-device:' || p_new_device_id, 0)
    );

    select * into target_device
    from public.registered_devices device
    where device.device_id = p_new_device_id
    for update;
    if found and target_device.license_id is not null then
      raise exception 'target device is already assigned to another licence';
    end if;

    insert into public.licenses (
      id, platform_customer_id, platform_business_id, subject_customer_id,
      subject_business_id, customer_name, customer_email, business_name,
      device_id, platform, architecture, app_version, plan_name, issue_date,
      expiry_date, grace_days, allowed_features, maximum_users,
      maximum_businesses, maximum_branches, internal_notes, status,
      signed_license_key, signature_algorithm, issuer_key_id,
      issued_by_admin_id, issued_by_admin_email, activation_date, renewed_at,
      revoked_at, suspended_at, created_at, updated_at
    ) values (
      p_replacement ->> 'id',
      (p_replacement ->> 'platform_customer_id')::uuid,
      (p_replacement ->> 'platform_business_id')::uuid,
      p_replacement ->> 'subject_customer_id',
      p_replacement ->> 'subject_business_id',
      p_replacement ->> 'customer_name',
      p_replacement ->> 'customer_email',
      p_replacement ->> 'business_name',
      p_replacement ->> 'device_id',
      p_replacement ->> 'platform',
      p_replacement ->> 'architecture',
      p_replacement ->> 'app_version',
      p_replacement ->> 'plan_name',
      (p_replacement ->> 'issue_date')::date,
      (p_replacement ->> 'expiry_date')::date,
      (p_replacement ->> 'grace_days')::integer,
      p_replacement -> 'allowed_features',
      (p_replacement ->> 'maximum_users')::integer,
      (p_replacement ->> 'maximum_businesses')::integer,
      (p_replacement ->> 'maximum_branches')::integer,
      p_replacement ->> 'internal_notes',
      'active',
      p_replacement ->> 'signed_license_key',
      p_replacement ->> 'signature_algorithm',
      p_replacement ->> 'issuer_key_id',
      p_admin_user_id,
      p_admin_email,
      null,
      null,
      null,
      null,
      p_changed_at,
      p_changed_at
    ) returning * into replacement_license;

    update public.licenses
    set status = 'replaced',
        replaced_by_license_id = replacement_license.id,
        updated_at = p_changed_at
    where id = current_license.id
    returning * into changed_license;

    update public.registered_devices
    set device_status = 'replaced',
        replaced_by_device_id = p_new_device_id,
        updated_at = p_changed_at
    where device_id = current_license.device_id;

    insert into public.registered_devices (
      device_id, platform_customer_id, platform_business_id, license_id,
      platform, architecture, app_version, device_status, updated_at
    ) values (
      p_new_device_id, current_license.platform_customer_id,
      current_license.platform_business_id, replacement_license.id,
      current_license.platform, current_license.architecture,
      current_license.app_version, 'registered', p_changed_at
    )
    on conflict (device_id) do update
      set platform_customer_id = excluded.platform_customer_id,
          platform_business_id = excluded.platform_business_id,
          license_id = excluded.license_id,
          platform = excluded.platform,
          architecture = excluded.architecture,
          app_version = excluded.app_version,
          device_status = 'registered',
          replaced_by_device_id = null,
          updated_at = excluded.updated_at;

    insert into public.license_events (
      license_id, action, admin_user_id, admin_email, previous_values,
      new_values, notes, request_id, created_at
    ) values (
      current_license.id, p_action_name, p_admin_user_id, p_admin_email,
      p_previous_values, p_new_values, p_reason, p_request_id, p_changed_at
    );
    insert into public.license_events (
      license_id, action, admin_user_id, admin_email, previous_values,
      new_values, notes, request_id, created_at
    ) values (
      replacement_license.id, 'REPLACEMENT_LICENSE_GENERATED', p_admin_user_id,
      p_admin_email, null,
      jsonb_build_object(
        'device_id', replacement_license.device_id,
        'replaces_license_id', current_license.id,
        'status', replacement_license.status
      ),
      p_reason, p_request_id, p_changed_at
    );

    mutation_response := jsonb_build_object(
      'license', to_jsonb(replacement_license),
      'replacedLicense', to_jsonb(changed_license),
      'replacedLicenseId', current_license.id,
      'duplicate', false
    );
  else
    update public.licenses
    set status = case when p_updates ? 'status' then p_updates ->> 'status' else status end,
        issue_date = case when p_updates ? 'issue_date' then (p_updates ->> 'issue_date')::date else issue_date end,
        expiry_date = case when p_updates ? 'expiry_date' then (p_updates ->> 'expiry_date')::date else expiry_date end,
        grace_days = case when p_updates ? 'grace_days' then (p_updates ->> 'grace_days')::integer else grace_days end,
        allowed_features = case when p_updates ? 'allowed_features' then p_updates -> 'allowed_features' else allowed_features end,
        plan_name = case when p_updates ? 'plan_name' then p_updates ->> 'plan_name' else plan_name end,
        maximum_users = case when p_updates ? 'maximum_users' then (p_updates ->> 'maximum_users')::integer else maximum_users end,
        maximum_businesses = case when p_updates ? 'maximum_businesses' then (p_updates ->> 'maximum_businesses')::integer else maximum_businesses end,
        maximum_branches = case when p_updates ? 'maximum_branches' then (p_updates ->> 'maximum_branches')::integer else maximum_branches end,
        internal_notes = case when p_updates ? 'internal_notes' then p_updates ->> 'internal_notes' else internal_notes end,
        signed_license_key = case when p_updates ? 'signed_license_key' then p_updates ->> 'signed_license_key' else signed_license_key end,
        issuer_key_id = case when p_updates ? 'issuer_key_id' then p_updates ->> 'issuer_key_id' else issuer_key_id end,
        signature_algorithm = case when p_updates ? 'signature_algorithm' then p_updates ->> 'signature_algorithm' else signature_algorithm end,
        issued_by_admin_id = case when p_updates ? 'issued_by_admin_id' then (p_updates ->> 'issued_by_admin_id')::uuid else issued_by_admin_id end,
        issued_by_admin_email = case when p_updates ? 'issued_by_admin_email' then p_updates ->> 'issued_by_admin_email' else issued_by_admin_email end,
        renewed_at = case when p_updates ? 'renewed_at' then (p_updates ->> 'renewed_at')::timestamptz else renewed_at end,
        revoked_at = case when p_updates ? 'revoked_at' then (p_updates ->> 'revoked_at')::timestamptz else revoked_at end,
        suspended_at = case when p_updates ? 'suspended_at' then (p_updates ->> 'suspended_at')::timestamptz else suspended_at end,
        updated_at = p_changed_at
    where id = current_license.id
    returning * into changed_license;

    if p_action = 'revoke' then
      update public.registered_devices
      set device_status = 'revoked', updated_at = p_changed_at
      where license_id = current_license.id or device_id = current_license.device_id;
    end if;

    insert into public.license_events (
      license_id, action, admin_user_id, admin_email, previous_values,
      new_values, notes, request_id, created_at
    ) values (
      changed_license.id, p_action_name, p_admin_user_id, p_admin_email,
      p_previous_values, p_new_values, p_reason, p_request_id, p_changed_at
    );

    mutation_response := jsonb_build_object(
      'license', to_jsonb(changed_license),
      'duplicate', false
    );
  end if;

  insert into public.admin_audit_logs (
    admin_user_id, admin_email, action, target_type, target_id, ip_address,
    user_agent, previous_values, new_values, request_id, result, created_at
  ) values (
    p_admin_user_id, p_admin_email, p_action_name, 'license', current_license.id,
    safe_ip, p_user_agent, p_previous_values, p_new_values, p_request_id,
    'success', p_changed_at
  );

  insert into public.admin_license_mutations (
    idempotency_key, license_id, action, response, created_at
  ) values (
    p_idempotency_key, current_license.id, p_action, mutation_response, p_changed_at
  );

  return mutation_response;
end;
$$;

comment on function public.admin_mutate_license(
  text, text, text, timestamptz, timestamptz, jsonb, jsonb, text, text,
  text, text, uuid, text, text, text, jsonb, jsonb
) is
  'Service-role-only atomic licence mutation, device-binding, immutable history, audit, and idempotency boundary.';

revoke all on function public.admin_mutate_license(
  text, text, text, timestamptz, timestamptz, jsonb, jsonb, text, text,
  text, text, uuid, text, text, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.admin_mutate_license(
  text, text, text, timestamptz, timestamptz, jsonb, jsonb, text, text,
  text, text, uuid, text, text, text, jsonb, jsonb
) to service_role;

insert into public.admin_control_plane_schema_versions (version, description)
values (2026082201, 'Atomic idempotent licence mutations and device-binding audit safety')
on conflict (version) do nothing;

do $$
begin
  if to_regprocedure('public.admin_control_plane_schema_status_2026082102()') is null then
    if to_regprocedure('public.admin_control_plane_current_schema_status()') is null then
      raise exception 'Current control-plane readiness function is missing';
    end if;
    alter function public.admin_control_plane_current_schema_status()
      rename to admin_control_plane_schema_status_2026082102;
  end if;
end;
$$;

revoke all on function public.admin_control_plane_schema_status_2026082102()
  from public, anon, authenticated;
grant execute on function public.admin_control_plane_schema_status_2026082102()
  to service_role;

create or replace function public.admin_control_plane_current_schema_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  expected_version constant bigint := 2026082201;
  actual_version bigint;
  previous_status jsonb;
  missing_relations jsonb;
  missing_functions jsonb;
  missing_indexes jsonb;
  missing_rls jsonb;
  missing_privileges jsonb;
  ready boolean;
  result jsonb;
begin
  previous_status := public.admin_control_plane_schema_status_2026082102();
  select max(version) into actual_version from public.admin_control_plane_schema_versions;

  missing_relations := case when to_regclass('public.admin_license_mutations') is null
    then jsonb_build_array('admin_license_mutations') else '[]'::jsonb end;
  missing_functions := case when to_regprocedure(
    'public.admin_mutate_license(text,text,text,timestamp with time zone,timestamp with time zone,jsonb,jsonb,text,text,text,text,uuid,text,text,text,jsonb,jsonb)'
  ) is null then jsonb_build_array('public.admin_mutate_license') else '[]'::jsonb end;
  missing_indexes := case when to_regclass('public.idx_admin_license_mutations_license_created') is null
    then jsonb_build_array('idx_admin_license_mutations_license_created') else '[]'::jsonb end
    || case when to_regclass('public.idx_licenses_status_platform_created') is null
      then jsonb_build_array('idx_licenses_status_platform_created') else '[]'::jsonb end;

  select case
    when relation.oid is null or not relation.relrowsecurity or not relation.relforcerowsecurity
      then jsonb_build_array('admin_license_mutations')
    else '[]'::jsonb
  end into missing_rls
  from (select to_regclass('public.admin_license_mutations') as oid) target
  left join pg_catalog.pg_class relation on relation.oid = target.oid;

  missing_privileges := case when
    pg_catalog.has_table_privilege('anon', 'public.admin_license_mutations', 'SELECT')
    or pg_catalog.has_table_privilege('authenticated', 'public.admin_license_mutations', 'SELECT')
    or not pg_catalog.has_table_privilege('service_role', 'public.admin_license_mutations', 'SELECT')
    or not pg_catalog.has_table_privilege('service_role', 'public.admin_license_mutations', 'INSERT')
    then jsonb_build_array('admin_license_mutations') else '[]'::jsonb end;

  ready :=
    coalesce((previous_status ->> 'ready')::boolean, false)
    and actual_version >= expected_version
    and jsonb_array_length(missing_relations) = 0
    and jsonb_array_length(missing_functions) = 0
    and jsonb_array_length(missing_indexes) = 0
    and jsonb_array_length(missing_rls) = 0
    and jsonb_array_length(missing_privileges) = 0;

  result := jsonb_set(previous_status, '{ready}', to_jsonb(ready));
  result := jsonb_set(result, '{expectedVersion}', to_jsonb(expected_version));
  result := jsonb_set(result, '{actualVersion}', to_jsonb(actual_version));
  result := jsonb_set(result, '{missing,relations}', coalesce(previous_status #> '{missing,relations}', '[]'::jsonb) || missing_relations);
  result := jsonb_set(result, '{missing,functions}', coalesce(previous_status #> '{missing,functions}', '[]'::jsonb) || missing_functions);
  result := jsonb_set(result, '{missing,indexes}', coalesce(previous_status #> '{missing,indexes}', '[]'::jsonb) || missing_indexes);
  result := jsonb_set(result, '{missing,rls}', coalesce(previous_status #> '{missing,rls}', '[]'::jsonb) || missing_rls);
  result := jsonb_set(result, '{missing,privileges}', coalesce(previous_status #> '{missing,privileges}', '[]'::jsonb) || missing_privileges);
  return result;
end;
$$;

comment on function public.admin_control_plane_current_schema_status() is
  'Service-role-only readiness verification including atomic licence mutations.';
revoke all on function public.admin_control_plane_current_schema_status()
  from public, anon, authenticated;
grant execute on function public.admin_control_plane_current_schema_status()
  to service_role;

notify pgrst, 'reload schema';

commit;
