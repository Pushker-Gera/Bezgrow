import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function localManifest() {
  const path = join(process.cwd(), "public", "downloads", "desktop-release.json")
  if (!existsSync(path)) return null

  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as unknown
    return manifest && typeof manifest === "object" ? manifest : null
  } catch {
    return null
  }
}

export async function GET() {
  const local = localManifest()
  if (local) return NextResponse.json(local, { headers: { "Cache-Control": "no-store" } })

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
