import "server-only"

import { createHash } from "node:crypto"
import { z } from "zod"
import { authenticateDeviceReport } from "@/lib/device/report-auth"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const checkinSchema = z.object({
  license_key: z.string().trim().min(100).max(20000),
  device_id: z.string().trim().min(8).max(180),
  platform: z.enum(["macos", "windows"]),
  operating_system: z.string().trim().max(160),
  architecture: z.enum(["arm64", "x64"]),
  app_version: z.string().trim().min(1).max(40),
  release_channel: z.string().trim().min(1).max(40).default("stable"),
  update_check_result: z.enum(["success", "failed", "no_update", "update_available"]).optional(),
  diagnostics_available: z.boolean().default(false),
}).strict()

function compareVersions(left: string, right: string) {
  const parts = (value: string) => value.split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
  const leftParts = parts(left)
  const rightParts = parts(right)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  return 0
}

function isInRollout(deviceId: string, releaseId: string, percentage: number) {
  if (percentage >= 100) return true
  if (percentage <= 0) return false
  const bucket = Number.parseInt(createHash("sha256").update(`${releaseId}:${deviceId}`).digest("hex").slice(0, 8), 16) % 100
  return bucket < percentage
}

export async function POST(request: Request) {
  const parsed = checkinSchema.safeParse(await request.json().catch(() => null))
  const fallbackRequestId = crypto.randomUUID()
  if (!parsed.success) {
    return Response.json(
      { success: false, error: parsed.error.issues[0]?.message || "Invalid device report.", requestId: fallbackRequestId },
      { status: 422, headers: { "Cache-Control": "no-store", "X-Request-Id": fallbackRequestId } }
    )
  }

  const input = parsed.data
  const auth = await authenticateDeviceReport(request, {
    licenseKey: input.license_key,
    deviceId: input.device_id,
  })
  if (!auth.ok) {
    return Response.json(
      { success: false, error: auth.error, requestId: auth.requestId },
      { status: auth.status, headers: { "Cache-Control": "no-store", "X-Request-Id": auth.requestId } }
    )
  }
  const { requestId, license, device } = auth.context

  try {
    const now = new Date().toISOString()
    const deviceResult = await adminSupabase
      .from("registered_devices")
      .upsert(
        {
          id: device?.id,
          device_id: input.device_id,
          platform_customer_id: license.platform_customer_id,
          platform_business_id: license.platform_business_id,
          license_id: license.id,
          platform: input.platform,
          operating_system: input.operating_system,
          architecture: input.architecture,
          app_version: input.app_version,
          activation_date: device?.activation_date || now,
          last_reported_at: now,
          last_update_check_at: now,
          release_channel: input.release_channel,
          device_status: "active",
          diagnostics_available: input.diagnostics_available,
          updated_at: now,
        },
        { onConflict: "device_id" }
      )
      .select("*")
      .single()
    if (deviceResult.error) throw deviceResult.error

    const checkin = await adminSupabase.from("device_checkins").insert({
      registered_device_id: deviceResult.data.id,
      app_version: input.app_version,
      release_channel: input.release_channel,
      update_check_result: input.update_check_result || null,
      license_status: license.status,
      request_id: requestId,
      reported_at: now,
    })
    if (checkin.error) throw checkin.error

    const releaseResult = await adminSupabase
      .from("desktop_releases")
      .select("id,version,build_number,mandatory,rollout_percentage,minimum_supported_version,release_notes,published_at,release_channel,release_artifacts(file_url,file_size,sha256,validation_status,signature_status,notarization_status,code_signing_status,validated_at)")
      .eq("platform", input.platform)
      .eq("architecture", input.architecture)
      .eq("release_channel", input.release_channel)
      .eq("release_status", "published")
      .eq("active", true)
      .order("published_at", { ascending: false })
      .limit(5)
    if (releaseResult.error) throw releaseResult.error
    const eligibleRelease = (releaseResult.data || []).find((release) => {
      const artifact = Array.isArray(release.release_artifacts) ? release.release_artifacts[0] : null
      return (
        compareVersions(release.version, input.app_version) > 0 &&
        (release.mandatory || isInRollout(input.device_id, release.id, release.rollout_percentage)) &&
        artifact?.validation_status === "valid" &&
        artifact.signature_status === "valid" &&
        artifact.code_signing_status === "valid" &&
        (input.platform !== "macos" || artifact.notarization_status === "valid")
      )
    }) || null
    const update = eligibleRelease
      ? {
          ...eligibleRelease,
          mandatory:
            eligibleRelease.mandatory ||
            Boolean(
              eligibleRelease.minimum_supported_version &&
              compareVersions(input.app_version, eligibleRelease.minimum_supported_version) < 0
            ),
        }
      : null

    return Response.json(
      {
        success: true,
        requestId,
        serverTime: now,
        licenseStatus: license.status,
        diagnosticRequested: Boolean(deviceResult.data.diagnostic_requested_at),
        eligibleRelease: update,
      },
      { headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } }
    )
  } catch {
    return Response.json(
      { success: false, error: `Device report failed. Request ID: ${requestId}`, requestId },
      { status: 500, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } }
    )
  }
}
