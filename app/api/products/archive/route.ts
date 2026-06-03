import { z } from "zod"
import { requireWorkspace } from "@/lib/api/tenant"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { writeAdminLog } from "@/lib/api/auth"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const archiveSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().trim().max(300).optional(),
})

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)

  try {
    const parsed = archiveSchema.safeParse(await request.json())
    if (!parsed.success) return fail("Invalid product id.", 400)

    const { data, error } = await adminSupabase
      .from("products")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", parsed.data.id)
      .eq("organization_id", workspace.context.organizationId)
      .select("id,name,sku")
      .single()

    if (error || !data) return fail("Product could not be archived.", 400)

    await writeAdminLog({
      action: "product_archived",
      description: `Product archived: ${data.name}`,
      adminUserId: workspace.context.userId,
      organizationId: workspace.context.organizationId,
      metadata: { productId: data.id, sku: data.sku, reason: parsed.data.reason || null },
    })

    return ok({ product: data })
  } catch {
    return serverFail()
  }
}
