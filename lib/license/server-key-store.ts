import "server-only"

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto"
import { normalizePem } from "@/lib/license/codec"

export const LICENSE_KEYSTORE_PATH_ENV = "BEZGROW_LICENSE_KEYSTORE_PATH"
export const LICENSE_KEYSTORE_DIR_ENV = "BEZGROW_LICENSE_KEYSTORE_DIR"
export const LICENSE_SIGNING_ALGORITHM = "ed25519"

type LicenseKeyStoreFile = {
  version: number
  algorithm: typeof LICENSE_SIGNING_ALGORITHM
  key_id: string
  public_key_pem: string
  private_key_pem: string
  created_at: string
  updated_at: string
  source: "generated" | "migrated_env" | "regenerated"
  integrity_hash: string
}

export type LicenseKeyStoreStatus = {
  configured: boolean
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

function nowIso() {
  return new Date().toISOString()
}

function keyStorePath() {
  const configuredPath = process.env[LICENSE_KEYSTORE_PATH_ENV]?.trim()
  if (configuredPath) return path.resolve(configuredPath)

  const configuredDir = process.env[LICENSE_KEYSTORE_DIR_ENV]?.trim()
  const dir = configuredDir ? path.resolve(configuredDir) : path.join(process.cwd(), ".bezgrow")
  return path.join(dir, "license-signing-key.json")
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("base64url")
}

function keyId(publicKeyPem: string) {
  return `ed25519_${sha256(normalizePem(publicKeyPem)).slice(0, 20)}`
}

function integrityHash(record: Omit<LicenseKeyStoreFile, "integrity_hash" | "updated_at">) {
  return sha256(
    JSON.stringify({
      version: record.version,
      algorithm: record.algorithm,
      key_id: record.key_id,
      public_key_pem: normalizePem(record.public_key_pem),
      private_key_pem: normalizePem(record.private_key_pem),
      created_at: record.created_at,
      source: record.source,
    })
  )
}

function completeRecord(input: Omit<LicenseKeyStoreFile, "integrity_hash">): LicenseKeyStoreFile {
  const record = {
    ...input,
    public_key_pem: normalizePem(input.public_key_pem),
    private_key_pem: normalizePem(input.private_key_pem),
  }
  return { ...record, integrity_hash: integrityHash(record) }
}

function secureDirectory(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") {
    try {
      chmodSync(dir, 0o700)
    } catch {
      // Existing system-managed directories such as /tmp may not allow chmod.
    }
  }
}

function secureFile(filePath: string) {
  if (process.platform !== "win32") chmodSync(filePath, 0o600)
}

function writeRecord(filePath: string, record: LicenseKeyStoreFile, flag: "wx" | "w" = "wx") {
  secureDirectory(path.dirname(filePath))
  writeFileSync(/* turbopackIgnore: true */ filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag })
  secureFile(filePath)
}

function publicKeyFromPrivate(privateKeyPem: string) {
  return normalizePem(
    createPublicKey(createPrivateKey(privateKeyPem)).export({
      type: "spki",
      format: "pem",
    }) as string
  )
}

function validateRecord(value: unknown, filePath: string): { ok: true; record: LicenseKeyStoreFile; warning?: string } | { ok: false; reason: string } {
  if (!value || typeof value !== "object") return { ok: false, reason: "License key store is not valid JSON." }
  const raw = value as Partial<LicenseKeyStoreFile>
  const publicKeyPem = normalizePem(String(raw.public_key_pem || ""))
  const privateKeyPem = normalizePem(String(raw.private_key_pem || ""))
  const createdAt = String(raw.created_at || "")
  const updatedAt = String(raw.updated_at || createdAt || "")
  const source = raw.source === "migrated_env" || raw.source === "regenerated" ? raw.source : "generated"

  if (raw.version !== 1) return { ok: false, reason: "License key store version is unsupported." }
  if (raw.algorithm !== LICENSE_SIGNING_ALGORITHM) return { ok: false, reason: "License key store algorithm is unsupported." }
  if (!publicKeyPem || !privateKeyPem) return { ok: false, reason: "License signing key material is incomplete." }
  if (!createdAt || !updatedAt) return { ok: false, reason: "License key store timestamps are missing." }

  try {
    const privateKey = createPrivateKey(privateKeyPem)
    const publicKey = createPublicKey(publicKeyPem)
    if (privateKey.asymmetricKeyType !== LICENSE_SIGNING_ALGORITHM || publicKey.asymmetricKeyType !== LICENSE_SIGNING_ALGORITHM) {
      return { ok: false, reason: "License signing keys are not Ed25519 keys." }
    }

    const derivedPublicKey = publicKeyFromPrivate(privateKeyPem)
    if (derivedPublicKey !== publicKeyPem) return { ok: false, reason: "License public key does not match the private key." }

    const expectedKeyId = keyId(publicKeyPem)
    if (raw.key_id !== expectedKeyId) return { ok: false, reason: "License key fingerprint does not match the public key." }

    const record = completeRecord({
      version: 1,
      algorithm: LICENSE_SIGNING_ALGORITHM,
      key_id: expectedKeyId,
      public_key_pem: publicKeyPem,
      private_key_pem: privateKeyPem,
      created_at: createdAt,
      updated_at: updatedAt,
      source,
    })
    if (raw.integrity_hash !== record.integrity_hash) return { ok: false, reason: "License key store integrity check failed." }

    const probe = new TextEncoder().encode(`bezgrow-license-integrity:${expectedKeyId}`)
    const signature = sign(null, probe, privateKeyPem)
    if (!verify(null, probe, publicKeyPem, signature)) return { ok: false, reason: "License signing key self-test failed." }

    let warning: string | undefined
    if (process.platform !== "win32") {
      const mode = statSync(/* turbopackIgnore: true */ filePath).mode & 0o777
      if ((mode & 0o077) !== 0) warning = "License key store permissions were wider than expected and have been tightened."
    }

    return { ok: true, record, warning }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "License signing key validation failed." }
  }
}

