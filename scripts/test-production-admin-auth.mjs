import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import nextEnv from "@next/env"
import { createClient } from "@supabase/supabase-js"

const { loadEnvConfig } = nextEnv
loadEnvConfig(process.cwd())

if (process.env.BEZGROW_RUN_PRODUCTION_E2E !== "1") {
  throw new Error("Set BEZGROW_RUN_PRODUCTION_E2E=1 to authorize temporary production auth records.")
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
const baseUrl = (process.env.BEZGROW_E2E_BASE_URL || "https://www.bezgrow.com").replace(/\/+$/, "")

assert.ok(supabaseUrl && anonKey && serviceRoleKey, "Supabase E2E environment is incomplete.")

const service = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const temporaryUsers = []

function temporaryIdentity(role) {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
  return {
    email: `admin-final-e2e-${role}-${suffix}@example.invalid`,
    password: `ADMIN-FINAL-E2E-${randomBytes(24).toString("base64url")}`,
    role,
  }
}

async function createTemporaryUser(role) {
  const identity = temporaryIdentity(role)
  const created = await service.auth.admin.createUser({
    email: identity.email,
    password: identity.password,
    email_confirm: true,
    user_metadata: { full_name: `ADMIN-FINAL-E2E-${role}` },
  })
  if (created.error || !created.data.user) throw created.error || new Error("Temporary user was not created.")
  temporaryUsers.push(created.data.user.id)

  const profile = await service
    .from("profiles")
    .update({
      role,
      is_suspended: false,
      full_name: `ADMIN-FINAL-E2E-${role}`,
    })
    .eq("id", created.data.user.id)
    .select("id,role")
    .single()
  if (profile.error) throw profile.error

  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const signedIn = await client.auth.signInWithPassword({
    email: identity.email,
    password: identity.password,
  })
  if (signedIn.error || !signedIn.data.session) {
    throw signedIn.error || new Error("Temporary user could not sign in.")
  }
  return {
    id: created.data.user.id,
    token: signedIn.data.session.access_token,
    client,
  }
}

async function requestDashboard(token) {
  const startedAt = performance.now()
  const response = await fetch(`${baseUrl}/api/admin/dashboard?days=30`, {
    cache: "no-store",
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  })
  const payload = await response.json().catch(() => null)
  return {
    status: response.status,
    elapsedMs: Math.round(performance.now() - startedAt),
    payload,
  }
}

async function controlPlaneVisibility(client) {
  const [customers, businesses, licenses, devices, releases, audits] = await Promise.all([
    client.from("platform_customers").select("id", { count: "exact", head: true }),
    client.from("platform_businesses").select("id", { count: "exact", head: true }),
    client.from("licenses").select("id", { count: "exact", head: true }),
    client.from("registered_devices").select("id", { count: "exact", head: true }),
    client.from("desktop_releases").select("id", { count: "exact", head: true }),
    client.from("admin_audit_logs").select("id", { count: "exact", head: true }),
  ])
  const summarize = (result) => ({
    count: result.error ? 0 : result.count || 0,
    access: result.error ? "denied" : "granted",
    code: result.error?.code || null,
  })
  return {
    customers: summarize(customers),
    businesses: summarize(businesses),
    licenses: summarize(licenses),
    devices: summarize(devices),
    releases: summarize(releases),
    audits: summarize(audits),
  }
}

async function cleanup() {
  for (const id of temporaryUsers.reverse()) {
    await service.from("profiles").delete().eq("id", id)
    const removed = await service.auth.admin.deleteUser(id)
    if (removed.error) {
      console.error(JSON.stringify({ cleanup: "failed", userId: id, message: removed.error.message }))
    }
  }
}

try {
  const [normalUser, platformAdmin] = await Promise.all([
    createTemporaryUser("user"),
    createTemporaryUser("platform_admin"),
  ])
  const [anonymous, normal, admin] = await Promise.all([
    requestDashboard(null),
    requestDashboard(normalUser.token),
    requestDashboard(platformAdmin.token),
  ])
  const anonymousClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const [anonymousVisibility, normalVisibility, adminVisibility] = await Promise.all([
    controlPlaneVisibility(anonymousClient),
    controlPlaneVisibility(normalUser.client),
    controlPlaneVisibility(platformAdmin.client),
  ])
  const schemaStatusResult = await service.rpc("admin_control_plane_current_schema_status")
  if (schemaStatusResult.error) throw schemaStatusResult.error

  assert.equal(anonymous.status, 401, "Anonymous admin access must be rejected.")
  assert.equal(normal.status, 403, "Normal-user admin access must be rejected.")
  for (const visibility of [anonymousVisibility, normalVisibility]) {
    assert.ok(
      Object.values(visibility).every((entry) => entry.count === 0),
      "Non-admin users must not see control-plane rows."
    )
  }
  assert.equal(
    adminVisibility.customers.access,
    "granted",
    "Platform admin must have platform-customer read access."
  )
  assert.equal(
    adminVisibility.businesses.access,
    "granted",
    "Platform admin must have platform-business read access."
  )
  assert.ok(adminVisibility.customers.count >= 1, "Platform admin must be able to read platform customers.")
  assert.ok(adminVisibility.businesses.count >= 1, "Platform admin must be able to read platform businesses.")
  assert.ok(
    [200, 500, 503].includes(admin.status),
    `Platform-admin dashboard returned unexpected HTTP ${admin.status}.`
  )

  console.log(
    JSON.stringify(
      {
        baseUrl,
        anonymous: { status: anonymous.status },
        normalUser: { status: normal.status },
        rls: {
          anonymous: anonymousVisibility,
          normalUser: normalVisibility,
          platformAdmin: adminVisibility,
        },
        schemaStatus: schemaStatusResult.data,
        platformAdmin: {
          status: admin.status,
          elapsedMs: admin.elapsedMs,
          ok: admin.payload?.ok ?? admin.payload?.success ?? false,
          code: admin.payload?.code || null,
          message: admin.payload?.message || admin.payload?.error || null,
          requestId: admin.payload?.requestId || null,
          sectionStatuses: admin.payload?.sections
            ? Object.fromEntries(
                Object.entries(admin.payload.sections).map(([name, section]) => [
                  name,
                  section?.status || "unknown",
                ])
              )
            : null,
        },
      },
      null,
      2
    )
  )
} finally {
  await cleanup()
}
