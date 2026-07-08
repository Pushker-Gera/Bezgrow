export const LICENSE_KEY_PREFIX = "BZG-LIC-v1"
export const LICENSE_SCHEMA_VERSION = 1
export const ED25519_RAW_KEY_BYTES = 32

export type LicensePayload = {
  schema_version: number
  license_id: string
  customer_id: string
  customer_name: string
  customer_email?: string | null
  business_id: string
  business_name: string
  device_id: string
  plan_name: string
  expiry_date: string
  grace_period_days: number
  allowed_features: string[]
  issued_by_admin: string
  issued_at: string
  signature_algorithm?: "ed25519" | "rsa-pss-sha256" | string | null
  issuer_key_id?: string | null
  issuer_public_key?: string | null
  notes?: string | null
}

export type ParsedLicenseKey = {
  payload: LicensePayload
  payloadText: string
  decodedPayloadText: string
  signature: Uint8Array
  signatureText: string
  licenseKey: string
}

type BufferLike = {
  from(input: string | Uint8Array, encoding?: string): { toString(encoding: string): string }
}

function runtimeBuffer() {
  return (globalThis as unknown as { Buffer?: BufferLike }).Buffer
}

function encodeUtf8(value: string) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value)
  const buffer = runtimeBuffer()
  if (buffer) return new Uint8Array(buffer.from(value, "utf8") as unknown as ArrayBufferLike)
  throw new Error("UTF-8 encoder is not available.")
}

function decodeUtf8(value: Uint8Array) {
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(value)
  const buffer = runtimeBuffer()
  if (buffer) return buffer.from(value).toString("utf8")
  throw new Error("UTF-8 decoder is not available.")
}

export function bytesToBase64Url(bytes: Uint8Array) {
  const buffer = runtimeBuffer()
  const base64 =
    buffer?.from(bytes).toString("base64") ||
    btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

export function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
  const buffer = runtimeBuffer()
  if (buffer) return new Uint8Array(buffer.from(padded, "base64") as unknown as ArrayBufferLike)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export function normalizeLicenseEnvKey(value: string) {
  let normalized = value.trim()
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1)
  }
  return normalized.trim().replace(/\s+/g, "")
}

export function rawEd25519KeyToBytes(value: string, label = "License key") {
  const trimmed = value.trim()
  const normalized = normalizeLicenseEnvKey(value)
  if (!normalized) throw new Error(`${label} is missing.`)
  if (trimmed.includes("-----BEGIN") || trimmed.includes("-----END") || trimmed.includes("\\n")) {
    throw new Error(`${label} has invalid format. Use raw base64url Ed25519 keys, not PEM.`)
  }
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error(`${label} has invalid format. Use unquoted raw base64url Ed25519 key text.`)
  }

  const bytes = base64UrlToBytes(normalized)
  if (bytes.length !== ED25519_RAW_KEY_BYTES) {
    throw new Error(`${label} has invalid format. Expected a ${ED25519_RAW_KEY_BYTES}-byte raw Ed25519 key encoded as base64url.`)
  }
  return bytes
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((output, key) => {
        const next = (value as Record<string, unknown>)[key]
        if (next !== undefined) output[key] = normalizeValue(next)
        return output
      }, {})
  }
  return value
}

export function canonicalLicenseText(payload: LicensePayload) {
  return JSON.stringify(normalizeValue(payload))
}

export function encodeLicenseKey(payload: LicensePayload, signature: Uint8Array) {
  return `${LICENSE_KEY_PREFIX}.${bytesToBase64Url(encodeUtf8(canonicalLicenseText(payload)))}.${bytesToBase64Url(signature)}`
}

export function normalizeLicenseKeyInput(value: string) {
  return value.trim().replace(/\s+/g, "")
}

