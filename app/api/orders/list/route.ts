import { NextResponse } from "next/server"
import { requireWorkspace, parsePagination, paginationRange } from "@/lib/api/tenant"
import { fail } from "@/lib/api/responses"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)

  const pagination = parsePagination(request)
  const { from, to } = paginationRange(pagination)
  const { adminSupabase } = await import("@/lib/supabase/admin")

  let query = adminSupabase
    .from("orders")
    .select(
      "id,order_number,customer_id,customer_name,total_amount,order_status,status,payment_status,tracking_number,courier,created_at,updated_at",
      { count: "exact" }
    )
    .eq("organization_id", workspace.context.organizationId)
    .order("created_at", { ascending: false })
    .range(from, to)

  if (pagination.search) {
    const term = pagination.search.replaceAll(",", " ")
    query = query.or(`order_number.ilike.%${term}%,customer_name.ilike.%${term}%,tracking_number.ilike.%${term}%,courier.ilike.%${term}%`)
  }

  const { data, error, count } = await query
  if (error) return fail("Orders failed to load.", 500)

  return NextResponse.json(
    { data: data || [], pagination: { ...pagination, total: count || 0 } },
    { headers: { "Cache-Control": "no-store" } }
  )
}
