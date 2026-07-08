import "server-only"

import { randomUUID, sign } from "node:crypto"
import { canonicalLicenseText, encodeLicenseKey, type LicensePayload } from "@/lib/license/codec"
import {
  ensureLicenseSigningKeyStore,
  getLicenseSigningKeypair,
  LICENSE_PRIVATE_KEY_ENV,
  LICENSE_PUBLIC_KEY_ENV,
} from "@/lib/license/server-key-store"

export function licenseSigningStatus() {
  const { status } = ensureLicenseSigningKeyStore()
  return {
    ...status,
    privateKeyEnv: LICENSE_PRIVATE_KEY_ENV,
    publicKeyEnv: LICENSE_PUBLIC_KEY_ENV,
  }
}

function encodeUtf8(value: string) {
  return new TextEncoder().encode(value)
}

export function hasLicenseSigningKey() {
  return licenseSigningStatus().configured
}

export function createLicenseId() {
  return `lic_${randomUUID()}`
}

export function signLicensePayload(payload: LicensePayload) {
  const keypair = getLicenseSigningKeypair()
  const signedPayload: LicensePayload = {
    ...payload,
    signature_algorithm: keypair.algorithm,
    issuer_key_id: keypair.keyId,
  }

  const payloadText = canonicalLicenseText(signedPayload)
  const signature = sign(null, encodeUtf8(payloadText), keypair.privateKeyPem)

  return {
    license_key: encodeLicenseKey(signedPayload, signature),
    signature: signature.toString("base64url"),
    payload: signedPayload,
  }
}
