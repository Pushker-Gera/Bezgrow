import "server-only"

import { createHash, createPublicKey, verify } from "node:crypto"
import { z } from "zod"
import { adminSupabase } from "@/lib/supabase/admin"

const DEVICE_DENIED = "This device is not authorized for Bezgrow Platform Administration."
const MAX_CLOCK_SKEW_SECONDS = 90
const OWNER_DEVICE_ID = "BZG-23D76F50F880422489AF152B"
const OWNER_ADMIN_USER_ID = "58dc79eb-9d86-4f50-9cb1-fea6c5470fd4"
const OWNER_ADMIN_EMAIL = "pushkergera@gmail.com"
const FALLBACK_KEY_ACTION = "platform_admin_device_key_enrolled"
const FALLBACK_KEY_RECOVERY_ACTION = "platform_admin_device_key_recovered"
const FALLBACK_NONCE_ACTION = "platform_admin_request_nonce"

const proofSchema = z.object({
  deviceId: z.string().regex(/^BZG-[A-Z0-9-]{8,92}$/),
  publicKey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.string().regex(/^\d{10,13}$/),
  nonce: z.string().regex(/^[0-9a-f]{48}$/),
})

export type PlatformAdminDeviceContext = {
  registeredDeviceId: string
  deviceId: string
  allowedAdminUserId: string
}

function proofHeaders(request: Request) {
  return proofSchema.safeParse({
    deviceId: request.headers.get("x-bezgrow-device-id") || "",
    publicKey: request.headers.get("x-bezgrow-device-public-key") || "",
    signature: request.headers.get("x-bezgrow-device-signature") || "",
    timestamp: request.headers.get("x-bezgrow-device-timestamp") || "",
    nonce: request.headers.get("x-bezgrow-device-nonce") || "",
  })
}

async function requestBodySha256(request: Request) {
  const bytes = request.method === "GET" || request.method === "HEAD"
    ? new Uint8Array()
    : new Uint8Array(await request.clone().arrayBuffer())
  return createHash("sha256").update(bytes).digest("hex")
}

function rawEd25519PublicKey(hex: string) {
  const prefix = Buffer.from("302a300506032b6570032100", "hex")
  return createPublicKey({
    key: Buffer.concat([prefix, Buffer.from(hex, "hex")]),
    format: "der",
    type: "spki",
  })
}

