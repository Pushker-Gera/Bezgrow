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
    error.message.match(/column "([^"]+)" does not exist/i) ||
    error.message.match(/column ([\w.]+) does not exist/i)

  return match?.[1]?.split(".").pop() || null
}

function buildOrdersQuery(
  adminSupabase: Awaited<typeof import("@/lib/supabase/admin")>["adminSupabase"],
  organizationId: string,
  pagination: ReturnType<typeof parsePagination>,
  from: number,
  to: number,
  columns: string[]
) {
  const searchableColumns = ["order_number", "customer_name", "tracking_number", "courier_name", "courier"].filter((column) => columns.includes(column))
  let query = adminSupabase
    .from("orders")
    .select(columns.join(","), { count: "exact" })
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .range(from, to)

  if (pagination.search && searchableColumns.length) {
    const term = pagination.search.replaceAll(",", " ")
    query = query.or(searchableColumns.map((column) => `${column}.ilike.%${term}%`).join(","))
  }

  return query
}

export async function GET(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)

  const pagination = parsePagination(request)
  const { from, to } = paginationRange(pagination)
  const { adminSupabase } = await import("@/lib/supabase/admin")
  const requiredColumns = new Set(["id", "order_number", "customer_name", "total_amount", "created_at"])
  const columns = [
    "id",
    "order_number",
    "customer_id",
    "customer_name",
    "customer_phone",
    "customer_address",
    "total_amount",
    "grand_total",
    "total",
    "order_status",
    "status",
    "payment_status",
    "tracking_number",
    "courier_name",
    "courier",
    "created_at",
    "updated_at",
  ]

  let activeColumns = [...columns]
  let result = await buildOrdersQuery(adminSupabase, workspace.context.organizationId, pagination, from, to, activeColumns)

  for (let attempt = 0; attempt < columns.length; attempt += 1) {
    const missingColumn = missingColumnFromError(result.error)
    if (!missingColumn || requiredColumns.has(missingColumn) || !activeColumns.includes(missingColumn)) break

    activeColumns = activeColumns.filter((column) => column !== missingColumn)
    result = await buildOrdersQuery(adminSupabase, workspace.context.organizationId, pagination, from, to, activeColumns)
  }

  const { data, error, count } = result
  if (error) {
    console.warn("[orders/list] query failed", {
      code: error.code,
      message: error.message,
      details: error.details,
      activeColumns,
    })
    return fail("Orders failed to load.", 500)
  }

  const rows = ((data || []) as unknown as OrderListRow[]).map((order) => ({
    ...order,
    courier_name: order.courier_name || order.courier || null,
  }))

  return NextResponse.json(
    { data: rows, pagination: { ...pagination, total: count || 0 } },
    { headers: { "Cache-Control": "no-store" } }
  )
}