function assertPayload(value: unknown): LicensePayload {
  if (!value || typeof value !== "object") throw new Error("License payload is missing.")
  const payload = value as Partial<LicensePayload>
  const required: Array<keyof LicensePayload> = [
    "schema_version",
    "license_id",
    "customer_id",
    "customer_name",
    "business_id",
    "business_name",
    "device_id",
    "plan_name",
    "expiry_date",
    "grace_period_days",
    "allowed_features",
    "issued_by_admin",
    "issued_at",
  ]

  for (const key of required) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === "") {
      throw new Error(`License field ${key} is missing.`)
    }
  }

  if (payload.schema_version !== LICENSE_SCHEMA_VERSION) throw new Error("Unsupported license version.")
  if (!Array.isArray(payload.allowed_features)) throw new Error("License features are invalid.")

  return {
    schema_version: LICENSE_SCHEMA_VERSION,
    license_id: String(payload.license_id),
    customer_id: String(payload.customer_id),
    customer_name: String(payload.customer_name),
    customer_email: payload.customer_email ? String(payload.customer_email) : null,
    business_id: String(payload.business_id),
    business_name: String(payload.business_name),
    device_id: String(payload.device_id),
    plan_name: String(payload.plan_name),
    expiry_date: String(payload.expiry_date).slice(0, 10),
    grace_period_days: Math.max(0, Number(payload.grace_period_days || 0)),
    allowed_features: payload.allowed_features.map(String).filter(Boolean).sort(),
    issued_by_admin: String(payload.issued_by_admin),
    issued_at: String(payload.issued_at),
    signature_algorithm: payload.signature_algorithm ? String(payload.signature_algorithm) : undefined,
    issuer_key_id: payload.issuer_key_id ? String(payload.issuer_key_id) : undefined,
    issuer_public_key: payload.issuer_public_key ? String(payload.issuer_public_key) : undefined,
    notes: payload.notes ? String(payload.notes) : null,
  }
}

export function parseLicenseInput(input: unknown): ParsedLicenseKey {
  const raw = typeof input === "string" ? normalizeLicenseKeyInput(input) : input
  if (!raw) throw new Error("License key is required.")

  if (typeof raw === "object") {
    const container = raw as { license_key?: unknown; licenseKey?: unknown }
    return parseLicenseInput(container.license_key || container.licenseKey)
  }

  if (typeof raw !== "string") throw new Error("License key is invalid.")

  const parts = raw.split(".")
  if (parts.length !== 3 || parts[0] !== LICENSE_KEY_PREFIX) throw new Error("License key format is invalid.")

  const decodedPayloadText = decodeUtf8(base64UrlToBytes(parts[1]))
  const payload = assertPayload(JSON.parse(decodedPayloadText))
  const payloadText = canonicalLicenseText(payload)

  return {
    payload,
    payloadText,
    decodedPayloadText,
    signature: base64UrlToBytes(parts[2]),
    signatureText: parts[2],
    licenseKey: raw,
  }
}

export function normalizePem(value: string) {
  return value.replace(/\\n/g, "\n").trim()
}

function pemBody(pem: string) {
  return normalizePem(pem)
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "")
}

export function pemToBytes(pem: string) {
  return base64UrlToBytes(pemBody(pem).replace(/\+/g, "-").replace(/\//g, "_"))
}

function arrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return copy.buffer
}

function licensePublicKey(publicKeyValue?: string | null) {
  return normalizeLicenseEnvKey(publicKeyValue || "")
}

async function verifyEd25519(parsed: ParsedLicenseKey, publicKeyRaw: string) {
  if (typeof crypto === "undefined" || !crypto.subtle) throw new Error("License verification is not available in this runtime.")

  const publicKey = await crypto.subtle.importKey(
    "raw",
    arrayBuffer(rawEd25519KeyToBytes(publicKeyRaw, "License public key")),
    { name: "Ed25519" },
    false,
    ["verify"]
  )

  return crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    arrayBuffer(parsed.signature),
    arrayBuffer(encodeUtf8(parsed.payloadText))
  )
}

async function verifyRsaPssSha256(parsed: ParsedLicenseKey, publicKeyPem: string) {
  if (typeof crypto === "undefined" || !crypto.subtle) throw new Error("License verification is not available in this runtime.")

  const publicKey = await crypto.subtle.importKey(
    "spki",
    arrayBuffer(pemToBytes(publicKeyPem)),
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["verify"]
  )

  return crypto.subtle.verify(
    { name: "RSA-PSS", saltLength: 32 },
    publicKey,
    arrayBuffer(parsed.signature),
    arrayBuffer(encodeUtf8(parsed.payloadText))
  )
}

export async function verifyLicenseSignature(parsed: ParsedLicenseKey, publicKeyPem?: string | null) {
  const publicKey = licensePublicKey(publicKeyPem)
  if (!publicKey) throw new Error("License public key is not configured.")

  const algorithm = String(parsed.payload.signature_algorithm || "rsa-pss-sha256").toLowerCase()
  if (algorithm === "ed25519") return verifyEd25519(parsed, publicKey)
  if (algorithm === "rsa-pss-sha256") return verifyRsaPssSha256(parsed, normalizePem(publicKeyPem || ""))
  throw new Error(`Unsupported license signature algorithm: ${algorithm}.`)
}
