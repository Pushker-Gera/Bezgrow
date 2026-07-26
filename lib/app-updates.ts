import { desktopArchitecture, isTauriRuntimeAsync } from "@/lib/desktop/tauri"

type WindowsRelease = {
  downloadUrl?: string
  url?: string
  file?: string
  version?: string
  size?: number
  sha256?: string
  signed?: boolean
  generatedAt?: string
}

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
  windows?: WindowsRelease
  windowsMsi?: WindowsRelease
  windowsArm64?: WindowsRelease
  windowsArm64Msi?: WindowsRelease
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
    manifest.windows?.generatedAt,
    manifest.windowsMsi?.generatedAt,
    manifest.windowsArm64?.generatedAt,
    manifest.windowsArm64Msi?.generatedAt,
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

export function releaseForCurrentPlatform(manifest: DesktopReleaseManifest | null) {
  if (!manifest) return null
  if (currentPlatform() !== "windows") return manifest.mac || null
  if (desktopArchitecture() === "arm64") {
    return manifest.windowsArm64 || manifest.windowsArm64Msi || manifest.windows || manifest.windowsMsi || null
  }
  return manifest.windows || manifest.windowsMsi || null
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

  const desktopRuntime = await isTauriRuntimeAsync()
  const manifestPath = "/api/desktop-release"
  const url = desktopRuntime
    ? `/api/desktop-proxy?path=${encodeURIComponent(manifestPath)}`
    : manifestPath
  return readManifest(url, signal)
}
