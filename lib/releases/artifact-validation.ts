import "server-only"

import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { open, stat } from "node:fs/promises"
import { basename, extname, resolve, sep } from "node:path"
import { isPublicHttpsUrl } from "@/lib/security/public-url"

export type InstallerPlatform = "macos" | "windows"
export type InstallerArchitecture = "arm64" | "x64" | "x86_64"

export type InstallerCandidate = {
  platform: InstallerPlatform
  architecture?: InstallerArchitecture | null
  version?: string | null
  downloadUrl?: string | null
  file?: string | null
  filename?: string | null
  size?: number | null
  sha256?: string | null
  signed?: boolean | null
  notarized?: boolean | null
  generatedAt?: string | null
  buildCommit?: string | null
  buildTimestamp?: string | null
  releaseChannel?: string | null
  releaseNotes?: string | null
  buildNumber?: string | null
  mandatory?: boolean
  minimumSupportedVersion?: string | null
}

export type ValidatedInstaller = {
  version: string | null
  platform: InstallerPlatform
  architecture: InstallerArchitecture | null
  downloadUrl: string | null
  filename: string | null
  contentType: string | null
  size: number | null
  sha256: string | null
  available: boolean
  signed: boolean
  notarized: boolean
  checksumVerified: boolean
  metadataValid: boolean
  productionRecommended: boolean
  warning: string | null
  blockedReason: string | null
  releaseChannel: string
  generatedAt: string | null
  buildCommit: string | null
  buildTimestamp: string | null
  releaseNotes: string | null
  buildNumber: string | null
  mandatory: boolean
  minimumSupportedVersion: string | null
}

type ArtifactBytes = {
  size: number
  sha256: string
  firstBytes: Buffer
  trailingBytes: Buffer
  filename: string
  contentType: string
  finalUrl?: string
}

type ValidationOptions = {
  cache?: boolean
}

type PeArchitecture = InstallerArchitecture | "x86"

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
const HEADER_BYTES = 4096
const LOCAL_CACHE_MS = 30_000
const REMOTE_CACHE_MS = 5 * 60_000
const validationCache = new Map<string, { expiresAt: number; result: Promise<ValidatedInstaller> }>()

const contentTypes: Record<string, string> = {
  ".dmg": "application/x-apple-diskimage",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".msi": "application/x-msi",
  ".msix": "application/msix",
}

function semverLike(value: string | null | undefined) {
  return Boolean(value && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value))
}

function sha256Like(value: string | null | undefined) {
  return Boolean(value && /^[a-fA-F0-9]{64}$/.test(value))
}

function commitLike(value: string | null | undefined) {
  return Boolean(value && /^[a-fA-F0-9]{40}$/.test(value))
}

function timestampLike(value: string | null | undefined) {
  return Boolean(value && !Number.isNaN(Date.parse(value)))
}

function candidateHref(candidate: InstallerCandidate) {
  return candidate.downloadUrl || candidate.file || null
}

function inferredArchitecture(filename: string) {
  const lower = filename.toLowerCase()
  if (/(?:^|[-_.])(arm64|aarch64)(?:[-_.]|$)/.test(lower)) return "arm64" as const
  if (/(?:^|[-_.])(x64|x86_64|amd64)(?:[-_.]|$)/.test(lower)) return "x64" as const
  return null
}

function comparableArchitecture(architecture: InstallerArchitecture | PeArchitecture | null) {
  return architecture === "x86_64" ? "x64" : architecture
}

function inferredVersion(filename: string) {
  return filename.match(/(?:^|[-_.])v?(\d+\.\d+\.\d+)(?=[-_.]|$)/i)?.[1] || null
}

function installerExtension(platform: InstallerPlatform, filename: string) {
  const extension = extname(filename).toLowerCase()
  if (platform === "macos") return extension === ".dmg" ? extension : null
  return [".exe", ".msi", ".msix"].includes(extension) ? extension : null
}

function looksLikeHtmlOrText(bytes: Buffer) {
  const prefix = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase()
  return (
    prefix.startsWith("<!doctype html") ||
    prefix.startsWith("<html") ||
    prefix.startsWith("<?xml") ||
    prefix.startsWith("{") ||
    prefix.startsWith("[")
  )
}

function magicMatches(extension: string, firstBytes: Buffer, trailingBytes: Buffer) {
  if (extension === ".dmg") return trailingBytes.includes(Buffer.from("koly"))
  if (extension === ".exe") return peArchitecture(firstBytes) !== null
  if (extension === ".msi") {
    return firstBytes
      .subarray(0, 8)
      .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  }
  if (extension === ".msix") return firstBytes.subarray(0, 2).toString("ascii") === "PK"
  return false
}

