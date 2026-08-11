import { NextResponse } from "next/server"
import {
  DESKTOP_ADMIN_PAGE_COOKIE,
  desktopAdminPageCookieOptions,
  issueDesktopAdminPageSession,
} from "@/lib/desktop/runtime-admin-session"

export const dynamic = "force-dynamic"

const FORWARDED_HEADERS = [
  "accept",
  "authorization",
  "content-type",
  "idempotency-key",
  "x-bezgrow-desktop-admin",
  "x-bezgrow-device-id",
  "x-bezgrow-device-public-key",
  "x-bezgrow-device-signature",
  "x-bezgrow-device-timestamp",
  "x-bezgrow-device-nonce",
]
const ALLOWED_CONTROL_PLANE_PATHS = [
  "/api/auth/",
  "/api/desktop-auth/",
  "/api/license/verify",
  "/api/devices/checkin",
  "/api/desktop-release",
  "/api/desktop-updater/",
  "/api/diagnostics/upload",
  "/api/integrations/whatsapp/invoice",
  "/api/platform-admin/device/authorize",
  "/api/platform-admin/device/status",
  "/api/admin/",
]

function isAllowedControlPlanePath(apiPath: string) {
  return ALLOWED_CONTROL_PLANE_PATHS.some((allowed) =>
    allowed.endsWith("/") ? apiPath.startsWith(allowed) : apiPath === allowed
  )
}

function cloudOrigin() {
  const configured =
    process.env.NEXT_PUBLIC_DESKTOP_API_ORIGIN ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "https://www.bezgrow.com"
  const url = new URL(configured)

  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    url.protocol = "https:"
  }

  if (url.hostname === "bezgrow.com") {
    url.hostname = "www.bezgrow.com"
  }

  return url.origin
}

async function proxyRequest(request: Request) {
  const requestUrl = new URL(request.url)
  const apiPath = requestUrl.searchParams.get("path") || ""

  if (
    !apiPath.startsWith("/api/") ||
    apiPath.startsWith("/api/desktop-proxy") ||
    !isAllowedControlPlanePath(apiPath)
  ) {
    return NextResponse.json({ error: "Only explicit platform-control actions may use the desktop network proxy." }, { status: 400 })
  }

  const target = new URL(apiPath, cloudOrigin())
  const headers = new Headers()

  FORWARDED_HEADERS.forEach((name) => {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  })

  const method = request.method.toUpperCase()
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer()
  const upstream = await fetch(target, {
    method,
    headers,
    body,
    cache: "no-store",
    redirect: "manual",
  })

  const responseHeaders = new Headers()
  const contentType = upstream.headers.get("content-type")
  if (contentType) responseHeaders.set("content-type", contentType)
  const contentDisposition = upstream.headers.get("content-disposition")
  if (contentDisposition) responseHeaders.set("content-disposition", contentDisposition)
  responseHeaders.set("cache-control", "no-store")

  const bodyBytes = await upstream.arrayBuffer()
  const response = new NextResponse(bodyBytes, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })

  const deviceVerification =
    apiPath === "/api/platform-admin/device/authorize" ||
    apiPath === "/api/platform-admin/device/status"
  const authenticatedAdminRequest = apiPath.startsWith("/api/admin/")
  if (deviceVerification || authenticatedAdminRequest) {
    let deviceAuthorized = false
    if (deviceVerification && upstream.ok && contentType?.includes("application/json")) {
      try {
        const payload = JSON.parse(new TextDecoder().decode(bodyBytes) || "null") as { authorized?: boolean } | null
        deviceAuthorized = payload?.authorized === true
      } catch {
        deviceAuthorized = false
      }
    }
    const pageSession = (
      (deviceVerification && deviceAuthorized) ||
      (authenticatedAdminRequest && upstream.ok)
    ) ? issueDesktopAdminPageSession() : null
    response.cookies.set(DESKTOP_ADMIN_PAGE_COOKIE, pageSession || "", {
      ...desktopAdminPageCookieOptions,
      maxAge: pageSession ? desktopAdminPageCookieOptions.maxAge : 0,
    })
  }

  return response
}

export const GET = proxyRequest
export const POST = proxyRequest
export const PUT = proxyRequest
export const PATCH = proxyRequest
export const DELETE = proxyRequest
