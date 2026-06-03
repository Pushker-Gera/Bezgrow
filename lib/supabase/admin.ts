import "server-only"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing Supabase admin environment variables.")
}

const adminSupabaseUrl: string = supabaseUrl
const adminServiceRoleKey: string = serviceRoleKey

export const adminSupabase = createClient(adminSupabaseUrl, adminServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
})
