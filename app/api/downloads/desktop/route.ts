import { NextResponse } from "next/server"
import { getDesktopReleaseAvailability } from "@/lib/releases/public"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

function jsonError(message: string, status = 404) {
  return NextResponse.json(
    { success: false, error: message },
    { status, headers: { "Cache-Control": "no-store" } }
  )
}

function safeDownloadFilename(value: string | null, platform: "mac" | "windows") {
  const fallback = platform === "mac" ? "Bezgrow-mac.dmg" : "Bezgrow-windows.exe"
  const filename = (value || fallback).replace(/[\r\n"\\/]/g, "-").trim()
  return filename || fallback
}

async function binaryInstallerResponse(
  href: string,
  request: Request,
  filename: string,
  contentType: string,
  expectedSize: number | null
) {
  const upstream = await fetch(new URL(href, request.url), {
    method: "GET",
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
    headers: {
      Accept:
        "application/octet-stream, application/x-apple-diskimage, application/vnd.microsoft.portable-executable, application/x-msi, application/msix",
    },
  }).catch(() => null)
  if (!upstream?.ok || !upstream.body) {
    return jsonError(
      `Validated installer download failed with HTTP ${upstream?.status || 502}.`,
      502
    )
  }

  const upstreamType = (upstream.headers.get("content-type") || "").toLowerCase()
  if (
    upstreamType.includes("text/html") ||
    upstreamType.includes("application/json") ||
    upstreamType.startsWith("text/")
  ) {
    return jsonError("Installer source returned a webpage instead of binary bytes.", 502)
  }

  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Type": contentType || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "X-Bezgrow-Artifact-Validation": "sha256-verified",
  })
  const upstreamLength = Number(upstream.headers.get("content-length") || 0)
  const contentLength = expectedSize || upstreamLength
  if (contentLength > 0) headers.set("Content-Length", String(contentLength))

  return new NextResponse(upstream.body, { status: 200, headers })
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
  const installer = release.installer
  const href = installer?.downloadUrl

  if (!release.available || !installer || !href) {
    return jsonError(
      release.blockedReason ||
        release.reason ||
        `${platform === "mac" ? "Mac" : "Windows"} installer is unavailable.`
    )
  }
  if (!/^https:\/\//i.test(href) && !(href.startsWith("/downloads/") && !href.includes(".."))) {
    return jsonError("Validated installer URL is not a supported download location.", 502)
  }

  return binaryInstallerResponse(
    href,
    request,
    safeDownloadFilename(installer.filename, platform),
    installer.contentType || "application/octet-stream",
    installer.size
  )
}
