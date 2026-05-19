import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const adminSupabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const planAmounts: Record<string, number> = {
  monthly: 250,
  yearly: 2000,
}

export async function POST(request: Request) {
  try {
    const token = request.headers.get("authorization")?.replace("Bearer ", "")
    if (!token) {
      return NextResponse.json({ success: false, error: "Please login before activating a plan." }, { status: 401 })
    }

    const { data: authData, error: authError } = await adminSupabase.auth.getUser(token)
    if (authError || !authData.user?.email) {
      return NextResponse.json({ success: false, error: "Invalid user session." }, { status: 401 })
    }

    const body = await request.json().catch(() => ({}))
    const plan = body.plan === "yearly" ? "yearly" : "monthly"
    const reference = typeof body.reference === "string" ? body.reference.trim() : ""

    const { error: profileError } = await adminSupabase.from("profiles").upsert({
      id: authData.user.id,
      email: authData.user.email,
      approved: true,
      business_created: false,
      role: "user",
    })

    if (profileError) {
      return NextResponse.json({ success: false, error: profileError.message }, { status: 500 })
    }

    await adminSupabase.from("pending_users").delete().eq("id", authData.user.id)
    await adminSupabase.from("pending_users").delete().eq("email", authData.user.email)
    await adminSupabase.from("admin_logs").insert({
      action: "UPI_SUBSCRIPTION_ACTIVATED",
      description: `${authData.user.email} activated ${plan} access for Rs ${planAmounts[plan]}${reference ? ` with reference ${reference}` : ""}.`,
    })

    return NextResponse.json({
      success: true,
      plan,
      amount: planAmounts[plan],
      redirectTo: "/create-business",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payment activation failed."
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
