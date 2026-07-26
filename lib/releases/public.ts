import "server-only"

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { basename, extname, join } from "node:path"
import {
  type InstallerArchitecture,
  type InstallerCandidate,
  type InstallerPlatform,
  type ValidatedInstaller,
  validateInstallerCandidate,
} from "@/lib/releases/artifact-validation"
import { adminSupabase } from "@/lib/supabase/admin"

export type PublicInstallerRelease = ValidatedInstaller

export type PublicDesktopReleaseManifest = {
  version?: string
  generatedAt: string
  releaseNotes: string[]
  mac?: PublicInstallerRelease
  macX64?: PublicInstallerRelease
  windows?: PublicInstallerRelease
  windowsMsi?: PublicInstallerRelease
  windowsMsix?: PublicInstallerRelease
  windowsArm64?: PublicInstallerRelease
  windowsArm64Msi?: PublicInstallerRelease
  windowsArm64Msix?: PublicInstallerRelease
}

type ArtifactRow = {
  file_url: string
  file_size: number | null
  sha256: string | null
  validation_status: string
  signature_status: string
  notarization_status: string
  code_signing_status: string
  validated_at: string | null
  validation_error?: string | null
  artifact_type?: string | null
  file_name?: string | null
}

type ReleaseRow = {
  id?: string
  version: string
  build_number: string
  platform: InstallerPlatform
  architecture: InstallerArchitecture
  release_channel: string
  minimum_supported_version: string | null
  release_notes: string | null
  mandatory: boolean
  rollout_percentage?: number
  release_status?: string
  active?: boolean
  created_at?: string
  published_at: string | null
  release_artifacts?: ArtifactRow[]
}

type RawInstaller = {
  downloadUrl?: string
  url?: string
  file?: string
  filename?: string
  version?: string
  architecture?: InstallerArchitecture
  size?: number
  sha256?: string
  signed?: boolean
  notarized?: boolean
  generatedAt?: string
  releaseChannel?: string
}

type RawManifest = {
  version?: string
  generatedAt?: string
  releaseNotes?: string[]
  mac?: RawInstaller
  macX64?: RawInstaller
  windows?: RawInstaller
  windowsMsi?: RawInstaller
  windowsMsix?: RawInstaller
  windowsArm64?: RawInstaller
  windowsArm64Msi?: RawInstaller
  windowsArm64Msix?: RawInstaller
}

export type PublicReleaseAvailabilityStatus =
  | "available"
  | "no_release"
  | "unpublished"
  | "artifact_missing"
  | "checksum_mismatch"
  | "artifact_invalid"
  | "platform_mismatch"
  | "rollout_restricted"

export type PublicReleaseAvailability = ValidatedInstaller & {
  status: PublicReleaseAvailabilityStatus
  reason: string
  installer: PublicInstallerRelease | null
}

export type PublicDesktopReleaseAvailability = {
  manifest: PublicDesktopReleaseManifest | null
  mac: PublicReleaseAvailability
  windows: PublicReleaseAvailability
}

const downloadsDirectory = join(process.cwd(), "public", "downloads")
const desktopManifestPath = join(downloadsDirectory, "desktop-release.json")

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch (error) {
    console.error("[desktop-release-json]", {
      path,
      message: error instanceof Error ? error.message : "Invalid JSON",
    })
    return null
  }
}

function packageVersion() {
  const packageJson = readJson<{ version?: string }>(join(process.cwd(), "package.json"))
  return packageJson?.version || null
}

function inferArchitecture(filename: string): InstallerArchitecture | null {
  const lower = filename.toLowerCase()
  if (/(?:^|[-_.])(arm64|aarch64)(?:[-_.]|$)/.test(lower)) return "arm64"
  if (/(?:^|[-_.])(x64|x86_64|amd64)(?:[-_.]|$)/.test(lower)) return "x64"
  return null
}

