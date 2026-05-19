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

export async function POST(request: Request) {
  const admin = await requireAdmin(request)
  if (!admin.ok) {
    return NextResponse.json({ success: false, error: admin.error }, { status: 403 })
  }

  const body = (await request.json()) as {
    ownerId?: string
    businessName?: string
    action?: "activate" | "suspend"
  }

  if (!body.ownerId || !body.action) {
    return NextResponse.json({ success: false, error: "Missing business owner or action." }, { status: 400 })
  }

  const payload = body.action === "activate" ? { approved: true, business_created: true } : { business_created: false }
  const { error } = await adminSupabase.from("profiles").update(payload).eq("id", body.ownerId)

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  const description = `${body.businessName || "Business"} ${body.action === "activate" ? "activated" : "suspended"} by admin.`
  await adminSupabase.from("admin_logs").insert({
    action: body.action === "activate" ? "BUSINESS_ACTIVATED" : "BUSINESS_SUSPENDED",
    description,
  })

  return NextResponse.json({ success: true, message: description })
}
