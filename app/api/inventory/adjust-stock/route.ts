import { z } from "zod"
import { requireWorkspace } from "@/lib/api/tenant"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { writeAdminLog } from "@/lib/api/auth"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const adjustSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.coerce.number().finite(),
  type: z.enum(["adjustment", "sale", "purchase", "return", "damage", "opening_stock"]).default("adjustment"),
  reason: z.string().trim().min(2).max(400),
  referenceNo: z.string().trim().max(120).optional(),
})

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)

  try {
    const parsed = adjustSchema.safeParse(await request.json())
    if (!parsed.success) return fail(parsed.error.issues[0]?.message || "Invalid stock adjustment.", 400)

    const { data: product, error: productError } = await adminSupabase
      .from("products")
      .select("id,name,sku,stock")
      .eq("id", parsed.data.productId)
      .eq("organization_id", workspace.context.organizationId)
      .maybeSingle()

    if (productError || !product) return fail("Product was not found.", 404)

    const previousStock = Number(product.stock || 0)
    const newStock = previousStock + parsed.data.quantity
    if (newStock < 0) return fail("Stock adjustment would make stock negative.", 400)

    const { error: updateError } = await adminSupabase
      .from("products")
      .update({ stock: newStock, updated_at: new Date().toISOString() })
      .eq("id", product.id)
      .eq("organization_id", workspace.context.organizationId)

    if (updateError) return fail("Stock could not be adjusted.", 400)

    const { error: movementError } = await adminSupabase.from("stock_movements").insert({
      organization_id: workspace.context.organizationId,
      product_id: product.id,
      type: parsed.data.type,
      quantity: parsed.data.quantity,
      previous_stock: previousStock,
      new_stock: newStock,
      reason: parsed.data.reason,
      reference_no: parsed.data.referenceNo || null,
    })

    if (movementError) return fail("Stock movement could not be audited.", 400)

    await writeAdminLog({
      action: "stock_adjusted",
      description: `Stock adjusted: ${product.name}`,
      adminUserId: workspace.context.userId,
      organizationId: workspace.context.organizationId,
      metadata: {
        productId: product.id,
        sku: product.sku,
        quantity: parsed.data.quantity,
        previousStock,
        newStock,
      },
    })

    return ok({ productId: product.id, previousStock, newStock })
  } catch {
    return serverFail()
  }
}
