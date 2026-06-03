import { z } from "zod"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { writeAdminLog } from "@/lib/api/auth"
import { requireWorkspace } from "@/lib/api/tenant"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const deleteSchema = z.object({
  invoice_id: z.string().uuid(),
  confirmation: z.literal("DELETE"),
})

type InvoiceItemRow = {
  id: string
  product_id: string | null
  quantity: number | null
}

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)

  if (!workspace.ok) {
    return fail(workspace.error, workspace.status)
  }

  const parsed = deleteSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return fail("Type DELETE to confirm invoice deletion.", 422)
  }

  try {
    const { data: invoice, error: invoiceError } = await adminSupabase
      .from("invoices")
      .select("id, invoice_number")
      .eq("id", parsed.data.invoice_id)
      .eq("organization_id", workspace.context.organizationId)
      .maybeSingle()

    if (invoiceError || !invoice) return fail("Invoice was not found.", 404)

    const { data: items, error: itemsError } = await adminSupabase
      .from("invoice_items")
      .select("id, product_id, quantity")
      .eq("invoice_id", parsed.data.invoice_id)
      .eq("organization_id", workspace.context.organizationId)

    if (itemsError) return fail("Invoice items could not be loaded.", 500)

    const invoiceItems = (items || []) as InvoiceItemRow[]
    const productIds = Array.from(new Set(invoiceItems.map((item) => item.product_id).filter(Boolean))) as string[]

    if (productIds.length > 0) {
      const { data: products, error: productsError } = await adminSupabase
        .from("products")
        .select("id, stock")
        .eq("organization_id", workspace.context.organizationId)
        .in("id", productIds)

      if (productsError) return fail("Product stock could not be loaded.", 500)

      const stockByProduct = new Map((products || []).map((product) => [product.id, Number(product.stock || 0)]))

      for (const item of invoiceItems) {
        if (!item.product_id) continue
        const previousStock = stockByProduct.get(item.product_id) ?? 0
        const quantity = Number(item.quantity || 0)
        const nextStock = previousStock + quantity

        const { error: stockError } = await adminSupabase
          .from("products")
          .update({ stock: nextStock, updated_at: new Date().toISOString() })
          .eq("id", item.product_id)
          .eq("organization_id", workspace.context.organizationId)

        if (stockError) return fail("Stock restore failed.", 500)

        await adminSupabase.from("stock_movements").insert({
          organization_id: workspace.context.organizationId,
          product_id: item.product_id,
          type: "adjustment",
          quantity,
          previous_stock: previousStock,
          new_stock: nextStock,
          reason: `Invoice ${invoice.invoice_number || invoice.id} deleted and stock restored`,
        })

        stockByProduct.set(item.product_id, nextStock)
      }
    }

    const deleteItems = await adminSupabase
      .from("invoice_items")
      .delete()
      .eq("invoice_id", parsed.data.invoice_id)
      .eq("organization_id", workspace.context.organizationId)

    if (deleteItems.error) return fail("Invoice items could not be deleted.", 500)

    const deleteInvoice = await adminSupabase
      .from("invoices")
      .delete()
      .eq("id", parsed.data.invoice_id)
      .eq("organization_id", workspace.context.organizationId)

    if (deleteInvoice.error) return fail("Invoice could not be deleted.", 500)

    await writeAdminLog({
      action: "invoice.deleted_with_stock_restore",
      description: "Invoice deleted and stock restored.",
      adminUserId: workspace.context.userId,
      organizationId: workspace.context.organizationId,
      metadata: { invoice_id: parsed.data.invoice_id },
    })

    return ok({ invoiceId: parsed.data.invoice_id, restoredItems: invoiceItems.length })
  } catch {
    return serverFail()
  }
}
