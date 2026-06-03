import "server-only"
import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing Supabase server environment variables.")
}

const serverSupabaseUrl: string = supabaseUrl
const serverSupabaseAnonKey: string = supabaseAnonKey

export async function createServerSupabase() {
  const cookieStore = await cookies()

  return createServerClient(serverSupabaseUrl, serverSupabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        } catch {
          // Server Components cannot set cookies. Route handlers and server actions can.
        }
      },
    },
  })
}
