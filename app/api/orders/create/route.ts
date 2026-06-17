import { z } from "zod"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { writeAdminLog } from "@/lib/api/auth"
import { requireWorkspace } from "@/lib/api/tenant"
import { adminSupabase } from "@/lib/supabase/admin"
import { insertStockMovement } from "@/lib/api/stock-movements"

export const dynamic = "force-dynamic"

type OrderInsertPayload = Record<string, string | number | null>

function missingColumnFromError(error: { message?: string | null } | null) {
  if (!error?.message) return null
  const match =
    error.message.match(/Could not find the '([^']+)' column/i) ||
    error.message.match(/column "([^"]+)" of relation/i) ||
    error.message.match(/column "([^"]+)" does not exist/i)

  return match?.[1] || null
}

async function insertOrderWithSchemaFallback(payload: OrderInsertPayload) {
  const retryPayload = { ...payload }
  const requiredColumns = new Set(["organization_id", "customer_name", "order_number", "total_amount"])

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await adminSupabase.from("orders").insert(retryPayload).select("id, order_number").single()
    const missingColumn = missingColumnFromError(result.error)

    if (!result.error || !missingColumn || requiredColumns.has(missingColumn)) {
      return result
    }

    if (missingColumn === "courier_name" && "courier_name" in retryPayload) {
      retryPayload.courier = retryPayload.courier_name
      delete retryPayload.courier_name
      continue
    }

    if (!(missingColumn in retryPayload)) return result
    delete retryPayload[missingColumn]
  }

  return adminSupabase.from("orders").insert(retryPayload).select("id, order_number").single()
}

const orderItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.coerce.number().int().positive(),
  unit_price: z.coerce.number().nonnegative(),
  total: z.coerce.number().nonnegative(),
})

const orderSchema = z.object({
  customer_name: z.string().trim().min(2).max(160),
  customer_phone: z.string().trim().max(40).nullable().optional(),
  customer_address: z.string().trim().max(500).nullable().optional(),
  courier_name: z.string().trim().max(120).nullable().optional(),
  tracking_number: z.string().trim().max(120).nullable().optional(),
  payment_mode: z.string().trim().max(60).optional().default("cod"),
  sales_channel: z.string().trim().max(60).optional().default("direct"),
  items: z.array(orderItemSchema).min(1).max(100),
})

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)

  const parsed = orderSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return fail(parsed.error.issues[0]?.message || "Invalid order.", 422)

  try {
    const productIds = Array.from(new Set(parsed.data.items.map((item) => item.product_id)))
    const quantityByProductId = new Map<string, number>()

    for (const item of parsed.data.items) {
      quantityByProductId.set(item.product_id, (quantityByProductId.get(item.product_id) || 0) + item.quantity)
    }

    const { data: products, error: productsError } = await adminSupabase
      .from("products")
      .select("id, stock")
      .eq("organization_id", workspace.context.organizationId)
      .in("id", productIds)

    if (productsError) return fail("Products could not be verified.", 500)

    const productStock = new Map((products || []).map((product) => [product.id, Number(product.stock || 0)]))
    for (const [productId, quantity] of quantityByProductId) {
      if (!productStock.has(productId)) return fail("One or more products were not found.", 404)
      if ((productStock.get(productId) || 0) < quantity) return fail("Order quantity exceeds available stock.", 409)
    }

    const orderNumber = `ORD-${new Date().getFullYear()}-${Date.now()}`
    const totalAmount = parsed.data.items.reduce((sum, item) => sum + Number(item.total || 0), 0)

    const { data: order, error: orderError } = await insertOrderWithSchemaFallback({
      organization_id: workspace.context.organizationId,
      customer_name: parsed.data.customer_name,
      customer_phone: parsed.data.customer_phone || null,
      customer_address: parsed.data.customer_address || null,
      order_number: orderNumber,
      total_amount: totalAmount,
      courier_name: parsed.data.courier_name || null,
      tracking_number: parsed.data.tracking_number || null,
      payment_mode: parsed.data.payment_mode,
      sales_channel: parsed.data.sales_channel,
    })

    if (orderError || !order) return fail("Order could not be created.", 500)

    const { error: itemError } = await adminSupabase.from("order_items").insert(
      parsed.data.items.map((item) => ({
        organization_id: workspace.context.organizationId,
        order_id: order.id,
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price: item.unit_price,
        total: item.total,
      }))
    )

    if (itemError) {
      await adminSupabase.from("orders").delete().eq("id", order.id).eq("organization_id", workspace.context.organizationId)
      return fail("Order items could not be created.", 500)
    }

    for (const [productId, quantity] of quantityByProductId) {
      const previousStock = productStock.get(productId) || 0
      const nextStock = previousStock - quantity
      const { error: stockError } = await adminSupabase
        .from("products")
        .update({ stock: nextStock, updated_at: new Date().toISOString() })
        .eq("id", productId)
        .eq("organization_id", workspace.context.organizationId)

      if (stockError) return fail("Order was created, but product stock could not be updated.", 500)

      await insertStockMovement({
        organization_id: workspace.context.organizationId,
        product_id: productId,
        type: "sale",
        quantity: -quantity,
        previous_stock: previousStock,
        new_stock: nextStock,
        reason: `Order ${order.order_number || orderNumber}`,
        reference_no: order.id,
      })
    }

    await writeAdminLog({
      action: "order.created",
      description: "Order created.",
      adminUserId: workspace.context.userId,
      organizationId: workspace.context.organizationId,
      metadata: { order_id: order.id, order_number: order.order_number, total_amount: totalAmount },
    })

    return ok({ id: order.id, order_number: order.order_number || orderNumber })
  } catch {
    return serverFail()
  }
}
