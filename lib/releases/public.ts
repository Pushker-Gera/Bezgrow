import "server-only"

import { adminSupabase } from "@/lib/supabase/admin"

export type PublicInstallerRelease = {
  downloadUrl: string
  version: string
  buildNumber: string
  size: number
  sha256: string
  signed: true
  notarized?: true
  generatedAt: string
  mandatory: boolean
  minimumSupportedVersion: string | null
  releaseChannel: string
  architecture: "arm64" | "x64"
}

export type PublicDesktopReleaseManifest = {
  version?: string
  generatedAt: string
  releaseNotes: string[]
  mac?: PublicInstallerRelease
  macX64?: PublicInstallerRelease
  windows?: PublicInstallerRelease
  windowsArm64?: PublicInstallerRelease
}

type ReleaseRow = {
  id?: string
  version: string
  build_number: string
  platform: "macos" | "windows"
  architecture: "arm64" | "x64"
  release_channel: string
  minimum_supported_version: string | null
  release_notes: string | null
  mandatory: boolean
  rollout_percentage?: number
  release_status?: string
  active?: boolean
  created_at?: string
  published_at: string | null
  release_artifacts?: Array<{
    file_url: string
    file_size: number | null
    sha256: string | null
    validation_status: string
    signature_status: string
    notarization_status: string
    code_signing_status: string
    validated_at: string | null
    validation_error?: string | null
  }>
}

export type PublicReleaseAvailability = {
  status:
    | "available"
    | "no_release"
    | "internal_release"
    | "unpublished"
    | "artifact_missing"
    | "checksum_mismatch"
    | "artifact_invalid"
    | "signing_incomplete"
    | "notarization_incomplete"
    | "rollout_restricted"
  reason: string
  version: string | null
  architecture: "arm64" | "x64" | null
  releaseNotes: string | null
  installer: PublicInstallerRelease | null
}

export type PublicDesktopReleaseAvailability = {
  manifest: PublicDesktopReleaseManifest | null
  mac: PublicReleaseAvailability
  windows: PublicReleaseAvailability
}

function publicArtifact(release: ReleaseRow): PublicInstallerRelease | null {
  const artifact = release.release_artifacts?.[0]
  if (
    !artifact ||
    artifact.validation_status !== "valid" ||
    artifact.signature_status !== "valid" ||
    artifact.code_signing_status !== "valid" ||
    (release.platform === "macos" && artifact.notarization_status !== "valid") ||
    !artifact.file_size ||
    !artifact.sha256
  ) {
    return null
  }

  try {
    const url = new URL(artifact.file_url)
    if (url.protocol !== "https:" || url.username || url.password) return null
  } catch {
    return null
  }

  return {
    downloadUrl: artifact.file_url,
    version: release.version,
    buildNumber: release.build_number,
    size: Number(artifact.file_size),
    sha256: artifact.sha256,
    signed: true,
    ...(release.platform === "macos" ? { notarized: true as const } : {}),
    generatedAt: artifact.validated_at || release.published_at || new Date(0).toISOString(),
    mandatory: release.mandatory,
    minimumSupportedVersion: release.minimum_supported_version,
    releaseChannel: release.release_channel,
    architecture: release.architecture,
  }
}

function unavailable(
  status: PublicReleaseAvailability["status"],
  reason: string,
  release?: ReleaseRow
): PublicReleaseAvailability {
  return {
    status,
    reason,
    version: release?.version || null,
    architecture: release?.architecture || null,
    releaseNotes: release?.release_notes || null,
    installer: null,
  }
}

