import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { chmod, readFile, rm, writeFile } from "node:fs/promises"
import nextEnv from "@next/env"
import { createClient } from "@supabase/supabase-js"

const { loadEnvConfig } = nextEnv
loadEnvConfig(process.cwd())

if (process.env.BEZGROW_RUN_PRODUCTION_E2E !== "1") {
  throw new Error("Set BEZGROW_RUN_PRODUCTION_E2E=1 to authorize a temporary browser-test administrator.")
}

const command = process.argv[2]
const sessionPath = process.env.BEZGROW_BROWSER_SESSION_FILE || "/private/tmp/bezgrow-admin-browser-session.json"
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

assert.ok(supabaseUrl && anonKey && serviceRoleKey, "Supabase E2E environment is incomplete.")

const service = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function retry(label, work) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await work()
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 350))
    }
  }
  throw new Error(`${label} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

if (command === "setup") {
  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const identity = {
    email: `admin-browser-e2e-${runId}@example.invalid`,
    password: `ADMIN-BROWSER-E2E-${randomBytes(24).toString("base64url")}`,
  }
  const created = await retry("Temporary browser admin creation", async () => {
    const result = await service.auth.admin.createUser({
      email: identity.email,
      password: identity.password,
      email_confirm: true,
      user_metadata: { full_name: "ADMIN-BROWSER-E2E" },
    })
    if (result.error || !result.data.user) throw result.error || new Error("Temporary browser admin was not created.")
    return result.data.user
  })
  const profile = await service
    .from("profiles")
    .update({ role: "platform_admin", is_suspended: false, full_name: "ADMIN-BROWSER-E2E" })
    .eq("id", created.id)
    .select("id")
    .single()
  if (profile.error) {
    await service.auth.admin.deleteUser(created.id)
    throw profile.error
  }
  await writeFile(sessionPath, JSON.stringify({ ...identity, userId: created.id }), { mode: 0o600 })
  await chmod(sessionPath, 0o600)
  console.log(`temporary-admin-session-ready path=${sessionPath}`)
} else if (command === "cleanup") {
  const session = JSON.parse(await readFile(sessionPath, "utf8"))
  await service.from("admin_audit_logs").delete().eq("admin_user_id", session.userId)
  await service.from("profiles").delete().eq("id", session.userId)
  await retry("Temporary browser admin cleanup", async () => {
    const result = await service.auth.admin.deleteUser(session.userId)
    if (result.error) throw result.error
  })
  await rm(sessionPath, { force: true })
  console.log("temporary-admin-session-cleanup-ok")
} else {
  throw new Error("Use setup or cleanup.")
}
