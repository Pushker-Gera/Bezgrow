import "server-only"

import { createHash, createPublicKey, verify } from "node:crypto"
import { z } from "zod"
import { adminSupabase } from "@/lib/supabase/admin"

const DEVICE_DENIED = "This device is not authorized for Bezgrow Platform Administration."
const MAX_CLOCK_SKEW_SECONDS = 90

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
  const device = result.data
  if (
    result.error ||
    !device ||
    device.device_status !== "active" ||
    device.platform_admin_allowed !== true ||
    !device.allowed_admin_user_id ||
    device.platform_admin_revoked_at ||
    (options.adminUserId && device.allowed_admin_user_id !== options.adminUserId)
  ) {
    return { ok: false, status: 403, error: DEVICE_DENIED }
  }

  let registeredPublicKey = String(device.platform_admin_public_key || "")
  if (!registeredPublicKey && options.allowPublicKeyEnrollment) {
    const enrollment = await adminSupabase
      .from("registered_devices")
      .update({
        platform_admin_public_key: proof.publicKey,
        platform_admin_last_verified_at: new Date().toISOString(),
      })
      .eq("id", device.id)
      .is("platform_admin_public_key", null)
      .select("platform_admin_public_key")
      .maybeSingle()
    if (enrollment.error) return { ok: false, status: 403, error: DEVICE_DENIED }
    registeredPublicKey = String(enrollment.data?.platform_admin_public_key || "")
    if (!registeredPublicKey) {
      const reread = await adminSupabase
        .from("registered_devices")
        .select("platform_admin_public_key")
        .eq("id", device.id)
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
  const nonceResult = await adminSupabase.from("platform_admin_request_nonces").insert({
    nonce: proof.nonce,
    registered_device_id: device.id,
    admin_user_id: options.adminUserId || null,
    request_path: pathAndQuery,
    used_at: usedAt.toISOString(),
    expires_at: new Date(usedAt.getTime() + MAX_CLOCK_SKEW_SECONDS * 2_000).toISOString(),
  })
  if (nonceResult.error) return { ok: false, status: 403, error: DEVICE_DENIED }

  // Nonces only need to survive the verification window. Keep replay protection
  // bounded without making successful authorization depend on housekeeping.
  await adminSupabase
    .from("platform_admin_request_nonces")
    .delete()
    .lt("expires_at", usedAt.toISOString())

  await adminSupabase
    .from("registered_devices")
    .update({ platform_admin_last_verified_at: usedAt.toISOString() })
    .eq("id", device.id)

  return {
    ok: true,
    context: {
      registeredDeviceId: device.id,
      deviceId: device.device_id,
      allowedAdminUserId: device.allowed_admin_user_id,
    },
  }
}

export { DEVICE_DENIED as PLATFORM_ADMIN_DEVICE_DENIED }
