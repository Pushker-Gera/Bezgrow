import { requireWorkspace } from "@/lib/api/tenant"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { writeAdminLog } from "@/lib/api/auth"
import { adminSupabase } from "@/lib/supabase/admin"
import { productUpdateSchema } from "@/lib/api/product-schema"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)

  try {
    const parsed = productUpdateSchema.safeParse(await request.json())
    if (!parsed.success) return fail(parsed.error.issues[0]?.message || "Invalid product.", 400)

    const { id, ...payload } = parsed.data
    const stock = Number(payload.stock || 0)
    if (stock < 0) return fail("Stock cannot be negative.", 400)

    const { data: previous, error: previousError } = await adminSupabase
      .from("products")
      .select("id,name,sku,stock")
      .eq("id", id)
      .eq("organization_id", workspace.context.organizationId)
      .maybeSingle()

    if (previousError || !previous) return fail("Product was not found.", 404)

    const { data, error } = await adminSupabase
      .from("products")
      .update({ ...payload, stock, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("organization_id", workspace.context.organizationId)
      .select("id,name,sku,stock")
      .single()

    if (error || !data) return fail("Product could not be updated.", 400)

    const previousStock = Number(previous.stock || 0)
    const stockDifference = stock - previousStock

    if (stockDifference !== 0) {
      await adminSupabase.from("stock_movements").insert({
        organization_id: workspace.context.organizationId,
        product_id: id,
        type: "adjustment",
        quantity: stockDifference,
        previous_stock: previousStock,
        new_stock: stock,
        reason: "Product master stock adjustment",
      })
    }

    await writeAdminLog({
      action: "product_updated",
      description: `Product updated: ${data.name}`,
      adminUserId: workspace.context.userId,
      organizationId: workspace.context.organizationId,
      metadata: { productId: id, sku: data.sku, stockDifference },
    })

    return ok({ product: data })
  } catch {
    return serverFail()
  }
}
