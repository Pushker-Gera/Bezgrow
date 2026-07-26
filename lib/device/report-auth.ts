import "server-only"

import { effectiveLicenseStatus } from "@/lib/admin/control-plane"
import { parseLicenseInput, verifyLicenseSignature } from "@/lib/license/codec"
import { checkRateLimit, rateLimitKey } from "@/lib/security/rate-limit"
import { adminSupabase } from "@/lib/supabase/admin"

export type DeviceReportAuth = {
  requestId: string
  license: Record<string, unknown>
  payload: ReturnType<typeof parseLicenseInput>["payload"]
  device: Record<string, unknown> | null
}

function trustedReportOrigin(request: Request) {
  const origin = request.headers.get("origin")
  if (!origin) return true
  try {
    const url = new URL(origin)
    if (url.origin === new URL(request.url).origin) return true
    if (["bezgrow.com", "www.bezgrow.com"].includes(url.hostname) && url.protocol === "https:") return true
    return /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(url.origin)
  } catch {
    return false
  }
}

async function recordFailure(request: Request, requestId: string, deviceId: string, reason: string) {
  const { error } = await adminSupabase.from("admin_audit_logs").insert({
    admin_user_id: null,
    admin_email: null,
    action: "LICENSE_ACTIVATION_FAILED",
    target_type: "device",
    target_id: deviceId || null,
    ip_address:
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      null,
    user_agent: request.headers.get("user-agent"),
    previous_values: null,
    new_values: { reason },
    request_id: requestId,
    result: "failure",
  })
  if (error) {
    console.error("[device-report-audit]", { requestId, reason: "audit_unavailable" })
  }
}

export async function authenticateDeviceReport(
  request: Request,
  input: { licenseKey: string; deviceId: string }
): Promise<
  | { ok: true; context: DeviceReportAuth }
  | { ok: false; status: number; error: string; requestId: string }
> {
  const requestId = crypto.randomUUID()
  if (!trustedReportOrigin(request)) {
    return { ok: false, status: 403, error: "Invalid request origin.", requestId }
  }

  const limit = checkRateLimit({
    key: rateLimitKey(request, `device-report:${input.deviceId}`),
    limit: 60,
    windowMs: 60 * 60 * 1000,
  })
  if (!limit.allowed) {
    return { ok: false, status: 429, error: "Too many device reports. Please try again later.", requestId }
  }

  try {
    const parsed = parseLicenseInput(input.licenseKey)
    if (parsed.payload.device_id !== input.deviceId) {
      await recordFailure(request, requestId, input.deviceId, "wrong_device")
      return { ok: false, status: 403, error: "This license was issued for another device.", requestId }
    }
    const verified = await verifyLicenseSignature(
      parsed,
      process.env.NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY
    )
    if (!verified) {
      await recordFailure(request, requestId, input.deviceId, "tampered")
      return { ok: false, status: 403, error: "License signature validation failed.", requestId }
    }

    const licenseResult = await adminSupabase
      .from("licenses")
      .select("*")
      .eq("id", parsed.payload.license_id)
      .maybeSingle()
    if (licenseResult.error || !licenseResult.data) {
      await recordFailure(request, requestId, input.deviceId, "license_not_registered")
      return { ok: false, status: 403, error: "License is not registered with the platform.", requestId }
    }
    if (licenseResult.data.signed_license_key !== parsed.licenseKey) {
      await recordFailure(request, requestId, input.deviceId, "stale_or_replaced_key")
      return { ok: false, status: 403, error: "This license key has been replaced.", requestId }
    }
    const effectiveStatus = effectiveLicenseStatus(licenseResult.data)
    if (!["active", "trial", "expiring", "grace_period"].includes(effectiveStatus)) {
      await recordFailure(request, requestId, input.deviceId, effectiveStatus)
      return { ok: false, status: 403, error: `License is ${effectiveStatus.replaceAll("_", " ")}.`, requestId }
    }

    const deviceResult = await adminSupabase
      .from("registered_devices")
      .select("*")
      .eq("device_id", input.deviceId)
      .maybeSingle()
    if (deviceResult.error) throw deviceResult.error
    if (deviceResult.data && ["revoked", "replaced"].includes(deviceResult.data.device_status)) {
      return { ok: false, status: 403, error: `Device is ${deviceResult.data.device_status}.`, requestId }
    }

    return {
      ok: true,
      context: {
        requestId,
        license: licenseResult.data,
        payload: parsed.payload,
        device: deviceResult.data,
      },
    }
  } catch {
    await recordFailure(request, requestId, input.deviceId, "invalid_license")
    return { ok: false, status: 403, error: "License validation failed.", requestId }
  }
}
