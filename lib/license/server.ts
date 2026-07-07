import "server-only"

import { constants, randomUUID, sign } from "node:crypto"
import { canonicalLicenseText, encodeLicenseKey, normalizePem, type LicensePayload } from "@/lib/license/codec"

function privateKeyFromEnv() {
  return normalizePem(process.env.BEZGROW_LICENSE_PRIVATE_KEY || "")
}

function encodeUtf8(value: string) {
  return new TextEncoder().encode(value)
}

export function hasLicenseSigningKey() {
  return Boolean(privateKeyFromEnv())
}

export function createLicenseId() {
  return `lic_${randomUUID()}`
}

export function signLicensePayload(payload: LicensePayload) {
  const privateKey = privateKeyFromEnv()
  if (!privateKey) {
    throw new Error("BEZGROW_LICENSE_PRIVATE_KEY is not configured.")
  }

  const payloadText = canonicalLicenseText(payload)
  const signature = sign("sha256", encodeUtf8(payloadText), {
    key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  })

  return {
    license_key: encodeLicenseKey(payload, signature),
    signature: signature.toString("base64url"),
    payload,
  }
}
