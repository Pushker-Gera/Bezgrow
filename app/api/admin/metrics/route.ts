import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const adminSupabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function requireAdmin(request: Request) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "")
  if (!token) return { ok: false, error: "Missing admin session." }

  const { data: authData, error: authError } = await adminSupabase.auth.getUser(token)
  if (authError || !authData.user) return { ok: false, error: "Invalid admin session." }

  const { data: profile, error: profileError } = await adminSupabase
    .from("profiles")
    .select("role")
    .eq("id", authData.user.id)
    .single()

  if (profileError || profile?.role !== "admin") return { ok: false, error: "Admin access required." }

  return { ok: true, userId: authData.user.id }
}

export async function GET(request: Request) {
  try {
    const admin = await requireAdmin(request)
    if (!admin.ok) {
      return NextResponse.json({ success: false, error: admin.error }, { status: 403 })
    }

    const [organizations, profiles, products, invoices, invoiceItems, orders, logs, usersCount, pendingUsers] = await Promise.all([
      adminSupabase.from("organizations").select("*").order("created_at", { ascending: false }).limit(5000),
      adminSupabase.from("profiles").select("*").limit(10000),
      adminSupabase.from("products").select("*").limit(20000),
      adminSupabase.from("invoices").select("*").order("created_at", { ascending: false }).limit(20000),
      adminSupabase.from("invoice_items").select("*").limit(50000),
      adminSupabase.from("orders").select("*").order("created_at", { ascending: false }).limit(10000),
      adminSupabase.from("admin_logs").select("*").order("created_at", { ascending: false }).limit(20),
      adminSupabase.from("profiles").select("*", { count: "exact", head: true }),
      adminSupabase.from("pending_users").select("*").order("created_at", { ascending: false }).limit(5000),
    ])

    const firstError =
      organizations.error ||
      profiles.error ||
      products.error ||
      invoices.error ||
      invoiceItems.error ||
      orders.error ||
      usersCount.error ||
      pendingUsers.error

    if (firstError) {
      return NextResponse.json({ success: false, error: firstError.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      organizations: organizations.data || [],
      profiles: profiles.data || [],
      products: products.data || [],
      invoices: invoices.data || [],
      invoiceItems: invoiceItems.data || [],
      orders: orders.data || [],
      logs: logs.error ? [] : logs.data || [],
      usersCount: usersCount.count || 0,
      pendingUsers: pendingUsers.data || [],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Admin metrics service is temporarily unavailable."
    return NextResponse.json({ success: false, error: message }, { status: 503 })
  }
}