function generateRecord(source: LicenseKeyStoreFile["source"] = "generated") {
  const { publicKey, privateKey } = generateKeyPairSync(LICENSE_SIGNING_ALGORITHM, {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  const createdAt = nowIso()
  return completeRecord({
    version: 1,
    algorithm: LICENSE_SIGNING_ALGORITHM,
    key_id: keyId(publicKey),
    public_key_pem: publicKey,
    private_key_pem: privateKey,
    created_at: createdAt,
    updated_at: createdAt,
    source,
  })
}

function migratedEnvRecord() {
  const privateKeyPem = normalizePem(process.env.BEZGROW_LICENSE_PRIVATE_KEY || "")
  if (!privateKeyPem) return null

  try {
    const privateKey = createPrivateKey(privateKeyPem)
    if (privateKey.asymmetricKeyType !== LICENSE_SIGNING_ALGORITHM) return null
    const publicKeyPem = normalizePem(process.env.NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY || publicKeyFromPrivate(privateKeyPem))
    if (!publicKeyPem || publicKeyFromPrivate(privateKeyPem) !== publicKeyPem) return null
    const createdAt = nowIso()
    return completeRecord({
      version: 1,
      algorithm: LICENSE_SIGNING_ALGORITHM,
      key_id: keyId(publicKeyPem),
      public_key_pem: publicKeyPem,
      private_key_pem: privateKeyPem,
      created_at: createdAt,
      updated_at: createdAt,
      source: "migrated_env",
    })
  } catch {
    return null
  }
}

function statusFromRecord(record: LicenseKeyStoreFile, warning?: string): LicenseKeyStoreStatus {
  return {
    configured: true,
    publicKeyConfigured: true,
    production: process.env.NODE_ENV === "production",
    algorithm: LICENSE_SIGNING_ALGORITHM,
    keyId: record.key_id,
    keyStorePath: keyStorePath(),
    integrity: "ok",
    canRegenerate: false,
    message: "Licensing configured.",
    setupInstructions: [],
    source: record.source,
    warning,
  }
}

function unavailableStatus(message: string, integrity: LicenseKeyStoreStatus["integrity"] = "unavailable"): LicenseKeyStoreStatus {
  return {
    configured: false,
    publicKeyConfigured: false,
    production: process.env.NODE_ENV === "production",
    algorithm: LICENSE_SIGNING_ALGORITHM,
    keyId: null,
    keyStorePath: keyStorePath(),
    integrity,
    canRegenerate: integrity === "corrupted",
    message,
    setupInstructions:
      integrity === "corrupted"
        ? ["Use Regenerate Signing Keys from admin settings after confirming no valid backup exists."]
        : ["Check server write permissions for the Bezgrow license key store path, then reload admin settings."],
  }
}

function readExistingRecord(filePath: string) {
  try {
    const parsed = JSON.parse(readFileSync(/* turbopackIgnore: true */ filePath, "utf8")) as unknown
    const validated = validateRecord(parsed, filePath)
    if (validated.ok) {
      secureFile(filePath)
      return { status: statusFromRecord(validated.record, validated.warning), record: validated.record }
    }
    return { status: unavailableStatus(validated.reason, "corrupted"), record: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : "License key store could not be read."
    return { status: unavailableStatus(message, "corrupted"), record: null }
  }
}

export function ensureLicenseSigningKeyStore() {
  const filePath = keyStorePath()
  if (existsSync(/* turbopackIgnore: true */ filePath)) return readExistingRecord(filePath)

  try {
    const record = migratedEnvRecord() || generateRecord("generated")
    writeRecord(filePath, record, "wx")
    return { status: statusFromRecord(record), record }
  } catch (error) {
    if (existsSync(/* turbopackIgnore: true */ filePath)) return readExistingRecord(filePath)
    const message = error instanceof Error ? error.message : "License signing keys could not be initialized."
    return { status: unavailableStatus(message), record: null }
  }
}

export function getLicenseSigningKeypair(): LicenseSigningKeypair {
  const { status, record } = ensureLicenseSigningKeyStore()
  if (!status.configured || !record) throw new Error(status.message)

  return {
    algorithm: record.algorithm,
    keyId: record.key_id,
    publicKeyPem: record.public_key_pem,
    privateKeyPem: record.private_key_pem,
  }
}

export function regenerateLicenseSigningKeyStore() {
  const filePath = keyStorePath()
  if (existsSync(/* turbopackIgnore: true */ filePath)) {
    const current = readExistingRecord(filePath)
    if (current.status.integrity === "ok") {
      return { status: current.status, record: current.record, regenerated: false, reason: "Healthy license signing keys are never regenerated automatically." }
    }

    const backupPath = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`
    renameSync(/* turbopackIgnore: true */ filePath, /* turbopackIgnore: true */ backupPath)
  }

  const record = generateRecord("regenerated")
  writeRecord(filePath, record, "wx")
  return { status: statusFromRecord(record), record, regenerated: true, reason: "Corrupted license signing keys were regenerated." }
}
