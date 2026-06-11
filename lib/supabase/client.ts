import { createBrowserClient } from "@supabase/ssr"
import { authCookieOptions } from "@/lib/supabase/session"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "Missing Supabase public environment variables. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
  )
}

const publicSupabaseUrl: string = supabaseUrl
const publicSupabaseAnonKey: string = supabaseAnonKey

export const supabase = createBrowserClient(publicSupabaseUrl, publicSupabaseAnonKey, {
  cookieOptions: authCookieOptions,
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