function peArchitecture(bytes: Buffer): PeArchitecture | null {
  if (bytes.length < 64 || bytes.subarray(0, 2).toString("ascii") !== "MZ") return null
  const peOffset = bytes.readUInt32LE(0x3c)
  if (
    peOffset < 64 ||
    peOffset + 6 > bytes.length ||
    !bytes.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))
  ) {
    return null
  }
  const machine = bytes.readUInt16LE(peOffset + 4)
  if (machine === 0x14c) return "x86"
  if (machine === 0x8664) return "x64"
  if (machine === 0xaa64) return "arm64"
  return null
}

function is32BitInstallerBootstrap(filename: string, architecture: PeArchitecture | null) {
  const lower = filename.toLowerCase()
  return architecture === "x86" && (lower.includes("-setup") || lower.includes("portable"))
}

function minimumArtifactBytes(extension: string) {
  return extension === ".dmg" ? 5 * 1024 * 1024 : 1024 * 1024
}

function contentDispositionFilename(value: string | null) {
  if (!value) return ""
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const plain = value.match(/filename="?([^";]+)"?/i)?.[1]
  const raw = encoded || plain || ""
  try {
    return basename(decodeURIComponent(raw.trim()))
  } catch {
    return basename(raw.trim())
  }
}

async function hashLocalFile(filePath: string, size: number) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)

  const handle = await open(filePath, "r")
  try {
    const firstBytes = Buffer.alloc(Math.min(HEADER_BYTES, size))
    const trailingBytes = Buffer.alloc(Math.min(512, size))
    await handle.read(firstBytes, 0, firstBytes.length, 0)
    await handle.read(trailingBytes, 0, trailingBytes.length, Math.max(0, size - trailingBytes.length))
    return { sha256: hash.digest("hex"), firstBytes, trailingBytes }
  } finally {
    await handle.close()
  }
}

async function readLocalArtifact(href: string): Promise<ArtifactBytes> {
  if (!href.startsWith("/downloads/") || href.includes("..")) {
    throw new Error("Local installer path must be inside /downloads.")
  }
  const downloadsRoot = resolve(process.cwd(), "public", "downloads")
  const filePath = resolve(process.cwd(), "public", `.${href}`)
  if (!filePath.startsWith(`${downloadsRoot}${sep}`)) {
    throw new Error("Local installer path escapes the downloads directory.")
  }
  const details = await stat(filePath)
  if (!details.isFile()) throw new Error("Installer path is not a file.")
  if (details.size <= 0) throw new Error("Installer file is empty.")
  if (details.size > MAX_ARTIFACT_BYTES) throw new Error("Installer exceeds the 2 GB validation limit.")

  const bytes = await hashLocalFile(filePath, details.size)
  const filename = basename(filePath)
  return {
    ...bytes,
    size: details.size,
    filename,
    contentType: contentTypes[extname(filename).toLowerCase()] || "application/octet-stream",
  }
}

async function fetchPublicInstaller(initialUrl: string): Promise<Response> {
  let currentUrl = new URL(initialUrl)
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    if (!(await isPublicHttpsUrl(currentUrl))) {
      throw new Error("Installer URL is not an allowed public HTTPS location.")
    }
    const response = await fetch(currentUrl, {
      method: "GET",
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      headers: {
        Accept: "application/octet-stream, application/x-apple-diskimage, application/vnd.microsoft.portable-executable, application/x-msi, application/msix",
      },
    })
    if (response.status < 300 || response.status >= 400) return response
    const location = response.headers.get("location")
    if (!location) throw new Error(`Installer URL returned HTTP ${response.status} without a redirect target.`)
    currentUrl = new URL(location, currentUrl)
  }
  throw new Error("Installer URL redirected too many times.")
}

