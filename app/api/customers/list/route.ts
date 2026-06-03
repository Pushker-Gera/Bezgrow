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
    .from("customers")
    .select("id,name,email,phone,gst_number,address,created_at,updated_at,is_active,total_sales,last_purchase_at,deleted_at,customer_type", { count: "exact" })
    .eq("organization_id", workspace.context.organizationId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .range(from, to)

  if (pagination.search) {
    const term = pagination.search.replaceAll(",", " ")
    query = query.or(`name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%,gst_number.ilike.%${term}%`)
  }

  const { data, error, count } = await query
  if (error) return fail("Customers failed to load.", 500)

  return NextResponse.json(
    { data: data || [], pagination: { ...pagination, total: count || 0 } },
    { headers: { "Cache-Control": "no-store" } }
  )
}
