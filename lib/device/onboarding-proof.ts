import "server-only"

import { createHash, createPublicKey, verify } from "node:crypto"
import { z } from "zod"
import { adminSupabase } from "@/lib/supabase/admin"

const MAX_CLOCK_SKEW_SECONDS = 90
const ONBOARDING_PATH = "/api/entitlements/onboard"

const proofSchema = z.object({
  deviceId: z.string().regex(/^BZG-[A-Z0-9-]{8,92}$/),
  publicKey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.string().regex(/^\d{10,13}$/),
  nonce: z.string().regex(/^[0-9a-f]{48}$/),
})

function rawEd25519PublicKey(hex: string) {
  const prefix = Buffer.from("302a300506032b6570032100", "hex")
  return createPublicKey({
    key: Buffer.concat([prefix, Buffer.from(hex, "hex")]),
    format: "der",
    type: "spki",
  })
}

export async function verifyOnboardingDeviceProof(request: Request, expectedDeviceId: string) {
  const parsed = proofSchema.safeParse({
    deviceId: request.headers.get("x-bezgrow-device-id") || "",
    publicKey: request.headers.get("x-bezgrow-device-public-key") || "",
    signature: request.headers.get("x-bezgrow-device-signature") || "",
    timestamp: request.headers.get("x-bezgrow-device-timestamp") || "",
    nonce: request.headers.get("x-bezgrow-device-nonce") || "",
  })
  if (!parsed.success || parsed.data.deviceId !== expectedDeviceId) return null

  const proof = parsed.data
  const timestamp = Number(proof.timestamp)
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > MAX_CLOCK_SKEW_SECONDS) return null

  const body = Buffer.from(await request.clone().arrayBuffer())
  const requestDigest = createHash("sha256").update(body).digest("hex")
  const canonical = [
    "bezgrow-platform-admin-v1",
    request.method.toUpperCase(),
    ONBOARDING_PATH,
    requestDigest,
    proof.deviceId,
    proof.timestamp,
    proof.nonce,
  ].join("\n")

  let valid = false
  try {
    valid = verify(
      null,
      Buffer.from(canonical),
      rawEd25519PublicKey(proof.publicKey),
      Buffer.from(proof.signature, "hex"),
    )
  } catch {
    valid = false
  }
  if (!valid) return null

  const usedAt = new Date()
  const nonce = await adminSupabase.from("onboarding_device_nonces").insert({
    nonce: proof.nonce,
    device_id: proof.deviceId,
    public_key: proof.publicKey,
    request_digest: requestDigest,
    used_at: usedAt.toISOString(),
    expires_at: new Date(usedAt.getTime() + MAX_CLOCK_SKEW_SECONDS * 2_000).toISOString(),
  })
  if (nonce.error) return null
  return { deviceId: proof.deviceId, publicKey: proof.publicKey }
}
