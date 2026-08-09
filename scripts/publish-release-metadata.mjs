import { createClient } from "@supabase/supabase-js"
import { readFileSync } from "node:fs"
import { basename, resolve } from "node:path"

const args = process.argv.slice(2)

function arg(name, fallback = "") {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] || fallback : fallback
}

const manifestPath = resolve(arg("--manifest", "public/downloads/desktop-release.json"))
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
const version = arg("--version", manifest.version)
const buildNumber = arg("--build-number", process.env.GITHUB_RUN_NUMBER || "")
const releaseChannel = arg("--channel", "stable")
const platformFilter = arg("--platform", "all")
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const requestId = `github-release-${process.env.GITHUB_RUN_ID || "local"}-${process.env.GITHUB_RUN_ATTEMPT || "1"}`

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error(
    "Release metadata publication requires the SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY GitHub Actions secrets."
  )
}
if (!version || !buildNumber) {
  throw new Error("Release metadata publication requires a version and build number.")
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const definitions = [
  { key: "mac", platform: "macos", architecture: manifest.mac?.architecture, artifactType: "dmg" },
  { key: "macX64", platform: "macos", architecture: "x64", artifactType: "dmg" },
  { key: "windows", platform: "windows", architecture: "x64", artifactType: "nsis" },
  { key: "windowsMsi", platform: "windows", architecture: "x64", artifactType: "msi" },
  { key: "windowsMsix", platform: "windows", architecture: "x64", artifactType: "msix" },
  { key: "windowsPortable", platform: "windows", architecture: "x64", artifactType: "portable_exe" },
  { key: "windowsPortableZip", platform: "windows", architecture: "x64", artifactType: "portable_zip" },
  { key: "windowsArm64", platform: "windows", architecture: "arm64", artifactType: "nsis" },
  { key: "windowsArm64Msi", platform: "windows", architecture: "arm64", artifactType: "msi" },
  { key: "windowsArm64Msix", platform: "windows", architecture: "arm64", artifactType: "msix" },
  { key: "windowsArm64Portable", platform: "windows", architecture: "arm64", artifactType: "portable_exe" },
  { key: "windowsArm64PortableZip", platform: "windows", architecture: "arm64", artifactType: "portable_zip" },
]

const artifacts = definitions
  .map((definition) => ({
    ...definition,
    installer: manifest[definition.key],
    channel: manifest[definition.key]?.releaseChannel || releaseChannel,
  }))
  .filter(
    ({ installer, platform }) =>
      installer && (platformFilter === "all" || platform === platformFilter)
  )

if (artifacts.length === 0) {
  throw new Error(`No ${platformFilter} installer metadata exists in the release manifest.`)
}

for (const entry of artifacts) {
  const { installer } = entry
  if (!["arm64", "x64"].includes(entry.architecture)) {
    throw new Error(`Architecture is missing or unsupported for ${entry.key}.`)
  }
  if (!installer.downloadUrl || !/^https:\/\//i.test(installer.downloadUrl)) {
    throw new Error(`A final public HTTPS download URL is required for ${entry.key}.`)
  }
  if (!installer.size || !/^[a-f0-9]{64}$/i.test(installer.sha256 || "")) {
    throw new Error(`Verified size and SHA-256 are required for ${entry.key}.`)
  }
  const productionTrusted =
    installer.signed === true &&
    (entry.platform === "windows" || installer.notarized === true)
  if (!productionTrusted && entry.channel !== "internal") {
    throw new Error(
      `${entry.key} is unsigned or unnotarized and can only be published as an internal/testing release.`
    )
  }
  const primaryUpdaterArtifact = ["mac", "macX64", "windows", "windowsArm64"].includes(entry.key)
  if (
    entry.channel !== "internal" &&
    primaryUpdaterArtifact &&
    (!installer.updaterUrl ||
      !installer.updaterSize ||
      !/^[a-f0-9]{64}$/i.test(installer.updaterSha256 || "") ||
      !installer.updateSignature ||
      installer.updaterSignatureVerified !== true)
  ) {
    throw new Error(`${entry.key} is missing verified Tauri v2 updater metadata and cannot be published as stable.`)
  }

  const response = await fetch(installer.downloadUrl, {
    method: "HEAD",
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`${entry.key} download returned HTTP ${response.status}.`)
  }
  const contentType = (response.headers.get("content-type") || "").toLowerCase()
  if (contentType.includes("text/html") || contentType.includes("application/json")) {
    throw new Error(`${entry.key} download returned a webpage or JSON response.`)
  }
}

const grouped = Map.groupBy(
  artifacts,
  (entry) => `${entry.platform}:${entry.architecture}:${entry.channel}`
)

for (const entries of grouped.values()) {
  const first = entries[0]
  const identity = {
    version,
    build_number: buildNumber,
    platform: first.platform,
    architecture: first.architecture,
    release_channel: first.channel,
  }
  const releaseResult = await supabase
    .from("desktop_releases")
    .upsert(
      {
        ...identity,
        release_status: "published",
        minimum_supported_version: manifest.minimumSupportedVersion || null,
        release_notes: Array.isArray(manifest.releaseNotes)
          ? manifest.releaseNotes.join("\n")
          : manifest.releaseNotes || null,
        rollout_percentage: 100,
        mandatory: Boolean(manifest.mandatory),
        mandatory_after: manifest.mandatoryAfter || null,
        active: true,
        published_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "version,build_number,platform,architecture,release_channel",
      }
    )
    .select("id")
    .single()
  if (releaseResult.error) throw releaseResult.error

  for (const entry of entries) {
    const installer = entry.installer
    const artifactResult = await supabase.from("release_artifacts").upsert(
      {
        release_id: releaseResult.data.id,
        artifact_type: entry.artifactType,
        file_name: installer.filename || basename(new URL(installer.downloadUrl).pathname),
        file_url: installer.downloadUrl,
        file_size: installer.size,
        sha256: installer.sha256.toLowerCase(),
        update_signature: installer.updateSignature || null,
        updater_url: installer.updaterUrl || null,
        updater_size: installer.updaterSize || null,
        updater_sha256: installer.updaterSha256?.toLowerCase() || null,
        updater_signature_status: installer.updaterSignatureVerified === true ? "valid" : "missing",
        signature_status: installer.signed === true ? "valid" : "invalid",
        notarization_status:
          entry.platform === "macos"
            ? installer.notarized === true
              ? "valid"
              : "invalid"
            : "not_applicable",
        code_signing_status: installer.signed === true ? "valid" : "invalid",
        validation_status: "valid",
        validated_at: new Date().toISOString(),
        validation_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "release_id,file_url" }
    )
    if (artifactResult.error) throw artifactResult.error
  }

  const audit = await supabase.from("admin_audit_logs").insert({
    admin_user_id: null,
    admin_email: "github-actions",
    action: "RELEASE_PUBLISHED_BY_CI",
    target_type: "desktop_release",
    target_id: releaseResult.data.id,
    previous_values: null,
    new_values: {
      ...identity,
      artifact_count: entries.length,
      checksums: entries.map((entry) => entry.installer.sha256),
      updater_checksums: entries.map((entry) => entry.installer.updaterSha256).filter(Boolean),
      source_commits: entries.map((entry) => entry.installer.buildCommit).filter(Boolean),
      build_timestamps: entries.map((entry) => entry.installer.buildTimestamp).filter(Boolean),
      artifact_urls: entries.map((entry) => entry.installer.downloadUrl),
    },
    request_id: requestId,
    result: "success",
  })
  if (audit.error) throw audit.error
}

console.log(`Published integrity-verified control-plane metadata for ${artifacts.length} installer artifacts.`)
