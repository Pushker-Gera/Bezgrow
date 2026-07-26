-- Corrective, additive Bezgrow control-plane migration.
-- This migration does not weaken RLS, expose signing material, or touch local ERP data.

begin;

alter table public.licenses
  add column if not exists subject_customer_id text,
  add column if not exists subject_business_id text,
  add column if not exists activation_date timestamptz,
  add column if not exists architecture text,
  add column if not exists renewed_at timestamptz,
  add column if not exists revoked_at timestamptz,
  add column if not exists suspended_at timestamptz;

alter table public.device_checkins
  add column if not exists license_id text,
  add column if not exists device_id text,
  add column if not exists business_id text,
  add column if not exists platform text,
  add column if not exists architecture text,
  add column if not exists activation_status text,
  add column if not exists client_reported_at timestamptz;

alter table public.release_artifacts
  add column if not exists artifact_type text,
  add column if not exists file_name text,
  add column if not exists update_signature text;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'licenses_architecture_check_v3'
      and conrelid = 'public.licenses'::regclass
  ) then
    alter table public.licenses
      add constraint licenses_architecture_check_v3
      check (architecture is null or architecture in ('arm64', 'x64')) not valid;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'device_checkins_platform_check_v3'
      and conrelid = 'public.device_checkins'::regclass
  ) then
    alter table public.device_checkins
      add constraint device_checkins_platform_check_v3
      check (platform is null or platform in ('macos', 'windows')) not valid;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'device_checkins_architecture_check_v3'
      and conrelid = 'public.device_checkins'::regclass
  ) then
    alter table public.device_checkins
      add constraint device_checkins_architecture_check_v3
      check (architecture is null or architecture in ('arm64', 'x64')) not valid;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'release_artifacts_artifact_type_check_v3'
      and conrelid = 'public.release_artifacts'::regclass
  ) then
    alter table public.release_artifacts
      add constraint release_artifacts_artifact_type_check_v3
      check (
        artifact_type is null
        or artifact_type in ('dmg', 'nsis', 'msi', 'portable_exe', 'portable_zip')
      ) not valid;
  end if;
end
$$;

create index if not exists idx_licenses_subject_business
  on public.licenses (subject_business_id, created_at desc);
create index if not exists idx_licenses_activation
  on public.licenses (activation_date desc)
  where activation_date is not null;
create index if not exists idx_device_checkins_license_reported
  on public.device_checkins (license_id, reported_at desc);
create index if not exists idx_device_checkins_platform_arch_reported
  on public.device_checkins (platform, architecture, reported_at desc);
create index if not exists idx_release_artifacts_type
  on public.release_artifacts (artifact_type, validation_status, updated_at desc);

-- Repair the exact production failure without rewriting the already-applied migration:
-- the PL/pgSQL variable named "result" collides with admin_audit_logs.result.
do $$
declare
  function_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.admin_control_plane_dashboard(uuid)'::regprocedure
  )
  into function_definition;

  function_definition := replace(
    function_definition,
    'result jsonb;',
    'dashboard_payload jsonb;'
  );
  function_definition := replace(
    function_definition,
    'into result',
    'into dashboard_payload'
  );
  function_definition := replace(
    function_definition,
    'result := result ||',
    'dashboard_payload := dashboard_payload ||'
  );
  function_definition := replace(
    function_definition,
    'return result;',
    'return dashboard_payload;'
  );

  execute function_definition;
end
$$;

