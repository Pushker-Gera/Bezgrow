import { NextResponse } from "next/server"
import desktopReleaseManifest from "@/public/downloads/desktop-release.json"

export const dynamic = "force-dynamic"

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

function jsonError(message: string, status = 404) {
  return NextResponse.json({ success: false, error: message }, { status, headers: { "Cache-Control": "no-store" } })
}

function redirectToInstaller(href: string, request: Request) {
  return NextResponse.redirect(new URL(href, request.url), {
    status: 302,
    headers: { "Cache-Control": "no-store" },
  })
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

function redirectToRemoteInstaller(href: string) {
  return NextResponse.redirect(href, {
    status: 302,
    headers: { "Cache-Control": "no-store" },
  })
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const platform = url.searchParams.get("platform") === "mac" ? "mac" : "windows"
  if (platform === "mac") {
    const href = desktopReleaseManifest.mac?.downloadUrl || desktopReleaseManifest.mac?.file || "/downloads/Bezgrow-mac.dmg"
    return redirectToInstaller(href, request)
  }

  const { releases, missing } = releasesForPlatform(platform, desktopReleaseManifest as DesktopReleaseManifest)
  const hrefs = releases
    .map((release) => release.downloadUrl || release.url || release.file || "")
    .filter(Boolean)

  if (hrefs.length === 0) return jsonError(missing)

  let sawRemote = false
  for (const href of hrefs) {
    if (/^https?:\/\//i.test(href)) {
      sawRemote = true
      const head = await fetch(href, { method: "HEAD", cache: "no-store", redirect: "follow" }).catch(() => null)
      if (head?.ok) return redirectToRemoteInstaller(href)
      continue
    }

    if (href.startsWith("/downloads/") && !href.includes("..")) {
      return redirectToInstaller(href, request)
    }
  }

  return sawRemote
    ? jsonError(`${missing} The published download URL did not respond.`, 502)
    : jsonError(`${missing} The file was not found on this build.`)
}
