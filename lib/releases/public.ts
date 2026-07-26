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
  version: string
  build_number: string
  platform: "macos" | "windows"
  architecture: "arm64" | "x64"
  release_channel: string
  minimum_supported_version: string | null
  release_notes: string | null
  mandatory: boolean
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
  }>
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
  }
}

export async function getPublicDesktopReleaseManifest(): Promise<PublicDesktopReleaseManifest | null> {
  const result = await adminSupabase
    .from("desktop_releases")
    .select("version,build_number,platform,architecture,release_channel,minimum_supported_version,release_notes,mandatory,published_at,release_artifacts(file_url,file_size,sha256,validation_status,signature_status,notarization_status,code_signing_status,validated_at)")
    .eq("release_status", "published")
    .eq("active", true)
    .eq("release_channel", "stable")
    .eq("rollout_percentage", 100)
    .order("published_at", { ascending: false })
    .limit(16)

  if (result.error) return null

  const manifest: PublicDesktopReleaseManifest = {
    generatedAt: new Date(0).toISOString(),
    releaseNotes: [],
  }

  for (const row of (result.data || []) as ReleaseRow[]) {
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

  return manifest.mac || manifest.macX64 || manifest.windows || manifest.windowsArm64
    ? manifest
    : null
}
