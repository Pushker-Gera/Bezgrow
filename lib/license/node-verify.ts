import "server-only"

import { constants, verify } from "node:crypto"
import { normalizePem, type ParsedLicenseKey } from "@/lib/license/codec"

function encodeUtf8(value: string) {
  return new TextEncoder().encode(value)
}

function publicKeyFor(parsed: ParsedLicenseKey, publicKeyPem?: string | null) {
  return normalizePem(parsed.payload.issuer_public_key || publicKeyPem || "")
}

export function verifyLicenseSignatureNode(parsed: ParsedLicenseKey, publicKeyPem?: string | null) {
  const publicKey = publicKeyFor(parsed, publicKeyPem)
  if (!publicKey) throw new Error("License public key is not configured.")

  const algorithm = String(parsed.payload.signature_algorithm || "rsa-pss-sha256").toLowerCase()
  const data = encodeUtf8(parsed.payloadText)

  if (algorithm === "ed25519") {
    return verify(null, data, publicKey, parsed.signature)
  }

  if (algorithm === "rsa-pss-sha256") {
    return verify(
      "sha256",
      data,
      {
        key: publicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      },
      parsed.signature
    )
  }

  throw new Error(`Unsupported license signature algorithm: ${algorithm}.`)
}
