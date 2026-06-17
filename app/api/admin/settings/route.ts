import { z } from "zod"
import { requireAdmin, writeAdminLog } from "@/lib/api/auth"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const settingsSchema = z.object({
  id: z.string().trim().min(1).optional(),
  platform_name: z.string().trim().min(1).max(120),
  support_email: z.string().trim().email().max(254),
  maintenance_mode: z.boolean(),
  email_notifications: z.boolean(),
  auto_approvals: z.boolean(),
  inventory_tracking: z.boolean(),
  billing_automation: z.boolean(),
})

const logSchema = z.object({
  action: z.string().trim().min(2).max(120),
  description: z.string().trim().min(2).max(500),
})

export async function GET(request: Request) {
  const admin = await requireAdmin(request)
  if (!admin.ok) return fail(admin.error, admin.status)

  try {
    const { data, error } = await adminSupabase.from("platform_settings").select("*").maybeSingle()
    if (error) return fail("Platform settings failed to load.", 500)

    return ok({ settings: data || null }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return serverFail()
  }
}

export async function PATCH(request: Request) {
  const admin = await requireAdmin(request)
  if (!admin.ok) return fail(admin.error, admin.status)

  const parsed = settingsSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message || "Invalid platform settings.", 422)
  }

  try {
    const payload = {
      ...parsed.data,
      support_email: parsed.data.support_email.toLowerCase(),
    }

    const { data: existing } = await adminSupabase.from("platform_settings").select("id").maybeSingle()
    const result = existing?.id
      ? await adminSupabase.from("platform_settings").update(payload).eq("id", existing.id).select("*").single()
      : await adminSupabase.from("platform_settings").insert(payload).select("*").single()

    if (result.error) return fail("Platform settings could not be saved.", 500)

    await writeAdminLog({
      action: "SETTINGS_UPDATED",
      description: "Platform settings updated from admin control center.",
      adminUserId: admin.context.adminUserId,
      metadata: { settings_id: result.data?.id ?? null },
    })

    return ok({ settings: result.data })
  } catch {
    return serverFail()
  }
}

export async function POST(request: Request) {
  const admin = await requireAdmin(request)
  if (!admin.ok) return fail(admin.error, admin.status)

  const parsed = logSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message || "Invalid system action.", 422)
  }

  try {
    await writeAdminLog({
      action: parsed.data.action,
      description: parsed.data.description,
      adminUserId: admin.context.adminUserId,
    })

    return ok({ message: parsed.data.description })
  } catch {
    return serverFail()
  }
}