create or replace function public.admin_control_plane_dashboard_v2(
  requesting_admin_id uuid,
  range_days integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  since_at timestamptz;
  sections jsonb := '{}'::jsonb;
  section_payload jsonb;
begin
  if range_days < 7 or range_days > 365 then
    raise exception 'analytics range must be between 7 and 365 days';
  end if;
  if not exists (
    select 1
    from public.profiles profile
    where profile.id = requesting_admin_id
      and profile.role in ('admin', 'platform_admin')
      and coalesce(profile.is_suspended, false) = false
  ) then
    raise exception 'platform admin authorization required';
  end if;

  since_at := now() - make_interval(days => range_days);

  begin
    select jsonb_build_object(
      'status', 'ok',
      'source', 'public.licenses',
      'notes', 'Authoritative signed-license metadata only.',
      'metrics', jsonb_build_object(
        'active', count(*) filter (
          where license.status = 'active' and license.expiry_date >= current_date
        ),
        'expiring7', count(*) filter (
          where license.status in ('active', 'trial', 'expiring')
            and license.expiry_date between current_date and current_date + 7
        ),
        'expiring30', count(*) filter (
          where license.status in ('active', 'trial', 'expiring')
            and license.expiry_date between current_date and current_date + 30
        ),
        'expiring90', count(*) filter (
          where license.status in ('active', 'trial', 'expiring')
            and license.expiry_date between current_date and current_date + 90
        ),
        'gracePeriod', count(*) filter (
          where license.status not in ('suspended', 'revoked', 'replaced', 'draft')
            and license.expiry_date < current_date
            and license.expiry_date + license.grace_days >= current_date
        ),
        'expired', count(*) filter (
          where license.status = 'expired'
            or (
              license.status in ('active', 'trial', 'expiring', 'grace_period')
              and license.expiry_date + license.grace_days < current_date
            )
        ),
        'revoked', count(*) filter (where license.status = 'revoked'),
        'suspended', count(*) filter (where license.status = 'suspended'),
        'trial', count(*) filter (where license.status = 'trial')
      )
    )
    into section_payload
    from public.licenses license;
    sections := sections || jsonb_build_object('licenses', section_payload);
  exception
    when undefined_table or undefined_column or undefined_function then raise;
    when others then
      sections := sections || jsonb_build_object(
        'licenses',
        jsonb_build_object(
          'status', 'error',
          'source', 'public.licenses',
          'code', 'SECTION_QUERY_FAILED',
          'message', 'Licenses metrics could not be loaded.'
        )
      );
  end;

  begin
    select jsonb_build_object(
      'status', case when count(*) = 0 then 'never_reported' else 'ok' end,
      'source', 'public.registered_devices + public.device_checkins',
      'notes', case
        when count(*) = 0 then 'No authenticated device report has been received.'
        else 'Last reported during authenticated online contact.'
      end,
      'metrics', jsonb_build_object(
        'total', count(*),
        'activatedToday', count(*) filter (
          where device.activation_date >= date_trunc('day', now())
        ),
        'active30Days', count(*) filter (
          where device.last_reported_at >= now() - interval '30 days'
        ),
        'failedUpdateChecks', (
          select count(*)
          from public.device_checkins checkin
          where checkin.update_check_result = 'failed'
            and checkin.reported_at >= since_at
        )
      )
    )
    into section_payload
    from public.registered_devices device;
    sections := sections || jsonb_build_object('devices', section_payload);
  exception
    when undefined_table or undefined_column or undefined_function then raise;
    when others then
      sections := sections || jsonb_build_object(
        'devices',
        jsonb_build_object(
          'status', 'error',
          'source', 'public.registered_devices + public.device_checkins',
          'code', 'SECTION_QUERY_FAILED',
          'message', 'Devices metrics could not be loaded.'
        )
      );
  end;

  begin
    select jsonb_build_object(
      'status', 'ok',
      'source', 'public.platform_businesses',
      'notes', 'Platform workspace metadata; local ERP records are excluded.',
      'count', count(*)
    )
    into section_payload
    from public.platform_businesses;
    sections := sections || jsonb_build_object('businesses', section_payload);
  exception
    when undefined_table or undefined_column or undefined_function then raise;
    when others then
      sections := sections || jsonb_build_object(
        'businesses',
        jsonb_build_object(
          'status', 'error',
          'source', 'public.platform_businesses',
          'code', 'SECTION_QUERY_FAILED',
          'message', 'Businesses metrics could not be loaded.'
        )
      );
  end;

  begin
    select jsonb_build_object(
      'status', 'ok',
      'source', 'public.platform_customers',
      'count', count(*)
    )
    into section_payload
    from public.platform_customers;
    sections := sections || jsonb_build_object('customers', section_payload);
  exception
    when undefined_table or undefined_column or undefined_function then raise;
    when others then
      sections := sections || jsonb_build_object(
        'customers',
        jsonb_build_object(
          'status', 'error',
          'source', 'public.platform_customers',
          'code', 'SECTION_QUERY_FAILED',
          'message', 'Customers metrics could not be loaded.'
        )
      );
  end;

  begin
    select jsonb_build_object(
      'status', case
        when not exists (
          select 1
          from public.desktop_releases release
          where release.release_status = 'published' and release.active
        ) then 'not_configured'
        else 'ok'
      end,
      'source', 'public.desktop_releases + public.release_artifacts',
      'notes', case
        when not exists (
          select 1
          from public.desktop_releases release
          where release.release_status = 'published' and release.active
        ) then 'No validated release has been published.'
        else 'Published release metadata.'
      end,
      'latestMac', (
        select to_jsonb(release_row)
        from (
          select release.id, release.version, release.build_number,
            release.platform, release.architecture, release.release_channel,
            release.release_status, release.published_at, release.mandatory
          from public.desktop_releases release
          where release.platform = 'macos'
            and release.release_status = 'published'
            and release.active
          order by release.published_at desc nulls last, release.created_at desc
          limit 1
        ) release_row
      ),
      'latestWindows', (
        select to_jsonb(release_row)
        from (
          select release.id, release.version, release.build_number,
            release.platform, release.architecture, release.release_channel,
            release.release_status, release.published_at, release.mandatory
          from public.desktop_releases release
          where release.platform = 'windows'
            and release.release_status = 'published'
            and release.active
          order by release.published_at desc nulls last, release.created_at desc
          limit 1
        ) release_row
      )
    )
    into section_payload;
    sections := sections || jsonb_build_object('releases', section_payload);
  exception
    when undefined_table or undefined_column or undefined_function then raise;
    when others then
      sections := sections || jsonb_build_object(
        'releases',
        jsonb_build_object(
          'status', 'error',
          'source', 'public.desktop_releases + public.release_artifacts',
          'code', 'SECTION_QUERY_FAILED',
          'message', 'Releases metrics could not be loaded.'
        )
      );
  end;

  begin
    select jsonb_build_object(
      'status', case when count(*) = 0 then 'not_configured' else 'ok' end,
      'source', 'public.backup_status',
      'notes', case
        when count(*) = 0 then 'No workspace has configured cloud backup.'
        else 'Consented backup metadata only.'
      end,
      'metrics', jsonb_build_object(
        'enabled', count(*) filter (where backup.cloud_backup_enabled),
        'failed', count(*) filter (
          where backup.last_failed_backup_at is not null
            and (
              backup.last_successful_backup_at is null
              or backup.last_failed_backup_at > backup.last_successful_backup_at
            )
        )
      )
    )
    into section_payload
    from public.backup_status backup;
    sections := sections || jsonb_build_object('backups', section_payload);
  exception
    when undefined_table or undefined_column or undefined_function then raise;
    when others then
      sections := sections || jsonb_build_object(
        'backups',
        jsonb_build_object(
          'status', 'error',
          'source', 'public.backup_status',
          'code', 'SECTION_QUERY_FAILED',
          'message', 'Backups metrics could not be loaded.'
        )
      );
  end;

  begin
    select jsonb_build_object(
      'status', 'ok',
      'source', 'public.support_cases',
      'metrics', jsonb_build_object(
        'attention', count(*) filter (
          where support.status <> 'resolved' and support.priority in ('high', 'urgent')
        )
      ),
      'cases', coalesce((
        select jsonb_agg(to_jsonb(support_row))
        from (
          select support.id, support.case_number, support.subject,
            support.status, support.priority, support.updated_at
          from public.support_cases support
          where support.status <> 'resolved'
            and support.priority in ('high', 'urgent')
          order by
            case support.priority when 'urgent' then 1 when 'high' then 2 else 3 end,
            support.updated_at desc
          limit 8
        ) support_row
      ), '[]'::jsonb)
    )
    into section_payload
    from public.support_cases support;
    sections := sections || jsonb_build_object('support', section_payload);
  exception
    when undefined_table or undefined_column or undefined_function then raise;
    when others then
      sections := sections || jsonb_build_object(
        'support',
        jsonb_build_object(
          'status', 'error',
          'source', 'public.support_cases',
          'code', 'SECTION_QUERY_FAILED',
          'message', 'Support metrics could not be loaded.'
        )
      );
  end;

  begin
    select jsonb_build_object(
      'status', case when count(*) = 0 then 'never_reported' else 'ok' end,
      'source', 'public.admin_audit_logs',
      'notes', case
        when count(*) = 0 then 'No control-plane event has been recorded.'
        else 'Append-only administrative and security events.'
      end,
      'recent', coalesce((
        select jsonb_agg(to_jsonb(audit_row))
        from (
          select audit.id, audit.admin_email, audit.action, audit.target_type,
            audit.target_id, audit.result, audit.request_id, audit.created_at
          from public.admin_audit_logs audit
          order by audit.created_at desc
          limit 8
        ) audit_row
      ), '[]'::jsonb),
      'failures', coalesce((
        select jsonb_agg(to_jsonb(failure_row))
        from (
          select audit.id, audit.admin_email, audit.action, audit.target_type,
            audit.target_id, audit.result, audit.request_id, audit.created_at
          from public.admin_audit_logs audit
          where audit.action in ('LICENSE_ACTIVATION_FAILED', 'ADMIN_LOGIN_FAILED')
            and audit.result = 'failure'
          order by audit.created_at desc
          limit 8
        ) failure_row
      ), '[]'::jsonb),
      'security', coalesce((
        select jsonb_agg(to_jsonb(security_row))
        from (
          select audit.id, audit.admin_email, audit.action, audit.target_type,
            audit.target_id, audit.result, audit.request_id, audit.created_at
          from public.admin_audit_logs audit
          where audit.action in (
            'ADMIN_LOGIN_FAILED',
            'LICENSE_REVOKED',
            'DEVICE_REVOKED',
            'INTEGRITY_EVENT'
          )
          order by audit.created_at desc
          limit 8
        ) security_row
      ), '[]'::jsonb)
    )
    into section_payload
    from public.admin_audit_logs audit;
    sections := sections || jsonb_build_object('audit', section_payload);
  exception
    when undefined_table or undefined_column or undefined_function then raise;
    when others then
      sections := sections || jsonb_build_object(
        'audit',
        jsonb_build_object(
          'status', 'error',
          'source', 'public.admin_audit_logs',
          'code', 'SECTION_QUERY_FAILED',
          'message', 'Audit metrics could not be loaded.'
        )
      );
  end;

  begin
    select jsonb_build_object(
      'status', case
        when (
          select count(*)
          from public.device_checkins checkin
          where checkin.reported_at >= since_at
        ) + (
          select count(*)
          from public.license_events event
          where event.created_at >= since_at
        ) = 0 then 'never_reported'
        else 'ok'
      end,
      'source', 'public.device_checkins + public.license_events',
      'notes', format(
        'Range: %s days. Local customer sales and inventory are excluded.',
        range_days
      ),
      'metrics', jsonb_build_object(
        'deviceReports', (
          select count(*)
          from public.device_checkins checkin
          where checkin.reported_at >= since_at
        ),
        'licenseEvents', (
          select count(*)
          from public.license_events event
          where event.created_at >= since_at
        )
      )
    )
    into section_payload;
    sections := sections || jsonb_build_object('analytics', section_payload);
  exception
    when undefined_table or undefined_column or undefined_function then raise;
    when others then
      sections := sections || jsonb_build_object(
        'analytics',
        jsonb_build_object(
          'status', 'error',
          'source', 'public.device_checkins + public.license_events',
          'code', 'SECTION_QUERY_FAILED',
          'message', 'Analytics metrics could not be loaded.'
        )
      );
  end;

  return jsonb_build_object(
    'rangeDays', range_days,
    'sections', sections
  );
end;
$$;

revoke all on function public.admin_control_plane_dashboard_v2(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.admin_control_plane_dashboard_v2(uuid, integer)
  to service_role;

create or replace function public.register_device_checkin(
  p_request_id text,
  p_license_id text,
  p_device_id text,
  p_platform_business_id uuid,
  p_platform_customer_id uuid,
  p_business_id text,
  p_platform text,
  p_operating_system text,
  p_architecture text,
  p_app_version text,
  p_release_channel text,
  p_update_check_result text,
  p_license_status text,
  p_activation_status text,
  p_diagnostics_available boolean,
  p_client_reported_at timestamptz default null,
  p_reported_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  license_row public.licenses%rowtype;
  existing_device public.registered_devices%rowtype;
  saved_device public.registered_devices%rowtype;
  event_action text;
begin
  select *
  into license_row
  from public.licenses license
  where license.id = p_license_id
  for update;

  if not found then
    raise exception 'registered license is required';
  end if;
  if license_row.device_id is distinct from p_device_id then
    raise exception 'license device does not match';
  end if;
  if license_row.platform_business_id is distinct from p_platform_business_id then
    raise exception 'license business does not match';
  end if;
  if license_row.platform_customer_id is distinct from p_platform_customer_id then
    raise exception 'license customer does not match';
  end if;
  if license_row.subject_business_id is not null
    and license_row.subject_business_id is distinct from p_business_id then
    raise exception 'signed business does not match';
  end if;

  select *
  into existing_device
  from public.registered_devices device
  where device.device_id = p_device_id
  for update;

  if found and (
    existing_device.license_id is distinct from p_license_id
    or existing_device.platform_business_id is distinct from p_platform_business_id
    or existing_device.platform_customer_id is distinct from p_platform_customer_id
  ) then
    raise exception 'device is already assigned to another license or customer';
  end if;

  event_action := case
    when existing_device.id is null then 'DEVICE_REGISTERED'
    else 'DEVICE_CHECKIN'
  end;

  insert into public.registered_devices (
    device_id,
    platform_customer_id,
    platform_business_id,
    license_id,
    platform,
    operating_system,
    architecture,
    app_version,
    activation_date,
    last_reported_at,
    last_update_check_at,
    release_channel,
    device_status,
    diagnostics_available,
    created_at,
    updated_at
  )
  values (
    p_device_id,
    p_platform_customer_id,
    p_platform_business_id,
    p_license_id,
    p_platform,
    p_operating_system,
    p_architecture,
    p_app_version,
    p_reported_at,
    p_reported_at,
    p_reported_at,
    p_release_channel,
    'active',
    coalesce(p_diagnostics_available, false),
    p_reported_at,
    p_reported_at
  )
  on conflict (device_id) do update
  set
    platform = excluded.platform,
    operating_system = excluded.operating_system,
    architecture = excluded.architecture,
    app_version = excluded.app_version,
    last_reported_at = excluded.last_reported_at,
    last_update_check_at = excluded.last_update_check_at,
    release_channel = excluded.release_channel,
    device_status = case
      when public.registered_devices.device_status in ('revoked', 'replaced')
        then public.registered_devices.device_status
      else 'active'
    end,
    diagnostics_available = excluded.diagnostics_available,
    updated_at = excluded.updated_at
  returning *
  into saved_device;

  if saved_device.device_status in ('revoked', 'replaced') then
    raise exception 'device is not permitted to check in';
  end if;

  insert into public.device_checkins (
    registered_device_id,
    license_id,
    device_id,
    business_id,
    platform,
    architecture,
    app_version,
    release_channel,
    update_check_result,
    activation_status,
    license_status,
    request_id,
    client_reported_at,
    reported_at
  )
  values (
    saved_device.id,
    p_license_id,
    p_device_id,
    p_business_id,
    p_platform,
    p_architecture,
    p_app_version,
    p_release_channel,
    p_update_check_result,
    p_activation_status,
    p_license_status,
    p_request_id,
    p_client_reported_at,
    p_reported_at
  );

  update public.licenses
  set
    subject_business_id = coalesce(subject_business_id, p_business_id),
    activation_date = coalesce(activation_date, p_reported_at),
    architecture = p_architecture,
    app_version = p_app_version,
    updated_at = p_reported_at
  where id = p_license_id;

  update public.platform_businesses
  set
    platform = p_platform,
    app_version = p_app_version,
    update_channel = p_release_channel,
    telemetry_reported_at = p_reported_at,
    updated_at = p_reported_at
  where id = p_platform_business_id;

  insert into public.license_events (
    license_id,
    action,
    admin_user_id,
    admin_email,
    previous_values,
    new_values,
    notes,
    request_id,
    created_at
  )
  values (
    p_license_id,
    event_action,
    null,
    null,
    null,
    jsonb_build_object(
      'device_id', p_device_id,
      'business_id', p_business_id,
      'platform', p_platform,
      'architecture', p_architecture,
      'app_version', p_app_version,
      'release_channel', p_release_channel,
      'activation_status', p_activation_status,
      'license_status', p_license_status
    ),
    'Authenticated minimal device metadata report.',
    p_request_id,
    p_reported_at
  );

  insert into public.admin_audit_logs (
    admin_user_id,
    admin_email,
    action,
    target_type,
    target_id,
    ip_address,
    user_agent,
    previous_values,
    new_values,
    request_id,
    result,
    created_at
  )
  values (
    null,
    null,
    event_action,
    'device',
    p_device_id,
    null,
    null,
    null,
    jsonb_build_object(
      'license_id', p_license_id,
      'business_id', p_business_id,
      'platform', p_platform,
      'architecture', p_architecture,
      'app_version', p_app_version
    ),
    p_request_id,
    'success',
    p_reported_at
  );

  return to_jsonb(saved_device);
end;
$$;

revoke all on function public.register_device_checkin(
  text, text, text, uuid, uuid, text, text, text, text, text, text,
  text, text, text, boolean, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.register_device_checkin(
  text, text, text, uuid, uuid, text, text, text, text, text, text,
  text, text, text, boolean, timestamptz, timestamptz
) to service_role;

insert into public.admin_control_plane_schema_versions (version, description)
values (
  2026072701,
  'Dashboard error isolation, authoritative device registration, and release metadata corrections'
)
on conflict (version) do nothing;

-- Advance readiness tracking while retaining the exhaustive checks from the
-- original migration. Future additive migrations remain compatible.
do $$
declare
  function_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.admin_control_plane_schema_status()'::regprocedure
  )
  into function_definition;

  function_definition := replace(
    function_definition,
    'expected_version constant bigint := 2026072601;',
    'expected_version constant bigint := 2026072701;'
  );
  function_definition := replace(
    function_definition,
    'actual_version = expected_version',
    'actual_version >= expected_version'
  );
  execute function_definition;
end
$$;

do $$
begin
  if to_regprocedure('public.admin_control_plane_dashboard_v2(uuid,integer)') is null then
    raise exception 'Required function public.admin_control_plane_dashboard_v2 is missing';
  end if;
  if to_regprocedure(
    'public.register_device_checkin(text,text,text,uuid,uuid,text,text,text,text,text,text,text,text,text,boolean,timestamp with time zone,timestamp with time zone)'
  ) is null then
    raise exception 'Required function public.register_device_checkin is missing';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
