import "server-only"

import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject, verify } from "node:crypto"
import { normalizeLicenseEnvKey, rawEd25519KeyToBytes } from "@/lib/license/codec"

export const LICENSE_SIGNING_ALGORITHM = "ed25519"
export const LICENSE_PRIVATE_KEY_ENV = "BEZGROW_LICENSE_PRIVATE_KEY"
export const LICENSE_PUBLIC_KEY_ENV = "NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY"

export type LicenseKeyStoreStatus = {
  configured: boolean
  privateKeyConfigured: boolean
  publicKeyConfigured: boolean
  production: boolean
  algorithm: typeof LICENSE_SIGNING_ALGORITHM
  keyId: string | null
  keyStorePath: string
  integrity: "ok" | "missing" | "corrupted" | "unavailable"
  issue: "configured" | "missing" | "invalid_format" | "mismatched_pair"
  canRegenerate: boolean
  message: string
  setupInstructions: string[]
  source?: string
  warning?: string
}

export type LicenseSigningKeypair = {
  algorithm: typeof LICENSE_SIGNING_ALGORITHM
  keyId: string
  publicKeyRaw: string
  privateKeyRaw: string
  publicKey: KeyObject
  privateKey: KeyObject
}

type Ed25519Jwk = {
  kty: "OKP"
  crv: "Ed25519"
  x: string
  d?: string
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("base64url")
}

function keyId(publicKeyRaw: string) {
  return `ed25519_${sha256(publicKeyRaw).slice(0, 20)}`
}

function publicKeyObject(publicKeyRaw: string) {
  return createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: publicKeyRaw,
    } satisfies Ed25519Jwk,
    format: "jwk",
  })
}

function privateKeyObject(privateKeyRaw: string, publicKeyRaw: string) {
  return createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: publicKeyRaw,
      d: privateKeyRaw,
    } satisfies Ed25519Jwk,
    format: "jwk",
  })
}

function publicKeyFromPrivate(privateKey: KeyObject) {
  const publicJwk = createPublicKey(privateKey).export({ format: "jwk" }) as Ed25519Jwk
  if (publicJwk.kty !== "OKP" || publicJwk.crv !== "Ed25519" || !publicJwk.x) {
    throw new Error("Derived license public key has invalid format.")
  }
  return publicJwk.x
}

function setupInstructions() {
  return [
    "Run npm run generate-license-keys.",
    `Set ${LICENSE_PRIVATE_KEY_ENV} to the printed raw base64url private key in the server environment.`,
    `Set ${LICENSE_PUBLIC_KEY_ENV} to the printed raw base64url public key in the app/client environment and rebuild the desktop/web app.`,
    "Do not use PEM blocks, quotes, or generated key files.",
  ]
}

function statusBase(): Omit<LicenseKeyStoreStatus, "configured" | "privateKeyConfigured" | "publicKeyConfigured" | "keyId" | "integrity" | "issue" | "message" | "setupInstructions"> {
  return {
    production: process.env.NODE_ENV === "production",
    algorithm: LICENSE_SIGNING_ALGORITHM,
    keyStorePath: "",
    canRegenerate: false,
    source: "environment:raw-ed25519-base64url",
  }
}

function missingStatus(privateKeyConfigured: boolean, publicKeyConfigured: boolean, message: string): LicenseKeyStoreStatus {
  return {
    ...statusBase(),
    configured: false,
    privateKeyConfigured,
    publicKeyConfigured,
    keyId: null,
    integrity: "missing",
    issue: "missing",
    message,
    setupInstructions: setupInstructions(),
  }
}

function invalidFormatStatus(privateKeyConfigured: boolean, publicKeyConfigured: boolean, message: string): LicenseKeyStoreStatus {
  return {
    ...statusBase(),
    configured: false,
    privateKeyConfigured,
    publicKeyConfigured,
    keyId: null,
    integrity: "corrupted",
    issue: "invalid_format",
    message,
    setupInstructions: setupInstructions(),
  }
}

function mismatchedStatus(privateKeyConfigured: boolean, publicKeyConfigured: boolean, message: string): LicenseKeyStoreStatus {
  return {
    ...statusBase(),
    configured: false,
    privateKeyConfigured,
    publicKeyConfigured,
    keyId: null,
    integrity: "corrupted",
    issue: "mismatched_pair",
    message,
    setupInstructions: setupInstructions(),
  }
}

