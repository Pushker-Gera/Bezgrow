export const RELEASE_STATES = [
  "draft",
  "building",
  "validating",
  "ready",
  "published",
  "failed",
  "paused",
  "retired",
] as const

export type ReleaseState = (typeof RELEASE_STATES)[number]
export type ReleaseTrustMode = "internal" | "stable"

export type PublishedReleaseCandidate = {
  version: string | null
  available: boolean
  publicationStatus: string | null
  productionRecommended: boolean
  checksumVerified: boolean
  metadataValid: boolean
  releaseChannel: string
}

export function compareReleaseVersions(left: string, right: string) {
  const parse = (value: string) => {
    const [core, prerelease = ""] = value.replace(/^v/, "").split("-", 2)
    return { parts: core.split(".").map((part) => Number(part)), prerelease }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.parts.length, b.parts.length); index += 1) {
    const difference = (b.parts[index] || 0) - (a.parts[index] || 0)
    if (difference !== 0) return difference
  }
  if (!a.prerelease && b.prerelease) return -1
  if (a.prerelease && !b.prerelease) return 1
  return b.prerelease.localeCompare(a.prerelease)
}

export function isExplicitlyPublished(candidate: { publicationStatus?: string | null }) {
  return candidate.publicationStatus?.toLowerCase() === "published"
}

function trustScore(candidate: PublishedReleaseCandidate) {
  return (
    (candidate.productionRecommended ? 100 : 0) +
    (candidate.releaseChannel === "stable" ? 20 : 0) +
    (candidate.checksumVerified ? 10 : 0) +
    (candidate.metadataValid ? 5 : 0)
  )
}

/**
 * Public consumers deliberately know nothing about the source/package version.
 * A source bump is a build concern; only an explicitly published, validated
 * artifact can change the downloadable version.
 */
export function selectLatestPublishedInstaller<T extends PublishedReleaseCandidate>(
  candidates: T[]
): T | null {
  return (
    candidates
      .filter((candidate) => isExplicitlyPublished(candidate) && candidate.available && candidate.version)
      .sort((left, right) => {
        const versionOrder = compareReleaseVersions(left.version || "0.0.0", right.version || "0.0.0")
        return versionOrder || trustScore(right) - trustScore(left)
      })[0] || null
  )
}

export function commonPublishedVersion(
  candidates: Array<{ available: boolean; version: string | null }>
) {
  const versions = [...new Set(candidates.filter((candidate) => candidate.available).map((candidate) => candidate.version).filter(Boolean))]
  return versions.length === 1 ? versions[0] : null
}
