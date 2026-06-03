import { z } from "zod"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { writeAdminLog } from "@/lib/api/auth"
import { requireWorkspace } from "@/lib/api/tenant"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const movementSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  mode: z.enum(["add", "transfer"]),
  warehouse_id: z.string().uuid().nullable().optional(),
  batch_no: z.string().trim().max(120).nullable().optional(),
  barcode: z.string().trim().max(120).nullable().optional(),
  expiry_date: z.string().trim().max(40).nullable().optional(),
  shipping_qr: z.string().trim().max(240).nullable().optional(),
})

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)

  const parsed = movementSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return fail("Invalid stock movement.", 422)

  try {
    const { data: product, error: productError } = await adminSupabase
      .from("products")
      .select("id, name, stock, batch_no, barcode, expiry_date")
      .eq("id", parsed.data.product_id)
      .eq("organization_id", workspace.context.organizationId)
      .maybeSingle()

    if (productError || !product) return fail("Product was not found.", 404)

    const previousStock = Number(product.stock || 0)
    const quantity = Number(parsed.data.quantity || 0)
    const nextStock = parsed.data.mode === "add" ? previousStock + quantity : previousStock - quantity
    if (nextStock < 0) return fail("Transfer quantity cannot be greater than available stock.", 409)

    const updatePayload: Record<string, unknown> = {
      stock: nextStock,
      updated_at: new Date().toISOString(),
    }
    if (parsed.data.warehouse_id) updatePayload.warehouse_id = parsed.data.warehouse_id
    if (parsed.data.mode === "add" && parsed.data.batch_no) updatePayload.batch_no = parsed.data.batch_no
    if (parsed.data.mode === "add" && parsed.data.barcode) updatePayload.barcode = parsed.data.barcode
    if (parsed.data.mode === "add" && parsed.data.expiry_date) updatePayload.expiry_date = parsed.data.expiry_date

    const { error: updateError } = await adminSupabase
      .from("products")
      .update(updatePayload)
      .eq("id", product.id)
      .eq("organization_id", workspace.context.organizationId)

    if (updateError) return fail("Product stock could not be updated.", 500)

    const { error: movementError } = await adminSupabase.from("stock_movements").insert({
      organization_id: workspace.context.organizationId,
      product_id: product.id,
      quantity: parsed.data.mode === "transfer" ? -quantity : quantity,
      type: parsed.data.mode === "transfer" ? "transfer" : "stock_in",
      previous_stock: previousStock,
      new_stock: nextStock,
      warehouse_id: parsed.data.warehouse_id || null,
      shipping_qr: parsed.data.shipping_qr || null,
      reason: parsed.data.mode === "transfer" ? "Inventory moved to selected warehouse" : "Manual stock addition",
    })

    if (movementError) return fail("Stock movement could not be recorded.", 500)

    await writeAdminLog({
      action: parsed.data.mode === "transfer" ? "inventory.transferred" : "inventory.stock_added",
      description: "Inventory stock changed.",
      adminUserId: workspace.context.userId,
      organizationId: workspace.context.organizationId,
      metadata: { product_id: product.id, previousStock, nextStock, quantity },
    })

    return ok({ productId: product.id, previousStock, newStock: nextStock })
  } catch {
    return serverFail()
  }
}
