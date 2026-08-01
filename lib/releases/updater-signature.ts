import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { resolve, sep } from "node:path"

const MAX_UPDATER_BYTES = 2 * 1024 * 1024 * 1024
const ED25519_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

type ParsedSignature = {
  keyId: Buffer
  signature: Buffer
  trustedComment: string
  globalSignature: Buffer
  prehashed: boolean
}

function decodedText(value: string) {
  const trimmed = value.trim()
  if (trimmed.startsWith("untrusted comment:")) return trimmed
  const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim()
  return decoded.startsWith("untrusted comment:") ? decoded : trimmed
}

function parsePublicKey(value: string) {
  const lines = decodedText(value).split(/\r?\n/).filter(Boolean)
  const encoded = lines.find((line) => !line.startsWith("untrusted comment:")) || ""
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.length !== 42 || !["Ed", "ED"].includes(bytes.subarray(0, 2).toString("ascii"))) {
    throw new Error("The configured updater public key is not a valid Minisign Ed25519 key.")
  }
  return { keyId: bytes.subarray(2, 10), key: bytes.subarray(10, 42) }
}

function parseSignature(value: string): ParsedSignature {
  const lines = decodedText(value).split(/\r?\n/).filter(Boolean)
  if (lines.length !== 4 || !lines[0].startsWith("untrusted comment:") || !lines[2].startsWith("trusted comment: ")) {
    throw new Error("The updater signature is not a complete Minisign signature.")
  }
  const primary = Buffer.from(lines[1], "base64")
  const globalSignature = Buffer.from(lines[3], "base64")
  if (primary.length !== 74 || globalSignature.length !== 64) {
    throw new Error("The updater signature has invalid Minisign field lengths.")
  }
  const algorithm = primary.subarray(0, 2).toString("ascii")
  if (algorithm !== "ED" && algorithm !== "Ed") throw new Error("The updater signature algorithm is unsupported.")
  return {
    keyId: primary.subarray(2, 10),
    signature: primary.subarray(10, 74),
    trustedComment: lines[2].slice("trusted comment: ".length),
    globalSignature,
    prehashed: algorithm === "ED",
  }
}

async function streamRemote(url: string, consume: (chunk: Buffer) => void) {
  const { isPublicHttpsUrl } = await import("@/lib/security/public-url")
  let current = new URL(url)
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!(await isPublicHttpsUrl(current))) throw new Error("Updater URL is not an allowed public HTTPS location.")
    const response = await fetch(current, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      headers: { Accept: "application/octet-stream" },
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (!location) throw new Error(`Updater URL returned HTTP ${response.status} without a redirect.`)
      current = new URL(location, current)
      continue
    }
    if (!response.ok) throw new Error(`Updater URL returned HTTP ${response.status}.`)
    const type = (response.headers.get("content-type") || "").toLowerCase()
    if (type.includes("text/html") || type.includes("application/json") || type.startsWith("text/")) {
      throw new Error("Updater URL returned text/HTML instead of updater bytes.")
    }
    if (!response.body) throw new Error("Updater response did not include a body.")
    const reader = response.body.getReader()
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) return size
      const chunk = Buffer.from(value)
      size += chunk.length
      if (size > MAX_UPDATER_BYTES) {
        await reader.cancel()
        throw new Error("Updater exceeds the 2 GB validation limit.")
      }
      consume(chunk)
    }
  }
  throw new Error("Updater URL redirected too many times.")
}

async function streamLocal(url: string, consume: (chunk: Buffer) => void) {
  if (!url.startsWith("/downloads/") || url.includes("..")) throw new Error("Local updater must be inside /downloads.")
  const root = resolve(process.cwd(), "public", "downloads")
  const file = resolve(process.cwd(), "public", `.${url}`)
  if (!file.startsWith(`${root}${sep}`)) throw new Error("Local updater path escapes /downloads.")
  const details = await stat(file)
  if (!details.isFile() || details.size <= 0 || details.size > MAX_UPDATER_BYTES) throw new Error("Local updater size is invalid.")
  for await (const chunk of createReadStream(file)) consume(Buffer.from(chunk))
  return details.size
}

async function streamFile(file: string, consume: (chunk: Buffer) => void) {
  const details = await stat(file)
  if (!details.isFile() || details.size <= 0 || details.size > MAX_UPDATER_BYTES) throw new Error("Updater file size is invalid.")
  for await (const chunk of createReadStream(file)) consume(Buffer.from(chunk))
  return details.size
}

export async function verifyUpdaterArtifact(input: {
  url: string
  sha256?: string | null
  signature?: string | null
  publicKey?: string | null
  localFilePath?: string | null
}) {
  if (!input.signature) throw new Error("Updater signature is missing.")
  if (!input.publicKey) throw new Error("BEZGROW_UPDATER_PUBLIC_KEY is not configured on the release service.")
  const publicKey = parsePublicKey(input.publicKey)
  const signature = parseSignature(input.signature)
  if (!publicKey.keyId.equals(signature.keyId)) throw new Error("Updater signature was created by a different key.")
  if (!signature.prehashed) throw new Error("Legacy non-prehashed updater signatures are not accepted for publication.")

  const sha256 = createHash("sha256")
  const blake2 = createHash("blake2b512")
  const consume = (chunk: Buffer) => { sha256.update(chunk); blake2.update(chunk) }
  const size = input.localFilePath
    ? await streamFile(input.localFilePath, consume)
    : input.url.startsWith("/")
      ? await streamLocal(input.url, consume)
      : await streamRemote(input.url, consume)
  if (size <= 0) throw new Error("Updater artifact is empty.")
  const actualSha256 = sha256.digest("hex")
  if (!input.sha256 || actualSha256 !== input.sha256.toLowerCase()) {
    throw new Error(`Updater SHA-256 mismatch. Expected ${input.sha256 || "a published checksum"}; received ${actualSha256}.`)
  }

  const key = createPublicKey({ key: Buffer.concat([ED25519_DER_PREFIX, publicKey.key]), format: "der", type: "spki" })
  if (!verifyEd25519(null, blake2.digest(), key, signature.signature)) {
    throw new Error("Updater Minisign signature verification failed.")
  }
  const globalPayload = Buffer.concat([signature.signature, Buffer.from(signature.trustedComment)])
  if (!verifyEd25519(null, globalPayload, key, signature.globalSignature)) {
    throw new Error("Updater Minisign trusted-comment signature verification failed.")
  }
  return { size, sha256: actualSha256, signatureValid: true }
}
