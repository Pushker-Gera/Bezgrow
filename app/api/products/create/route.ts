import { requireWorkspace } from "@/lib/api/tenant"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { writeAdminLog } from "@/lib/api/auth"
import { adminSupabase } from "@/lib/supabase/admin"
import { productMutationErrorMessage } from "@/lib/api/product-errors"
import { productPayloadSchema, productValidationMessage } from "@/lib/api/product-schema"
import { insertStockMovement } from "@/lib/api/stock-movements"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)

  try {
    const parsed = productPayloadSchema.safeParse(await request.json())
    if (!parsed.success) return fail(productValidationMessage(parsed.error), 400)

    const stock = Number(parsed.data.stock || 0)
    if (stock < 0) return fail("Stock cannot be negative.", 400)
    const payload = {
      ...parsed.data,
      description: parsed.data.description || "",
      price: parsed.data.price ?? parsed.data.sale_rate ?? parsed.data.mrp ?? parsed.data.purchase_rate ?? 0,
    }

    const { data, error } = await adminSupabase
      .from("products")
      .insert({
        ...payload,
        organization_id: workspace.context.organizationId,
        stock,
      })
      .select("id,name,sku,stock")
      .single()

    if (error || !data) {
      console.error("[products/create] insert failed", {
        code: error?.code,
        message: error?.message,
        details: error?.details,
      })
      return fail(productMutationErrorMessage("Product could not be created.", error?.message, error?.details, error?.code), 400)
    }

    if (stock !== 0) {
      const { error: movementError } = await insertStockMovement({
        organization_id: workspace.context.organizationId,
        product_id: data.id,
        type: "opening_stock",
        quantity: stock,
        previous_stock: 0,
        new_stock: stock,
        reason: "Initial product master stock",
      })
      if (movementError) {
        console.warn("[products/create] product created but opening stock movement could not be recorded", {
          productId: data.id,
          code: movementError.code,
          message: movementError.message,
        })
      }
    }

    await writeAdminLog({
      action: "product_created",
      description: `Product created: ${data.name}`,
      adminUserId: workspace.context.userId,
      organizationId: workspace.context.organizationId,
      metadata: { productId: data.id, sku: data.sku, stock },
    })

    return ok({ product: data })
  } catch {
    return serverFail()
  }
}
