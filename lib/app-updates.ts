export type DesktopReleaseManifest = {
  version?: string
  releaseNotes?: string[] | string
  notes?: string[] | string
  mac?: {
    url?: string
    file?: string
    size?: number
    notarized?: boolean
  }
  windows?: {
    url?: string
    file?: string
    size?: number
    signed?: boolean
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

export function installerHrefForCurrentPlatform(manifest: DesktopReleaseManifest | null) {
  if (typeof navigator === "undefined" || !manifest) return ""

  const platform = navigator.platform.toLowerCase()
  const userAgent = navigator.userAgent.toLowerCase()
  const isWindows = platform.includes("win") || userAgent.includes("windows")
  const release = isWindows ? manifest.windows : manifest.mac
  const href = release?.url || release?.file

  return href || "/download"
}

export async function fetchDesktopReleaseManifest() {
  const localResponse = await fetch("/downloads/desktop-release.json", { cache: "no-store" }).catch(() => null)

  if (localResponse?.ok) {
    return (await localResponse.json()) as DesktopReleaseManifest
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://www.bezgrow.com"
  const remoteUrl = `${siteUrl.replace(/\/$/, "")}/downloads/desktop-release.json`
  const remoteResponse = await fetch(remoteUrl, { cache: "no-store" }).catch(() => null)

  if (remoteResponse?.ok) {
    return (await remoteResponse.json()) as DesktopReleaseManifest
  }

  return null
}
