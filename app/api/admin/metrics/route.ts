import { adminSupabase } from "@/lib/supabase/admin"
import { requireAdmin } from "@/lib/api/auth"
import { fail, ok, serverFail } from "@/lib/api/responses"

export const dynamic = "force-dynamic"

type SupabaseListResult<T> = {
  data: T[] | null
  error: { message?: string } | null
}

function rowsOrEmpty<T>(result: SupabaseListResult<T>) {
  return result.error ? [] : result.data || []
}

export async function GET(request: Request) {
  try {
    const admin = await requireAdmin(request)
    if (!admin.ok) return fail(admin.error, admin.status)

    const [organizations, profiles, products, invoices, invoiceItems, orders, logs, usersCount, pendingUsers] =
      await Promise.all([
        adminSupabase
          .from("organizations")
          .select("id,name,currency,business_type,business_category,owner_id,created_at")
          .order("created_at", { ascending: false })
          .limit(500),
        adminSupabase
          .from("profiles")
          .select("id,email,full_name,role,approved,business_created,is_suspended,created_at")
          .limit(1000),
        adminSupabase
          .from("products")
          .select("id,organization_id,stock,min_stock,purchase_rate")
          .limit(5000),
        adminSupabase
          .from("invoices")
          .select("id,organization_id,invoice_number,payment_status,grand_total,total_amount,tax_amount,tax_total,created_at")
          .order("created_at", { ascending: false })
          .limit(5000),
        adminSupabase
          .from("invoice_items")
          .select("organization_id,invoice_id,product_id,quantity,line_total,gst_amount")
          .limit(10000),
        adminSupabase
          .from("orders")
          .select("id,organization_id,status,total_amount,grand_total,created_at")
          .order("created_at", { ascending: false })
          .limit(2000),
        adminSupabase
          .from("admin_logs")
          .select("id,action,description,organization_id,admin_user_id,metadata,created_at")
          .order("created_at", { ascending: false })
          .limit(20),
        adminSupabase.from("profiles").select("id", { count: "exact", head: true }),
        adminSupabase
          .from("pending_users")
          .select("id,email,full_name,business_name,status,created_at")
          .order("created_at", { ascending: false })
          .limit(500),
      ])

    return ok(
      {
        organizations: rowsOrEmpty(organizations),
        profiles: rowsOrEmpty(profiles),
        products: rowsOrEmpty(products),
        invoices: rowsOrEmpty(invoices),
        invoiceItems: rowsOrEmpty(invoiceItems),
        orders: rowsOrEmpty(orders),
        logs: rowsOrEmpty(logs),
        usersCount: usersCount.error ? rowsOrEmpty(profiles).length : usersCount.count || 0,
        pendingUsers: rowsOrEmpty(pendingUsers),
      },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch {
    return serverFail()
  }
}
