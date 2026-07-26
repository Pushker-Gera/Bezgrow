import "server-only"

import { z } from "zod"
import { authenticateDeviceReport } from "@/lib/device/report-auth"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const diagnosticSchema = z.object({
  license_key: z.string().trim().min(100).max(20000),
  device_id: z.string().trim().min(8).max(180),
  app_version: z.string().trim().max(40),
  operating_system: z.string().trim().max(160),
  platform: z.enum(["macos", "windows"]),
  database_integrity_result: z.string().trim().max(200),
  migration_version: z.string().trim().max(80),
  license_status: z.string().trim().max(80),
  update_status: z.string().trim().max(120),
  sanitized_error_codes: z.array(z.string().trim().regex(/^[A-Z0-9_.:-]{1,120}$/)).max(100),
  startup_timing_ms: z.coerce.number().int().min(0).max(3_600_000),
  last_backup_result: z.string().trim().max(160),
  support_case_id: z.string().uuid().nullable().optional(),
}).strict()

export async function POST(request: Request) {
  const parsed = diagnosticSchema.safeParse(await request.json().catch(() => null))
  const fallbackRequestId = crypto.randomUUID()
  if (!parsed.success) {
    return Response.json(
      { success: false, error: parsed.error.issues[0]?.message || "Invalid diagnostic package.", requestId: fallbackRequestId },
      { status: 422, headers: { "Cache-Control": "no-store", "X-Request-Id": fallbackRequestId } }
    )
  }
  const auth = await authenticateDeviceReport(request, {
    licenseKey: parsed.data.license_key,
    deviceId: parsed.data.device_id,
  })
  if (!auth.ok) {
    return Response.json(
      { success: false, error: auth.error, requestId: auth.requestId },
      { status: auth.status, headers: { "Cache-Control": "no-store", "X-Request-Id": auth.requestId } }
    )
  }

  const { requestId, device, license } = auth.context
  if (!device?.id) {
    return Response.json(
      { success: false, error: "Device must check in before uploading diagnostics.", requestId },
      { status: 409, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } }
    )
  }

  try {
    const { license_key: _licenseKey, ...diagnostic } = parsed.data
    void _licenseKey
    const settings = await adminSupabase
      .from("platform_settings")
      .select("diagnostic_upload_enabled,diagnostic_retention_days")
      .limit(1)
      .maybeSingle()
    if (settings.error) throw settings.error
    if (settings.data?.diagnostic_upload_enabled === false) {
      return Response.json(
        { success: false, error: "Diagnostic uploads are disabled by platform policy.", requestId },
        { status: 403, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } }
      )
    }
    const retentionDays = Number(settings.data?.diagnostic_retention_days || 30)
    const expiresAt = new Date(Date.now() + retentionDays * 86_400_000).toISOString()
    if (diagnostic.support_case_id) {
      const supportCase = await adminSupabase
        .from("support_cases")
        .select("id,registered_device_id,license_id,platform_customer_id")
        .eq("id", diagnostic.support_case_id)
        .maybeSingle()
      if (
        supportCase.error ||
        !supportCase.data ||
        (
          supportCase.data.registered_device_id !== device.id &&
          supportCase.data.license_id !== license.id &&
          supportCase.data.platform_customer_id !== license.platform_customer_id
        )
      ) {
        return Response.json(
          { success: false, error: "Support case is not linked to this device or license.", requestId },
          { status: 403, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } }
        )
      }
    }
    const result = await adminSupabase
      .from("diagnostic_uploads")
      .insert({
        ...diagnostic,
        registered_device_id: device.id,
        uploaded_at: new Date().toISOString(),
        expires_at: expiresAt,
      })
      .select("id,uploaded_at")
      .single()
    if (result.error) throw result.error
    await adminSupabase
      .from("registered_devices")
      .update({
        diagnostics_available: true,
        diagnostic_requested_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", device.id)

    return Response.json(
      { success: true, requestId, diagnostic: result.data },
      { status: 201, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } }
    )
  } catch {
    return Response.json(
      { success: false, error: `Diagnostic upload failed. Request ID: ${requestId}`, requestId },
      { status: 500, headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } }
    )
  }
}
