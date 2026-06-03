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
    .from("invoices")
    .select(
      "id,invoice_number,customer_id,customer_name,payment_status,status,payment_method,grand_total,total_amount,total,tax_amount,tax_total,due_date,created_at,updated_at",
      { count: "exact" }
    )
    .eq("organization_id", workspace.context.organizationId)
    .order("created_at", { ascending: false })
    .range(from, to)

  if (pagination.search) {
    const term = pagination.search.replaceAll(",", " ")
    query = query.or(`invoice_number.ilike.%${term}%,customer_name.ilike.%${term}%,payment_method.ilike.%${term}%`)
  }

  const { data, error, count } = await query
  if (error) return fail("Invoices failed to load.", 500)

  return NextResponse.json(
    { data: data || [], pagination: { ...pagination, total: count || 0 } },
    { headers: { "Cache-Control": "no-store" } }
  )
}
