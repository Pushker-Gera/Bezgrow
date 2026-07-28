import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import nextEnv from "@next/env"
import { createClient } from "@supabase/supabase-js"

const { loadEnvConfig } = nextEnv
loadEnvConfig(process.cwd())

if (process.env.BEZGROW_RUN_PRODUCTION_E2E !== "1") {
  throw new Error("Set BEZGROW_RUN_PRODUCTION_E2E=1 to authorize temporary license records.")
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
const baseUrl = (process.env.BEZGROW_E2E_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "")

assert.ok(supabaseUrl && anonKey && serviceRoleKey, "Supabase E2E environment is incomplete.")

const service = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`
const identity = {
  email: `license-e2e-admin-${runId}@example.invalid`,
  password: `LICENSE-E2E-${randomBytes(24).toString("base64url")}`,
}
const createdIds = {
  user: "",
  license: "",
  customer: "",
  business: "",
}

async function retry(label, work) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await work()
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250))
    }
  }
  throw new Error(`${label} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function cleanup() {
  if (createdIds.license) {
    const deviceResult = await service.from("registered_devices").delete().eq("license_id", createdIds.license)
    if (deviceResult.error) throw deviceResult.error
    const now = new Date().toISOString()
    const licenseResult = await service
      .from("licenses")
      .update({
        status: "revoked",
        revoked_at: now,
        internal_notes: "Automated E2E signing validation record; revoked immediately after verification.",
        updated_at: now,
      })
      .eq("id", createdIds.license)
    if (licenseResult.error) throw licenseResult.error
  }
  if (createdIds.business) {
    const result = await service.from("platform_businesses").delete().eq("id", createdIds.business)
    if (result.error) throw result.error
  }
  if (createdIds.customer) {
    const result = await service.from("platform_customers").delete().eq("id", createdIds.customer)
    if (result.error) throw result.error
  }
  if (createdIds.user) {
    const profileResult = await service.from("profiles").delete().eq("id", createdIds.user)
    if (profileResult.error) throw profileResult.error
    await retry("Temporary auth-user cleanup", async () => {
      const result = await service.auth.admin.deleteUser(createdIds.user)
      if (result.error) throw result.error
    })
  }
}

try {
  const created = await service.auth.admin.createUser({
    email: identity.email,
    password: identity.password,
    email_confirm: true,
    user_metadata: { full_name: "LICENSE-E2E-ADMIN" },
  })
  if (created.error || !created.data.user) throw created.error || new Error("Temporary admin was not created.")
  createdIds.user = created.data.user.id

  const profile = await service
    .from("profiles")
    .update({ role: "platform_admin", is_suspended: false, full_name: "LICENSE-E2E-ADMIN" })
    .eq("id", createdIds.user)
    .select("id")
    .single()
  if (profile.error) throw profile.error

  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const signedIn = await client.auth.signInWithPassword(identity)
  if (signedIn.error || !signedIn.data.session) throw signedIn.error || new Error("Temporary admin sign-in failed.")
  const token = signedIn.data.session.access_token

  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  }
  const basePayload = {
    customer_name: "License E2E Customer",
    customer_email: `license-e2e-customer-${runId}@example.invalid`,
    customer_phone: "",
    customer_company: "",
    customer_country: "",
    business_name: "License E2E Business",
    workspace_id: "",
    device_id: `BZG-E2E-${randomUUID().replaceAll("-", "").toUpperCase()}`,
    platform: "windows",
    architecture: "x64",
    app_version: "0.1.6",
    plan_name: "Enterprise",
    issue_date: "2026-07-28",
    expiry_date: "2027-07-28",
    grace_days: 7,
    allowed_features: ["backup", "billing", "customers", "inventory", "products", "reports"],
    maximum_users: 25,
    maximum_businesses: 3,
    maximum_branches: 10,
    internal_notes: "",
    status: "active",
  }

  const invalidResponse = await fetch(`${baseUrl}/api/admin/licenses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...basePayload, workspace_id: "ab" }),
  })
  const invalidPayload = await invalidResponse.json()
  assert.equal(invalidResponse.status, 422)
  assert.equal(invalidPayload.field, "workspace_id")
  assert.equal(invalidPayload.fieldName, "Workspace ID")
  assert.equal(invalidPayload.validationMessage, "Enter at least 3 characters.")
  assert.equal(invalidPayload.error, "Workspace ID: Enter at least 3 characters.")

  const response = await fetch(`${baseUrl}/api/admin/licenses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...basePayload, idempotency_key: randomUUID() }),
  })
  const payload = await response.json()
  assert.equal(response.status, 200, payload.error || "License API did not return HTTP 200.")
  assert.equal(payload.success, true)
  assert.match(payload.license_key, /^BZG-LIC-v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.equal(payload.license.platform, "windows")
  assert.equal(payload.license.architecture, "x64")
  assert.equal(payload.license.plan_name, "Enterprise")
  assert.equal(payload.license.internal_notes, null)
  createdIds.license = payload.license.id
  createdIds.customer = payload.license.platform_customer_id
  createdIds.business = payload.license.platform_business_id

  const verificationResponse = await fetch(`${baseUrl}/api/license/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ license: payload.license_key }),
  })
  const verification = await verificationResponse.json()
  assert.equal(verificationResponse.status, 200, verification.error || "Signed license verification failed.")
  assert.equal(verification.valid, true)

  console.log(
    JSON.stringify({
      liveLicenseGeneration: "ok",
      invalidField: invalidPayload.field,
      platform: payload.license.platform,
      architecture: payload.license.architecture,
      plan: payload.license.plan_name,
      signaturePrefix: String(payload.license_key).split(".")[0],
      verified: verification.valid,
    })
  )
} finally {
  await cleanup()
}