function releaseAvailability(
  release: ReleaseRow | undefined,
  platform: "macos" | "windows"
): PublicReleaseAvailability {
  if (!release) {
    return unavailable(
      "no_release",
      platform === "macos"
        ? "No macOS release metadata has been created."
        : "No Windows release metadata has been created."
    )
  }
  if (release.release_channel !== "stable") {
    return unavailable(
      "internal_release",
      `The latest ${platform === "macos" ? "macOS" : "Windows"} release is ${release.release_channel} only.`,
      release
    )
  }
  if (release.release_status !== "published" || !release.active || !release.published_at) {
    return unavailable(
      "unpublished",
      `The ${platform === "macos" ? "macOS" : "Windows"} release is not published.`,
      release
    )
  }
  if (Number(release.rollout_percentage ?? 0) !== 100) {
    return unavailable(
      "rollout_restricted",
      `The ${platform === "macos" ? "macOS" : "Windows"} release is not available to the full public rollout.`,
      release
    )
  }
  const artifact = release.release_artifacts?.[0]
  if (!artifact?.file_url) {
    return unavailable(
      "artifact_missing",
      `The published ${platform === "macos" ? "macOS" : "Windows"} release has no installer artifact.`,
      release
    )
  }
  if (
    artifact.validation_status === "invalid" &&
    /sha-?256|checksum|size does not match/i.test(artifact.validation_error || "")
  ) {
    return unavailable(
      "checksum_mismatch",
      `The ${platform === "macos" ? "macOS" : "Windows"} installer failed checksum or size validation.`,
      release
    )
  }
  if (artifact.validation_status !== "valid" || !artifact.file_size || !artifact.sha256) {
    return unavailable(
      artifact.validation_status === "missing" ? "artifact_missing" : "artifact_invalid",
      `The ${platform === "macos" ? "macOS" : "Windows"} installer has not passed artifact validation.`,
      release
    )
  }
  if (artifact.signature_status !== "valid" || artifact.code_signing_status !== "valid") {
    return unavailable(
      "signing_incomplete",
      `The ${platform === "macos" ? "macOS" : "Windows"} installer has not passed signing validation.`,
      release
    )
  }
  if (platform === "macos" && artifact.notarization_status !== "valid") {
    return unavailable(
      "notarization_incomplete",
      "The macOS installer has not passed Apple notarization.",
      release
    )
  }
  const installer = publicArtifact(release)
  if (!installer) {
    return unavailable(
      "artifact_invalid",
      `The ${platform === "macos" ? "macOS" : "Windows"} installer URL or metadata is invalid.`,
      release
    )
  }
  return {
    status: "available",
    reason: `${platform === "macos" ? "macOS" : "Windows"} installer verified and published.`,
    version: release.version,
    architecture: release.architecture,
    releaseNotes: release.release_notes,
    installer,
  }
}

export async function getDesktopReleaseAvailability(): Promise<PublicDesktopReleaseAvailability> {
  const result = await adminSupabase
    .from("desktop_releases")
    .select("id,version,build_number,platform,architecture,release_channel,release_status,active,rollout_percentage,minimum_supported_version,release_notes,mandatory,published_at,created_at,release_artifacts(file_url,file_size,sha256,validation_status,validation_error,signature_status,notarization_status,code_signing_status,validated_at)")
    .order("created_at", { ascending: false })
    .limit(64)

  if (result.error) {
    console.error("[public-release-availability]", {
      code: result.error.code,
      message: result.error.message,
    })
    return {
      manifest: null,
      mac: unavailable("artifact_invalid", "macOS release metadata could not be loaded."),
      windows: unavailable("artifact_invalid", "Windows release metadata could not be loaded."),
    }
  }

  const rows = (result.data || []) as ReleaseRow[]
  const macRows = rows.filter((row) => row.platform === "macos")
  const windowsRows = rows.filter((row) => row.platform === "windows")
  const preferred = (platformRows: ReleaseRow[]) =>
    platformRows.find(
      (row) =>
        row.release_channel === "stable" &&
        row.release_status === "published" &&
        row.active &&
        row.published_at
    ) ||
    platformRows.find((row) => row.release_channel === "stable") ||
    platformRows[0]
  const mac = releaseAvailability(preferred(macRows), "macos")
  const windows = releaseAvailability(preferred(windowsRows), "windows")

  const manifest: PublicDesktopReleaseManifest = {
    generatedAt: new Date(0).toISOString(),
    releaseNotes: [],
  }

  for (const row of rows) {
    if (
      row.release_status !== "published" ||
      !row.active ||
      row.release_channel !== "stable" ||
      Number(row.rollout_percentage ?? 0) !== 100
    ) {
      continue
    }
    const artifact = publicArtifact(row)
    if (!artifact) continue
    const key =
      row.platform === "macos"
        ? row.architecture === "arm64"
          ? "mac"
          : "macX64"
        : row.architecture === "arm64"
          ? "windowsArm64"
          : "windows"
    if (manifest[key]) continue
    manifest[key] = artifact
    if (!manifest.version) manifest.version = row.version
    if (Date.parse(artifact.generatedAt) > Date.parse(manifest.generatedAt)) {
      manifest.generatedAt = artifact.generatedAt
    }
    if (row.release_notes && !manifest.releaseNotes.includes(row.release_notes)) {
      manifest.releaseNotes.push(row.release_notes)
    }
  }

  return {
    manifest:
      manifest.mac || manifest.macX64 || manifest.windows || manifest.windowsArm64
        ? manifest
        : null,
    mac,
    windows,
  }
}

export async function getPublicDesktopReleaseManifest(): Promise<PublicDesktopReleaseManifest | null> {
  return (await getDesktopReleaseAvailability()).manifest
}
