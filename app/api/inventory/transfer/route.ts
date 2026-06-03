import { z } from "zod"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { writeAdminLog } from "@/lib/api/auth"
import { requireWorkspace } from "@/lib/api/tenant"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const transferSchema = z.object({
  product_id: z.string().uuid(),
  from_warehouse_id: z.string().uuid(),
  to_warehouse_id: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  reason: z.string().trim().max(240).optional().default("Warehouse transfer"),
})

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)

  if (!workspace.ok) {
    return fail(workspace.error, workspace.status)
  }

  const parsed = transferSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return fail("Invalid transfer request.", 422)
  }

  if (parsed.data.from_warehouse_id === parsed.data.to_warehouse_id) {
    return fail("Choose two different warehouses.", 422)
  }

  try {
    const { data: inventory, error: inventoryError } = await adminSupabase
      .from("inventory_items")
      .select("id, product_id, warehouse_id, quantity")
      .eq("organization_id", workspace.context.organizationId)
      .eq("product_id", parsed.data.product_id)
      .in("warehouse_id", [parsed.data.from_warehouse_id, parsed.data.to_warehouse_id])

    if (inventoryError) return fail("Inventory could not be loaded.", 500)

    const fromRow = (inventory || []).find((row) => row.warehouse_id === parsed.data.from_warehouse_id)
    const toRow = (inventory || []).find((row) => row.warehouse_id === parsed.data.to_warehouse_id)
    const fromQuantity = Number(fromRow?.quantity || 0)

    if (!fromRow || fromQuantity < parsed.data.quantity) {
      return fail("Not enough source warehouse stock.", 409)
    }

    const nextFromQuantity = fromQuantity - parsed.data.quantity
    const nextToQuantity = Number(toRow?.quantity || 0) + parsed.data.quantity

    const fromUpdate = await adminSupabase
      .from("inventory_items")
      .update({ quantity: nextFromQuantity, updated_at: new Date().toISOString() })
      .eq("id", fromRow.id)
      .eq("organization_id", workspace.context.organizationId)

    if (fromUpdate.error) return fail("Source warehouse stock could not be updated.", 500)

    const toUpdate = toRow
      ? await adminSupabase
          .from("inventory_items")
          .update({ quantity: nextToQuantity, updated_at: new Date().toISOString() })
          .eq("id", toRow.id)
          .eq("organization_id", workspace.context.organizationId)
      : await adminSupabase.from("inventory_items").insert({
          organization_id: workspace.context.organizationId,
          product_id: parsed.data.product_id,
          warehouse_id: parsed.data.to_warehouse_id,
          quantity: parsed.data.quantity,
        })

    if (toUpdate.error) return fail("Destination warehouse stock could not be updated.", 500)

    await adminSupabase.from("stock_movements").insert({
      organization_id: workspace.context.organizationId,
      product_id: parsed.data.product_id,
      type: "transfer",
      quantity: parsed.data.quantity,
      previous_stock: fromQuantity,
      new_stock: nextFromQuantity,
      reason: parsed.data.reason,
      reference_no: `${parsed.data.from_warehouse_id}->${parsed.data.to_warehouse_id}`,
    })

    await writeAdminLog({
      action: "inventory.transfer",
      description: "Warehouse transfer recorded.",
      adminUserId: workspace.context.userId,
      organizationId: workspace.context.organizationId,
      metadata: parsed.data,
    })

    return ok({ fromQuantity: nextFromQuantity, toQuantity: nextToQuantity })
  } catch {
    return serverFail()
  }
}
