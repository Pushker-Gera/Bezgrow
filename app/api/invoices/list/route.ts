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
  const orgId = workspace.context.organizationId
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
    .select("*", { count: "exact" })
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .range(from, to)

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

  const enrichedRows = rows.map((invoice) => {
    const record = invoice as Record<string, unknown>
    const customerId = typeof record.customer_id === "string" ? record.customer_id : ""
    const customer = customerMap.get(customerId)

    return {
      ...invoice,
      customer_name: record.customer_name || customer?.name || null,
      customer_phone: record.customer_phone || customer?.phone || null,
      customer_email: record.customer_email || customer?.email || null,
    }
  })

  return NextResponse.json(
    { data: enrichedRows, pagination: { ...pagination, total: count || 0 } },
    { headers: { "Cache-Control": "no-store" } }
  )
}
