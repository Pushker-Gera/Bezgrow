import "server-only"

import { createHash } from "node:crypto"
import { z } from "zod"
import { authenticateDeviceReport } from "@/lib/device/report-auth"
import { getDesktopReleaseAvailability } from "@/lib/releases/public"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const checkinSchema = z.object({
  license_key: z.string().trim().min(100).max(20000),
  license_id: z.string().trim().min(8).max(180).optional(),
  device_id: z.string().trim().min(8).max(180),
  business_id: z.string().trim().min(1).max(180).optional(),
  platform: z.enum(["macos", "windows"]),
  architecture: z.enum(["arm64", "x64", "x86_64"]),
  app_version: z.string().trim().min(1).max(40),
  release_channel: z.string().trim().min(1).max(40).default("stable"),
  activation_status: z.enum(["active", "inactive", "pending"]).default("active"),
  license_status: z.string().trim().min(1).max(80).optional(),
  timestamp: z.string().datetime().optional(),
  update_check_result: z.enum(["success", "failed", "no_update", "update_available"]).optional(),
  diagnostics_available: z.boolean().default(false),
}).strict()

type CheckinReleaseArtifact = {
  file_url?: string | null
  file_size?: number | null
  sha256?: string | null
  validation_status?: string | null
  signature_status?: string | null
  notarization_status?: string | null
  code_signing_status?: string | null
  validated_at?: string | null
  artifact_type?: string | null
  file_name?: string | null
  updater_url?: string | null
  updater_size?: number | null
  updater_sha256?: string | null
  update_signature?: string | null
  updater_signature_status?: string | null
}

