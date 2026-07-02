import { NextResponse } from "next/server"
import { fail } from "@/lib/api/responses"
import { requireWorkspace } from "@/lib/api/tenant"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

function amount(row: Record<string, unknown>) {
  return Number(row.grand_total || row.total_amount || row.total || 0)
}

function taxAmount(row: Record<string, unknown>) {
  return Number(row.tax_amount || row.tax_total || 0)
}

function isThisMonth(value: string | null | undefined) {
  if (!value) return false
  const date = new Date(value)
  const now = new Date()
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()
}

export async function GET(request: Request) {
  const workspace = await requireWorkspace(request)

  if (!workspace.ok) {
    return fail(workspace.error, workspace.status)
  }

  const orgId = workspace.context.organizationId
  const [invoiceResult, customerResult, productResult, orderResult] = await Promise.all([
    adminSupabase
      .from("invoices")
      .select("id, invoice_number, customer_id, customer_name, payment_status, status, grand_total, total_amount, total, tax_amount, tax_total, due_date, created_at", {
        count: "exact",
      })
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(500),
    adminSupabase
      .from("customers")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .is("deleted_at", null),
    adminSupabase
      .from("products")
      .select("id, stock, min_stock, sale_rate, price, mrp", { count: "exact" })
      .eq("organization_id", orgId)
      .is("deleted_at", null)
      .limit(1000),
    adminSupabase
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId),
  ])

  if (invoiceResult.error) {
    return fail("Billing summary failed to load.", 500)
  }

  const invoices = invoiceResult.data || []
  const products = productResult.error ? [] : productResult.data || []
  const paid = invoices.filter((invoice) =>
    ["paid", "completed", "success"].includes(
      String(invoice.payment_status || invoice.status || "").toLowerCase()
    )
  )
  const unpaid = invoices.filter((invoice) =>
    ["unpaid", "pending", "overdue", ""].includes(
      String(invoice.payment_status || invoice.status || "").toLowerCase()
    )
  )
  const partial = invoices.filter((invoice) => String(invoice.payment_status || invoice.status || "").toLowerCase() === "partial")
  const open = invoices.filter((invoice) =>
    ["unpaid", "pending", "overdue", "partial", ""].includes(
      String(invoice.payment_status || invoice.status || "").toLowerCase()
    )
  )
  const weeklyRevenue = Array.from({ length: 7 }, (_, index) => {
    const date = new Date()
    date.setDate(date.getDate() - (6 - index))
    const dayKey = date.toDateString()

    return {
      label: date.toLocaleDateString(undefined, { weekday: "short" }),
      total: invoices
        .filter((invoice) => invoice.created_at && new Date(invoice.created_at).toDateString() === dayKey)
        .reduce((sum, invoice) => sum + amount(invoice), 0),
    }
  })
  const inventoryValue = products.reduce(
    (sum, product) =>
      sum + Number(product.stock || 0) * Number(product.sale_rate || product.price || product.mrp || 0),
    0
  )
  const lowStock = products.filter((product) => Number(product.stock || 0) <= Number(product.min_stock ?? 5))
  const revenue = invoices.reduce((sum, invoice) => sum + amount(invoice), 0)
  const paidRevenue = paid.reduce((sum, invoice) => sum + amount(invoice), 0)

  return NextResponse.json(
    {
      currency: workspace.context.currency,
      locale: workspace.context.locale,
      timezone: workspace.context.timezone,
      metrics: {
        invoiceCount: invoiceResult.count || invoices.length,
        revenue,
        monthlyRevenue: invoices.filter((invoice) => isThisMonth(invoice.created_at)).reduce((sum, invoice) => sum + amount(invoice), 0),
        paidRevenue,
        outstanding: open.reduce((sum, invoice) => sum + amount(invoice), 0),
        tax: invoices.reduce((sum, invoice) => sum + taxAmount(invoice), 0),
        inventoryValue,
        averageInvoice: invoices.length ? revenue / invoices.length : 0,
        collectionRate: revenue ? Math.round((paidRevenue / revenue) * 100) : 0,
        openInvoices: open.length,
        paidCount: paid.length,
        unpaidCount: unpaid.length,
        partialCount: partial.length,
        lowStockCount: lowStock.length,
        customerCount: customerResult.count || 0,
        productCount: productResult.count || products.length,
        orderCount: orderResult.count || 0,
      },
      weeklyRevenue,
      recentInvoices: invoices.slice(0, 10),
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
