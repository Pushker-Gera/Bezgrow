import { NextResponse } from "next/server"
import { isValidDesktopOAuthState, storeDesktopOAuthExchange } from "@/lib/desktop/oauth-store"

export const dynamic = "force-dynamic"

function isLocalDesktopRequest(url: URL) {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
}

function completionUrl(url: URL, error?: string) {
  const next = new URL("/desktop-auth-complete", url.origin)
  if (error) next.searchParams.set("error", error)
  return next
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  if (!isLocalDesktopRequest(url)) {
    return NextResponse.json({ success: false, error: "Desktop auth callback is only available inside the desktop app." }, { status: 404 })
  }

  const state = url.searchParams.get("state")
  const accessToken = url.searchParams.get("access_token")
  const refreshToken = url.searchParams.get("refresh_token")
  const redirectTo = url.searchParams.get("redirect_to") || "/dashboard"
  const expiresAt = Number(url.searchParams.get("expires_at") || 0) || undefined
  const expiresIn = Number(url.searchParams.get("expires_in") || 0) || undefined
  const tokenType = url.searchParams.get("token_type") || undefined

  if (!isValidDesktopOAuthState(state) || !accessToken || !refreshToken) {
    return NextResponse.redirect(completionUrl(url, "invalid_desktop_auth"))
  }

  storeDesktopOAuthExchange(state!, {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    expires_in: expiresIn,
    token_type: tokenType,
    redirectTo,
  })

  return NextResponse.redirect(completionUrl(url))
}
