import assert from "node:assert/strict"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const ownerAdminId = "58dc79eb-9d86-4f50-9cb1-fea6c5470fd4"
const ownerDeviceId = "BZG-23D76F50F880422489AF152B"

assert.ok(supabaseUrl, "NEXT_PUBLIC_SUPABASE_URL is required for the live control-plane audit.")
assert.ok(serviceRoleKey, "SUPABASE_SERVICE_ROLE_KEY is required for the live control-plane audit.")

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const readiness = await supabase.rpc("admin_control_plane_current_schema_status")
if (readiness.error) throw readiness.error
assert.equal(readiness.data?.ready, true, JSON.stringify(readiness.data?.missing || {}))
assert.equal(readiness.data?.expectedVersion, 2026082203)
assert.ok(Number(readiness.data?.actualVersion) >= 2026082203)

const areas = {
  licenses: [
    "license_control_plane",
    "id,platform_customer_id,platform_business_id,customer_name,customer_email,business_name,device_id,platform,architecture,app_version,plan_name,issue_date,expiry_date,grace_days,allowed_features,maximum_users,maximum_businesses,maximum_branches,internal_notes,status,signed_license_key,issuer_key_id,signature_algorithm,issued_by_admin_id,issued_by_admin_email,created_at,updated_at,effective_status",
  ],
  devices: [
    "registered_devices",
    "id,device_id,license_id,device_status,platform_admin_allowed,allowed_admin_user_id,platform_admin_public_key,platform_admin_revoked_at",
  ],
  businesses: [
    "platform_businesses",
    "id,platform_customer_id,workspace_id,business_name,status,platform,app_version,cloud_mode,cloud_backup_enabled",
  ],
  releases: [
    "desktop_releases",
    "id,version,platform,architecture,release_channel,release_status,mandatory,mandatory_after,build_commit,build_timestamp,release_artifacts(file_url,file_size,sha256,artifact_type,updater_url,updater_size,updater_sha256,updater_signature_status,validation_status)",
  ],
  auditLogs: [
    "admin_audit_logs",
    "id,admin_user_id,action,target_type,target_id,request_id,result,created_at",
  ],
  backups: [
    "backup_status",
    "id,platform_business_id,cloud_backup_enabled,last_successful_backup_at,last_failed_backup_at,backup_size,encryption_status,restore_request_status,updated_at",
  ],
  settings: [
    "platform_settings",
    "id,platform_name,support_email,default_license_duration_days,default_grace_days,update_channels,backup_policies,updated_at",
  ],
  licenseMutations: [
    "admin_license_mutations",
    "idempotency_key,license_id,action,created_at",
  ],
}

const counts = {}
for (const [area, [table, columns]] of Object.entries(areas)) {
  const result = await supabase.from(table).select(columns, { count: "exact" }).limit(1)
  if (result.error) throw new Error(`${area}: ${result.error.code} ${result.error.message}`)
  counts[area] = result.count || 0
}

const [ownerDevice, ownerProfile, nonceTable, dashboard, mutationRpc] = await Promise.all([
  supabase
    .from("registered_devices")
    .select("id,device_id,device_status,platform_admin_allowed,allowed_admin_user_id,platform_admin_revoked_at")
    .eq("device_id", ownerDeviceId)
    .maybeSingle(),
  supabase
    .from("profiles")
    .select("id,role,is_suspended")
    .eq("id", ownerAdminId)
    .maybeSingle(),
  supabase.from("platform_admin_request_nonces").select("nonce", { count: "exact", head: true }),
  supabase.rpc("admin_control_plane_dashboard_v2", {
    requesting_admin_id: ownerAdminId,
    range_days: 30,
  }),
  supabase.rpc("admin_mutate_license", {
    p_license_id: "READ_ONLY-CAPABILITY-PROBE",
    p_action: "invalid_read_only_probe",
    p_action_name: "READ_ONLY_CAPABILITY_PROBE",
    p_expected_updated_at: new Date(0).toISOString(),
    p_changed_at: new Date(0).toISOString(),
    p_updates: {},
    p_replacement: null,
    p_new_device_id: null,
    p_reason: null,
    p_idempotency_key: "read-only-capability-probe",
    p_request_id: "read-only-capability-probe",
    p_admin_user_id: ownerAdminId,
    p_admin_email: null,
    p_ip_address: null,
    p_user_agent: "read-only-capability-probe",
    p_previous_values: {},
    p_new_values: {},
  }),
])

for (const [name, result] of Object.entries({ ownerDevice, ownerProfile, nonceTable, dashboard })) {
  if (result.error) throw new Error(`${name}: ${result.error.code} ${result.error.message}`)
}
assert.match(mutationRpc.error?.message || "", /invalid licence mutation action/i, "Atomic mutation RPC capability probe did not reach its validation boundary.")

assert.equal(ownerDevice.data?.device_status, "active")
assert.equal(ownerDevice.data?.platform_admin_allowed, true)
assert.equal(ownerDevice.data?.allowed_admin_user_id, ownerAdminId)
assert.equal(ownerDevice.data?.platform_admin_revoked_at, null)
assert.equal(ownerProfile.data?.role, "platform_admin")
assert.equal(ownerProfile.data?.is_suspended, false)

const sections = dashboard.data?.sections || {}
for (const section of ["licenses", "devices", "businesses", "customers", "releases", "backups", "audit", "analytics"]) {
  assert.ok(sections[section], `Dashboard section is missing: ${section}`)
  assert.notEqual(sections[section]?.status, "error", `Dashboard section failed: ${section}`)
}

console.log(JSON.stringify({
  status: "live-control-plane-ok",
  schemaVersion: readiness.data.actualVersion,
  counts,
  ownerDeviceAuthorized: true,
  dashboardSections: Object.keys(sections).sort(),
}))
