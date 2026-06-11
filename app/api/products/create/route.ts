import { requireWorkspace } from "@/lib/api/tenant"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { writeAdminLog } from "@/lib/api/auth"
import { adminSupabase } from "@/lib/supabase/admin"
import { productMutationErrorMessage } from "@/lib/api/product-errors"
import { productPayloadSchema, productValidationMessage } from "@/lib/api/product-schema"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)

  try {
    const parsed = productPayloadSchema.safeParse(await request.json())
    if (!parsed.success) return fail(productValidationMessage(parsed.error), 400)

    const stock = Number(parsed.data.stock || 0)
    if (stock < 0) return fail("Stock cannot be negative.", 400)

    const { data, error } = await adminSupabase
      .from("products")
      .insert({
        ...parsed.data,
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
      await adminSupabase.from("stock_movements").insert({
        organization_id: workspace.context.organizationId,
        product_id: data.id,
        type: "opening_stock",
        quantity: stock,
        previous_stock: 0,
        new_stock: stock,
        reason: "Initial product master stock",
      })
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