function readEnvKeypair(): { keypair: LicenseSigningKeypair; publicKeyConfigured: boolean } | { error: LicenseKeyStoreStatus } {
  const privateKeyValue = process.env[LICENSE_PRIVATE_KEY_ENV] || ""
  const publicKeyValue = process.env[LICENSE_PUBLIC_KEY_ENV] || ""
  const privateKeyConfigured = Boolean(normalizeLicenseEnvKey(privateKeyValue))
  const publicKeyConfigured = Boolean(normalizeLicenseEnvKey(publicKeyValue))

  if (!privateKeyConfigured || !publicKeyConfigured) {
    return {
      error: missingStatus(
        privateKeyConfigured,
        publicKeyConfigured,
        !privateKeyConfigured && !publicKeyConfigured
          ? "License signing keys are missing."
          : !privateKeyConfigured
            ? `${LICENSE_PRIVATE_KEY_ENV} is missing.`
            : `${LICENSE_PUBLIC_KEY_ENV} is missing.`
      ),
    }
  }

  let privateKeyRaw = ""
  let publicKeyRaw = ""
  let publicKey: KeyObject
  let privateKey: KeyObject

  try {
    rawEd25519KeyToBytes(privateKeyValue, LICENSE_PRIVATE_KEY_ENV)
    rawEd25519KeyToBytes(publicKeyValue, LICENSE_PUBLIC_KEY_ENV)
    privateKeyRaw = normalizeLicenseEnvKey(privateKeyValue)
    publicKeyRaw = normalizeLicenseEnvKey(publicKeyValue)
    publicKey = publicKeyObject(publicKeyRaw)
  } catch (error) {
    return {
      error: invalidFormatStatus(
        privateKeyConfigured,
        publicKeyConfigured,
        error instanceof Error ? error.message : "License key format is invalid."
      ),
    }
  }

  try {
    privateKey = privateKeyObject(privateKeyRaw, publicKeyRaw)
    if (privateKey.asymmetricKeyType !== LICENSE_SIGNING_ALGORITHM || publicKey.asymmetricKeyType !== LICENSE_SIGNING_ALGORITHM) {
      return {
        error: invalidFormatStatus(privateKeyConfigured, publicKeyConfigured, "License keys must be raw Ed25519 keys."),
      }
    }

    const derivedPublicKeyRaw = publicKeyFromPrivate(privateKey)
    if (derivedPublicKeyRaw !== publicKeyRaw) {
      return {
        error: mismatchedStatus(privateKeyConfigured, publicKeyConfigured, "License keys mismatched: public key does not match private key."),
      }
    }

    const probe = new TextEncoder().encode(`bezgrow-license-integrity:${keyId(publicKeyRaw)}`)
    const signature = sign(null, probe, privateKey)
    if (!verify(null, probe, publicKey, signature)) {
      return {
        error: mismatchedStatus(privateKeyConfigured, publicKeyConfigured, "License keys mismatched: signing self-test failed."),
      }
    }

    return {
      publicKeyConfigured,
      keypair: {
        algorithm: LICENSE_SIGNING_ALGORITHM,
        keyId: keyId(publicKeyRaw),
        publicKeyRaw,
        privateKeyRaw,
        publicKey,
        privateKey,
      },
    }
  } catch (error) {
    return {
      error: mismatchedStatus(
        privateKeyConfigured,
        publicKeyConfigured,
        error instanceof Error ? `License keys mismatched: ${error.message}` : "License keys mismatched."
      ),
    }
  }
}

export function ensureLicenseSigningKeyStore() {
  const result = readEnvKeypair()
  if ("error" in result) return { status: result.error, record: null }

  return {
    status: {
      ...statusBase(),
      configured: true,
      privateKeyConfigured: true,
      publicKeyConfigured: result.publicKeyConfigured,
      keyId: result.keypair.keyId,
      integrity: "ok" as const,
      issue: "configured" as const,
      message: "Licensing configured.",
      setupInstructions: [],
    },
    record: result.keypair,
  }
}

export function getLicenseSigningKeypair(): LicenseSigningKeypair {
  const { status, record } = ensureLicenseSigningKeyStore()
  if (!status.configured || !record) throw new Error(status.message)
  return record
}
