import { NextResponse } from "next/server"
import { getDesktopReleaseAvailability } from "@/lib/releases/public"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  const availability = await getDesktopReleaseAvailability()
  const href = availability.mac.installer?.downloadUrl

  if (
    !availability.mac.available ||
    !href ||
    href === "/downloads/Bezgrow-mac.dmg"
  ) {
    return NextResponse.redirect(new URL("/download", request.url), {
      status: 307,
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    })
  }

  return NextResponse.redirect(new URL(href, request.url), {
    status: 307,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Bezgrow-Artifact-Redirect": "versioned",
    },
  })
}
