import { NextResponse } from "next/server"
import { requireWorkspace, parsePagination, paginationRange } from "@/lib/api/tenant"
import { fail } from "@/lib/api/responses"

export const dynamic = "force-dynamic"

type OrderListRow = Record<string, unknown> & {
  courier?: string | null
  courier_name?: string | null
}

function missingColumnFromError(error: { message?: string | null } | null) {
  if (!error?.message) return null
  const match =
    error.message.match(/Could not find the '([^']+)' column/i) ||
    error.message.match(/column "([^"]+)" of relation/i) ||
    error.message.match(/column "([^"]+)" does not exist/i)

  return match?.[1] || null
}

function buildOrdersQuery(
  adminSupabase: Awaited<typeof import("@/lib/supabase/admin")>["adminSupabase"],
  organizationId: string,
  pagination: ReturnType<typeof parsePagination>,
  from: number,
  to: number,
  courierField: "courier_name" | "courier"
) {
  let query = adminSupabase
    .from("orders")
    .select(
      `id,order_number,customer_id,customer_name,customer_phone,customer_address,total_amount,grand_total,total,order_status,status,payment_status,tracking_number,${courierField},created_at,updated_at`,
      { count: "exact" }
    )
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .range(from, to)

  if (pagination.search) {
    const term = pagination.search.replaceAll(",", " ")
    query = query.or(`order_number.ilike.%${term}%,customer_name.ilike.%${term}%,tracking_number.ilike.%${term}%,${courierField}.ilike.%${term}%`)
  }

  return query
}

export async function GET(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)

  const pagination = parsePagination(request)
  const { from, to } = paginationRange(pagination)
  const { adminSupabase } = await import("@/lib/supabase/admin")

  let result = await buildOrdersQuery(adminSupabase, workspace.context.organizationId, pagination, from, to, "courier_name")
  if (missingColumnFromError(result.error) === "courier_name") {
    result = await buildOrdersQuery(adminSupabase, workspace.context.organizationId, pagination, from, to, "courier")
  }

  const { data, error, count } = result
  if (error) return fail("Orders failed to load.", 500)

  const rows = ((data || []) as OrderListRow[]).map((order) => ({
    ...order,
    courier_name: order.courier_name || order.courier || null,
  }))

  return NextResponse.json(
    { data: rows, pagination: { ...pagination, total: count || 0 } },
    { headers: { "Cache-Control": "no-store" } }
  )
}
