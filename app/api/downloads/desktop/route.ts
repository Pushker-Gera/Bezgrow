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

function releaseBaseUrl(manifest: DesktopReleaseManifest | null) {
  const version = manifest?.version || process.env.npm_package_version || "0.1.1"
  return (process.env.NEXT_PUBLIC_DESKTOP_RELEASE_BASE_URL || `https://github.com/Pushker-Gera/Bezgrow/releases/download/v${version}`).replace(/\/$/, "")
}

function remoteRelease(manifest: DesktopReleaseManifest | null, fileName: string): InstallerRelease {
  const href = `${releaseBaseUrl(manifest)}/${fileName}`
  return { downloadUrl: href, url: href, version: manifest?.version }
}

function releasesForPlatform(platform: string, manifest: DesktopReleaseManifest | null): PlatformRelease {
  if (platform === "mac") {
    return {
      releases: [manifest?.mac, { file: "/downloads/Bezgrow-mac.dmg" }, remoteRelease(manifest, "Bezgrow-mac.dmg")]
        .filter(Boolean) as InstallerRelease[],
      missing: "Mac installer is unavailable.",
    }
  }

  return {
    releases: [
      manifest?.windows,
      manifest?.windowsMsi,
      remoteRelease(manifest, "Bezgrow-windows.exe"),
      remoteRelease(manifest, "Bezgrow-windows.msi"),
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
  const verifyRemoteDownloads = process.env.BEZGROW_VERIFY_REMOTE_DOWNLOADS === "1"

  for (const href of hrefs) {
    if (/^https?:\/\//i.test(href)) {
      sawRemote = true
      if (!verifyRemoteDownloads) {
        return NextResponse.redirect(href, { headers: { "Cache-Control": "no-store" } })
      }

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
