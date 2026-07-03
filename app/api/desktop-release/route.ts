import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

export async function GET() {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://www.bezgrow.com"
  const releaseUrl = `${siteUrl.replace(/\/$/, "")}/downloads/desktop-release.json`
  const response = await fetch(releaseUrl, { cache: "no-store" }).catch(() => null)

  if (!response?.ok) {
    return NextResponse.json(
      { error: "Desktop release metadata is unavailable." },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    )
  }

  const manifest = await response.json().catch(() => null)

  if (!manifest || typeof manifest !== "object") {
    return NextResponse.json(
      { error: "Desktop release metadata is invalid." },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    )
  }

  return NextResponse.json(manifest, { headers: { "Cache-Control": "no-store" } })
}