function candidateFromManifest(
  platform: InstallerPlatform,
  installer: RawInstaller,
  manifestVersion: string | undefined,
  releaseNotes: string[]
): InstallerCandidate {
  const href = installer.downloadUrl || installer.url || installer.file || null
  const filename = installer.filename || (href ? basename(href.split("?")[0]) : null)
  return {
    platform,
    architecture: installer.architecture || (filename ? inferArchitecture(filename) : null),
    version: installer.version || manifestVersion || null,
    downloadUrl: href,
    file: installer.file || null,
    filename,
    size: installer.size || null,
    sha256: installer.sha256 || null,
    signed: installer.signed === true,
    notarized: installer.notarized === true,
    generatedAt: installer.generatedAt || null,
    releaseChannel:
      installer.releaseChannel ||
      (installer.signed === true && (platform === "windows" || installer.notarized === true)
        ? "stable"
        : "internal"),
    releaseNotes: releaseNotes.join("\n\n") || null,
  }
}

function checkedInCandidates(platform: InstallerPlatform) {
  const manifest = readJson<RawManifest>(desktopManifestPath)
  const candidates: InstallerCandidate[] = []
  const notes = Array.isArray(manifest?.releaseNotes) ? manifest.releaseNotes.filter(Boolean) : []
  const entries =
    platform === "macos"
      ? [manifest?.mac, manifest?.macX64]
      : [
          manifest?.windows,
          manifest?.windowsMsi,
          manifest?.windowsMsix,
          manifest?.windowsArm64,
          manifest?.windowsArm64Msi,
          manifest?.windowsArm64Msix,
        ]
  for (const entry of entries) {
    if (entry) candidates.push(candidateFromManifest(platform, entry, manifest?.version, notes))
  }

  const platformManifestNames =
    platform === "macos"
      ? ["Bezgrow-mac.dmg.release.json"]
      : [
          "Bezgrow-windows.exe.release.json",
          "Bezgrow-windows.msi.release.json",
          "Bezgrow-windows.msix.release.json",
        ]
  for (const name of platformManifestNames) {
    const installer = readJson<RawInstaller>(join(downloadsDirectory, name))
    if (installer) candidates.push(candidateFromManifest(platform, installer, manifest?.version, notes))
  }

  if (existsSync(downloadsDirectory)) {
    const allowedExtensions = platform === "macos" ? [".dmg"] : [".exe", ".msi", ".msix"]
    for (const filename of readdirSync(downloadsDirectory)) {
      if (!allowedExtensions.includes(extname(filename).toLowerCase())) continue
      const href = `/downloads/${filename}`
      if (candidates.some((candidate) => (candidate.downloadUrl || candidate.file) === href)) continue
      candidates.push({
        platform,
        architecture: inferArchitecture(filename),
        version: manifest?.version || packageVersion(),
        downloadUrl: href,
        filename,
        signed: false,
        notarized: false,
        releaseChannel: "internal",
        releaseNotes: notes.join("\n\n") || null,
      })
    }
  }

  return candidates
}

function configuredCandidates(platform: InstallerPlatform) {
  const prefix = platform === "macos" ? "MAC" : "WINDOWS"
  const url =
    process.env[`BEZGROW_${prefix}_INSTALLER_URL`]?.trim() ||
    process.env[`NEXT_PUBLIC_${prefix}_INSTALLER_URL`]?.trim()
  if (!url) return []

  const rawArchitecture = process.env[`BEZGROW_${prefix}_INSTALLER_ARCHITECTURE`]?.trim()
  const architecture =
    rawArchitecture === "arm64" || rawArchitecture === "x64" ? rawArchitecture : null
  const rawSize = Number(process.env[`BEZGROW_${prefix}_INSTALLER_SIZE`] || 0)
  const filename = process.env[`BEZGROW_${prefix}_INSTALLER_FILENAME`]?.trim() || basename(url.split("?")[0])
  return [
    {
      platform,
      architecture: architecture || inferArchitecture(filename),
      version: process.env[`BEZGROW_${prefix}_INSTALLER_VERSION`]?.trim() || packageVersion(),
      downloadUrl: url,
      filename,
      size: rawSize > 0 ? rawSize : null,
      sha256: process.env[`BEZGROW_${prefix}_INSTALLER_SHA256`]?.trim() || null,
      signed: /^(1|true|yes)$/i.test(process.env[`BEZGROW_${prefix}_INSTALLER_SIGNED`] || ""),
      notarized:
        platform === "macos" &&
        /^(1|true|yes)$/i.test(process.env.BEZGROW_MAC_INSTALLER_NOTARIZED || ""),
      releaseChannel: process.env[`BEZGROW_${prefix}_INSTALLER_CHANNEL`]?.trim() || "internal",
      generatedAt: new Date().toISOString(),
    } satisfies InstallerCandidate,
  ]
}

