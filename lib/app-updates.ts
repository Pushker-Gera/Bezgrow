import { desktopArchitecture, isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { localLicenseSnapshot } from "@/lib/offline/local/license"

type WindowsRelease = {
  downloadUrl?: string
  url?: string
  file?: string
  version?: string
  size?: number
  sha256?: string
  signed?: boolean
  generatedAt?: string
  mandatory?: boolean
  minimumSupportedVersion?: string | null
  releaseChannel?: string
  checksumVerified?: boolean
  installerType?: string
  architecture?: "x64" | "x86_64" | "arm64"
  platform?: "windows" | "macos"
  updaterUrl?: string
  updaterSignature?: string
  updaterSize?: number
  updaterSha256?: string
  publicationStatus?: string
  releaseDate?: string
  mandatoryAfter?: string | null
  trustState?: "signed-production" | "unsigned-manual-install" | "invalid"
  releaseMode?: "SIGNED_PRODUCTION_RELEASE" | "UNSIGNED_MANUAL_RELEASE" | "INVALID_RELEASE"
  productionSigned?: boolean
  manualInstallAllowed?: boolean
  metadataValid?: boolean
  buildCommit?: string
  filename?: string
  updaterSignatureVerified?: boolean
}

type MacRelease = WindowsRelease & {
  notarized?: boolean
}

export type DesktopReleaseManifest = {
  version?: string
  generatedAt?: string
  releaseNotes?: string[] | string
  notes?: string[] | string
  mac?: MacRelease
  macX64?: MacRelease
  windows?: WindowsRelease
  windowsMsi?: WindowsRelease
  windowsMsix?: WindowsRelease
  windowsArm64?: WindowsRelease
  windowsArm64Msi?: WindowsRelease
  windowsArm64Msix?: WindowsRelease
}

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "success"
  | "failed"
  | "offline"

export const appUpdateStatusLabel: Record<AppUpdateStatus, string> = {
  idle: "Ready to check",
  checking: "Checking for updates",
  available: "Update available",
  downloading: "Downloading",
  ready: "Ready to install",
  success: "No update available",
  failed: "Update failed, try again",
  offline: "Offline",
}

export function compareVersions(left: string, right: string) {
  function parse(value: string) {
    const normalized = value.trim().replace(/^v/i, "").split("+", 1)[0]
    const [core, prerelease = ""] = normalized.split("-", 2)
    const coreParts = core.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : 0))
    return { core: [coreParts[0] || 0, coreParts[1] || 0, coreParts[2] || 0], prerelease: prerelease ? prerelease.split(".") : [] }
  }

  const leftVersion = parse(left)
  const rightVersion = parse(right)
  for (let index = 0; index < 3; index += 1) {
    const leftValue = leftVersion.core[index]
    const rightValue = rightVersion.core[index]

    if (leftValue > rightValue) return 1
    if (leftValue < rightValue) return -1
  }

  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length > 0) return 1
  if (rightVersion.prerelease.length === 0 && leftVersion.prerelease.length > 0) return -1

  const maxPrerelease = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length)
  for (let index = 0; index < maxPrerelease; index += 1) {
    const leftPart = leftVersion.prerelease[index]
    const rightPart = rightVersion.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return Number(leftPart) > Number(rightPart) ? 1 : -1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart > rightPart ? 1 : -1
  }
  return 0
}

export function isOnline() {
  return typeof navigator === "undefined" ? true : navigator.onLine
}

export function normalizeReleaseNotes(manifest: DesktopReleaseManifest | null) {
  const rawNotes = manifest?.releaseNotes || manifest?.notes

  if (Array.isArray(rawNotes)) return rawNotes.filter(Boolean)
  if (typeof rawNotes === "string" && rawNotes.trim()) return [rawNotes.trim()]

  return []
}

export function releaseGeneratedAt(manifest: DesktopReleaseManifest | null) {
  if (!manifest) return 0
  const timestamps = [
    manifest.generatedAt,
    manifest.mac?.generatedAt,
    manifest.macX64?.generatedAt,
    manifest.windows?.generatedAt,
    manifest.windowsMsi?.generatedAt,
    manifest.windowsMsix?.generatedAt,
    manifest.windowsArm64?.generatedAt,
    manifest.windowsArm64Msi?.generatedAt,
    manifest.windowsArm64Msix?.generatedAt,
  ]
    .map((value) => (value ? Date.parse(value) : 0))
    .filter((value) => Number.isFinite(value))

  return Math.max(0, ...timestamps)
}

function currentPlatform() {
  if (typeof navigator === "undefined") return "mac"

  const platform = navigator.platform.toLowerCase()
  const userAgent = navigator.userAgent.toLowerCase()
  return platform.includes("win") || userAgent.includes("windows") ? "windows" : "mac"
}

export function verifiedInstallerRouteForCurrentPlatform() {
  return currentPlatform() === "windows"
    ? "/api/downloads/desktop?platform=windows"
    : "/api/downloads/desktop?platform=mac"
}

