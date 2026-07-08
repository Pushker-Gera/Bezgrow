import "server-only"

import { constants, createPublicKey, verify } from "node:crypto"
import { normalizeLicenseEnvKey, normalizePem, rawEd25519KeyToBytes, type ParsedLicenseKey } from "@/lib/license/codec"

function encodeUtf8(value: string) {
  return new TextEncoder().encode(value)
}

type Ed25519Jwk = {
  kty: "OKP"
  crv: "Ed25519"
  x: string
}

function publicKeyFor(publicKeyValue?: string | null) {
  return normalizeLicenseEnvKey(publicKeyValue || "")
}

function ed25519PublicKey(publicKeyRaw: string) {
  rawEd25519KeyToBytes(publicKeyRaw, "License public key")
  return createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: publicKeyRaw,
    } satisfies Ed25519Jwk,
    format: "jwk",
  })
}

export function verifyLicenseSignatureNode(parsed: ParsedLicenseKey, publicKeyValue?: string | null) {
  const publicKey = publicKeyFor(publicKeyValue)
  if (!publicKey) throw new Error("License public key is not configured.")

  const algorithm = String(parsed.payload.signature_algorithm || "rsa-pss-sha256").toLowerCase()
  const data = encodeUtf8(parsed.payloadText)

  if (algorithm === "ed25519") {
    return verify(null, data, ed25519PublicKey(publicKey), parsed.signature)
  }

  if (algorithm === "rsa-pss-sha256") {
    return verify(
      "sha256",
      data,
      {
        key: normalizePem(publicKeyValue || ""),
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      },
      parsed.signature
    )
  }

  throw new Error(`Unsupported license signature algorithm: ${algorithm}.`)
}