async function readRemoteArtifact(href: string): Promise<ArtifactBytes> {
  const response = await fetchPublicInstaller(href)
  if (!response.ok) throw new Error(`Installer URL returned HTTP ${response.status}.`)

  const contentType = (response.headers.get("content-type") || "application/octet-stream").toLowerCase()
  if (
    contentType.includes("text/html") ||
    contentType.includes("application/json") ||
    contentType.startsWith("text/")
  ) {
    throw new Error("Installer URL returned HTML, JSON, or text instead of installer bytes.")
  }
  const reportedSize = Number(response.headers.get("content-length") || 0)
  if (reportedSize > MAX_ARTIFACT_BYTES) throw new Error("Installer exceeds the 2 GB validation limit.")
  if (!response.body) throw new Error("Installer response did not contain a readable body.")

  const hash = createHash("sha256")
  let size = 0
  let firstBytes = Buffer.alloc(0)
  let trailingBytes = Buffer.alloc(0)
  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const bytes = Buffer.from(value)
    if (firstBytes.length < HEADER_BYTES) {
      firstBytes = Buffer.concat([firstBytes, bytes]).subarray(0, HEADER_BYTES)
    }
    trailingBytes = Buffer.concat([trailingBytes, bytes]).subarray(-512)
    size += bytes.length
    if (size > MAX_ARTIFACT_BYTES) {
      await reader.cancel()
      throw new Error("Installer exceeds the 2 GB validation limit.")
    }
    hash.update(bytes)
  }
  if (size <= 0) throw new Error("Installer file is empty.")
  if (reportedSize > 0 && reportedSize !== size) {
    throw new Error(`Installer response was truncated: expected ${reportedSize} bytes but received ${size}.`)
  }

  const finalUrl = response.url || href
  const fallbackName = basename(new URL(finalUrl).pathname)
  const filename = contentDispositionFilename(response.headers.get("content-disposition")) || fallbackName
  return {
    size,
    sha256: hash.digest("hex"),
    firstBytes,
    trailingBytes,
    filename,
    contentType,
    finalUrl,
  }
}

function unavailable(candidate: InstallerCandidate, reason: string): ValidatedInstaller {
  const href = candidateHref(candidate)
  return {
    version: candidate.version || null,
    platform: candidate.platform,
    architecture: candidate.architecture || null,
    downloadUrl: href,
    filename: candidate.filename || (href ? basename(href.split("?")[0]) : null),
    contentType: null,
    size: candidate.size || null,
    sha256: candidate.sha256?.toLowerCase() || null,
    available: false,
    signed: candidate.signed === true,
    notarized: candidate.platform === "windows" ? false : candidate.notarized === true,
    checksumVerified: false,
    metadataValid: false,
    productionRecommended: false,
    warning: null,
    blockedReason: reason,
    releaseChannel: candidate.releaseChannel || "internal",
    generatedAt: candidate.generatedAt || null,
    buildCommit: candidate.buildCommit || null,
    buildTimestamp: candidate.buildTimestamp || null,
    releaseNotes: candidate.releaseNotes || null,
    buildNumber: candidate.buildNumber || null,
    mandatory: Boolean(candidate.mandatory),
    minimumSupportedVersion: candidate.minimumSupportedVersion || null,
  }
}

