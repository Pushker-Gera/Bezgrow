import { NextResponse } from "next/server"
import { getDesktopReleaseAvailability } from "@/lib/releases/public"

export const dynamic = "force-dynamic"

function jsonError(message: string, status = 404) {
  return NextResponse.json({ success: false, error: message }, { status, headers: { "Cache-Control": "no-store" } })
}

function redirectToInstaller(href: string, request: Request) {
  const location = new URL(href, request.url)
  return new NextResponse(null, {
    status: 302,
    headers: {
      "Cache-Control": "no-store",
      Location: location.toString(),
    },
  })
}

function redirectToRemoteInstaller(href: string) {
  return new NextResponse(null, {
    status: 302,
    headers: {
      "Cache-Control": "no-store",
      Location: href,
    },
  })
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const requestedPlatform = url.searchParams.get("platform")
  if (!requestedPlatform || !["mac", "macos", "windows"].includes(requestedPlatform)) {
    return jsonError("Query parameter platform must be mac or windows.", 400)
  }
  const platform = requestedPlatform === "windows" ? "windows" : "mac"
  const availability = await getDesktopReleaseAvailability()
  const release = platform === "mac" ? availability.mac : availability.windows
  const href = release.installer?.downloadUrl

  if (!release.available || !href) {
    return jsonError(
      release.blockedReason ||
        release.reason ||
        `${platform === "mac" ? "Mac" : "Windows"} installer is unavailable.`
    )
  }
  if (/^https:\/\//i.test(href)) {
    return redirectToRemoteInstaller(href)
  }
  if (href.startsWith("/downloads/") && !href.includes("..")) {
    return redirectToInstaller(href, request)
  }

  return jsonError("Validated installer URL is not a supported download location.", 502)
}
