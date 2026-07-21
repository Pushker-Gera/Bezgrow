import { NextResponse } from "next/server"
import type { PostgrestError } from "@supabase/supabase-js"
import { isConfiguredAdmin } from "@/lib/admin-role"
import { isValidDesktopOAuthState, storeDesktopOAuthExchange } from "@/lib/desktop/oauth-store"
import { createServerSupabase } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

type SupabaseQueryClient = Pick<Awaited<ReturnType<typeof createServerSupabase>>, "from">

type ProfileGate = {
  role: string | null
  approved: boolean | null
  business_created: boolean | null
  is_suspended: boolean | null
}

function getSiteUrl(origin: string) {
  const configuredUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  return (origin || configuredUrl || "https://www.bezgrow.com").replace(/\/$/, "")
}

function getSafeNextPath(next: string | null) {
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/dashboard"
}

function trustedDesktopCallbackOrigin(value: string | null) {
  if (!value) return null

  try {
    const url = new URL(value)
    const trustedHost = url.hostname === "127.0.0.1" || url.hostname === "localhost"
    if (url.protocol !== "http:" || !trustedHost) return null
    return url.origin
  } catch {
    return null
  }
}

async function getOptionalAdminSupabase(): Promise<SupabaseQueryClient | null> {
  try {
    const { adminSupabase } = await import("@/lib/supabase/admin")
    return adminSupabase as SupabaseQueryClient
  } catch (error) {
    console.warn("[auth/callback] admin client unavailable; using authenticated session lookup", {
      message: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

async function readProfile(client: SupabaseQueryClient, userId: string) {
  return client
    .from("profiles")
    .select("role, approved, business_created, is_suspended")
    .eq("id", userId)
    .maybeSingle()
}

async function getProfileRedirect(
  client: SupabaseQueryClient,
  userId: string,
  email: string | null | undefined,
  requestedNext: string
) {
  let lookupClient = client
  let { data: profile, error: profileError } = (await readProfile(client, userId)) as {
    data: ProfileGate | null
    error: PostgrestError | null
  }

  if (profileError || !profile) {
    const adminClient = await getOptionalAdminSupabase()
    if (adminClient) {
      const adminProfile = (await readProfile(adminClient, userId)) as {
        data: ProfileGate | null
        error: PostgrestError | null
      }
      profile = adminProfile.data
      profileError = adminProfile.error
      lookupClient = adminClient
    }
  }

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
  } else if (profile.approved === false) {
    destination = "/pending-approval"
    reason = "pending_approval"
  } else if (!profile.business_created) {
    const [{ data: membership }, { data: ownedOrganization }] = await Promise.all([
      lookupClient
        .from("organization_members")
        .select("organization_id")
        .eq("user_id", userId)
        .limit(1)
        .maybeSingle(),
      lookupClient
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
  const desktopCallbackOrigin = trustedDesktopCallbackOrigin(url.searchParams.get("desktop_callback_origin"))
  const supabase = await createServerSupabase()
  let authSession: Awaited<ReturnType<typeof supabase.auth.exchangeCodeForSession>>["data"]["session"] | null = null

  console.info("[auth/callback] received", {
    hasCode: Boolean(code),
    hasAccessToken: Boolean(accessToken),
    hasRefreshToken: Boolean(refreshToken),
    next: safeNext,
    desktopOAuth: isValidDesktopOAuthState(desktopOAuthState),
    desktopCallback: Boolean(desktopCallbackOrigin),
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
  const redirectPath = await getProfileRedirect(supabase, user.id, user.email, safeNext)
  console.info("[auth/callback] redirect destination", { userId: user.id, redirectPath })

  if (isValidDesktopOAuthState(desktopOAuthState) && authSession?.access_token && authSession.refresh_token) {
    if (desktopCallbackOrigin) {
      const localCallback = new URL("/api/desktop-auth/callback", desktopCallbackOrigin)
      localCallback.searchParams.set("state", desktopOAuthState!)
      localCallback.searchParams.set("access_token", authSession.access_token)
      localCallback.searchParams.set("refresh_token", authSession.refresh_token)
      if (authSession.expires_at) localCallback.searchParams.set("expires_at", String(authSession.expires_at))
      if (authSession.expires_in) localCallback.searchParams.set("expires_in", String(authSession.expires_in))
      if (authSession.token_type) localCallback.searchParams.set("token_type", authSession.token_type)
      localCallback.searchParams.set("redirect_to", new URL(redirectPath, siteUrl).toString())
      return NextResponse.redirect(localCallback)
    }

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
    return NextResponse.json({ redirectTo: `${siteUrl}/login`, error: "Missing login session." }, { status: 400 })
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
    return NextResponse.json({ redirectTo: `${siteUrl}/login`, error: "Unable to verify login session." }, { status: 401 })
  }

  const {
    data: { user },
  } = desktopValidated ? await supabase.auth.getUser(body.access_token) : await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ redirectTo: `${siteUrl}/login`, error: "Unable to verify login session." }, { status: 401 })
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
  const redirectPath = await getProfileRedirect(supabase, user.id, user.email, getSafeNextPath(body.next || null))
  console.info("[auth/callback] post redirect destination", { userId: user.id, redirectPath })
  return NextResponse.json({ redirectTo: new URL(redirectPath, siteUrl).toString() })
}