async function validateUncached(candidate: InstallerCandidate): Promise<ValidatedInstaller> {
  const href = candidateHref(candidate)
  if (!href) return unavailable(candidate, "No installer URL or local file is configured.")

  let bytes: ArtifactBytes
  try {
    bytes = href.startsWith("/") ? await readLocalArtifact(href) : await readRemoteArtifact(href)
  } catch (error) {
    return unavailable(candidate, error instanceof Error ? error.message : "Installer could not be reached.")
  }

  const filename = candidate.filename || bytes.filename
  const extension = installerExtension(candidate.platform, filename)
  if (!extension) {
    return unavailable(
      { ...candidate, filename, size: bytes.size, sha256: bytes.sha256 },
      candidate.platform === "macos"
        ? "Artifact is not a macOS .dmg installer."
        : "Artifact is not a Windows .exe, .msi, or .msix installer."
    )
  }
  if (looksLikeHtmlOrText(bytes.firstBytes)) {
    return unavailable(
      { ...candidate, filename, size: bytes.size, sha256: bytes.sha256 },
      "Installer content is HTML, JSON, XML, or text instead of binary installer bytes."
    )
  }
  if (!magicMatches(extension, bytes.firstBytes, bytes.trailingBytes)) {
    return unavailable(
      { ...candidate, filename, size: bytes.size, sha256: bytes.sha256 },
      "Installer file signature is invalid or the file is corrupted."
    )
  }
  if (bytes.size < minimumArtifactBytes(extension)) {
    return unavailable(
      { ...candidate, filename, size: bytes.size, sha256: bytes.sha256 },
      `Installer is implausibly small: ${bytes.size} bytes.`
    )
  }

  const filenameArchitecture = inferredArchitecture(filename)
  const binaryArchitecture = extension === ".exe" ? peArchitecture(bytes.firstBytes) : null
  const installerBootstrap = is32BitInstallerBootstrap(filename, binaryArchitecture)
  if (
    candidate.architecture &&
    filenameArchitecture &&
    comparableArchitecture(candidate.architecture) !== comparableArchitecture(filenameArchitecture)
  ) {
    return unavailable(
      { ...candidate, filename, size: bytes.size, sha256: bytes.sha256 },
      `Installer architecture ${filenameArchitecture} does not match metadata architecture ${candidate.architecture}.`
    )
  }
  if (
    candidate.architecture &&
    binaryArchitecture &&
    !installerBootstrap &&
    comparableArchitecture(candidate.architecture) !== comparableArchitecture(binaryArchitecture)
  ) {
    return unavailable(
      { ...candidate, filename, size: bytes.size, sha256: bytes.sha256 },
      `Installer PE architecture ${binaryArchitecture} does not match metadata architecture ${candidate.architecture}.`
    )
  }
  const filenameVersion = inferredVersion(filename)
  if (candidate.version && filenameVersion !== candidate.version) {
    return unavailable(
      { ...candidate, filename, size: bytes.size, sha256: bytes.sha256 },
      filenameVersion
        ? `Installer version ${filenameVersion} does not match metadata version ${candidate.version}.`
        : `Installer filename ${filename} does not contain metadata version ${candidate.version}.`
    )
  }
  if (candidate.size && candidate.size !== bytes.size) {
    return unavailable(
      { ...candidate, filename, size: bytes.size, sha256: bytes.sha256 },
      `Installer size does not match metadata: expected ${candidate.size} bytes but found ${bytes.size}.`
    )
  }
  if (candidate.sha256 && candidate.sha256.toLowerCase() !== bytes.sha256) {
    return unavailable(
      { ...candidate, filename, size: bytes.size, sha256: bytes.sha256 },
      "Installer SHA-256 does not match release metadata."
    )
  }

  const signed = candidate.signed === true
  const notarized = candidate.platform === "macos" && candidate.notarized === true
  const checksumVerified = sha256Like(candidate.sha256)
  const metadataValid = Boolean(
    semverLike(candidate.version) &&
      candidate.architecture &&
      candidate.filename &&
      filenameVersion === candidate.version &&
      candidate.size &&
      sha256Like(candidate.sha256) &&
      commitLike(candidate.buildCommit) &&
      timestampLike(candidate.buildTimestamp)
  )
  const releaseChannel = candidate.releaseChannel || (signed && (candidate.platform === "windows" || notarized) ? "stable" : "internal")
  const productionRecommended = Boolean(
    signed &&
      (candidate.platform === "windows" || notarized) &&
      checksumVerified &&
      metadataValid &&
      releaseChannel === "stable"
  )
  const available = checksumVerified && metadataValid
  const warning =
    candidate.platform === "macos" && (!signed || !notarized)
      ? "Unsigned development distribution. macOS may display a security warning. This build has not yet been Apple notarized."
      : candidate.platform === "windows" && !signed
        ? "Unsigned Windows build. Windows SmartScreen may show a warning because an Authenticode certificate has not yet been configured."
        : !metadataValid
          ? "Installer is available, but some release metadata is incomplete."
          : null

  return {
    version: candidate.version || filenameVersion,
    platform: candidate.platform,
    architecture:
      candidate.architecture ||
      (binaryArchitecture === "x86" ? null : binaryArchitecture) ||
      filenameArchitecture,
    downloadUrl: href,
    filename,
    contentType: contentTypes[extension] || bytes.contentType,
    size: bytes.size,
    sha256: bytes.sha256,
    available,
    signed,
    notarized,
    checksumVerified,
    metadataValid,
    productionRecommended,
    warning,
    blockedReason: available
      ? null
      : "Installer bytes passed package validation, but immutable version, commit, build timestamp, architecture, size, filename, and SHA-256 metadata are required before download.",
    releaseChannel,
    generatedAt: candidate.generatedAt || null,
    buildCommit: candidate.buildCommit || null,
    buildTimestamp: candidate.buildTimestamp || null,
    releaseNotes: candidate.releaseNotes || null,
    buildNumber: candidate.buildNumber || null,
    mandatory: Boolean(candidate.mandatory),
    minimumSupportedVersion: candidate.minimumSupportedVersion || null,
  }
}

export async function validateInstallerCandidate(
  candidate: InstallerCandidate,
  options: ValidationOptions = {}
): Promise<ValidatedInstaller> {
  if (options.cache === false) return validateUncached(candidate)

  const href = candidateHref(candidate) || ""
  const key = JSON.stringify(candidate)
  const now = Date.now()
  const cached = validationCache.get(key)
  if (cached && cached.expiresAt > now) return cached.result

  const result = validateUncached(candidate)
  validationCache.set(key, {
    result,
    expiresAt: now + (href.startsWith("/") ? LOCAL_CACHE_MS : REMOTE_CACHE_MS),
  })
  return result
}

export function mimeTypeForInstaller(filename: string) {
  return contentTypes[extname(filename).toLowerCase()] || "application/octet-stream"
}
