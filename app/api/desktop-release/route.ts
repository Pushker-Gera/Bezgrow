import { NextResponse } from "next/server"
import { getDesktopReleaseAvailability } from "@/lib/releases/public"

export const dynamic = "force-dynamic"

export async function GET() {
  const availability = await getDesktopReleaseAvailability()
  return NextResponse.json({
    success: true,
    ...(availability.manifest || {}),
    availability: {
      mac: availability.mac,
      windows: availability.windows,
    },
  }, {
    headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=60" },
  })
}