function controlPlaneCandidate(release: ReleaseRow): InstallerCandidate | null {
  const artifact = release.release_artifacts?.[0]
  if (!artifact?.file_url) return null
  return {
    platform: release.platform,
    architecture: release.architecture,
    version: release.version,
    downloadUrl: artifact.file_url,
    filename: artifact.file_name || basename(artifact.file_url.split("?")[0]),
    size: artifact.file_size,
    sha256: artifact.sha256,
    signed:
      artifact.signature_status === "valid" && artifact.code_signing_status === "valid",
    notarized:
      release.platform === "macos" && artifact.notarization_status === "valid",
    generatedAt: artifact.validated_at || release.published_at,
    releaseChannel: release.release_channel,
    releaseNotes: release.release_notes,
    buildNumber: release.build_number,
    mandatory: release.mandatory,
    minimumSupportedVersion: release.minimum_supported_version,
  }
}

function publishedRows(rows: ReleaseRow[], platform: InstallerPlatform) {
  return rows.filter(
    (row) =>
      row.platform === platform &&
      row.release_status === "published" &&
      row.active &&
      row.published_at &&
      Number(row.rollout_percentage ?? 100) === 100
  )
}

function deduplicateCandidates(candidates: InstallerCandidate[]) {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = candidate.downloadUrl || candidate.file || ""
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function validationStatus(reason: string): PublicReleaseAvailabilityStatus {
  if (/sha-?256|checksum|size does not match|truncated/i.test(reason)) return "checksum_mismatch"
  if (/architecture|not a macOS|not a Windows/i.test(reason)) return "platform_mismatch"
  if (/not configured|no installer/i.test(reason)) return "no_release"
  if (/HTTP 404|could not be reached|not found|missing/i.test(reason)) return "artifact_missing"
  return "artifact_invalid"
}

function missingAvailability(
  platform: InstallerPlatform,
  reason: string,
  status: PublicReleaseAvailabilityStatus = "no_release"
): PublicReleaseAvailability {
  return {
    status,
    reason,
    version: null,
    platform,
    architecture: null,
    downloadUrl: null,
    filename: null,
    contentType: null,
    size: null,
    sha256: null,
    available: false,
    signed: false,
    notarized: false,
    checksumVerified: false,
    metadataValid: false,
    productionRecommended: false,
    warning: null,
    blockedReason: reason,
    releaseChannel: "internal",
    generatedAt: null,
    releaseNotes: null,
    buildNumber: null,
    mandatory: false,
    minimumSupportedVersion: null,
    installer: null,
  }
}

async function availabilityForPlatform(
  platform: InstallerPlatform,
  rows: ReleaseRow[],
  controlPlaneError: string | null
): Promise<PublicReleaseAvailability> {
  const platformRows = rows.filter((row) => row.platform === platform)
  const controlCandidates = publishedRows(rows, platform)
    .map(controlPlaneCandidate)
    .filter((candidate): candidate is InstallerCandidate => Boolean(candidate))
  const candidates = deduplicateCandidates([
    ...controlCandidates,
    ...checkedInCandidates(platform),
    ...configuredCandidates(platform),
  ])

  if (candidates.length === 0) {
    if (platformRows.length > 0) {
      const published = platformRows.some(
        (row) => row.release_status === "published" && row.active && row.published_at
      )
      if (published) {
        return missingAvailability(
          platform,
          `The published ${platform === "macos" ? "macOS" : "Windows"} metadata points to a missing artifact.`,
          "artifact_missing"
        )
      }
      return missingAvailability(
        platform,
        `No ${platform === "macos" ? "macOS" : "Windows"} release is currently published.`,
        "unpublished"
      )
    }
    return missingAvailability(
      platform,
      controlPlaneError ||
        `No genuine ${platform === "macos" ? "macOS" : "Windows"} installer was found in local downloads, release metadata, or configured URLs.`
    )
  }

  const validations = await Promise.all(candidates.map((candidate) => validateInstallerCandidate(candidate)))
  const available = validations
    .filter((installer) => installer.available)
    .sort((left, right) => {
      const score = (installer: ValidatedInstaller) =>
        (installer.productionRecommended ? 100 : 0) +
        (installer.releaseChannel === "stable" ? 20 : 0) +
        (installer.checksumVerified ? 10 : 0) +
        (installer.metadataValid ? 5 : 0)
      return score(right) - score(left)
    })[0]

  if (available) {
    const reason = available.warning || `${platform === "macos" ? "macOS" : "Windows"} installer is available and passed integrity validation.`
    return {
      ...available,
      status: "available",
      reason,
      installer: available,
    }
  }

  const failed = validations[0]
  const reason = failed.blockedReason || `${platform === "macos" ? "macOS" : "Windows"} installer failed validation.`
  return {
    ...failed,
    status: validationStatus(reason),
    reason,
    installer: null,
  }
}

function manifestKey(installer: PublicInstallerRelease) {
  if (installer.platform === "macos") {
    return installer.architecture === "x64" ? "macX64" : "mac"
  }
  if (installer.architecture === "arm64") {
    if (installer.filename?.toLowerCase().endsWith(".msix")) return "windowsArm64Msix"
    return installer.filename?.toLowerCase().endsWith(".msi")
      ? "windowsArm64Msi"
      : "windowsArm64"
  }
  if (installer.filename?.toLowerCase().endsWith(".msix")) return "windowsMsix"
  return installer.filename?.toLowerCase().endsWith(".msi") ? "windowsMsi" : "windows"
}

export async function getDesktopReleaseAvailability(): Promise<PublicDesktopReleaseAvailability> {
  let rows: ReleaseRow[] = []
  let controlPlaneError: string | null = null
  try {
    const result = await adminSupabase
      .from("desktop_releases")
      .select("id,version,build_number,platform,architecture,release_channel,release_status,active,rollout_percentage,minimum_supported_version,release_notes,mandatory,published_at,created_at,release_artifacts(file_url,file_size,sha256,validation_status,validation_error,signature_status,notarization_status,code_signing_status,validated_at,artifact_type,file_name)")
      .order("created_at", { ascending: false })
      .limit(64)
    if (result.error) {
      controlPlaneError = "Release metadata service could not be loaded."
      console.error("[public-release-availability]", {
        code: result.error.code,
        message: result.error.message,
      })
    } else {
      rows = (result.data || []) as ReleaseRow[]
    }
  } catch (error) {
    controlPlaneError = "Release metadata service could not be loaded."
    console.error("[public-release-availability]", {
      message: error instanceof Error ? error.message : "Unknown release metadata error",
    })
  }

  const [mac, windows] = await Promise.all([
    availabilityForPlatform("macos", rows, controlPlaneError),
    availabilityForPlatform("windows", rows, controlPlaneError),
  ])

  const manifest: PublicDesktopReleaseManifest = {
    generatedAt: new Date(0).toISOString(),
    releaseNotes: [],
  }
  for (const availability of [mac, windows]) {
    const installer = availability.installer
    if (!installer) continue
    const key = manifestKey(installer)
    manifest[key] = installer
    if (!manifest.version) manifest.version = installer.version || undefined
    if (
      installer.generatedAt &&
      Date.parse(installer.generatedAt) > Date.parse(manifest.generatedAt)
    ) {
      manifest.generatedAt = installer.generatedAt
    }
    if (installer.releaseNotes && !manifest.releaseNotes.includes(installer.releaseNotes)) {
      manifest.releaseNotes.push(installer.releaseNotes)
    }
  }

  return {
    manifest:
      manifest.mac ||
      manifest.macX64 ||
      manifest.windows ||
      manifest.windowsMsi ||
      manifest.windowsMsix ||
      manifest.windowsArm64 ||
      manifest.windowsArm64Msi ||
      manifest.windowsArm64Msix
        ? manifest
        : null,
    mac,
    windows,
  }
}

export async function getPublicDesktopReleaseManifest(): Promise<PublicDesktopReleaseManifest | null> {
  return (await getDesktopReleaseAvailability()).manifest
}
