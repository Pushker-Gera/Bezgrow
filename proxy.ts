import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { authCookieOptions } from "@/lib/supabase/session"

const protectedPrefixes = ["/dashboard", "/profile"]
const adminPrefixes = ["/admin"]
const desktopAuthMarkerCookie = "bezgrow_desktop_auth"
const desktopServerBuild = process.env.BEZGROW_DESKTOP_BUILD === "1"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()

type ProfileGate = {
  role: string | null
  business_created: boolean | null
  is_suspended: boolean | null
}

function isConfiguredAdmin(email: string | null | undefined, role?: string | null) {
  void email
  return role === "admin" || role === "platform_admin"
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
  const localDesktopHost = ["localhost", "127.0.0.1", "[::1]"].includes(request.nextUrl.hostname)
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

  const desktopAuthMarked = request.cookies.get(desktopAuthMarkerCookie)?.value === "1"

  if (localDesktopHost && adminRoute && (desktopServerBuild || desktopAuthMarked)) {
    return redirectWithCookies(request, NextResponse.next({ request }), "/platform-admin")
  }

  if (localDesktopHost && desktopAuthMarked && protectedRoute) {
    return NextResponse.next()
  }

  if (localDesktopHost && desktopServerBuild && protectedRoute) {
    return NextResponse.next()
  }

  if (localDesktopHost && protectedRoute) {
    return redirectWithCookies(
      request,
      NextResponse.next({ request }),
      `/offline?next=${encodeURIComponent(`${pathname}${request.nextUrl.search}`)}`
    )
  }

  if (protectedRoute) {
    return redirectWithCookies(request, NextResponse.next({ request }), "/download?erp=desktop_local_only")
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
    .select("role, business_created, is_suspended")
    .eq("id", user.id)
    .maybeSingle()

  const profile = userProfile as ProfileGate | null

  if (!profile || profile.is_suspended) {
    return redirectWithCookies(request, response, profile?.is_suspended ? "/login?error=account_suspended" : "/login?error=profile_missing")
  }

  if (adminRoute) {
    if (!isConfiguredAdmin(user.email, profile.role)) {
      return redirectWithCookies(request, response, "/login?next=/admin&platform_admin=1&error=admin_required")
    }
    return response
  }

  return response
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*", "/profile/:path*"],
}
