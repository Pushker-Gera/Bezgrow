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
  const orgId = workspace.context.organizationId
  const status = url.searchParams.get("status") || "all"
  const customerId = url.searchParams.get("customer_id") || "all"
  const period = url.searchParams.get("period") || "all"
  let matchingCustomerIds: string[] = []

  if (pagination.search) {
    const customerTerm = pagination.search.replaceAll(",", " ").trim()
    const { data: matchingCustomers } = await adminSupabase
      .from("customers")
      .select("id")
      .eq("organization_id", orgId)
      .or(`name.ilike.%${customerTerm}%,email.ilike.%${customerTerm}%,phone.ilike.%${customerTerm}%`)
      .limit(100)

    matchingCustomerIds = (matchingCustomers || []).map((customer) => customer.id).filter(Boolean)
  }

  let query = adminSupabase
    .from("invoices")
    .select(
      "id,organization_id,customer_id,customer_name,invoice_number,payment_status,status,payment_method,notes,due_date,grand_total,total_amount,total,tax_amount,tax_total,created_at,sync_status,invoice_type",
      { count: "exact" }
    )
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .range(from, to)

  if (status !== "all") {
    query = query.or(`payment_status.eq.${status},status.eq.${status}`)
  }

  if (customerId !== "all") {
    query = query.eq("customer_id", customerId)
  }

  if (period !== "all") {
    const now = new Date()
    let start: Date | null = null
    let end: Date | null = null

    if (period === "today") {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      end = new Date(start)
      end.setDate(start.getDate() + 1)
    }

    if (period === "week") {
      start = new Date(now)
      start.setDate(now.getDate() - 7)
    }

    if (period === "month") {
      start = new Date(now.getFullYear(), now.getMonth(), 1)
    }

    if (start) query = query.gte("created_at", start.toISOString())
    if (end) query = query.lt("created_at", end.toISOString())
  }

  if (pagination.search) {
    const term = pagination.search.replaceAll(",", " ")
    const filters = [
      `invoice_number.ilike.%${term}%`,
      `customer_name.ilike.%${term}%`,
      `payment_method.ilike.%${term}%`,
    ]

    if (matchingCustomerIds.length > 0) {
      filters.push(`customer_id.in.(${matchingCustomerIds.join(",")})`)
    }

    query = query.or(filters.join(","))
  }

  const { data, error, count } = await query
  if (error) return fail(`Invoices failed to load: ${error.message}`, 500)

  const rows = data || []
  const invoiceIds = rows.map((invoice) => invoice.id).filter(Boolean)
  const customerIds = Array.from(
    new Set(
      rows
        .map((invoice) => {
          const value = (invoice as Record<string, unknown>).customer_id
          return typeof value === "string" ? value : ""
        })
        .filter(Boolean)
    )
  )
  const customerMap = new Map<string, { name?: string | null; phone?: string | null; email?: string | null }>()

  if (customerIds.length > 0) {
    const { data: customers } = await adminSupabase
      .from("customers")
      .select("id,name,phone,email")
      .eq("organization_id", orgId)
      .in("id", customerIds)

    ;(customers || []).forEach((customer) => {
      customerMap.set(customer.id, customer)
    })
  }

  const itemMetrics = new Map<string, { itemCount: number; quantity: number; tax: number; total: number }>()

  if (invoiceIds.length > 0) {
    const { data: itemRows } = await adminSupabase
      .from("invoice_items")
      .select("invoice_id,quantity,line_total,gst_amount")
      .eq("organization_id", orgId)
      .in("invoice_id", invoiceIds)

    ;(itemRows || []).forEach((item) => {
      const invoiceId = typeof item.invoice_id === "string" ? item.invoice_id : ""
      if (!invoiceId) return

      const current = itemMetrics.get(invoiceId) || { itemCount: 0, quantity: 0, tax: 0, total: 0 }
      current.itemCount += 1
      current.quantity += Number(item.quantity || 0)
      current.tax += Number(item.gst_amount || 0)
      current.total += Number(item.line_total || 0)
      itemMetrics.set(invoiceId, current)
    })
  }

  const enrichedRows = rows.map((invoice) => {
    const record = invoice as Record<string, unknown>
    const customerId = typeof record.customer_id === "string" ? record.customer_id : ""
    const customer = customerMap.get(customerId)
    const metrics = itemMetrics.get(invoice.id) || { itemCount: 0, quantity: 0, tax: 0, total: 0 }

    return {
      ...invoice,
      customer_name: record.customer_name || customer?.name || null,
      customer_phone: record.customer_phone || customer?.phone || null,
      customer_email: record.customer_email || customer?.email || null,
      item_count: metrics.itemCount,
      total_quantity: metrics.quantity,
      item_tax: metrics.tax,
      item_total: metrics.total,
    }
  })

  return NextResponse.json(
    { data: enrichedRows, pagination: { ...pagination, total: count || 0 } },
    { headers: { "Cache-Control": "no-store" } }
  )
}
