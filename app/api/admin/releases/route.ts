import "server-only"

import { z } from "zod"
import { requireAdminControlPlane, writeAdminAudit } from "@/lib/api/auth"
import {
  adminFail,
  adminOk,
  adminRange,
  adminSort,
  controlPlaneErrorMessage,
  csvResponse,
  parseAdminListQuery,
  unexpectedAdminError,
} from "@/lib/admin/control-plane"
import { validateInstallerCandidate } from "@/lib/releases/artifact-validation"
import { verifyUpdaterArtifact } from "@/lib/releases/updater-signature"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === "https:", "Artifact URL must use HTTPS.")

const createReleaseSchema = z.object({
  version: z.string().trim().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
  build_number: z.string().trim().min(1).max(40),
  platform: z.enum(["macos", "windows"]),
  architecture: z.enum(["arm64", "x64"]),
  release_channel: z.string().trim().min(2).max(40).default("stable"),
  publication_mode: z.enum(["cross-platform", "staged"]).default("cross-platform"),
  build_commit: z.string().trim().regex(/^[a-fA-F0-9]{40}$/),
  build_timestamp: z.string().datetime({ offset: true }),
  file_url: httpsUrl,
  file_size: z.coerce.number().int().min(1).optional(),
  sha256: z.string().trim().regex(/^[a-fA-F0-9]{64}$/).optional(),
  artifact_type: z.enum(["dmg", "nsis", "msi", "msix", "portable_exe", "portable_zip"]).optional(),
  file_name: z.string().trim().min(1).max(240).optional(),
  update_signature: z.string().trim().max(20000).optional(),
  updater_url: httpsUrl.optional(),
  updater_size: z.coerce.number().int().min(1).optional(),
  updater_sha256: z.string().trim().regex(/^[a-fA-F0-9]{64}$/).optional(),
  minimum_supported_version: z.string().trim().max(40).optional(),
  release_notes: z.string().trim().max(10000).optional(),
  rollout_percentage: z.coerce.number().int().min(0).max(100).default(100),
  mandatory: z.boolean().default(false),
  mandatory_after: z.string().datetime({ offset: true }).optional(),
})

const releaseActionSchema = z.object({
  id: z.string().uuid(),
  action: z.enum([
    "publish",
    "pause",
    "unpublish",
    "resume",
    "mark_mandatory",
    "set_rollout",
    "retire",
    "archive",
    "verify_artifact",
    "mark_manual",
    "mark_internal",
    "mark_stable",
  ]),
  rollout_percentage: z.coerce.number().int().min(0).max(100).optional(),
  mandatory: z.boolean().optional(),
})

type ReleaseRow = {
  id: string
  platform: "macos" | "windows"
  architecture: "arm64" | "x64"
  version: string
  build_number: string
  release_channel: string
  release_status: string
  active: boolean
  publication_mode?: "cross-platform" | "staged"
  trust_mode?: "internal" | "stable"
  build_commit?: string | null
  build_timestamp?: string | null
  release_artifacts?: Array<{
    id: string
    file_url: string
    file_size: number | null
    sha256: string | null
    validation_status: string
    signature_status: string
    notarization_status: string
    code_signing_status: string
    artifact_type?: string | null
    file_name?: string | null
    update_signature?: string | null
    updater_url?: string | null
    updater_size?: number | null
    updater_sha256?: string | null
    updater_signature_status?: string | null
  }>
}

function publicationError(release: ReleaseRow) {
  const artifacts = release.release_artifacts || []
  if (artifacts.length === 0) return `${release.platform} artifact unavailable.`
  const artifact = artifacts.find((entry) => entry.validation_status === "valid")
  if (!artifact) return `${release.platform} download artifact failed validation.`
  if (!/^[a-f0-9]{40}$/i.test(release.build_commit || "")) return `${release.platform} build commit provenance is missing.`
  if (Number.isNaN(Date.parse(release.build_timestamp || ""))) return `${release.platform} build timestamp provenance is missing.`
  for (const entry of artifacts) {
    if (entry.validation_status !== "valid") return `${release.platform} ${entry.artifact_type || "installer"} has not passed validation.`
    if (!entry.file_size || !/^[a-f0-9]{64}$/i.test(entry.sha256 || "")) {
      return `${release.platform} ${entry.artifact_type || "installer"} is missing size or SHA-256 metadata.`
    }
  }
  if (release.platform === "windows" && release.publication_mode !== "staged") {
    const kinds = new Set(artifacts.map((entry) => entry.artifact_type))
    if (!kinds.has("nsis") || !kinds.has("msi")) {
      return "Windows cross-platform publication requires validated NSIS and MSI artifacts."
    }
  }
  const productionTrusted =
    artifact.signature_status === "valid" &&
    artifact.code_signing_status === "valid" &&
    (release.platform === "windows" || artifact.notarization_status === "valid")
  const manualChannel = ["manual", "internal"].includes(release.release_channel)
  if (!productionTrusted && !manualChannel) {
    return "Unsigned or unnotarized builds can only be published as manual installation releases."
  }
  if (
    !manualChannel &&
    (!artifact.updater_url ||
      !artifact.updater_size ||
      !artifact.updater_sha256 ||
      !artifact.update_signature ||
      artifact.updater_signature_status !== "valid")
  ) {
    return "Stable releases require a present, SHA-256 validated, cryptographically verified updater artifact."
  }
  return null
}

