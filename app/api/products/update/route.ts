import { requireWorkspace } from "@/lib/api/tenant"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { writeAdminLog } from "@/lib/api/auth"
import { adminSupabase } from "@/lib/supabase/admin"
import { productMutationErrorMessage } from "@/lib/api/product-errors"
import { productUpdateSchema, productValidationMessage } from "@/lib/api/product-schema"
import { insertStockMovement } from "@/lib/api/stock-movements"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)

  try {
    const parsed = productUpdateSchema.safeParse(await request.json())
    if (!parsed.success) return fail(productValidationMessage(parsed.error), 400)

    const { id, ...inputPayload } = parsed.data
    const payload = {
      ...inputPayload,
      description: inputPayload.description || "",
      price: inputPayload.price ?? inputPayload.sale_rate ?? inputPayload.mrp ?? inputPayload.purchase_rate ?? 0,
    }
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

    if (error || !data) {
      console.error("[products/update] update failed", {
        code: error?.code,
        message: error?.message,
        details: error?.details,
      })
      return fail(productMutationErrorMessage("Product could not be updated.", error?.message, error?.details, error?.code), 400)
    }

    const previousStock = Number(previous.stock || 0)
    const stockDifference = stock - previousStock

    if (stockDifference !== 0) {
      const { error: movementError } = await insertStockMovement({
        organization_id: workspace.context.organizationId,
        product_id: id,
        type: "adjustment",
        quantity: stockDifference,
        previous_stock: previousStock,
        new_stock: stock,
        reason: "Product master stock adjustment",
      })
      if (movementError) {
        console.warn("[products/update] product updated but stock movement could not be recorded", {
          productId: id,
          code: movementError.code,
          message: movementError.message,
        })
      }
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
