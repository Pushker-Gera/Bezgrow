import "server-only"

import { z } from "zod"
import { authenticateDeviceReport } from "@/lib/device/report-auth"
import {
  PLATFORM_ADMIN_DEVICE_DENIED,
  verifyPlatformAdminDeviceRequest,
} from "@/lib/platform-admin/device-authorization"

export const dynamic = "force-dynamic"

const inputSchema = z.object({
  license_key: z.string().trim().min(100).max(20_000),
  device_id: z.string().trim().min(8).max(180),
}).strict()

function denied(status = 403) {
  return Response.json(
    { success: false, authorized: false, error: PLATFORM_ADMIN_DEVICE_DENIED },
    { status, headers: { "Cache-Control": "no-store" } },
  )
}

export async function POST(request: Request) {
  const parsed = inputSchema.safeParse(await request.clone().json().catch(() => null))
  if (!parsed.success) return denied()
  const licenseAuth = await authenticateDeviceReport(request, {
    licenseKey: parsed.data.license_key,
    deviceId: parsed.data.device_id,
  })
  if (!licenseAuth.ok || licenseAuth.context.device?.device_id !== parsed.data.device_id) {
    return denied()
  }

  const device = await verifyPlatformAdminDeviceRequest(request, {
    allowPublicKeyEnrollment: true,
  })
  if (!device.ok || device.context.deviceId !== parsed.data.device_id) return denied()

  return Response.json(
    { success: true, authorized: true },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  )
}
