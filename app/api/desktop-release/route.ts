import { NextResponse } from "next/server"
import { getPublicDesktopReleaseManifest } from "@/lib/releases/public"
import desktopReleaseManifest from "@/public/downloads/desktop-release.json"

export const dynamic = "force-dynamic"

export async function GET() {
  const controlPlaneManifest = await getPublicDesktopReleaseManifest()
  return NextResponse.json(controlPlaneManifest || desktopReleaseManifest, {
    headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=60" },
  })
}
