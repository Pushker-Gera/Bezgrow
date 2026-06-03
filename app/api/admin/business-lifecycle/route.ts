import { z } from "zod"
import { adminSupabase } from "@/lib/supabase/admin"
import { requireAdmin, writeAdminLog } from "@/lib/api/auth"
import { fail, ok, serverFail } from "@/lib/api/responses"

export const dynamic = "force-dynamic"

const lifecycleSchema = z.object({
  ownerId: z.string().uuid(),
  businessName: z.string().trim().max(160).optional(),
  organizationId: z.string().uuid().nullable().optional(),
  action: z.enum(["activate", "suspend"]),
})

export async function POST(request: Request) {
  const admin = await requireAdmin(request)
  if (!admin.ok) return fail(admin.error, admin.status)

  let body: z.infer<typeof lifecycleSchema>
  try {
    body = lifecycleSchema.parse(await request.json())
  } catch {
    return fail("Invalid business lifecycle request.", 400)
  }

  const now = new Date().toISOString()
  const payload =
    body.action === "activate"
      ? {
          approved: true,
          business_created: true,
          is_suspended: false,
          suspended_at: null,
          suspended_by: null,
          updated_at: now,
        }
      : {
          is_suspended: true,
          suspended_at: now,
          suspended_by: admin.context.adminUserId,
          updated_at: now,
        }

  try {
    const { error } = await adminSupabase.from("profiles").update(payload).eq("id", body.ownerId)
    if (error) return fail("Unable to update business lifecycle.", 400)

    const description = `${body.businessName || "Business"} ${
      body.action === "activate" ? "activated" : "suspended"
    } by admin.`

    await writeAdminLog({
      action: body.action === "activate" ? "BUSINESS_ACTIVATED" : "BUSINESS_SUSPENDED",
      description,
      adminUserId: admin.context.adminUserId,
      organizationId: body.organizationId ?? null,
      metadata: { owner_id: body.ownerId, business_name: body.businessName ?? null },
    })

    return ok({ message: description })
  } catch {
    return serverFail()
  }
}
