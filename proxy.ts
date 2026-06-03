import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

const protectedPrefixes = ["/dashboard", "/profile"]
const adminPrefixes = ["/admin"]

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()

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

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, approved, business_created, is_suspended")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile || profile.is_suspended) {
    return redirectWithCookies(request, response, "/login")
  }

  if (adminRoute) {
    if (profile.role !== "admin") {
      return redirectWithCookies(request, response, "/dashboard")
    }
    return response
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
