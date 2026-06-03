import { NextResponse } from "next/server"
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

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get("code")
  const safeNext = getSafeNextPath(url.searchParams.get("next"))

  if (code) {
    const supabase = await createServerSupabase()
    await supabase.auth.exchangeCodeForSession(code)
  }

  return NextResponse.redirect(new URL(safeNext, getSiteUrl(url.origin)))
}
