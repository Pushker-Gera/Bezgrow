import { z } from "zod"
import { adminSupabase } from "@/lib/supabase/admin"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { validateMutationOrigin } from "@/lib/api/auth"
import { checkRateLimit, rateLimitKey } from "@/lib/security/rate-limit"

export const dynamic = "force-dynamic"

const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  businessName: z.string().trim().min(2).max(160),
  phone: z.string().trim().min(7).max(30),
  email: z.string().trim().email().max(254),
  password: z
    .string()
    .min(8)
    .max(128)
    .regex(/[A-Za-z]/, "Password must include a letter.")
    .regex(/[0-9]/, "Password must include a number."),
  termsAccepted: z.boolean().refine(Boolean, "Terms must be accepted."),
})

export async function POST(request: Request) {
  try {
    if (!validateMutationOrigin(request)) {
      return fail("Invalid request origin.", 403)
    }

    const limit = checkRateLimit({
      key: rateLimitKey(request, "auth.register"),
      limit: 8,
      windowMs: 60 * 60 * 1000,
    })

    if (!limit.allowed) {
      return fail("Too many signup attempts. Please try again later.", 429)
    }

    const parsed = registerSchema.safeParse(await request.json())

    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message || "Invalid signup details.", 400)
    }

    const payload = parsed.data
    const email = payload.email.toLowerCase()

    const { data: existingPending } = await adminSupabase
      .from("pending_users")
      .select("id,status")
      .eq("email", email)
      .maybeSingle()

    if (existingPending?.status === "pending") {
      return fail("This email already has a pending approval request.", 409)
    }

    const { data: authData, error: authError } = await adminSupabase.auth.admin.createUser({
      email,
      password: payload.password,
      email_confirm: true,
      user_metadata: {
        full_name: payload.fullName,
        business_name: payload.businessName,
        phone: payload.phone,
      },
    })

    if (authError || !authData.user) {
      const message = authError?.message?.toLowerCase().includes("already")
        ? "This email is already registered. Please login or use another email."
        : "Signup could not be completed."
      return fail(message, authError?.message?.toLowerCase().includes("already") ? 409 : 400)
    }

    const userId = authData.user.id

    const { error: profileError } = await adminSupabase.from("profiles").upsert({
      id: userId,
      email,
      full_name: payload.fullName,
      role: "user",
      approved: false,
      business_created: false,
      is_suspended: false,
      updated_at: new Date().toISOString(),
    })

    if (profileError) {
      await adminSupabase.auth.admin.deleteUser(userId)
      return fail("Account profile could not be created. Please contact support.", 500)
    }

    const { error: pendingError } = await adminSupabase.from("pending_users").upsert({
      id: userId,
      full_name: payload.fullName,
      business_name: payload.businessName,
      phone: payload.phone,
      email,
      status: "pending",
    })

    if (pendingError) {
      await adminSupabase.auth.admin.deleteUser(userId)
      return fail("Approval request could not be created. Please contact support.", 500)
    }

    return ok({ status: "pending", message: "Application submitted for admin approval." })
  } catch {
    return serverFail()
  }
}
