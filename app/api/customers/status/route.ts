import { z } from "zod"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { writeAdminLog } from "@/lib/api/auth"
import { requireWorkspace } from "@/lib/api/tenant"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const statusSchema = z.object({
  id: z.string().uuid(),
  active: z.boolean().optional(),
  archive: z.boolean().optional().default(false),
})

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)

  const parsed = statusSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return fail("Invalid customer status request.", 422)

  const isArchive = parsed.data.archive === true
  const active = isArchive ? false : parsed.data.active ?? true

  try {
    const { data, error } = await adminSupabase
      .from("customers")
      .update({
        is_active: active,
        deleted_at: isArchive ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", parsed.data.id)
      .eq("organization_id", workspace.context.organizationId)
      .select("id")
      .maybeSingle()

    if (error || !data) return fail("Customer status could not be updated.", 404)

    await writeAdminLog({
      action: isArchive ? "customer.archived" : active ? "customer.activated" : "customer.deactivated",
      description: "Customer status changed.",
      adminUserId: workspace.context.userId,
      organizationId: workspace.context.organizationId,
      metadata: { customer_id: parsed.data.id },
    })

    return ok({ id: parsed.data.id, active, archived: isArchive })
  } catch {
    return serverFail()
  }
}