function cohortPublicationError(releases: ReleaseRow[], publicationMode: "cross-platform" | "staged") {
  if (releases.length === 0) return "No release cohort was found."
  if (publicationMode === "cross-platform") {
    const platforms = new Set(releases.map((release) => release.platform))
    if (!platforms.has("macos")) return "The release cohort is missing a validated macOS artifact."
    if (!platforms.has("windows")) return "The release cohort is missing validated Windows artifacts."
  }
  const commits = new Set(releases.map((release) => release.build_commit).filter(Boolean))
  if (commits.size !== 1) return "Every platform in the release cohort must come from the same exact commit."
  for (const release of releases) {
    if (release.release_status !== "ready" && release.release_status !== "paused") {
      return `${release.platform} is ${release.release_status}; verify it until it is READY before publication.`
    }
    const error = publicationError(release)
    if (error) return error
  }
  return null
}

function inferredArtifactType(platform: ReleaseRow["platform"], fileName: string) {
  const lower = fileName.toLowerCase()
  if (platform === "macos") return lower.endsWith(".dmg") ? "dmg" : null
  if (lower.endsWith(".msi")) return "msi"
  if (lower.endsWith(".msix")) return "msix"
  if (lower.endsWith(".zip")) return "portable_zip"
  if (lower.includes("portable") && lower.endsWith(".exe")) return "portable_exe"
  if (lower.endsWith(".exe")) return "nsis"
  return null
}

async function verifyArtifact(
  artifact: NonNullable<ReleaseRow["release_artifacts"]>[number],
  release: ReleaseRow
) {
  const validation = await validateInstallerCandidate(
    {
      platform: release.platform,
      architecture: release.architecture,
      version: release.version,
      downloadUrl: artifact.file_url,
      filename: artifact.file_name,
      size: artifact.file_size,
      sha256: artifact.sha256,
      signed:
        artifact.signature_status === "valid" && artifact.code_signing_status === "valid",
      notarized:
        release.platform === "macos" && artifact.notarization_status === "valid",
      releaseChannel: release.release_channel,
      buildCommit: release.build_commit,
      buildTimestamp: release.build_timestamp,
    },
    { cache: false }
  )
  const actualFileName = validation.filename || artifact.file_name || ""
  const artifactType = inferredArtifactType(release.platform, actualFileName)
  let updaterVerification: Awaited<ReturnType<typeof verifyUpdaterArtifact>> | null = null
  let updaterError: string | null = null
  if (artifact.updater_url && artifact.updater_sha256 && artifact.update_signature) {
    try {
      updaterVerification = await verifyUpdaterArtifact({
        url: artifact.updater_url,
        sha256: artifact.updater_sha256,
        signature: artifact.update_signature,
        publicKey: process.env.BEZGROW_UPDATER_PUBLIC_KEY,
      })
    } catch (error) {
      updaterError = error instanceof Error ? error.message : "Updater signature validation failed."
    }
  } else {
    updaterError = "Updater URL, SHA-256, or signature is missing."
  }
  return {
    artifact_type: artifact.artifact_type || artifactType,
    file_name: artifact.file_name || actualFileName,
    file_size: validation.size,
    sha256: artifact.sha256 || validation.sha256,
    validation_status: validation.available
      ? "valid"
      : /HTTP 404|not found|missing/i.test(validation.blockedReason || "")
        ? "missing"
        : "invalid",
    validation_error: validation.blockedReason || updaterError,
    updater_size: updaterVerification?.size || artifact.updater_size || null,
    updater_sha256: updaterVerification?.sha256 || artifact.updater_sha256 || null,
    updater_signature_status: updaterVerification?.signatureValid ? "valid" : updaterError ? "invalid" : "missing",
    validated_at: new Date().toISOString(),
  }
}

