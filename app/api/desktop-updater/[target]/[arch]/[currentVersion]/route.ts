import "server-only"

import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

type RouteContext = { params: Promise<{ target: string; arch: string; currentVersion: string }> }

function noUpdate() {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } })
}

function platformForTarget(value: string) {
  const target = value.toLowerCase()
  if (target.includes("windows")) return "windows" as const
  if (target.includes("darwin") || target.includes("macos")) return "macos" as const
  return null
}

function architectureForTarget(value: string) {
  const arch = value.toLowerCase()
  if (["x64", "x86_64", "amd64"].includes(arch)) return "x64" as const
  if (["arm64", "aarch64"].includes(arch)) return "arm64" as const
  return null
}

function newerThan(left: string, right: string) {
  const parts = (value: string) => value.replace(/^v/, "").split(/[+-]/, 1)[0].split(".").map(Number)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0)
  }
  return false
}

function trustedUpdaterUrl(value: unknown) {
  if (typeof value !== "string" || !value) return false
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false
    const configuredHost = (() => {
      try { return new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://www.bezgrow.com").hostname }
      catch { return "www.bezgrow.com" }
    })()
    return parsed.hostname === configuredHost || parsed.hostname === "bezgrow.com" || parsed.hostname.endsWith(".bezgrow.com") || parsed.hostname === "github.com" || parsed.hostname === "objects.githubusercontent.com"
  } catch {
    return false
  }
}

function validPublicationDate(value: unknown) {
  if (typeof value !== "string" || !value) return false
  const publishedAt = Date.parse(value)
  return Number.isFinite(publishedAt) && publishedAt <= Date.now() + 5 * 60_000
}

export async function GET(_request: Request, context: RouteContext) {
  const { target, arch, currentVersion } = await context.params
  const platform = platformForTarget(target)
  const architecture = architectureForTarget(arch)
  if (!platform || !architecture || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(currentVersion)) return noUpdate()

  const result = await adminSupabase
    .from("desktop_releases")
    .select("id,version,release_notes,published_at,minimum_supported_version,mandatory,mandatory_after,release_artifacts(updater_url,updater_size,updater_sha256,update_signature,updater_signature_status,validation_status,signature_status,notarization_status,code_signing_status)")
    .eq("platform", platform)
    .eq("architecture", architecture)
    .eq("release_channel", "stable")
    .eq("release_status", "published")
    .eq("active", true)
    .eq("rollout_percentage", 100)
    .lte("published_at", new Date().toISOString())
    .order("published_at", { ascending: false })
    .limit(10)

  if (result.error) {
    console.error("[desktop-updater] release lookup failed", { code: result.error.code, message: result.error.message })
    return noUpdate()
  }

  const release = (result.data || []).find((candidate) => {
    const artifact = Array.isArray(candidate.release_artifacts)
      ? candidate.release_artifacts.find((entry) => entry.updater_signature_status === "valid" && entry.updater_url)
      : null
    return (
      newerThan(candidate.version, currentVersion) &&
      artifact?.validation_status === "valid" &&
      artifact.signature_status === "valid" &&
      artifact.code_signing_status === "valid" &&
      artifact.updater_signature_status === "valid" &&
      trustedUpdaterUrl(artifact.updater_url) &&
      typeof artifact.updater_sha256 === "string" && /^[a-f0-9]{64}$/i.test(artifact.updater_sha256) &&
      typeof artifact.updater_size === "number" && artifact.updater_size > 0 && artifact.updater_size <= 3 * 1024 * 1024 * 1024 &&
      typeof artifact.update_signature === "string" && artifact.update_signature.length >= 80 &&
      validPublicationDate(candidate.published_at) &&
      (platform === "windows" || artifact.notarization_status === "valid")
    )
  })
  if (!release) return noUpdate()
  const artifact = Array.isArray(release.release_artifacts)
    ? release.release_artifacts.find((entry) => entry.updater_signature_status === "valid" && entry.updater_url)
    : null
  if (!artifact?.updater_url || !artifact.update_signature) return noUpdate()

  return Response.json(
    {
      version: release.version,
      pub_date: release.published_at,
      url: artifact.updater_url,
      signature: artifact.update_signature,
      notes: release.release_notes || "",
      size: artifact.updater_size,
      sha256: artifact.updater_sha256,
      platform,
      architecture,
      minimum_supported_version: release.minimum_supported_version,
      mandatory: release.mandatory,
      mandatory_after: release.mandatory_after,
      restart_required: true,
      publication_status: "published",
    },
    { headers: { "Cache-Control": "no-store, max-age=0", "Content-Type": "application/json" } }
  )
}
