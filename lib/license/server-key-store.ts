import "server-only"

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto"
import { normalizePem } from "@/lib/license/codec"

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
  canRegenerate: boolean
  message: string
  setupInstructions: string[]
  source?: string
  warning?: string
}

export type LicenseSigningKeypair = {
  algorithm: typeof LICENSE_SIGNING_ALGORITHM
  keyId: string
  publicKeyPem: string
  privateKeyPem: string
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("base64url")
}

function keyId(publicKeyPem: string) {
  return `ed25519_${sha256(normalizePem(publicKeyPem)).slice(0, 20)}`
}

function publicKeyFromPrivate(privateKeyPem: string) {
  return normalizePem(
    createPublicKey(createPrivateKey(privateKeyPem)).export({
      type: "spki",
      format: "pem",
    }) as string
  )
}

function setupInstructions() {
  return [
    "Run npm run generate-license-keys.",
    `Set ${LICENSE_PRIVATE_KEY_ENV} in the server environment.`,
    `Set ${LICENSE_PUBLIC_KEY_ENV} in the app/client environment and rebuild the desktop/web app.`,
  ]
}

function statusBase(): Omit<LicenseKeyStoreStatus, "configured" | "privateKeyConfigured" | "publicKeyConfigured" | "keyId" | "integrity" | "message" | "setupInstructions"> {
  return {
    production: process.env.NODE_ENV === "production",
    algorithm: LICENSE_SIGNING_ALGORITHM,
    keyStorePath: "",
    canRegenerate: false,
    source: "environment",
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
    message,
    setupInstructions: setupInstructions(),
  }
}

function invalidStatus(privateKeyConfigured: boolean, publicKeyConfigured: boolean, message: string): LicenseKeyStoreStatus {
  return {
    ...statusBase(),
    configured: false,
    privateKeyConfigured,
    publicKeyConfigured,
    keyId: null,
    integrity: "corrupted",
    message,
    setupInstructions: setupInstructions(),
  }
}

function readEnvKeypair(): { keypair: LicenseSigningKeypair; publicKeyConfigured: boolean } | { error: LicenseKeyStoreStatus } {
  const privateKeyPem = normalizePem(process.env[LICENSE_PRIVATE_KEY_ENV] || "")
  const configuredPublicKeyPem = normalizePem(process.env[LICENSE_PUBLIC_KEY_ENV] || "")
  const privateKeyConfigured = Boolean(privateKeyPem)
  const publicKeyConfigured = Boolean(configuredPublicKeyPem)

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

  try {
    const privateKey = createPrivateKey(privateKeyPem)
    if (privateKey.asymmetricKeyType !== LICENSE_SIGNING_ALGORITHM) {
      return {
        error: invalidStatus(privateKeyConfigured, publicKeyConfigured, `${LICENSE_PRIVATE_KEY_ENV} must be an Ed25519 private key.`),
      }
    }

    const derivedPublicKeyPem = publicKeyFromPrivate(privateKeyPem)
    const publicKey = createPublicKey(configuredPublicKeyPem)
    if (publicKey.asymmetricKeyType !== LICENSE_SIGNING_ALGORITHM) {
      return {
        error: invalidStatus(privateKeyConfigured, publicKeyConfigured, `${LICENSE_PUBLIC_KEY_ENV} must be an Ed25519 public key.`),
      }
    }
    if (derivedPublicKeyPem !== configuredPublicKeyPem) {
      return {
        error: invalidStatus(privateKeyConfigured, publicKeyConfigured, "License public key does not match the private signing key."),
      }
    }

    const probe = new TextEncoder().encode(`bezgrow-license-integrity:${keyId(derivedPublicKeyPem)}`)
    const signature = sign(null, probe, privateKeyPem)
    if (!verify(null, probe, configuredPublicKeyPem, signature)) {
      return {
        error: invalidStatus(privateKeyConfigured, publicKeyConfigured, "License signing key self-test failed."),
      }
    }

    return {
      publicKeyConfigured,
      keypair: {
        algorithm: LICENSE_SIGNING_ALGORITHM,
        keyId: keyId(derivedPublicKeyPem),
        publicKeyPem: derivedPublicKeyPem,
        privateKeyPem,
      },
    }
  } catch (error) {
    return {
      error: invalidStatus(
        privateKeyConfigured,
        publicKeyConfigured,
        error instanceof Error ? error.message : "License signing keys could not be validated."
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
