import { NextResponse } from "next/server"
import { requireWorkspace } from "@/lib/api/tenant"
import { fail } from "@/lib/api/responses"

export const dynamic = "force-dynamic"

function sumRows(rows: Array<Record<string, unknown>>, fields: string[]) {
  return rows.reduce((sum, row) => {
    for (const field of fields) {
      const value = row[field]
      if (value !== null && value !== undefined && value !== "") {
        return sum + Number(value || 0)
      }
    }
    return sum
  }, 0)
}

export async function GET(request: Request) {
  const workspace = await requireWorkspace(request)

  if (!workspace.ok) {
    return fail(workspace.error, workspace.status)
  }

  const { adminSupabase } = await import("@/lib/supabase/admin")
  const orgId = workspace.context.organizationId
  const today = new Date().toISOString().slice(0, 10)

  const [
    productResult,
    invoiceResult,
    orderResult,
    customerResult,
    warehouseResult,
    movementResult,
  ] = await Promise.all([
    adminSupabase
      .from("products")
      .select("id, name, stock, min_stock, sale_rate, purchase_rate, price", { count: "exact" })
      .eq("organization_id", orgId)
      .is("deleted_at", null)
      .limit(1000),
    adminSupabase
      .from("invoices")
      .select("id, grand_total, total_amount, total, payment_status, status, created_at", { count: "exact" })
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(1000),
    adminSupabase
      .from("orders")
      .select("id, total_amount, order_status, status, created_at", { count: "exact" })
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(1000),
    adminSupabase
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId),
    adminSupabase
      .from("warehouses")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId),
    adminSupabase
      .from("stock_movements")
      .select("id, type, quantity, previous_stock, new_stock, reason, reference_no, created_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(12),
  ])

  const firstError =
    productResult.error ||
    invoiceResult.error ||
    orderResult.error ||
    customerResult.error ||
    warehouseResult.error ||
    movementResult.error

  if (firstError) {
    return fail("Dashboard summary failed to load.", 500)
  }

  const products = productResult.data || []
  const invoices = invoiceResult.data || []
  const orders = orderResult.data || []

  const totalRevenue = sumRows(invoices, ["grand_total", "total_amount", "total"])
  const todayRevenue = sumRows(
    invoices.filter((invoice) => String(invoice.created_at || "").startsWith(today)),
    ["grand_total", "total_amount", "total"]
  )
  const paidRevenue = sumRows(
    invoices.filter((invoice) =>
      ["paid", "completed", "success"].includes(
        String(invoice.payment_status || invoice.status || "").toLowerCase()
      )
    ),
    ["grand_total", "total_amount", "total"]
  )
  const pendingInvoices = invoices.filter((invoice) =>
    ["unpaid", "pending", "overdue", ""].includes(
      String(invoice.payment_status || invoice.status || "").toLowerCase()
    )
  ).length
  const lowStockProducts = products.filter(
    (product) => Number(product.stock || 0) <= Number(product.min_stock ?? 5)
  )
  const outOfStockProducts = products.filter((product) => Number(product.stock || 0) <= 0)
  const inventoryValue = products.reduce((sum, product) => {
    const rate = Number(product.sale_rate || product.price || product.purchase_rate || 0)
    return sum + Number(product.stock || 0) * rate
  }, 0)
  const pendingOrders = orders.filter((order) =>
    ["pending", "processing", "created"].includes(
      String(order.order_status || order.status || "").toLowerCase()
    )
  ).length
  const fulfillmentRate = orders.length
    ? Math.round(((orders.length - pendingOrders) / orders.length) * 100)
    : 0
  const inventoryHealth = products.length
    ? Math.round(((products.length - lowStockProducts.length) / products.length) * 100)
    : 100

  return NextResponse.json(
    {
      workspace: {
        organizationId: orgId,
        organizationName: workspace.context.organizationName,
        currency: workspace.context.currency,
        timezone: workspace.context.timezone,
        locale: workspace.context.locale,
        features: workspace.context.features,
      },
      metrics: {
        totalRevenue,
        todayRevenue,
        paidRevenue,
        pendingInvoices,
        productCount: productResult.count || products.length,
        lowStockCount: lowStockProducts.length,
        outOfStockCount: outOfStockProducts.length,
        inventoryValue,
        orderCount: orderResult.count || orders.length,
        pendingOrders,
        fulfillmentRate,
        inventoryHealth,
        customerCount: customerResult.count || 0,
        warehouseCount: warehouseResult.count || 0,
      },
      recentMovements: movementResult.data || [],
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