type CheckinRelease = {
  id: string
  version: string
  build_number: string
  mandatory: boolean
  mandatory_after?: string | null
  rollout_percentage: number
  minimum_supported_version?: string | null
  release_notes?: string | null
  published_at?: string | null
  release_channel?: string | null
  release_artifacts?: CheckinReleaseArtifact[]
}

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
  const storageArchitecture = input.architecture === "x86_64" ? "x64" : input.architecture
  const auth = await authenticateDeviceReport(request, {
    licenseKey: input.license_key,
    deviceId: input.device_id,
  })
  if (!auth.ok) {
    return Response.json(
      {
        success: false,
        error: auth.error,
        requestId: auth.requestId,
        code: auth.code || "device_report_rejected",
        licenseStatus: auth.licenseStatus || null,
        authoritative: Boolean(auth.licenseStatus),
      },
      { status: auth.status, headers: { "Cache-Control": "no-store", "X-Request-Id": auth.requestId } }
    )
  }
  const { requestId, license, device, refreshedLicenseKey } = auth.context

  try {
    if (input.license_id && input.license_id !== license.id) {
      return Response.json(
        { success: false, error: "License identifier does not match the signed license.", requestId },
        { status: 403, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } }
      )
    }
    if (input.business_id && input.business_id !== auth.context.payload.business_id) {
      return Response.json(
        { success: false, error: "Business identifier does not match the signed license.", requestId },
        { status: 403, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } }
      )
    }
    if (license.platform && input.platform !== license.platform) {
      return Response.json(
        { success: false, error: "Platform does not match the registered license.", requestId },
        { status: 409, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } }
      )
    }
    if (license.architecture && storageArchitecture !== license.architecture) {
      return Response.json(
        { success: false, error: "Architecture does not match the registered license.", requestId },
        { status: 409, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } }
      )
    }
    if (input.license_status && input.license_status !== license.status) {
      return Response.json(
        { success: false, error: "License status does not match the platform record.", requestId },
        { status: 409, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } }
      )
    }
    if (!license.platform_business_id || !license.platform_customer_id) {
      return Response.json(
        { success: false, error: "License is not linked to a platform customer and business.", requestId },
        { status: 409, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } }
      )
    }

    const now = new Date().toISOString()
    const registration = await adminSupabase.rpc("register_device_checkin", {
      p_request_id: requestId,
      p_license_id: license.id,
      p_device_id: input.device_id,
      p_platform_business_id: license.platform_business_id,
      p_platform_customer_id: license.platform_customer_id,
      p_business_id: auth.context.payload.business_id,
      p_platform: input.platform,
      p_operating_system: input.platform,
      p_architecture: storageArchitecture,
      p_app_version: input.app_version,
      p_release_channel: input.release_channel,
      p_update_check_result: input.update_check_result || null,
      p_license_status: license.status,
      p_activation_status: input.activation_status,
      p_diagnostics_available: input.diagnostics_available,
      p_client_reported_at: input.timestamp || null,
      p_reported_at: now,
    })

    let registeredDevice = registration.data as Record<string, unknown> | null
    const missingRegistrationFunction =
      registration.error?.code === "PGRST202" ||
      registration.error?.code === "42883" ||
      /register_device_checkin/i.test(registration.error?.message || "")

    if (registration.error && !missingRegistrationFunction) throw registration.error

    // Compatibility path for a deploy that reaches the application before the
    // corrective migration. The migration RPC is transactional and is always
    // preferred once PostgREST has reloaded its schema cache.
    if (!registeredDevice) {
      console.warn("[device-checkin-rpc-fallback]", {
        requestId,
        databaseCode: registration.error?.code || "empty_response",
      })
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
            operating_system: input.platform,
            architecture: storageArchitecture,
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
      registeredDevice = deviceResult.data

      const [checkin, businessUpdate, licenseEvent, auditEvent] = await Promise.all([
        adminSupabase.from("device_checkins").insert({
          registered_device_id: deviceResult.data.id,
          app_version: input.app_version,
          release_channel: input.release_channel,
          update_check_result: input.update_check_result || null,
          license_status: license.status,
          request_id: requestId,
          reported_at: now,
        }),
        adminSupabase
          .from("platform_businesses")
          .update({
            platform: input.platform,
            app_version: input.app_version,
            update_channel: input.release_channel,
            updated_at: now,
          })
          .eq("id", license.platform_business_id),
        adminSupabase.from("license_events").insert({
          license_id: license.id,
          action: device ? "DEVICE_CHECKIN" : "DEVICE_REGISTERED",
          new_values: {
            device_id: input.device_id,
            business_id: auth.context.payload.business_id,
            platform: input.platform,
            architecture: storageArchitecture,
            app_version: input.app_version,
            release_channel: input.release_channel,
          },
          notes: "Authenticated minimal device metadata report.",
          request_id: requestId,
          created_at: now,
        }),
        adminSupabase.from("admin_audit_logs").insert({
          admin_user_id: null,
          admin_email: null,
          action: device ? "DEVICE_CHECKIN" : "DEVICE_REGISTERED",
          target_type: "device",
          target_id: input.device_id,
          previous_values: null,
          new_values: {
            license_id: license.id,
            business_id: auth.context.payload.business_id,
            platform: input.platform,
            architecture: storageArchitecture,
            app_version: input.app_version,
          },
          request_id: requestId,
          result: "success",
          created_at: now,
        }),
      ])
      const fallbackError =
        checkin.error || businessUpdate.error || licenseEvent.error || auditEvent.error
      if (fallbackError) throw fallbackError
    }
    if (!registeredDevice) throw new Error("Device registration did not return a device record.")

    const releaseQuery = (columns: string) => adminSupabase
      .from("desktop_releases")
      .select(columns)
      .eq("platform", input.platform)
      .eq("architecture", storageArchitecture)
      .in("release_channel", [...new Set([input.release_channel, "stable", "manual", "internal"])])
      .eq("release_status", "published")
      .eq("active", true)
      .order("published_at", { ascending: false })
      .limit(5)
    let releaseResult = await releaseQuery("id,version,build_number,mandatory,mandatory_after,rollout_percentage,minimum_supported_version,release_notes,published_at,release_channel,release_artifacts(file_url,file_size,sha256,validation_status,signature_status,notarization_status,code_signing_status,validated_at,artifact_type,file_name,updater_url,updater_size,updater_sha256,update_signature,updater_signature_status)")
    if (releaseResult.error && ["42703", "PGRST204"].includes(releaseResult.error.code)) {
      releaseResult = await releaseQuery("id,version,build_number,mandatory,mandatory_after,rollout_percentage,minimum_supported_version,release_notes,published_at,release_channel,release_artifacts(file_url,file_size,sha256,validation_status,signature_status,notarization_status,code_signing_status,validated_at,artifact_type,file_name)")
    }
    if (releaseResult.error && ["42703", "PGRST204"].includes(releaseResult.error.code)) {
      releaseResult = await releaseQuery("id,version,build_number,mandatory,rollout_percentage,minimum_supported_version,release_notes,published_at,release_channel,release_artifacts(file_url,file_size,sha256,validation_status,signature_status,notarization_status,code_signing_status,validated_at,artifact_type,file_name)")
    }
    if (releaseResult.error) throw releaseResult.error
    const releaseRows = (releaseResult.data || []) as unknown as CheckinRelease[]
    const eligibleRelease = releaseRows.find((release) => {
      const validArtifacts = Array.isArray(release.release_artifacts)
        ? release.release_artifacts.filter(
            (entry) =>
              entry.validation_status === "valid" &&
              entry.file_url &&
              entry.file_size &&
              /^[a-f0-9]{64}$/i.test(entry.sha256 || "")
          )
        : []
      const artifact =
        validArtifacts.find(
          (entry) => entry.updater_signature_status === "valid" && entry.updater_url
        ) || validArtifacts[0]
      return (
        compareVersions(release.version, input.app_version) > 0 &&
        (release.mandatory || isInRollout(input.device_id, release.id, release.rollout_percentage)) &&
        Boolean(artifact)
      )
    }) || null
    let update: CheckinRelease | null = eligibleRelease
      ? {
          ...eligibleRelease,
          release_artifacts: Array.isArray(eligibleRelease.release_artifacts)
            ? eligibleRelease.release_artifacts
                .filter(
                  (artifact) =>
                    artifact.validation_status === "valid" &&
                    artifact.file_url &&
                    artifact.file_size &&
                    /^[a-f0-9]{64}$/i.test(artifact.sha256 || "")
                )
                .sort(
                  (left, right) =>
                    Number(right.updater_signature_status === "valid" && Boolean(right.updater_url)) -
                    Number(left.updater_signature_status === "valid" && Boolean(left.updater_url))
                )
                .slice(0, 1)
            : [],
          mandatory:
            eligibleRelease.mandatory ||
            Boolean(
              eligibleRelease.minimum_supported_version &&
              compareVersions(input.app_version, eligibleRelease.minimum_supported_version) < 0
            ),
        }
      : null

    if (!update) {
      const publicAvailability = await getDesktopReleaseAvailability()
      const publicInstaller = input.platform === "macos"
        ? publicAvailability.mac.installer
        : publicAvailability.windows.installer
      const installerArchitecture = publicInstaller?.architecture === "x86_64"
        ? "x64"
        : publicInstaller?.architecture
      if (
        publicInstaller?.available &&
        publicInstaller.version &&
        publicInstaller.downloadUrl &&
        publicInstaller.size &&
        publicInstaller.sha256 &&
        installerArchitecture === storageArchitecture &&
        compareVersions(publicInstaller.version, input.app_version) > 0
      ) {
        update = {
          id: `public-${input.platform}-${storageArchitecture}-${publicInstaller.version}`,
          version: publicInstaller.version,
          build_number: publicInstaller.buildNumber || "public-manifest",
          mandatory: publicInstaller.mandatory,
          mandatory_after: null,
          rollout_percentage: 100,
          minimum_supported_version: publicInstaller.minimumSupportedVersion,
          release_notes: publicInstaller.releaseNotes,
          published_at: publicInstaller.releaseDate || publicInstaller.generatedAt,
          release_channel: publicInstaller.releaseChannel,
          release_artifacts: [{
            file_url: publicInstaller.downloadUrl,
            file_size: publicInstaller.size,
            sha256: publicInstaller.sha256,
            validation_status: "valid",
            signature_status: publicInstaller.signed ? "valid" : "invalid",
            notarization_status: input.platform === "macos"
              ? publicInstaller.notarized ? "valid" : "invalid"
              : "not_applicable",
            code_signing_status: publicInstaller.signed ? "valid" : "invalid",
            validated_at: publicInstaller.generatedAt,
            artifact_type: publicInstaller.artifactType,
            file_name: publicInstaller.filename,
            updater_url: publicInstaller.updaterUrl,
            updater_size: publicInstaller.updaterSize,
            updater_sha256: publicInstaller.updaterSha256,
            update_signature: publicInstaller.updateSignature,
            updater_signature_status: publicInstaller.updaterSignatureVerified ? "valid" : "missing",
          }],
        }
      }
    }

    return Response.json(
      {
        success: true,
        requestId,
        serverTime: now,
        licenseStatus: license.status,
        refreshedLicenseKey,
        diagnosticRequested: Boolean(registeredDevice.diagnostic_requested_at),
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
