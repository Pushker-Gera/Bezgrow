import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { isConfiguredAdminEmail } from "@/lib/admin-access"

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

  if (!profile || profile.is_suspended) {
    if (!isConfiguredAdminEmail(user.email)) {
      return redirectWithCookies(request, response, "/login")
    }
  }

  if (adminRoute) {
    if (profile?.role !== "admin" && !isConfiguredAdminEmail(user.email)) {
      return redirectWithCookies(request, response, "/dashboard")
    }
    return response
  }

  if (!profile && isConfiguredAdminEmail(user.email)) {
    return redirectWithCookies(request, response, "/admin")
  }

  if (!profile) {
    return redirectWithCookies(request, response, "/login")
  }

  if (!profile.approved) {
    return redirectWithCookies(request, response, "/pending-approval")
  }

  if (!profile.business_created) {
    return redirectWithCookies(request, response, "/create-business")
  }

  return response
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*", "/profile/:path*"],
}