export async function GET(request: Request) {
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context

  try {
    const list = parseAdminListQuery(request)
    const { from, to } = adminRange(list)
    const exportMode = list.format === "csv"
    const sort = adminSort(
      list,
      ["created_at", "updated_at", "published_at", "version", "build_number", "platform", "release_status"],
      "created_at"
    )
    let query = adminSupabase
      .from("desktop_releases")
      .select("*,release_artifacts(*)", { count: "exact" })
      .order(sort.column, { ascending: sort.ascending })
    if (list.search) query = query.or(`version.ilike.%${list.search}%,build_number.ilike.%${list.search}%`)
    if (list.status) query = query.eq("release_status", list.status)
    if (list.platform) query = query.eq("platform", list.platform)
    if (list.channel) query = query.eq("release_channel", list.channel)
    query = exportMode ? query.limit(10000) : query.range(from, to)
    const result = await query
    if (result.error) {
      return adminFail(context, controlPlaneErrorMessage(result.error, "Releases failed to load."), 500)
    }
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const updateChecks = await adminSupabase
      .from("device_checkins")
      .select("update_check_result,reported_at,registered_devices(platform,architecture)")
      .gte("reported_at", since)
      .not("update_check_result", "is", null)
      .limit(10000)
    const updateStats = new Map<string, { checks: number; failures: number; available: number }>()
    if (!updateChecks.error) {
      for (const checkin of updateChecks.data || []) {
        const relation = checkin.registered_devices
        const device = (Array.isArray(relation) ? relation[0] : relation) as { platform?: string; architecture?: string } | null
        if (!device?.platform || !device.architecture) continue
        const key = `${device.platform}:${device.architecture}`
        const stats = updateStats.get(key) || { checks: 0, failures: 0, available: 0 }
        stats.checks += 1
        if (checkin.update_check_result === "failed") stats.failures += 1
        if (checkin.update_check_result === "update_available") stats.available += 1
        updateStats.set(key, stats)
      }
    }
    const rows = (result.data || []).map((release) => {
      const stats = updateStats.get(`${release.platform}:${release.architecture}`) || { checks: 0, failures: 0, available: 0 }
      return { ...release, update_checks_7d: stats.checks, update_failures_7d: stats.failures, update_available_7d: stats.available }
    })
    if (exportMode) {
      const data = rows.map((release) => {
        const artifact = Array.isArray(release.release_artifacts) ? release.release_artifacts[0] : null
        return {
          ...release,
          file_url: artifact?.file_url || null,
          file_size: artifact?.file_size || null,
          sha256: artifact?.sha256 || null,
          validation_status: artifact?.validation_status || null,
          signature_status: artifact?.signature_status || null,
          notarization_status: artifact?.notarization_status || null,
          code_signing_status: artifact?.code_signing_status || null,
          updater_url: artifact?.updater_url || null,
          updater_size: artifact?.updater_size || null,
          updater_sha256: artifact?.updater_sha256 || null,
          updater_signature_status: artifact?.updater_signature_status || null,
        }
      })
      return csvResponse(
        `bezgrow-desktop-releases-${new Date().toISOString().slice(0, 10)}.csv`,
        [
          "id",
          "version",
          "build_number",
          "platform",
          "architecture",
          "release_channel",
          "release_status",
          "minimum_supported_version",
          "rollout_percentage",
          "mandatory",
          "active",
          "file_url",
          "file_size",
          "sha256",
          "artifact_type",
          "file_name",
          "update_signature",
          "updater_url",
          "updater_size",
          "updater_sha256",
          "updater_signature_status",
          "validation_status",
          "signature_status",
          "notarization_status",
          "code_signing_status",
          "published_at",
          "created_at",
          "updated_at",
          "update_checks_7d",
          "update_failures_7d",
          "update_available_7d",
        ],
        data
      )
    }
    return adminOk(context, {
      data: rows,
      pagination: { page: list.page, limit: list.limit, total: result.count || 0 },
      publicationPolicy:
        "Validated manual installation artifacts may be downloaded with trust warnings. Stable production releases additionally require code signing and macOS notarization.",
    })
  } catch (error) {
    return unexpectedAdminError(context, error, "Releases failed to load.")
  }
}

