import { NextResponse } from "next/server"
import { fail } from "@/lib/api/responses"
import { requireWorkspace } from "@/lib/api/tenant"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const workspace = await requireWorkspace(request)

  if (!workspace.ok) {
    return fail(workspace.error, workspace.status)
  }

  const orgId = workspace.context.organizationId
  const [productResult, warehouseResult, movementResult] = await Promise.all([
    adminSupabase
      .from("products")
      .select("id, name, sku, barcode, stock, min_stock, sale_rate, price, purchase_rate, expiry_date", {
        count: "exact",
      })
      .eq("organization_id", orgId)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(1000),
    adminSupabase
      .from("warehouses")
      .select("id, name", { count: "exact" })
      .eq("organization_id", orgId)
      .order("name", { ascending: true })
      .limit(100),
    adminSupabase
      .from("stock_movements")
      .select("id, product_id, type, quantity, previous_stock, new_stock, reason, created_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(20),
  ])

  const firstError = productResult.error || warehouseResult.error || movementResult.error
  if (firstError) {
    return fail("Inventory summary failed to load.", 500)
  }

  const products = productResult.data || []
  const lowStock = products.filter((product) => Number(product.stock || 0) <= Number(product.min_stock ?? 5))
  const outOfStock = products.filter((product) => Number(product.stock || 0) <= 0)
  const inventoryValue = products.reduce((sum, product) => {
    const rate = Number(product.purchase_rate || product.sale_rate || product.price || 0)
    return sum + Number(product.stock || 0) * rate
  }, 0)

  return NextResponse.json(
    {
      currency: workspace.context.currency,
      metrics: {
        productCount: productResult.count || products.length,
        warehouseCount: warehouseResult.count || 0,
        stockUnits: products.reduce((sum, product) => sum + Number(product.stock || 0), 0),
        lowStockCount: lowStock.length,
        outOfStockCount: outOfStock.length,
        inventoryValue,
        health: products.length ? Math.round(((products.length - lowStock.length) / products.length) * 100) : 100,
      },
      lowStock: lowStock.slice(0, 20),
      warehouses: warehouseResult.data || [],
      recentMovements: movementResult.data || [],
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
