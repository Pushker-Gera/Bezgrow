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
    .from("organizations")
    .select("id,name,business_type,category,currency,timezone,locale,created_at,updated_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to)

  if (pagination.search) {
    const term = pagination.search.replaceAll(",", " ")
    query = query.or(`name.ilike.%${term}%,business_type.ilike.%${term}%,category.ilike.%${term}%,currency.ilike.%${term}%`)
  }

  const { data: organizations, error, count } = await query
  if (error) return fail("Businesses failed to load.", 500)

  const organizationIds = (organizations || []).map((org) => org.id)

  const [memberResult, productResult, invoiceResult] = await Promise.all([
    organizationIds.length
      ? adminSupabase
          .from("organization_members")
          .select("organization_id,user_id,role")
          .in("organization_id", organizationIds)
      : Promise.resolve({ data: [], error: null }),
    organizationIds.length
      ? adminSupabase
          .from("products")
          .select("organization_id,stock,sale_rate,price,purchase_rate")
          .in("organization_id", organizationIds)
          .is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    organizationIds.length
      ? adminSupabase
          .from("invoices")
          .select("organization_id,grand_total,total_amount,total,payment_status,status")
          .in("organization_id", organizationIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  if (memberResult.error || productResult.error || invoiceResult.error) {
    return fail("Business metrics failed to load.", 500)
  }

  const memberMap = new Map<string, number>()
  ;(memberResult.data || []).forEach((member) => {
    memberMap.set(member.organization_id, (memberMap.get(member.organization_id) || 0) + 1)
  })

  const productMap = new Map<string, { count: number; stockValue: number }>()
  ;(productResult.data || []).forEach((product) => {
    const current = productMap.get(product.organization_id) || { count: 0, stockValue: 0 }
    current.count += 1
    current.stockValue += Number(product.stock || 0) * Number(product.sale_rate || product.price || product.purchase_rate || 0)
    productMap.set(product.organization_id, current)
  })

  const invoiceMap = new Map<string, { count: number; revenue: number; paid: number }>()
  ;(invoiceResult.data || []).forEach((invoice) => {
    const current = invoiceMap.get(invoice.organization_id) || { count: 0, revenue: 0, paid: 0 }
    current.count += 1
    current.revenue += Number(invoice.grand_total || invoice.total_amount || invoice.total || 0)
    if (String(invoice.payment_status || invoice.status || "").toLowerCase() === "paid") {
      current.paid += 1
    }
    invoiceMap.set(invoice.organization_id, current)
  })

  const data = (organizations || []).map((organization) => ({
    ...organization,
    memberCount: memberMap.get(organization.id) || 0,
    productCount: productMap.get(organization.id)?.count || 0,
    stockValue: productMap.get(organization.id)?.stockValue || 0,
    invoiceCount: invoiceMap.get(organization.id)?.count || 0,
    revenue: invoiceMap.get(organization.id)?.revenue || 0,
    paidInvoices: invoiceMap.get(organization.id)?.paid || 0,
  }))

  return NextResponse.json(
    { data, pagination: { ...pagination, total: count || 0 } },
    { headers: { "Cache-Control": "no-store" } }
  )
}
