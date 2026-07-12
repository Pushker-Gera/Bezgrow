import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

type InstallerRelease = {
  downloadUrl?: string
  url?: string
  file?: string
  version?: string
  size?: number
  sha256?: string
}

type PlatformRelease = {
  releases: InstallerRelease[]
  missing: string
}

type DesktopReleaseManifest = {
  version?: string
  mac?: InstallerRelease
  windows?: InstallerRelease
  windowsMsi?: InstallerRelease
}

function readManifest() {
  const path = join(process.cwd(), "public", "downloads", "desktop-release.json")
  if (!existsSync(path)) return null

  try {
    return JSON.parse(readFileSync(path, "utf8")) as DesktopReleaseManifest
  } catch {
    return null
  }
}

function publicFileExists(path: string) {
  const fullPath = join(process.cwd(), "public", path.replace(/^\/+/, ""))
  return existsSync(fullPath)
}

function jsonError(message: string, status = 404) {
  return NextResponse.json({ success: false, error: message }, { status, headers: { "Cache-Control": "no-store" } })
}

function releasesForPlatform(platform: string, manifest: DesktopReleaseManifest | null): PlatformRelease {
  if (platform === "mac") {
    return {
      releases: [manifest?.mac, { file: "/downloads/Bezgrow-mac.dmg" }]
        .filter(Boolean) as InstallerRelease[],
      missing: "Mac installer is unavailable.",
    }
  }

  return {
    releases: [
      manifest?.windows,
      manifest?.windowsMsi,
      { file: "/downloads/Bezgrow-windows.exe" },
      { file: "/downloads/Bezgrow-windows.msi" },
    ]
      .filter(Boolean) as InstallerRelease[],
    missing: "Windows installer is unavailable.",
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const platform = url.searchParams.get("platform") === "mac" ? "mac" : "windows"
  const { releases, missing } = releasesForPlatform(platform, readManifest())
  const hrefs = releases
    .map((release) => release.downloadUrl || release.url || release.file || "")
    .filter(Boolean)

  if (hrefs.length === 0) return jsonError(missing)

  let sawRemote = false
  for (const href of hrefs) {
    if (/^https?:\/\//i.test(href)) {
      sawRemote = true
      const head = await fetch(href, { method: "HEAD", cache: "no-store", redirect: "follow" }).catch(() => null)
      if (head?.ok) return NextResponse.redirect(href, { headers: { "Cache-Control": "no-store" } })
      continue
    }

    if (publicFileExists(href)) {
      return NextResponse.redirect(new URL(href, request.url), { headers: { "Cache-Control": "no-store" } })
    }
  }

  return sawRemote
    ? jsonError(`${missing} The published download URL did not respond.`, 502)
    : jsonError(`${missing} The file was not found on this build.`)
}
