import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/api/auth"
import { fail } from "@/lib/api/responses"
import { parsePagination, paginationRange } from "@/lib/api/tenant"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const admin = await requireAdmin(request)
  if (!admin.ok) return fail(admin.error, admin.status)

  const pagination = parsePagination(request)
  const { from, to } = paginationRange(pagination)
  const { adminSupabase } = await import("@/lib/supabase/admin")

  let query = adminSupabase
    .from("admin_logs")
    .select("id,action,description,organization_id,admin_user_id,metadata,created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to)

  if (pagination.search) {
    const term = pagination.search.replaceAll(",", " ")
    query = query.or(`action.ilike.%${term}%,description.ilike.%${term}%`)
  }

  const { data, error, count } = await query
  if (error) return fail("Admin logs failed to load.", 500)

  return NextResponse.json(
    { data: data || [], pagination: { ...pagination, total: count || 0 } },
    { headers: { "Cache-Control": "no-store" } }
  )
}
