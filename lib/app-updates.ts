export type DesktopReleaseManifest = {
  version?: string
  generatedAt?: string
  releaseNotes?: string[] | string
  notes?: string[] | string
  mac?: {
    url?: string
    file?: string
    size?: number
    notarized?: boolean
    generatedAt?: string
  }
  windows?: {
    url?: string
    file?: string
    size?: number
    signed?: boolean
    generatedAt?: string
  }
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

export function normalizeReleaseNotes(manifest: DesktopReleaseManifest | null) {
  const rawNotes = manifest?.releaseNotes || manifest?.notes

  if (Array.isArray(rawNotes)) return rawNotes.filter(Boolean)
  if (typeof rawNotes === "string" && rawNotes.trim()) return [rawNotes.trim()]

  return []
}

export function releaseGeneratedAt(manifest: DesktopReleaseManifest | null) {
  if (!manifest) return 0
  const timestamps = [manifest.generatedAt, manifest.mac?.generatedAt, manifest.windows?.generatedAt]
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

export function installerHrefForCurrentPlatform(manifest: DesktopReleaseManifest | null) {
  if (typeof navigator === "undefined" || !manifest) return ""

  const platform = navigator.platform.toLowerCase()
  const userAgent = navigator.userAgent.toLowerCase()
  const isWindows = platform.includes("win") || userAgent.includes("windows")
  const release = isWindows ? manifest.windows : manifest.mac
  const href = release?.url || release?.file

  return href || "/download"
}

async function readManifest(url: string) {
  const response = await fetch(url, { cache: "no-store" }).catch(() => null)
  if (!response?.ok) return null

  return (await response.json().catch(() => null)) as DesktopReleaseManifest | null
}

export async function fetchDesktopReleaseManifest() {
  const localManifestPromise = readManifest("/downloads/desktop-release.json")
  const proxiedRemoteManifestPromise = readManifest("/api/desktop-release")

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://www.bezgrow.com"
  const remoteUrl = `${siteUrl.replace(/\/$/, "")}/downloads/desktop-release.json`
  const directRemoteManifestPromise = readManifest(remoteUrl)

  const manifests = await Promise.all([
    localManifestPromise,
    proxiedRemoteManifestPromise,
    directRemoteManifestPromise,
  ])

  return manifests.reduce<DesktopReleaseManifest | null>((latest, manifest) => newestManifest(latest, manifest), null)
}
