import { NextResponse } from "next/server"
import { getDesktopReleaseAvailability } from "@/lib/releases/public"

export const dynamic = "force-dynamic"

export async function GET() {
  const availability = await getDesktopReleaseAvailability()
  return NextResponse.json({
    success: true,
    ...(availability.manifest || {}),
    platforms: {
      macos: availability.mac,
      windows: availability.windows,
    },
    availability: {
      mac: availability.mac,
      windows: availability.windows,
    },
    metadataService: availability.metadataService,
  }, {
    headers: {
      "Cache-Control": "private, no-store, max-age=0, must-revalidate",
      "CDN-Cache-Control": "no-store",
      "Pragma": "no-cache",
    },
  })
}
