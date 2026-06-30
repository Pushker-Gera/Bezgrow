import { NextResponse } from "next/server"
import { isConfiguredAdmin } from "@/lib/admin-role"
import { isValidDesktopOAuthState, storeDesktopOAuthExchange } from "@/lib/desktop/oauth-store"
import { adminSupabase } from "@/lib/supabase/admin"
import { createServerSupabase } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

function getSiteUrl(origin: string) {
  const configuredUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  return (origin || configuredUrl || "https://www.bezgrow.com").replace(/\/$/, "")
}

function getSafeNextPath(next: string | null) {
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/dashboard"
}

async function getProfileRedirect(userId: string, email: string | null | undefined, requestedNext: string) {
  const { data: profile, error: profileError } = await adminSupabase
    .from("profiles")
    .select("role, approved, business_created, is_suspended")
    .eq("id", userId)
    .maybeSingle()

  let destination = "/dashboard"
  let reason = "approved_user"

  if (requestedNext === "/reset-password") {
    destination = "/reset-password"
    reason = "password_recovery"
  } else if (profile?.is_suspended) {
    destination = "/login?error=account_suspended"
    reason = "suspended"
  } else if (isConfiguredAdmin(email, profile?.role)) {
    destination = "/admin"
    reason = profile?.role === "admin" ? "profile_admin" : "configured_admin_email"
  } else if (profileError || !profile) {
    destination = "/login?error=profile_missing"
    reason = profileError ? "profile_lookup_error" : "profile_missing"
  } else if (!profile.approved) {
    destination = "/pending-approval"
    reason = "pending_approval"
  } else if (!profile.business_created) {
    const [{ data: membership }, { data: ownedOrganization }] = await Promise.all([
      adminSupabase
        .from("organization_members")
        .select("organization_id")
        .eq("user_id", userId)
        .limit(1)
        .maybeSingle(),
      adminSupabase
        .from("organizations")
        .select("id")
        .eq("owner_id", userId)
        .limit(1)
        .maybeSingle(),
    ])
    const hasBusiness = Boolean(membership?.organization_id || ownedOrganization?.id)
    destination = hasBusiness ? (requestedNext === "/admin" ? "/dashboard" : requestedNext) : "/create-business"
    reason = hasBusiness ? "approved_user_with_workspace" : "approved_user_needs_workspace"
  } else {
    destination = requestedNext === "/admin" ? "/dashboard" : requestedNext
  }

  console.info("[auth/callback] profile redirect", {
    userId,
    role: profile?.role || null,
    adminEmailMatch: isConfiguredAdmin(email, null),
    approved: profile?.approved ?? null,
    businessCreated: profile?.business_created ?? null,
    destination,
    reason,
  })

  return destination
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const siteUrl = getSiteUrl(url.origin)
  const code = url.searchParams.get("code")
  const accessToken = url.searchParams.get("access_token")
  const refreshToken = url.searchParams.get("refresh_token")
  const safeNext = getSafeNextPath(url.searchParams.get("next"))
  const desktopOAuthState = url.searchParams.get("desktop_oauth_state")
  const supabase = await createServerSupabase()
  let authSession: Awaited<ReturnType<typeof supabase.auth.exchangeCodeForSession>>["data"]["session"] | null = null

  console.info("[auth/callback] received", {
    hasCode: Boolean(code),
    hasAccessToken: Boolean(accessToken),
    hasRefreshToken: Boolean(refreshToken),
    next: safeNext,
    desktopOAuth: isValidDesktopOAuthState(desktopOAuthState),
  })

  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) {
      return NextResponse.redirect(new URL("/login", siteUrl))
    }
    authSession = data.session
  } else if (accessToken && refreshToken) {
    const { data, error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    })
    if (error) {
      return NextResponse.redirect(new URL("/login", siteUrl))
    }
    authSession = data.session
  } else {
    return NextResponse.redirect(new URL("/login", siteUrl))
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    console.info("[auth/callback] no session user after exchange")
    return NextResponse.redirect(new URL("/login", siteUrl))
  }

  console.info("[auth/callback] session user", { userId: user.id })
  const redirectPath = await getProfileRedirect(user.id, user.email, safeNext)
  console.info("[auth/callback] redirect destination", { userId: user.id, redirectPath })

  if (isValidDesktopOAuthState(desktopOAuthState) && authSession?.access_token && authSession.refresh_token) {
    storeDesktopOAuthExchange(desktopOAuthState!, {
      access_token: authSession.access_token,
      refresh_token: authSession.refresh_token,
      expires_at: authSession.expires_at,
      expires_in: authSession.expires_in,
      token_type: authSession.token_type,
      user: authSession.user,
      redirectTo: new URL(redirectPath, siteUrl).toString(),
    })

    return NextResponse.redirect(new URL("/desktop-auth-complete", siteUrl))
  }

  return NextResponse.redirect(new URL(redirectPath, siteUrl))
}

export async function POST(request: Request) {
  const url = new URL(request.url)
  const siteUrl = getSiteUrl(url.origin)
  const body = (await request.json().catch(() => null)) as {
    access_token?: string
    refresh_token?: string
    next?: string
    desktop?: boolean
  } | null

  if (!body?.access_token || !body.refresh_token) {
    return NextResponse.json({ redirectTo: `${siteUrl}/login` }, { status: 400 })
  }

  const desktopValidated = body.desktop === true && process.env.BEZGROW_DESKTOP_BUILD === "1"

  const supabase = await createServerSupabase()
  const { error } = desktopValidated
    ? await supabase.auth.getUser(body.access_token)
    : await supabase.auth.setSession({
        access_token: body.access_token,
        refresh_token: body.refresh_token,
      })

  if (error) {
    return NextResponse.json({ redirectTo: `${siteUrl}/login` }, { status: 401 })
  }

  const {
    data: { user },
  } = desktopValidated ? await supabase.auth.getUser(body.access_token) : await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ redirectTo: `${siteUrl}/login` }, { status: 401 })
  }

  if (desktopValidated) {
    const redirectPath = getSafeNextPath(body.next || null)
    const response = NextResponse.json({ redirectTo: new URL(redirectPath, siteUrl).toString() })
    response.cookies.set("bezgrow_desktop_auth", "1", {
      path: "/",
      maxAge: 60 * 60 * 24 * 180,
      sameSite: "lax",
    })
    return response
  }

  console.info("[auth/callback] post session user", { userId: user.id })
  const redirectPath = await getProfileRedirect(user.id, user.email, getSafeNextPath(body.next || null))
  console.info("[auth/callback] post redirect destination", { userId: user.id, redirectPath })
  return NextResponse.json({ redirectTo: new URL(redirectPath, siteUrl).toString() })
}
