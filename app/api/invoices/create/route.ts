import { z } from "zod"
import { adminSupabase } from "@/lib/supabase/admin"
import { writeAdminLog } from "@/lib/api/auth"
import { requireWorkspace } from "@/lib/api/tenant"
import { fail, ok, serverFail } from "@/lib/api/responses"

export const dynamic = "force-dynamic"

const invoiceItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  unit_price: z.coerce.number().min(0),
  tax_percent: z.coerce.number().min(0).max(100).default(0),
  discount_percent: z.coerce.number().min(0).max(100).default(0),
  line_total: z.coerce.number().min(0),
  gst_amount: z.coerce.number().min(0).default(0),
  product_name: z.string().trim().max(180).optional().default(""),
})

const createInvoiceSchema = z.object({
  customer_id: z.string().uuid(),
  subtotal: z.coerce.number().min(0),
  tax_amount: z.coerce.number().min(0),
  total_amount: z.coerce.number().min(0),
  payment_status: z.enum(["unpaid", "partial", "paid", "overdue", "cancelled"]).default("unpaid"),
  payment_method: z.string().trim().max(80).optional().default("cash"),
  due_date: z.string().trim().max(30).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  invoice_type: z.string().trim().max(80).optional().default("standard"),
  shipping_code: z.string().trim().max(120).nullable().optional(),
  courier_name: z.string().trim().max(120).nullable().optional(),
  tracking_number: z.string().trim().max(120).nullable().optional(),
  items: z.array(invoiceItemSchema).min(1).max(100),
})

function invoiceNumber() {
  return `INV-${new Date().getFullYear()}-${Date.now()}`
}

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)

  const parsed = createInvoiceSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message || "Invalid invoice.", 422)
  }

  try {
    const input = parsed.data
    const productIds = Array.from(new Set(input.items.map((item) => item.product_id)))

    const [{ data: customer }, { data: products, error: productError }] = await Promise.all([
      adminSupabase
        .from("customers")
        .select("id,name")
        .eq("id", input.customer_id)
        .eq("organization_id", workspace.context.organizationId)
        .maybeSingle(),
      adminSupabase
        .from("products")
        .select("id,name,stock")
        .eq("organization_id", workspace.context.organizationId)
        .in("id", productIds),
    ])

    if (!customer) return fail("Customer was not found.", 404)
    if (productError) return fail("Products could not be loaded.", 500)

    const productById = new Map((products || []).map((product) => [product.id, product]))
    for (const item of input.items) {
      const product = productById.get(item.product_id)
      if (!product) return fail("One or more products were not found.", 404)
      if (Number(product.stock || 0) < item.quantity) {
        return fail(`${product.name} has only ${Number(product.stock || 0)} in stock.`, 409)
      }
    }

    const { data: invoice, error: invoiceError } = await adminSupabase
      .from("invoices")
      .insert({
        organization_id: workspace.context.organizationId,
        invoice_number: invoiceNumber(),
        customer_id: input.customer_id,
        customer_name: customer.name || "Customer",
        subtotal: input.subtotal,
        tax_amount: input.tax_amount,
        total_amount: input.total_amount,
        grand_total: input.total_amount,
        payment_status: input.payment_status,
        payment_method: input.payment_method,
        due_date: input.due_date || null,
        notes: input.notes || null,
        invoice_type: input.invoice_type,
        shipping_code: input.shipping_code || null,
        courier_name: input.courier_name || null,
        tracking_number: input.tracking_number || null,
      })
      .select("id,invoice_number")
      .single()

    if (invoiceError || !invoice) return fail("Invoice could not be created.", 400)

    const invoiceItems = input.items.map((item) => ({
      organization_id: workspace.context.organizationId,
      invoice_id: invoice.id,
      product_id: item.product_id,
      product_name: item.product_name || productById.get(item.product_id)?.name || "",
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_percent: item.tax_percent,
      discount_percent: item.discount_percent,
      line_total: item.line_total,
      gst_amount: item.gst_amount,
    }))

    const { error: itemError } = await adminSupabase.from("invoice_items").insert(invoiceItems)
    if (itemError) {
      await adminSupabase.from("invoices").delete().eq("id", invoice.id).eq("organization_id", workspace.context.organizationId)
      return fail("Invoice items could not be created.", 400)
    }

    for (const item of input.items) {
      const product = productById.get(item.product_id)
      const previousStock = Number(product?.stock || 0)
      const newStock = previousStock - item.quantity

      const { error: stockError } = await adminSupabase
        .from("products")
        .update({ stock: newStock, updated_at: new Date().toISOString() })
        .eq("id", item.product_id)
        .eq("organization_id", workspace.context.organizationId)

      if (stockError) return fail("Invoice was created, but stock update failed. Review stock manually.", 500)

      await adminSupabase.from("stock_movements").insert({
        organization_id: workspace.context.organizationId,
        product_id: item.product_id,
        type: "sale",
        quantity: -item.quantity,
        previous_stock: previousStock,
        new_stock: newStock,
        reason: `Invoice ${invoice.invoice_number}`,
        reference_no: invoice.invoice_number,
      })
    }

    await writeAdminLog({
      action: "invoice.created",
      description: `Invoice created: ${invoice.invoice_number}`,
      adminUserId: workspace.context.userId,
      organizationId: workspace.context.organizationId,
      metadata: { invoice_id: invoice.id, total_amount: input.total_amount },
    })

    return ok({ invoice_id: invoice.id, invoice_number: invoice.invoice_number })
  } catch {
    return serverFail()
  }
}
