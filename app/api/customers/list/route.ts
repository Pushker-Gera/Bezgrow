import { NextResponse } from "next/server"
import { requireWorkspace, parsePagination, paginationRange } from "@/lib/api/tenant"
import { fail } from "@/lib/api/responses"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)

  const pagination = parsePagination(request)
  const url = new URL(request.url)
  const { from, to } = paginationRange(pagination)
  const { adminSupabase } = await import("@/lib/supabase/admin")

  const allowedSort = new Set(["created_at", "updated_at", "name", "total_sales", "last_purchase_at"])
  const sort = allowedSort.has(pagination.sort) ? pagination.sort : "created_at"
  let query = adminSupabase
    .from("customers")
    .select("id,name,email,phone,gst_number,address,created_at,updated_at,is_active,total_sales,last_purchase_at,deleted_at,customer_type", { count: "exact" })
    .eq("organization_id", workspace.context.organizationId)
    .is("deleted_at", null)
    .order(sort, { ascending: pagination.direction === "asc" })
    .range(from, to)

  if (pagination.search) {
    const term = pagination.search.replaceAll(",", " ")
    query = query.or(`name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%,gst_number.ilike.%${term}%`)
  }
  const status = url.searchParams.get("status") || "all"
  const customerType = url.searchParams.get("customer_type") || "all"
  const gstStatus = url.searchParams.get("gst_status") || "all"
  if (status === "active") query = query.eq("is_active", true)
  if (status === "inactive") query = query.eq("is_active", false)
  if (customerType !== "all") query = query.eq("customer_type", customerType)
  if (gstStatus === "gst") query = query.not("gst_number", "is", null).neq("gst_number", "")
  if (gstStatus === "nonGst") query = query.or("gst_number.is.null,gst_number.eq.")

  const { data, error, count } = await query
  if (error) return fail("Customers failed to load.", 500)

  const rows = data || []
  const customerIds = rows.map((customer) => customer.id).filter(Boolean)
  const metrics = new Map<string, { count: number; revenue: number; lastPurchaseAt: string | null }>()
  if (customerIds.length > 0) {
    const { data: invoiceRows } = await adminSupabase
      .from("invoices")
      .select("customer_id,grand_total,total_amount,total,created_at")
      .eq("organization_id", workspace.context.organizationId)
      .in("customer_id", customerIds)

    ;(invoiceRows || []).forEach((invoice) => {
      const customerId = typeof invoice.customer_id === "string" ? invoice.customer_id : ""
      if (!customerId) return
      const current = metrics.get(customerId) || { count: 0, revenue: 0, lastPurchaseAt: null }
      current.count += 1
      current.revenue += Number(invoice.grand_total || invoice.total_amount || invoice.total || 0)
      const createdAt = typeof invoice.created_at === "string" ? invoice.created_at : null
      if (createdAt && (!current.lastPurchaseAt || createdAt > current.lastPurchaseAt)) current.lastPurchaseAt = createdAt
      metrics.set(customerId, current)
    })
  }

  const enrichedRows = rows.map((customer) => {
    const metric = metrics.get(customer.id)
    return {
      ...customer,
      invoice_count: metric?.count || 0,
      total_sales: metric?.count ? metric.revenue : Number(customer.total_sales || 0),
      last_purchase_at: metric?.lastPurchaseAt || customer.last_purchase_at || null,
    }
  })

  return NextResponse.json(
    { data: enrichedRows, pagination: { ...pagination, total: count || 0 } },
    { headers: { "Cache-Control": "no-store" } }
  )
}