export async function POST(request: Request) {
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context
  const parsed = createReleaseSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return adminFail(context, parsed.error.issues[0]?.message || "Invalid release.", 422)

  try {
    const input = parsed.data
    const release = await adminSupabase
      .from("desktop_releases")
      .insert({
        version: input.version,
        build_number: input.build_number,
        platform: input.platform,
        architecture: input.architecture,
        release_channel: input.release_channel,
        release_status: "draft",
        publication_mode: input.publication_mode,
        trust_mode: ["manual", "internal"].includes(input.release_channel) ? "internal" : "stable",
        build_commit: input.build_commit.toLowerCase(),
        build_timestamp: input.build_timestamp,
        minimum_supported_version: input.minimum_supported_version || null,
        release_notes: input.release_notes || null,
        rollout_percentage: input.rollout_percentage,
        mandatory: input.mandatory,
        mandatory_after: input.mandatory_after || null,
        active: false,
        created_by_admin_id: context.adminUserId,
      })
      .select("*")
      .single()
    if (release.error) throw release.error

    const artifact = await adminSupabase
      .from("release_artifacts")
      .insert({
        release_id: release.data.id,
        file_url: input.file_url,
        file_size: input.file_size || null,
        sha256: input.sha256?.toLowerCase() || null,
        artifact_type:
          input.artifact_type ||
          inferredArtifactType(input.platform, input.file_name || new URL(input.file_url).pathname),
        file_name: input.file_name || decodeURIComponent(new URL(input.file_url).pathname.split("/").pop() || ""),
        update_signature: input.update_signature || null,
        updater_url: input.updater_url || null,
        updater_size: input.updater_size || null,
        updater_sha256: input.updater_sha256?.toLowerCase() || null,
        updater_signature_status: "pending",
        signature_status: "pending",
        notarization_status: input.platform === "windows" ? "not_applicable" : "pending",
        code_signing_status: "pending",
        validation_status: "pending",
      })
      .select("*")
      .single()
    if (artifact.error) throw artifact.error

    await writeAdminAudit(context, {
      action: "RELEASE_DRAFT_CREATED",
      targetType: "desktop_release",
      targetId: release.data.id,
      newValues: { release: release.data, artifact: artifact.data },
    })
    return adminOk(context, { release: { ...release.data, release_artifacts: [artifact.data] } })
  } catch (error) {
    return unexpectedAdminError(context, error, "Release draft could not be created.")
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context
  const parsed = releaseActionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return adminFail(context, parsed.error.issues[0]?.message || "Invalid release action.", 422)

  try {
    const input = parsed.data
    const current = await adminSupabase
      .from("desktop_releases")
      .select("*,release_artifacts(*)")
      .eq("id", input.id)
      .maybeSingle()
    if (current.error) throw current.error
    if (!current.data) return adminFail(context, "Release was not found.", 404)
    const release = current.data as ReleaseRow

    if (input.action === "verify_artifact") {
      const artifact = release.release_artifacts?.[0]
      if (!artifact) return adminFail(context, "Release artifact unavailable.", 404)
      const validating = await adminSupabase
        .from("desktop_releases")
        .update({ release_status: "validating", updated_at: new Date().toISOString() })
        .eq("id", release.id)
      if (validating.error) throw validating.error
      const verification = await verifyArtifact(artifact, release)
      const result = await adminSupabase
        .from("release_artifacts")
        .update(verification)
        .eq("id", artifact.id)
        .select("*")
        .single()
      if (result.error) throw result.error
      const verifiedStatus = result.data.validation_status === "valid" ? "ready" : "failed"
      const statusResult = await adminSupabase
        .from("desktop_releases")
        .update({ release_status: verifiedStatus, updated_at: new Date().toISOString() })
        .eq("id", release.id)
      if (statusResult.error) throw statusResult.error
      await writeAdminAudit(context, {
        action: "RELEASE_ARTIFACT_VERIFIED",
        targetType: "release_artifact",
        targetId: artifact.id,
        previousValues: artifact,
        newValues: result.data,
        result: result.data.validation_status === "valid" ? "success" : "failure",
      })
      return adminOk(context, { artifact: result.data })
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (input.action === "publish" || input.action === "resume") {
      const publicationMode = release.publication_mode || "cross-platform"
      let cohortQuery = adminSupabase
        .from("desktop_releases")
        .select("*,release_artifacts(*)")
        .eq("version", release.version)
        .eq("build_number", release.build_number)
        .eq("release_channel", release.release_channel)
      if (publicationMode === "staged") cohortQuery = cohortQuery.eq("id", release.id)
      const cohortResult = await cohortQuery
      if (cohortResult.error) throw cohortResult.error
      const cohort = (cohortResult.data || []) as ReleaseRow[]
      const error = cohortPublicationError(cohort, publicationMode)
      if (error) return adminFail(context, error, 422)
      const publishedAt = new Date().toISOString()
      const ids = cohort.map((entry) => entry.id)
      const promoted = await adminSupabase
        .from("desktop_releases")
        .update({ release_status: "published", active: true, published_at: publishedAt, updated_at: publishedAt })
        .in("id", ids)
        .select("*")
      if (promoted.error) throw promoted.error
      if ((promoted.data || []).length !== ids.length) {
        return adminFail(context, "Atomic release promotion did not update the complete cohort.", 500)
      }
      await writeAdminAudit(context, {
        action: input.action === "publish" ? "RELEASE_COHORT_PUBLISHED" : "RELEASE_COHORT_RESUMED",
        targetType: "desktop_release",
        targetId: release.id,
        previousValues: { cohort },
        newValues: { release_ids: ids, version: release.version, publication_mode: publicationMode, published_at: publishedAt },
      })
      return adminOk(context, { releases: promoted.data })
    }
    if (input.action === "pause") {
      updates.release_status = "paused"
      updates.active = false
    }
    if (input.action === "unpublish") {
      updates.release_status = "paused"
      updates.active = false
    }
    if (input.action === "retire") {
      updates.release_status = "retired"
      updates.active = false
    }
    if (input.action === "archive") {
      updates.release_status = "retired"
      updates.active = false
    }
    if (input.action === "mark_mandatory") updates.mandatory = input.mandatory ?? true
    if (input.action === "set_rollout") {
      if (input.rollout_percentage === undefined) return adminFail(context, "Rollout percentage is required.", 422)
      updates.rollout_percentage = input.rollout_percentage
    }
    if (input.action === "mark_internal") {
      updates.release_channel = "internal"
      updates.trust_mode = "internal"
    }
    if (input.action === "mark_manual") {
      updates.release_channel = "manual"
      updates.trust_mode = "internal"
    }
    if (input.action === "mark_stable") {
      updates.release_channel = "stable"
      updates.trust_mode = "stable"
    }

    let targetIds = [input.id]
    if ((release.publication_mode || "cross-platform") === "cross-platform") {
      const cohortIds = await adminSupabase
        .from("desktop_releases")
        .select("id")
        .eq("version", release.version)
        .eq("build_number", release.build_number)
        .eq("release_channel", release.release_channel)
      if (cohortIds.error) throw cohortIds.error
      targetIds = (cohortIds.data || []).map((entry) => entry.id)
      if (targetIds.length === 0) return adminFail(context, "Release cohort was not found.", 404)
    }
    const result = await adminSupabase
      .from("desktop_releases")
      .update(updates)
      .in("id", targetIds)
      .select("*")
    if (result.error) throw result.error
    const actionMap: Record<string, string> = {
      publish: "RELEASE_PUBLISHED",
      pause: "RELEASE_PAUSED",
      unpublish: "RELEASE_UNPUBLISHED",
      resume: "RELEASE_RESUMED",
      mark_mandatory: "RELEASE_MANDATORY_CHANGED",
      set_rollout: "RELEASE_ROLLOUT_CHANGED",
      retire: "RELEASE_RETIRED",
      archive: "RELEASE_ARCHIVED",
      mark_internal: "RELEASE_MARKED_INTERNAL",
      mark_manual: "RELEASE_MARKED_MANUAL",
      mark_stable: "RELEASE_MARKED_STABLE",
    }
    await writeAdminAudit(context, {
      action: actionMap[input.action],
      targetType: "desktop_release",
      targetId: input.id,
      previousValues: current.data,
      newValues: { releases: result.data, release_ids: targetIds },
    })
    return adminOk(context, {
      release: (result.data || []).find((entry) => entry.id === input.id) || null,
      releases: result.data || [],
    })
  } catch (error) {
    return unexpectedAdminError(context, error, "Release action failed.")
  }
}
