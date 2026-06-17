import { NextResponse } from "next/server"
import { parsePagination, paginationRange } from "@/lib/api/tenant"
import { getAuthenticatedUser } from "@/lib/api/auth"
import { fail } from "@/lib/api/responses"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const allowedSort = new Set(["created_at", "name", "sku", "stock", "sale_rate", "category"])

export async function GET(request: Request) {
  const user = await getAuthenticatedUser(request)
  if (!user) return fail("Authentication required.", 401)

  const [{ data: profile }, { data: membership }] = await Promise.all([
    adminSupabase
      .from("profiles")
      .select("approved, business_created, is_suspended")
      .eq("id", user.id)
      .maybeSingle(),
    adminSupabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle(),
  ])

  if (!profile || profile.is_suspended || profile.approved === false || profile.business_created === false) {
    return fail("Workspace access is not available.", 403)
  }

  if (!membership?.organization_id) {
    return fail("No workspace is connected to this account.", 403)
  }

  const pagination = parsePagination(request)
  const { from, to } = paginationRange(pagination)
  const sort = allowedSort.has(pagination.sort) ? pagination.sort : "created_at"

  let query = adminSupabase
    .from("products")
    .select(
      "id,organization_id,name,description,sku,barcode,category,unit,supplier,warehouse,manufacturer,price,stock,batch_no,mrp,purchase_rate,sale_rate,gst,expiry_date,purchase_date,min_stock,created_at,deleted_at",
      { count: "exact" }
    )
    .eq("organization_id", membership.organization_id)
    .is("deleted_at", null)
    .order(sort, { ascending: pagination.direction === "asc" })
    .range(from, to)

  if (pagination.search) {
    const term = pagination.search.replaceAll(",", " ")
    query = query.or(`name.ilike.%${term}%,sku.ilike.%${term}%,category.ilike.%${term}%,supplier.ilike.%${term}%,barcode.ilike.%${term}%`)
  }

  const { data, error, count } = await query
  if (error) return fail("Products failed to load.", 500)

  return NextResponse.json(
    { data: data || [], pagination: { ...pagination, total: count || 0 } },
    { headers: { "Cache-Control": "private, max-age=20, stale-while-revalidate=60" } }
  )
}
