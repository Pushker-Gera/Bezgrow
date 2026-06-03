import { z } from "zod"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { requireWorkspace } from "@/lib/api/tenant"
import { adminSupabase } from "@/lib/supabase/admin"
import { writeAdminLog } from "@/lib/api/auth"

export const dynamic = "force-dynamic"

const organizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  industry: z.string().trim().max(120).optional().default(""),
  currency: z.enum(["INR", "USD", "EUR", "GBP", "AED"]).default("INR"),
  timezone: z.string().trim().min(2).max(80).optional().default("Asia/Kolkata"),
  locale: z.string().trim().min(2).max(20).optional().default("en-IN"),
  business_type: z.string().trim().max(80).optional().default("retail"),
  business_category: z.string().trim().max(80).optional().default("general"),
})

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)

  if (!workspace.ok) {
    return fail(workspace.error, workspace.status)
  }

  const parsed = organizationSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return fail("Invalid organization settings.", 422)
  }

  try {
    const { error } = await adminSupabase
      .from("organizations")
      .update({
        ...parsed.data,
        updated_at: new Date().toISOString(),
      })
      .eq("id", workspace.context.organizationId)

    if (error) return fail("Organization settings could not be saved.", 500)

    await writeAdminLog({
      action: "organization.updated",
      description: "Organization settings updated.",
      adminUserId: workspace.context.userId,
      organizationId: workspace.context.organizationId,
      metadata: { fields: Object.keys(parsed.data) },
    })

    return ok({ organizationId: workspace.context.organizationId })
  } catch {
    return serverFail()
  }
}
