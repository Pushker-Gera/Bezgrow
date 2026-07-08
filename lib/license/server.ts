import "server-only"

import { constants, randomUUID, sign } from "node:crypto"
import { canonicalLicenseText, encodeLicenseKey, normalizePem, type LicensePayload } from "@/lib/license/codec"

export const LICENSE_PRIVATE_KEY_ENV = "BEZGROW_LICENSE_PRIVATE_KEY"
export const LICENSE_PUBLIC_KEY_ENV = "NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY"

function privateKeyFromEnv() {
  return normalizePem(process.env[LICENSE_PRIVATE_KEY_ENV] || "")
}

function publicKeyFromEnv() {
  return normalizePem(process.env[LICENSE_PUBLIC_KEY_ENV] || "")
}

export function licenseSigningStatus() {
  const privateConfigured = Boolean(privateKeyFromEnv())
  const publicConfigured = Boolean(publicKeyFromEnv())
  const production = process.env.NODE_ENV === "production"
  const setupInstructions = [
    "Run `npm run license:keys`.",
    `Set ${LICENSE_PRIVATE_KEY_ENV} on the admin/server environment only.`,
    `Set ${LICENSE_PUBLIC_KEY_ENV} in the app/client build environment.`,
    "Restart the server or rebuild the desktop app after changing license keys.",
  ]

  return {
    configured: privateConfigured,
    publicKeyConfigured: publicConfigured,
    production,
    privateKeyEnv: LICENSE_PRIVATE_KEY_ENV,
    publicKeyEnv: LICENSE_PUBLIC_KEY_ENV,
    message: privateConfigured
      ? "License signing configured."
      : production
        ? `License signing key is not configured on this admin server. Set ${LICENSE_PRIVATE_KEY_ENV}.`
        : `License signing key is missing. ${setupInstructions.join(" ")}`,
    setupInstructions,
  }
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
    throw new Error(`${LICENSE_PRIVATE_KEY_ENV} is not configured.`)
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