function releaseMatchesTarget(release: WindowsRelease | MacRelease | null | undefined, platform: "mac" | "windows", architecture: "x64" | "arm64") {
  if (!release) return null
  if (release.publicationStatus !== "published") return null
  const expectedPlatform = platform === "mac" ? "macos" : "windows"
  const expectedArchitectures = architecture === "x64" ? ["x64", "x86_64"] : ["arm64"]
  if (release.platform && release.platform !== expectedPlatform) return null
  if (release.architecture && !expectedArchitectures.includes(release.architecture)) return null
  return release
}

export function releaseForPlatform(manifest: DesktopReleaseManifest | null, platform: "mac" | "windows", architecture: "x64" | "arm64") {
  if (!manifest) return null
  if (platform === "mac") {
    return architecture === "x64"
      ? releaseMatchesTarget(manifest.macX64, platform, architecture)
      : releaseMatchesTarget(manifest.mac, platform, architecture)
  }
  const candidates = architecture === "arm64"
    ? [manifest.windowsArm64, manifest.windowsArm64Msi, manifest.windowsArm64Msix]
    : [manifest.windows, manifest.windowsMsi, manifest.windowsMsix]
  for (const candidate of candidates) {
    const matching = releaseMatchesTarget(candidate, platform, architecture)
    if (matching) return matching
  }
  return null
}

export function releaseForCurrentPlatform(manifest: DesktopReleaseManifest | null) {
  return releaseForPlatform(manifest, currentPlatform(), desktopArchitecture() === "arm64" ? "arm64" : "x64")
}

function releaseHref(release: ReturnType<typeof releaseForCurrentPlatform>) {
  return release?.downloadUrl || release?.url || release?.file || ""
}

export function latestVersionForCurrentPlatform(manifest: DesktopReleaseManifest | null) {
  const release = releaseForCurrentPlatform(manifest)
  return release?.version || ""
}

export function isDesktopUpdateAvailable(manifest: DesktopReleaseManifest | null, currentVersion: string) {
  const latestVersion = latestVersionForCurrentPlatform(manifest)
  const release = releaseForCurrentPlatform(manifest)
  const installable =
    release?.trustState === "signed-production" ||
    (release?.trustState === "unsigned-manual-install" && release.manualInstallAllowed === true)
  return Boolean(
    latestVersion &&
      installable &&
      release?.metadataValid === true &&
      release.checksumVerified === true &&
      typeof release.sha256 === "string" &&
      /^[a-f0-9]{64}$/i.test(release.sha256) &&
      typeof release.size === "number" &&
      release.size > 0 &&
      releaseHref(release) &&
      compareVersions(latestVersion, currentVersion) > 0
  )
}

export function automaticUpdaterAvailable(release: WindowsRelease | MacRelease | null | undefined) {
  return Boolean(
    release?.updaterSignatureVerified === true &&
      release.updaterUrl &&
      release.updaterSignature &&
      release.updaterSha256 &&
      /^[a-f0-9]{64}$/i.test(release.updaterSha256) &&
      release.updaterSize &&
      release.updaterSize > 0
  )
}

export function installerHrefForCurrentPlatform(manifest: DesktopReleaseManifest | null) {
  const release = releaseForCurrentPlatform(manifest)
  const href = releaseHref(release)

  return href || "/download"
}

