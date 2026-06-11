import type { CookieOptionsWithName } from "@supabase/ssr"

export const AUTH_COOKIE_MAX_AGE = 400 * 24 * 60 * 60

export const authCookieOptions: CookieOptionsWithName = {
  path: "/",
  sameSite: "lax",
  maxAge: AUTH_COOKIE_MAX_AGE,
}