async function verifyLegacyProductionDevice(
  proof: z.infer<typeof proofSchema>,
  options: { adminUserId?: string; allowPublicKeyEnrollment?: boolean },
) {
  if (
    proof.deviceId !== OWNER_DEVICE_ID ||
    (options.adminUserId && options.adminUserId !== OWNER_ADMIN_USER_ID)
  ) return null

  const [deviceResult, profileResult] = await Promise.all([
    adminSupabase
      .from("registered_devices")
      .select("id,device_id,device_status")
      .eq("device_id", OWNER_DEVICE_ID)
      .maybeSingle(),
    adminSupabase
      .from("profiles")
      .select("id,email,role,is_suspended")
      .eq("id", OWNER_ADMIN_USER_ID)
      .maybeSingle(),
  ])
  const device = deviceResult.data
  const profile = profileResult.data
  if (
    deviceResult.error ||
    profileResult.error ||
    !device ||
    !profile ||
    device.device_status !== "active" ||
    profile.id !== OWNER_ADMIN_USER_ID ||
    String(profile.email || "").toLowerCase() !== OWNER_ADMIN_EMAIL ||
    !["admin", "platform_admin"].includes(String(profile.role || "")) ||
    profile.is_suspended === true
  ) return null

  const readKeyRecords = () => adminSupabase
    .from("admin_audit_logs")
    .select("id,action,admin_user_id,new_values,created_at")
    .in("action", [FALLBACK_KEY_ACTION, FALLBACK_KEY_RECOVERY_ACTION])
    .eq("target_type", "registered_device")
    .eq("target_id", OWNER_DEVICE_ID)
    .eq("result", "success")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(3)

  let keyRecordsResult = await readKeyRecords()
  if (keyRecordsResult.error) return null
  if (keyRecordsResult.data.length === 0 && options.allowPublicKeyEnrollment) {
    const enrollment = await adminSupabase.from("admin_audit_logs").insert({
      admin_user_id: OWNER_ADMIN_USER_ID,
      admin_email: OWNER_ADMIN_EMAIL,
      action: FALLBACK_KEY_ACTION,
      target_type: "registered_device",
      target_id: OWNER_DEVICE_ID,
      new_values: { public_key: proof.publicKey, schema_compatibility: "pre-2026081100" },
      request_id: `platform-admin-key:${OWNER_DEVICE_ID}:${proof.publicKey}`,
      result: "success",
    })
    if (enrollment.error) return null
    keyRecordsResult = await readKeyRecords()
  }
  let keyRecords = keyRecordsResult.data || []
  let enrollments = keyRecords.filter((record) => record.action === FALLBACK_KEY_ACTION)
  let recoveries = keyRecords.filter((record) => record.action === FALLBACK_KEY_RECOVERY_ACTION)
  let activeRecord = recoveries[0] || enrollments[0]
  let activePublicKey = String(
    (activeRecord?.new_values as { public_key?: unknown } | null)?.public_key || "",
  )

  // A first internal/ad-hoc macOS build could enroll an ephemeral Keychain item
  // that the same bundle cannot read after relaunch. Permit exactly one audited
  // recovery to the new permission-restricted installation key. Any subsequent
  // replacement attempt fails closed.
  if (
    enrollments.length === 1 &&
    recoveries.length === 0 &&
    activePublicKey &&
    activePublicKey !== proof.publicKey &&
    options.allowPublicKeyEnrollment
  ) {
    const recovery = await adminSupabase.from("admin_audit_logs").insert({
      admin_user_id: OWNER_ADMIN_USER_ID,
      admin_email: OWNER_ADMIN_EMAIL,
      action: FALLBACK_KEY_RECOVERY_ACTION,
      target_type: "registered_device",
      target_id: OWNER_DEVICE_ID,
      previous_values: { public_key_sha256: createHash("sha256").update(activePublicKey).digest("hex") },
      new_values: { public_key: proof.publicKey, reason: "internal_macos_keychain_code_requirement" },
      request_id: `platform-admin-key-recovery:${OWNER_DEVICE_ID}:${proof.publicKey}`,
      result: "success",
    })
    if (recovery.error) return null
    keyRecordsResult = await readKeyRecords()
    if (keyRecordsResult.error) return null
    keyRecords = keyRecordsResult.data || []
    enrollments = keyRecords.filter((record) => record.action === FALLBACK_KEY_ACTION)
    recoveries = keyRecords.filter((record) => record.action === FALLBACK_KEY_RECOVERY_ACTION)
    activeRecord = recoveries[0] || enrollments[0]
    activePublicKey = String(
      (activeRecord?.new_values as { public_key?: unknown } | null)?.public_key || "",
    )
  }

  // Duplicate enrollment/recovery rows mean a race or attempted replacement.
  // Fail closed until an administrator reviews the append-only audit history.
  if (
    enrollments.length !== 1 ||
    recoveries.length > 1 ||
    activeRecord?.admin_user_id !== OWNER_ADMIN_USER_ID ||
    activePublicKey !== proof.publicKey
  ) return null

  return {
    registeredDeviceId: device.id,
    deviceId: device.device_id,
    allowedAdminUserId: OWNER_ADMIN_USER_ID,
  } satisfies PlatformAdminDeviceContext
}

async function consumeLegacyProductionNonce(
  proof: z.infer<typeof proofSchema>,
  context: PlatformAdminDeviceContext,
  pathAndQuery: string,
  usedAt: Date,
) {
  const requestId = `platform-admin-nonce:${proof.nonce}`
  const existing = await adminSupabase
    .from("admin_audit_logs")
    .select("id")
    .eq("action", FALLBACK_NONCE_ACTION)
    .eq("request_id", requestId)
    .limit(1)
  if (existing.error || existing.data.length !== 0) return false

  const inserted = await adminSupabase.from("admin_audit_logs").insert({
    admin_user_id: context.allowedAdminUserId,
    admin_email: OWNER_ADMIN_EMAIL,
    action: FALLBACK_NONCE_ACTION,
    target_type: "registered_device",
    target_id: context.deviceId,
    new_values: {
      request_path: pathAndQuery,
      expires_at: new Date(usedAt.getTime() + MAX_CLOCK_SKEW_SECONDS * 2_000).toISOString(),
    },
    request_id: requestId,
    result: "success",
  })
  if (inserted.error) return false

  const confirmed = await adminSupabase
    .from("admin_audit_logs")
    .select("id")
    .eq("action", FALLBACK_NONCE_ACTION)
    .eq("request_id", requestId)
    .limit(2)
  return !confirmed.error && confirmed.data.length === 1
}

export async function verifyPlatformAdminDeviceRequest(
  request: Request,
  options: { adminUserId?: string; allowPublicKeyEnrollment?: boolean } = {},
): Promise<
  | { ok: true; context: PlatformAdminDeviceContext }
  | { ok: false; status: number; error: string }
