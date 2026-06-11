import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { authCookieOptions } from "@/lib/supabase/session"

const protectedPrefixes = ["/dashboard", "/profile"]
const adminPrefixes = ["/admin"]

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

type ProfileGate = {
  role: string | null
  approved: boolean | null
  business_created: boolean | null
  is_suspended: boolean | null
}

function isConfiguredAdmin(email: string | null | undefined, role?: string | null) {
  if (role === "admin") return true

  const configuredAdminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  if (!configuredAdminEmail || !email) return false

  return email.trim().toLowerCase() === configuredAdminEmail
}

async function hasConnectedWorkspace(userId: string) {
  if (!supabaseUrl || !supabaseServiceRoleKey) return false

  try {
    const membershipResponse = await fetch(
      `${supabaseUrl}/rest/v1/organization_members?user_id=eq.${encodeURIComponent(userId)}&select=organization_id&limit=1`,
      {
        headers: {
          apikey: supabaseServiceRoleKey,
          authorization: `Bearer ${supabaseServiceRoleKey}`,
        },
        cache: "no-store",
      }
    )

    if (membershipResponse.ok) {
      const memberships = (await membershipResponse.json()) as Array<{ organization_id?: string | null }>
      if (memberships[0]?.organization_id) return true
    }

    const ownerResponse = await fetch(
      `${supabaseUrl}/rest/v1/organizations?owner_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`,
      {
        headers: {
          apikey: supabaseServiceRoleKey,
          authorization: `Bearer ${supabaseServiceRoleKey}`,
        },
        cache: "no-store",
      }
    )

    if (!ownerResponse.ok) return false
    const organizations = (await ownerResponse.json()) as Array<{ id?: string | null }>
    return Boolean(organizations[0]?.id)
  } catch {
    return false
  }
}

function redirectWithCookies(request: NextRequest, response: NextResponse, pathname: string) {
  const redirectUrl = new URL(pathname, request.url)
  const redirectResponse = NextResponse.redirect(redirectUrl)
  response.cookies.getAll().forEach((cookie) => {
    redirectResponse.cookies.set(cookie)
  })
  return redirectResponse
}

function redirectToLogin(request: NextRequest, response: NextResponse) {
  const loginUrl = new URL("/login", request.url)
  loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`)
  const redirectResponse = NextResponse.redirect(loginUrl)
  response.cookies.getAll().forEach((cookie) => {
    redirectResponse.cookies.set(cookie)
  })
  return redirectResponse
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isPrefetch =
    request.headers.get("purpose") === "prefetch" ||
    request.headers.get("next-router-prefetch") === "1" ||
    request.headers.has("next-router-prefetch")

  if (isPrefetch) {
    return NextResponse.next()
  }

  const protectedRoute = protectedPrefixes.some((prefix) => pathname.startsWith(prefix))
  const adminRoute = adminPrefixes.some((prefix) => pathname.startsWith(prefix))

  if (!protectedRoute && !adminRoute) {
    return NextResponse.next()
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    return redirectToLogin(request, NextResponse.next({ request }))
  }

  let response = NextResponse.next({ request })

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookieOptions: authCookieOptions,
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
        response = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options)
        })
      },
    },
  })

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return redirectToLogin(request, response)
  }

  const { data: userProfile } = await supabase
    .from("profiles")
    .select("role, approved, business_created, is_suspended")
    .eq("id", user.id)
    .maybeSingle()

  let profile = userProfile as ProfileGate | null

  if (!profile && supabaseServiceRoleKey) {
    try {
      const profileResponse = await fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role,approved,business_created,is_suspended`,
        {
          headers: {
            apikey: supabaseServiceRoleKey,
            authorization: `Bearer ${supabaseServiceRoleKey}`,
          },
          cache: "no-store",
        }
      )

      if (profileResponse.ok) {
        const rows = (await profileResponse.json()) as ProfileGate[]
        profile = rows[0] ?? null
      }
    } catch {
      profile = null
    }
  }

  if (!profile && adminRoute && isConfiguredAdmin(user.email, null)) {
    return response
  }

  if (!profile || profile.is_suspended) {
    return redirectWithCookies(request, response, profile?.is_suspended ? "/login?error=account_suspended" : "/login?error=profile_missing")
  }

  if (adminRoute) {
    if (!isConfiguredAdmin(user.email, profile.role)) {
      return redirectWithCookies(request, response, "/dashboard")
    }
    return response
  }

  if (!profile.approved) {
    return redirectWithCookies(request, response, "/pending-approval")
  }

  if (!profile.business_created && !(await hasConnectedWorkspace(user.id))) {
    return redirectWithCookies(request, response, "/create-business")
  }

  return response
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*", "/profile/:path*"],
}
