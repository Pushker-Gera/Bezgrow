import { NextResponse } from "next/server"
import desktopReleaseManifest from "@/public/downloads/desktop-release.json"

export const dynamic = "force-static"

export async function GET() {
  return NextResponse.json(desktopReleaseManifest, { headers: { "Cache-Control": "no-store" } })
}
