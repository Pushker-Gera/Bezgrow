import "server-only"

import {
  PLATFORM_ADMIN_DEVICE_DENIED,
  verifyPlatformAdminDeviceRequest,
} from "@/lib/platform-admin/device-authorization"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const device = await verifyPlatformAdminDeviceRequest(request)
  if (!device.ok) {
    return Response.json(
      { success: false, authorized: false, error: PLATFORM_ADMIN_DEVICE_DENIED },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    )
  }
  return Response.json(
    { success: true, authorized: true },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  )
}
