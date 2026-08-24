-- Device-bound App Lock reset authorizations.
-- Stores only the newly signed licence (which contains a one-way verifier),
-- never the plaintext password or local ERP data.

begin;

create or replace function public.admin_reset_app_password(
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
  existing_mutation public.admin_license_mutations%rowtype;
  mutation_response jsonb;
  safe_ip inet;
begin
  if p_action <> 'reset_app_password' or p_action_name <> 'APP_PASSWORD_RESET_AUTHORIZED' then
    raise exception 'invalid app-password reset action';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 160 then
    raise exception 'valid app-password reset idempotency key is required';
  end if;
  if p_request_id is null or p_admin_user_id is null then
    raise exception 'app-password reset audit identity is required';
  end if;
  if coalesce(p_updates ->> 'signed_license_key', '') = ''
     or coalesce(p_updates ->> 'issuer_key_id', '') = ''
     or coalesce(p_updates ->> 'signature_algorithm', '') = '' then
    raise exception 'signed app-password reset authorization is required';
  end if;

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
  if current_license.updated_at <> p_expected_updated_at then
    raise exception 'licence changed concurrently';
  end if;
  if current_license.status in ('draft', 'revoked', 'replaced') then
    raise exception 'invalid licence transition for app-password reset';
  end if;

  update public.licenses
  set signed_license_key = p_updates ->> 'signed_license_key',
      issuer_key_id = p_updates ->> 'issuer_key_id',
      signature_algorithm = p_updates ->> 'signature_algorithm',
      issued_by_admin_id = (p_updates ->> 'issued_by_admin_id')::uuid,
      issued_by_admin_email = p_updates ->> 'issued_by_admin_email',
      updated_at = p_changed_at
  where id = current_license.id
  returning * into changed_license;

  insert into public.license_events (
    license_id, action, admin_user_id, admin_email, previous_values,
    new_values, notes, request_id, created_at
  ) values (
    changed_license.id, p_action_name, p_admin_user_id, p_admin_email,
    p_previous_values, p_new_values, p_reason, p_request_id, p_changed_at
  );

  if p_ip_address ~ '^[0-9a-fA-F:.]+$' then
    begin
      safe_ip := p_ip_address::inet;
    exception when others then
      safe_ip := null;
    end;
  end if;

  insert into public.admin_audit_logs (
    admin_user_id, admin_email, action, target_type, target_id, ip_address,
    user_agent, previous_values, new_values, request_id, result, created_at
  ) values (
    p_admin_user_id, p_admin_email, p_action_name, 'license', current_license.id,
    safe_ip, p_user_agent, p_previous_values, p_new_values, p_request_id,
    'success', p_changed_at
  );

  mutation_response := jsonb_build_object(
    'license', to_jsonb(changed_license),
    'duplicate', false
  );
  insert into public.admin_license_mutations (
    idempotency_key, license_id, action, response, created_at
  ) values (
    p_idempotency_key, current_license.id, p_action, mutation_response, p_changed_at
  );

  return mutation_response;
end;
$$;

comment on function public.admin_reset_app_password(
  text, text, text, timestamptz, timestamptz, jsonb, jsonb, text, text,
  text, text, uuid, text, text, text, jsonb, jsonb
) is
  'Service-role-only, atomic, audited, idempotent App Lock reset authorization for one licensed device.';

revoke all on function public.admin_reset_app_password(
  text, text, text, timestamptz, timestamptz, jsonb, jsonb, text, text,
  text, text, uuid, text, text, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.admin_reset_app_password(
  text, text, text, timestamptz, timestamptz, jsonb, jsonb, text, text,
  text, text, uuid, text, text, text, jsonb, jsonb
) to service_role;

insert into public.admin_control_plane_schema_versions (version, description)
values (2026082401, 'Device-bound audited App Lock password reset authorization')
on conflict (version) do nothing;

do $$
begin
  if to_regprocedure('public.admin_control_plane_schema_status_2026082203()') is null then
    if to_regprocedure('public.admin_control_plane_current_schema_status()') is null then
      raise exception 'Current control-plane readiness function is missing';
    end if;
    alter function public.admin_control_plane_current_schema_status()
      rename to admin_control_plane_schema_status_2026082203;
  end if;
end;
$$;

revoke all on function public.admin_control_plane_schema_status_2026082203()
  from public, anon, authenticated;
grant execute on function public.admin_control_plane_schema_status_2026082203()
  to service_role;

create or replace function public.admin_control_plane_current_schema_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  expected_version constant bigint := 2026082401;
  actual_version bigint;
  previous_status jsonb;
  missing jsonb;
  missing_functions jsonb;
  ready boolean;
begin
  previous_status := public.admin_control_plane_schema_status_2026082203();
  select max(version) into actual_version from public.admin_control_plane_schema_versions;
  missing := coalesce(previous_status -> 'missing', '{}'::jsonb);
  missing_functions := coalesce(missing -> 'functions', '[]'::jsonb);

  if to_regprocedure('public.admin_reset_app_password(text,text,text,timestamp with time zone,timestamp with time zone,jsonb,jsonb,text,text,text,text,uuid,text,text,text,jsonb,jsonb)') is null then
    missing_functions := missing_functions || jsonb_build_array('public.admin_reset_app_password(...)');
  end if;
  missing := jsonb_set(missing, '{functions}', missing_functions, true);
  ready := coalesce((previous_status ->> 'ready')::boolean, false)
    and actual_version >= expected_version
    and jsonb_array_length(missing_functions) = 0;

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

commit;
