import { NextResponse } from "next/server"
import { isConfiguredAdminEmail } from "@/lib/admin-access"
import { adminSupabase } from "@/lib/supabase/admin"
import { createServerSupabase } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

function getSiteUrl(origin: string) {
  const configuredUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (configuredUrl) return configuredUrl.replace(/\/$/, "")
  return (process.env.NODE_ENV === "production" ? "https://bezgrow.com" : origin).replace(/\/$/, "")
}

function getSafeNextPath(next: string | null) {
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/dashboard"
}

async function getProfileRedirect(userId: string, userEmail: string | null | undefined, requestedNext: string) {
  const { data: profile } = await adminSupabase
    .from("profiles")
    .select("role, approved, is_suspended")
    .eq("id", userId)
    .maybeSingle()

  if (profile?.is_suspended) return "/login"
  if (profile?.role === "admin" || isConfiguredAdminEmail(userEmail)) return "/admin"
  if (!profile) return "/login"
  if (!profile.approved) return "/pending-approval"
  return requestedNext === "/admin" ? "/dashboard" : requestedNext
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const siteUrl = getSiteUrl(url.origin)
  const code = url.searchParams.get("code")
  const accessToken = url.searchParams.get("access_token")
  const refreshToken = url.searchParams.get("refresh_token")
  const safeNext = getSafeNextPath(url.searchParams.get("next"))
  const supabase = await createServerSupabase()

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) {
      return NextResponse.redirect(new URL("/login", siteUrl))
    }
  } else if (accessToken && refreshToken) {
    const { error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    })
    if (error) {
      return NextResponse.redirect(new URL("/login", siteUrl))
    }
  } else {
    return NextResponse.redirect(new URL("/login", siteUrl))
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.redirect(new URL("/login", siteUrl))
  }

  const redirectPath = await getProfileRedirect(user.id, user.email, safeNext)
  return NextResponse.redirect(new URL(redirectPath, siteUrl))
}

export async function POST(request: Request) {
  const url = new URL(request.url)
  const siteUrl = getSiteUrl(url.origin)
  const body = (await request.json().catch(() => null)) as {
    access_token?: string
    refresh_token?: string
    next?: string
  } | null

  if (!body?.access_token || !body.refresh_token) {
    return NextResponse.json({ redirectTo: `${siteUrl}/login` }, { status: 400 })
  }

  const supabase = await createServerSupabase()
  const { error } = await supabase.auth.setSession({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
  })

  if (error) {
    return NextResponse.json({ redirectTo: `${siteUrl}/login` }, { status: 401 })
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ redirectTo: `${siteUrl}/login` }, { status: 401 })
  }

  const redirectPath = await getProfileRedirect(user.id, user.email, getSafeNextPath(body.next || null))
  return NextResponse.json({ redirectTo: new URL(redirectPath, siteUrl).toString() })
}
