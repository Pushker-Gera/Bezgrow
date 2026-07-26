import "server-only"

import { createHash } from "node:crypto"
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
import { isPublicHttpsUrl } from "@/lib/security/public-url"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === "https:", "Artifact URL must use HTTPS.")

const createReleaseSchema = z.object({
  version: z.string().trim().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
  build_number: z.string().trim().min(1).max(40),
  platform: z.enum(["macos", "windows"]),
  architecture: z.enum(["arm64", "x64"]),
  release_channel: z.string().trim().min(2).max(40).default("stable"),
  file_url: httpsUrl,
  file_size: z.coerce.number().int().min(1).optional(),
  sha256: z.string().trim().regex(/^[a-fA-F0-9]{64}$/).optional(),
  artifact_type: z.enum(["dmg", "nsis", "msi", "portable_exe", "portable_zip"]).optional(),
  file_name: z.string().trim().min(1).max(240).optional(),
  update_signature: z.string().trim().max(20000).optional(),
  minimum_supported_version: z.string().trim().max(40).optional(),
  release_notes: z.string().trim().max(10000).optional(),
  rollout_percentage: z.coerce.number().int().min(0).max(100).default(100),
  mandatory: z.boolean().default(false),
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
  ]),
  rollout_percentage: z.coerce.number().int().min(0).max(100).optional(),
  mandatory: z.boolean().optional(),
})

type ReleaseRow = {
  id: string
  platform: "macos" | "windows"
  architecture: "arm64" | "x64"
  release_status: string
  active: boolean
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
  }>
}

function publicationError(release: ReleaseRow) {
  const artifact = release.release_artifacts?.[0]
  if (!artifact) return "Release artifact unavailable."
  if (artifact.validation_status !== "valid") return "Download artifact failed validation."
  if (artifact.signature_status !== "valid") return "Release signature has not been validated."
  if (artifact.code_signing_status !== "valid") return "Code signing has not been validated."
  if (release.platform === "macos" && artifact.notarization_status !== "valid") {
    return "macOS release has not passed notarization."
  }
  return null
}

function inferredArtifactType(platform: ReleaseRow["platform"], fileName: string) {
  const lower = fileName.toLowerCase()
  if (platform === "macos") return lower.endsWith(".dmg") ? "dmg" : null
  if (lower.endsWith(".msi")) return "msi"
  if (lower.endsWith(".zip")) return "portable_zip"
  if (lower.includes("portable") && lower.endsWith(".exe")) return "portable_exe"
  if (lower.endsWith(".exe")) return "nsis"
  return null
}

