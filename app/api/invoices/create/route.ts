import { z } from "zod"
import { adminSupabase } from "@/lib/supabase/admin"
import { writeAdminLog } from "@/lib/api/auth"
import { requireWorkspace } from "@/lib/api/tenant"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { insertStockMovement } from "@/lib/api/stock-movements"

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
  discount_amount: z.coerce.number().min(0).optional().default(0),
  discount_total: z.coerce.number().min(0).optional().default(0),
  taxable_amount: z.coerce.number().min(0).optional(),
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

type InvoiceInsertPayload = Record<string, string | number | null>

function missingColumnFromError(error: { code?: string; message?: string } | null) {
  if (!error?.message) return null
  const message = error.message
  const quotedColumnMatch =
    message.match(/Could not find the '([^']+)' column/i) ||
    message.match(/column "([^"]+)" of relation/i) ||
    message.match(/column "([^"]+)" does not exist/i)

  return quotedColumnMatch?.[1] || null
}

async function insertInvoiceWithSchemaFallback(payload: InvoiceInsertPayload) {
  const retryPayload = { ...payload }
  const removedColumns: string[] = []
  const requiredColumns = new Set(["organization_id", "invoice_number", "customer_id", "total_amount", "grand_total"])

  for (let attempt = 0; attempt < 14; attempt += 1) {
    const result = await adminSupabase
      .from("invoices")
      .insert(retryPayload)
      .select("id,invoice_number")
      .single()

    if (!result.error || !missingColumnFromError(result.error)) {
      return { ...result, removedColumns }
    }

    const missingColumn = missingColumnFromError(result.error)
    if (!missingColumn || requiredColumns.has(missingColumn) || !(missingColumn in retryPayload)) {
      return { ...result, removedColumns }
    }

    delete retryPayload[missingColumn]
    removedColumns.push(missingColumn)
  }

  const result = await adminSupabase
    .from("invoices")
    .insert(retryPayload)
    .select("id,invoice_number")
    .single()

  return { ...result, removedColumns }
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
    const quantityByProductId = new Map<string, number>()

    for (const item of input.items) {
      quantityByProductId.set(item.product_id, (quantityByProductId.get(item.product_id) || 0) + item.quantity)
    }

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
    for (const [productId, requestedQuantity] of quantityByProductId) {
      const product = productById.get(productId)
      if (!product) return fail("One or more products were not found.", 404)
      if (Number(product.stock || 0) < requestedQuantity) {
        return fail(`${product.name} has only ${Number(product.stock || 0)} in stock.`, 409)
      }
    }

    const { data: invoice, error: invoiceError, removedColumns } = await insertInvoiceWithSchemaFallback({
      organization_id: workspace.context.organizationId,
      invoice_number: invoiceNumber(),
      customer_id: input.customer_id,
      customer_name: customer.name || "Customer",
      subtotal: input.subtotal,
      discount_amount: input.discount_amount || input.discount_total || 0,
      discount_total: input.discount_total || input.discount_amount || 0,
      taxable_amount: input.taxable_amount ?? Math.max(0, input.subtotal - (input.discount_amount || input.discount_total || 0)),
      tax_amount: input.tax_amount,
      total_amount: input.total_amount,
      grand_total: input.total_amount,
      total: input.total_amount,
      payment_status: input.payment_status,
      status: input.payment_status,
      payment_method: input.payment_method,
      due_date: input.due_date || null,
      date: new Date().toISOString().slice(0, 10),
      notes: input.notes || null,
      invoice_type: input.invoice_type,
      shipping_code: input.shipping_code || null,
      courier_name: input.courier_name || null,
      tracking_number: input.tracking_number || null,
    })

    if (removedColumns.length > 0) {
      console.warn("Invoice created with legacy schema fallback", {
        removedColumns,
        organizationId: workspace.context.organizationId,
      })
    }

    if (invoiceError || !invoice) {
      console.error("Invoice create insert failed", {
        code: invoiceError?.code,
        message: invoiceError?.message,
        details: invoiceError?.details,
        organizationId: workspace.context.organizationId,
      })
      return fail(invoiceError?.message ? `Invoice could not be created: ${invoiceError.message}` : "Invoice could not be created.", 400)
    }

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

    for (const [productId, quantity] of quantityByProductId) {
      const product = productById.get(productId)
      const previousStock = Number(product?.stock || 0)
      const newStock = previousStock - quantity

      const { error: stockError } = await adminSupabase
        .from("products")
        .update({ stock: newStock, updated_at: new Date().toISOString() })
        .eq("id", productId)
        .eq("organization_id", workspace.context.organizationId)

      if (stockError) return fail("Invoice was created, but stock update failed. Review stock manually.", 500)

      const { error: movementError, removedColumns } = await insertStockMovement({
        organization_id: workspace.context.organizationId,
        product_id: productId,
        type: "sale",
        quantity: -quantity,
        previous_stock: previousStock,
        new_stock: newStock,
        reason: `Invoice ${invoice.invoice_number}`,
        reference_no: invoice.invoice_number,
      })

      if (removedColumns.length > 0) {
        console.warn("[invoices/create] stock_movements legacy schema fallback", {
          removedColumns,
          organizationId: workspace.context.organizationId,
          invoiceId: invoice.id,
        })
      }

      if (movementError) {
        console.error("[invoices/create] movement insert failed after invoice/stock update", {
          code: movementError.code,
          message: movementError.message,
          details: movementError.details,
          organizationId: workspace.context.organizationId,
          invoiceId: invoice.id,
        })
      }
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