export function absoluteInstallerUrl(href: string) {
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.bezgrow.com").replace(/\/$/, "")
  if (!href) return `${siteUrl}/download`
  if (/^https?:\/\//i.test(href)) return href
  return `${siteUrl}${href.startsWith("/") ? href : `/${href}`}`
}

export function formatUpdateSize(size: number | undefined) {
  if (!size || !Number.isFinite(size)) return ""
  const mb = size / (1024 * 1024)
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`
}

async function readManifest(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { cache: "no-store", signal }).catch(() => null)
  if (!response?.ok) return null

  return (await response.json().catch(() => null)) as DesktopReleaseManifest | null
}

async function authenticatedDeviceRelease(currentVersion: string, signal?: AbortSignal) {
  const snapshot = await localLicenseSnapshot().catch(() => null)
  const licenseKey = snapshot?.license?.license_key
  if (!snapshot?.allowed || typeof licenseKey !== "string" || !licenseKey) return null

  const platform = currentPlatform() === "windows" ? "windows" : "macos"
  const architecture = desktopArchitecture() === "arm64" ? "arm64" : "x86_64"
  const response = await fetch(`/api/desktop-proxy?path=${encodeURIComponent("/api/devices/checkin")}`, {
    method: "POST",
    cache: "no-store",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      license_key: licenseKey,
      device_id: snapshot.device_id,
      platform,
      architecture,
      app_version: currentVersion,
      release_channel: "stable",
      diagnostics_available: false,
    }),
  }).catch(() => null)
  if (!response?.ok) return null

  const payload = (await response.json().catch(() => null)) as {
    success?: boolean
    serverTime?: string
    eligibleRelease?: {
      version?: string
      build_number?: string
      minimum_supported_version?: string | null
      release_notes?: string | null
      mandatory?: boolean
      release_channel?: string
      published_at?: string | null
      mandatory_after?: string | null
      release_artifacts?: Array<{
        file_url?: string
        file_size?: number
        sha256?: string
        validated_at?: string | null
        signature_status?: string
        notarization_status?: string
        code_signing_status?: string
        validation_status?: string
        updater_url?: string | null
        updater_size?: number | null
        updater_sha256?: string | null
        update_signature?: string | null
        updater_signature_status?: string | null
        artifact_type?: string | null
        file_name?: string | null
      }>
    } | null
  } | null
  if (!payload?.success) return null
  if (!payload.eligibleRelease) {
    return {
      version: currentVersion,
      generatedAt: payload.serverTime,
      releaseNotes: [],
    } satisfies DesktopReleaseManifest
  }

  const release = payload.eligibleRelease
  const artifact = release.release_artifacts?.[0]
  const integrityValid =
    artifact?.validation_status === "valid" &&
    typeof artifact.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(artifact.sha256) &&
    typeof artifact.file_size === "number" &&
    artifact.file_size > 0
  if (!release.version || !artifact?.file_url || !integrityValid) return null
  const productionSigned =
    artifact.signature_status === "valid" &&
    artifact.code_signing_status === "valid" &&
    (platform !== "macos" || artifact.notarization_status === "valid")
  const installer: WindowsRelease = {
    downloadUrl: artifact.file_url,
    version: release.version,
    size: Number(artifact.file_size),
    sha256: artifact.sha256,
    signed: artifact.signature_status === "valid" && artifact.code_signing_status === "valid",
    generatedAt: artifact.validated_at || release.published_at || payload.serverTime,
    mandatory: Boolean(release.mandatory),
    minimumSupportedVersion: release.minimum_supported_version || null,
    releaseChannel: release.release_channel || "stable",
    platform,
    architecture,
    updaterUrl: artifact.updater_url || undefined,
    updaterSignature: artifact.update_signature || undefined,
    updaterSize: artifact.updater_size || undefined,
    updaterSha256: artifact.updater_sha256 || undefined,
    updaterSignatureVerified: artifact.updater_signature_status === "valid",
    publicationStatus: "published",
    releaseDate: release.published_at || undefined,
    mandatoryAfter: release.mandatory_after || null,
    trustState: productionSigned ? "signed-production" : "unsigned-manual-install",
    releaseMode: productionSigned ? "SIGNED_PRODUCTION_RELEASE" : "UNSIGNED_MANUAL_RELEASE",
    productionSigned,
    manualInstallAllowed: !productionSigned,
    metadataValid: true,
    checksumVerified: true,
    filename: artifact.file_name || undefined,
  }
  const manifest: DesktopReleaseManifest = {
    version: release.version,
    generatedAt: installer.generatedAt,
    releaseNotes: release.release_notes ? [release.release_notes] : [],
  }
  if (platform === "macos") {
    const macInstaller: MacRelease = {
      ...installer,
      notarized: artifact.notarization_status === "valid",
    }
    if (architecture === "arm64") manifest.mac = macInstaller
    else manifest.macX64 = macInstaller
  } else if (architecture === "arm64") {
    manifest.windowsArm64 = installer
  } else {
    manifest.windows = installer
  }
  return manifest
}

export async function fetchDesktopReleaseManifest(signal?: AbortSignal, currentVersion = "") {
  if (!isOnline()) return null

  const desktopRuntime = await isTauriRuntimeAsync()
  if (desktopRuntime && currentVersion) {
    const authenticated = await authenticatedDeviceRelease(currentVersion, signal)
    if (authenticated) return authenticated
  }
  const manifestPath = "/api/desktop-release"
  const url = desktopRuntime
    ? `/api/desktop-proxy?path=${encodeURIComponent(manifestPath)}`
    : manifestPath
  return readManifest(url, signal)
}

export async function reportDesktopUpdateResult(
  currentVersion: string,
  result: "success" | "failed" | "no_update" | "update_available",
) {
  if (!isOnline() || !(await isTauriRuntimeAsync())) return false
  const snapshot = await localLicenseSnapshot().catch(() => null)
  const licenseKey = snapshot?.license?.license_key
  if (!snapshot?.allowed || typeof licenseKey !== "string" || !licenseKey) return false
  const response = await fetch(`/api/desktop-proxy?path=${encodeURIComponent("/api/devices/checkin")}`, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      license_key: licenseKey,
      device_id: snapshot.device_id,
      platform: currentPlatform() === "windows" ? "windows" : "macos",
      architecture: desktopArchitecture() === "arm64" ? "arm64" : "x86_64",
      app_version: currentVersion,
      release_channel: "stable",
      diagnostics_available: false,
      update_check_result: result,
    }),
  }).catch(() => null)
  return Boolean(response?.ok)
}
