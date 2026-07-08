export type DesktopReleaseManifest = {
  version?: string
  generatedAt?: string
  releaseNotes?: string[] | string
  notes?: string[] | string
  mac?: {
    downloadUrl?: string
    url?: string
    file?: string
    version?: string
    size?: number
    sha256?: string
    notarized?: boolean
    generatedAt?: string
  }
  windows?: {
    downloadUrl?: string
    url?: string
    file?: string
    version?: string
    size?: number
    sha256?: string
    signed?: boolean
    generatedAt?: string
  }
  windowsMsi?: {
    downloadUrl?: string
    url?: string
    file?: string
    version?: string
    size?: number
    sha256?: string
    signed?: boolean
    generatedAt?: string
  }
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
  success: "Updated successfully",
  failed: "Update failed, try again",
  offline: "Offline",
}

export function compareVersions(left: string, right: string) {
  const leftParts = left.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const rightParts = right.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0)
  const maxLength = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] || 0
    const rightValue = rightParts[index] || 0

    if (leftValue > rightValue) return 1
    if (leftValue < rightValue) return -1
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
  const timestamps = [manifest.generatedAt, manifest.mac?.generatedAt, manifest.windows?.generatedAt, manifest.windowsMsi?.generatedAt]
    .map((value) => (value ? Date.parse(value) : 0))
    .filter((value) => Number.isFinite(value))

  return Math.max(0, ...timestamps)
}

function newestManifest(left: DesktopReleaseManifest | null, right: DesktopReleaseManifest | null) {
  if (!left) return right
  if (!right) return left

  const versionComparison = compareVersions(left.version || "", right.version || "")
  if (versionComparison > 0) return left
  if (versionComparison < 0) return right

  return releaseGeneratedAt(left) >= releaseGeneratedAt(right) ? left : right
}

function currentPlatform() {
  if (typeof navigator === "undefined") return "mac"

  const platform = navigator.platform.toLowerCase()
  const userAgent = navigator.userAgent.toLowerCase()
  return platform.includes("win") || userAgent.includes("windows") ? "windows" : "mac"
}

export function releaseForCurrentPlatform(manifest: DesktopReleaseManifest | null) {
  if (!manifest) return null
  return currentPlatform() === "windows" ? manifest.windows || manifest.windowsMsi || null : manifest.mac || null
}

function releaseHref(release: ReturnType<typeof releaseForCurrentPlatform>) {
  return release?.downloadUrl || release?.url || release?.file || ""
}

export function latestVersionForCurrentPlatform(manifest: DesktopReleaseManifest | null) {
  const release = releaseForCurrentPlatform(manifest)
  return release?.version || manifest?.version || ""
}

export function isDesktopUpdateAvailable(manifest: DesktopReleaseManifest | null, currentVersion: string) {
  const latestVersion = latestVersionForCurrentPlatform(manifest)
  return Boolean(latestVersion && releaseHref(releaseForCurrentPlatform(manifest)) && compareVersions(latestVersion, currentVersion) > 0)
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

export async function fetchDesktopReleaseManifest(signal?: AbortSignal) {
  if (!isOnline()) return null

  const localManifestPromise = readManifest("/downloads/desktop-release.json", signal)
  const proxiedRemoteManifestPromise = readManifest("/api/desktop-release", signal)

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://www.bezgrow.com"
  const remoteUrl = `${siteUrl.replace(/\/$/, "")}/downloads/desktop-release.json`
  const directRemoteManifestPromise = readManifest(remoteUrl, signal)

  const manifests = await Promise.all([
    localManifestPromise,
    proxiedRemoteManifestPromise,
    directRemoteManifestPromise,
  ])

  return manifests.reduce<DesktopReleaseManifest | null>((latest, manifest) => newestManifest(latest, manifest), null)
}
