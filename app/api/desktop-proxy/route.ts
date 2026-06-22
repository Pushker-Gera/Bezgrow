import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

const FORWARDED_HEADERS = ["accept", "authorization", "content-type"]

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

  if (!apiPath.startsWith("/api/") || apiPath.startsWith("/api/desktop-proxy")) {
    return NextResponse.json({ error: "Invalid desktop proxy target." }, { status: 400 })
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
  responseHeaders.set("cache-control", "no-store")

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

export const GET = proxyRequest
export const POST = proxyRequest
export const PUT = proxyRequest
export const PATCH = proxyRequest
export const DELETE = proxyRequest