> {
  const parsed = proofHeaders(request)
  if (!parsed.success || request.headers.get("x-bezgrow-desktop-admin") !== "1") {
    return { ok: false, status: 403, error: DEVICE_DENIED }
  }

  const proof = parsed.data
  const timestamp = Number(proof.timestamp)
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, status: 403, error: DEVICE_DENIED }
  }

  const result = await adminSupabase
    .from("registered_devices")
    .select("id,device_id,device_status,platform_admin_allowed,allowed_admin_user_id,platform_admin_public_key,platform_admin_revoked_at")
    .eq("device_id", proof.deviceId)
    .maybeSingle()
  const legacySchema = result.error?.code === "42703"
  const legacyContext = legacySchema
    ? await verifyLegacyProductionDevice(proof, options)
    : null
  const device = result.data
  if (
    legacySchema ? !legacyContext : (
      result.error ||
      !device ||
      device.device_status !== "active" ||
      device.platform_admin_allowed !== true ||
      !device.allowed_admin_user_id ||
      device.platform_admin_revoked_at ||
      (options.adminUserId && device.allowed_admin_user_id !== options.adminUserId)
    )
  ) {
    return { ok: false, status: 403, error: DEVICE_DENIED }
  }

  let registeredPublicKey = legacyContext ? proof.publicKey : String(device?.platform_admin_public_key || "")
  if (!legacyContext && !registeredPublicKey && options.allowPublicKeyEnrollment) {
    const enrollment = await adminSupabase
      .from("registered_devices")
      .update({
        platform_admin_public_key: proof.publicKey,
        platform_admin_last_verified_at: new Date().toISOString(),
      })
      .eq("id", device!.id)
      .is("platform_admin_public_key", null)
      .select("platform_admin_public_key")
      .maybeSingle()
    if (enrollment.error) return { ok: false, status: 403, error: DEVICE_DENIED }
    registeredPublicKey = String(enrollment.data?.platform_admin_public_key || "")
    if (!registeredPublicKey) {
      const reread = await adminSupabase
        .from("registered_devices")
        .select("platform_admin_public_key")
        .eq("id", device!.id)
        .maybeSingle()
      registeredPublicKey = String(reread.data?.platform_admin_public_key || "")
    }
  }
  if (!registeredPublicKey || registeredPublicKey !== proof.publicKey) {
    return { ok: false, status: 403, error: DEVICE_DENIED }
  }

  const url = new URL(request.url)
  const pathAndQuery = `${url.pathname}${url.search}`
  const bodySha256 = await requestBodySha256(request)
  const canonical = [
    "bezgrow-platform-admin-v1",
    request.method.toUpperCase(),
    pathAndQuery,
    bodySha256,
    proof.deviceId,
    proof.timestamp,
    proof.nonce,
  ].join("\n")
  let signatureValid = false
  try {
    signatureValid = verify(
      null,
      Buffer.from(canonical),
      rawEd25519PublicKey(registeredPublicKey),
      Buffer.from(proof.signature, "hex"),
    )
  } catch {
    signatureValid = false
  }
  if (!signatureValid) return { ok: false, status: 403, error: DEVICE_DENIED }

  const usedAt = new Date()
  if (legacyContext) {
    const consumed = await consumeLegacyProductionNonce(proof, legacyContext, pathAndQuery, usedAt)
    if (!consumed) return { ok: false, status: 403, error: DEVICE_DENIED }
    return { ok: true, context: legacyContext }
  }

  const nonceResult = await adminSupabase.from("platform_admin_request_nonces").insert({
    nonce: proof.nonce,
    registered_device_id: device!.id,
    admin_user_id: options.adminUserId || null,
    request_path: pathAndQuery,
    used_at: usedAt.toISOString(),
    expires_at: new Date(usedAt.getTime() + MAX_CLOCK_SKEW_SECONDS * 2_000).toISOString(),
  })
  if (nonceResult.error) return { ok: false, status: 403, error: DEVICE_DENIED }

  // Nonces only need to survive the verification window. Keep replay protection
  // bounded without making successful authorization depend on housekeeping.
  await Promise.allSettled([
    adminSupabase
      .from("platform_admin_request_nonces")
      .delete()
      .lt("expires_at", usedAt.toISOString()),
    adminSupabase
      .from("registered_devices")
      .update({ platform_admin_last_verified_at: usedAt.toISOString() })
      .eq("id", device?.id),
  ])

  return {
    ok: true,
    context: {
      registeredDeviceId: device!.id,
      deviceId: device!.device_id,
      allowedAdminUserId: device!.allowed_admin_user_id,
    },
  }
}

export { DEVICE_DENIED as PLATFORM_ADMIN_DEVICE_DENIED }
