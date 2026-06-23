import { NextResponse } from "next/server"
import { consumeDesktopOAuthExchange, isValidDesktopOAuthState } from "@/lib/desktop/oauth-store"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const state = new URL(request.url).searchParams.get("state")

  if (!isValidDesktopOAuthState(state)) {
    return NextResponse.json({ ready: false, error: "Invalid desktop login state." }, { status: 400 })
  }

  const exchange = consumeDesktopOAuthExchange(state)
  if (!exchange) {
    return NextResponse.json({ ready: false })
  }

  return NextResponse.json({
    ready: true,
    session: {
      access_token: exchange.access_token,
      refresh_token: exchange.refresh_token,
      expires_at: exchange.expires_at,
      expires_in: exchange.expires_in,
      token_type: exchange.token_type,
      user: exchange.user,
    },
    redirectTo: exchange.redirectTo,
  })
}