async function verifyArtifact(
  artifact: NonNullable<ReleaseRow["release_artifacts"]>[number],
  release: ReleaseRow
) {
  const url = new URL(artifact.file_url)
  if (!(await isPublicHttpsUrl(url))) {
    return {
      validation_status: "invalid",
      validation_error: "Artifact URL is not an allowed public HTTPS location.",
      validated_at: new Date().toISOString(),
    }
  }

  const response = await fetch(artifact.file_url, {
    method: "GET",
    cache: "no-store",
    redirect: "manual",
    headers: { Range: "bytes=0-" },
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status >= 300 && response.status < 400) {
    return {
      validation_status: "invalid",
      validation_error: "Artifact redirects are not accepted; use the final public HTTPS URL.",
      validated_at: new Date().toISOString(),
    }
  }
  if (!response.ok) {
    return {
      validation_status: response.status === 404 ? "missing" : "invalid",
      validation_error: `Artifact returned HTTP ${response.status}.`,
      validated_at: new Date().toISOString(),
    }
  }
  const contentType = (response.headers.get("content-type") || "").toLowerCase()
  if (
    contentType.includes("text/html") ||
    contentType.includes("application/json") ||
    contentType.startsWith("text/")
  ) {
    return {
      validation_status: "invalid",
      validation_error: "Artifact URL returned a webpage or JSON response instead of an installer.",
      validated_at: new Date().toISOString(),
    }
  }

  if (!response.body) {
    return {
      validation_status: "invalid",
      validation_error: "Artifact response did not include a readable body.",
      validated_at: new Date().toISOString(),
    }
  }

  const hash = createHash("sha256")
  let actualSize = 0
  let firstBytes = Buffer.alloc(0)
  let trailingBytes = Buffer.alloc(0)
  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const bytes = Buffer.from(value)
    if (firstBytes.byteLength < 32) {
      firstBytes = Buffer.concat([firstBytes, bytes]).subarray(0, 32)
    }
    trailingBytes = Buffer.concat([trailingBytes, bytes]).subarray(-512)
    actualSize += bytes.byteLength
    if (actualSize > 2 * 1024 * 1024 * 1024) {
      await reader.cancel()
      return {
        validation_status: "invalid",
        validation_error: "Artifact exceeds the 2 GB validation limit.",
        validated_at: new Date().toISOString(),
      }
    }
    hash.update(bytes)
  }
  const actualHash = hash.digest("hex")
  const disposition = response.headers.get("content-disposition") || ""
  const dispositionMatch = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)
  const urlFileName = decodeURIComponent(url.pathname.split("/").pop() || "")
  const actualFileName = (dispositionMatch?.[1] || urlFileName).replaceAll('"', "").trim()
  const artifactType = inferredArtifactType(release.platform, actualFileName)
  const expectedType = artifact.artifact_type || artifactType
  const platformMatches =
    release.platform === "macos"
      ? artifactType === "dmg"
      : artifactType === "nsis" ||
        artifactType === "msi" ||
        artifactType === "portable_exe" ||
        artifactType === "portable_zip"
  const magicMatches =
    artifactType === "dmg"
      ? trailingBytes.includes(Buffer.from("koly"))
      : artifactType === "msi"
        ? firstBytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
        : artifactType === "nsis" || artifactType === "portable_exe"
          ? firstBytes.subarray(0, 2).toString("ascii") === "MZ"
          : artifactType === "portable_zip"
            ? firstBytes.subarray(0, 2).toString("ascii") === "PK"
            : false
  const sizeMatches = !artifact.file_size || Number(artifact.file_size) === actualSize
  const hashMatches = !artifact.sha256 || artifact.sha256.toLowerCase() === actualHash
  const typeMatches = !artifact.artifact_type || artifact.artifact_type === artifactType
  const valid = sizeMatches && hashMatches && platformMatches && magicMatches && typeMatches
  return {
    artifact_type: expectedType,
    file_name: artifact.file_name || actualFileName,
    file_size: actualSize,
    sha256: artifact.sha256 || actualHash,
    validation_status: valid ? "valid" : "invalid",
    validation_error: !sizeMatches
      ? "Artifact size does not match release metadata."
      : !hashMatches
        ? "Artifact SHA-256 does not match release metadata."
        : !platformMatches || !typeMatches
          ? "Artifact type does not match the selected platform."
          : !magicMatches
            ? "Artifact file signature does not match its installer type."
        : null,
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
    if (exportMode) {
      const data = (result.data || []).map((release) => {
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
          "validation_status",
          "signature_status",
          "notarization_status",
          "code_signing_status",
          "published_at",
          "created_at",
          "updated_at",
        ],
        data
      )
    }
    return adminOk(context, {
      data: result.data || [],
      pagination: { page: list.page, limit: list.limit, total: result.count || 0 },
      publicationPolicy:
        "Public downloads require a validated artifact, signature, and code signing. macOS also requires notarization.",
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
        minimum_supported_version: input.minimum_supported_version || null,
        release_notes: input.release_notes || null,
        rollout_percentage: input.rollout_percentage,
        mandatory: input.mandatory,
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
      const verification = await verifyArtifact(artifact, release)
      const result = await adminSupabase
        .from("release_artifacts")
        .update(verification)
        .eq("id", artifact.id)
        .select("*")
        .single()
      if (result.error) throw result.error
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
    if (input.action === "publish") {
      const error = publicationError(release)
      if (error) return adminFail(context, error, 422)
      updates.release_status = "published"
      updates.active = true
      updates.published_at = new Date().toISOString()
    }
    if (input.action === "pause") {
      updates.release_status = "paused"
      updates.active = false
    }
    if (input.action === "unpublish") {
      updates.release_status = "paused"
      updates.active = false
    }
    if (input.action === "resume") {
      const error = publicationError(release)
      if (error) return adminFail(context, error, 422)
      updates.release_status = "published"
      updates.active = true
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

    const result = await adminSupabase.from("desktop_releases").update(updates).eq("id", input.id).select("*").single()
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
    }
    await writeAdminAudit(context, {
      action: actionMap[input.action],
      targetType: "desktop_release",
      targetId: input.id,
      previousValues: current.data,
      newValues: result.data,
    })
    return adminOk(context, { release: result.data })
  } catch (error) {
    return unexpectedAdminError(context, error, "Release action failed.")
  }
}
