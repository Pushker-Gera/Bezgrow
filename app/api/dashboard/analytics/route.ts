import { NextResponse } from "next/server"
import { fail } from "@/lib/api/responses"
import { requireWorkspace } from "@/lib/api/tenant"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

function total(row: Record<string, unknown>) {
  return Number(row.grand_total || row.total_amount || row.total || 0)
}

function monthKey(value: unknown) {
  const date = new Date(String(value || ""))
  if (Number.isNaN(date.getTime())) return "Unknown"
  return date.toLocaleString("en-US", { month: "short" })
}

export async function GET(request: Request) {
  const workspace = await requireWorkspace(request)

  if (!workspace.ok) {
    return fail(workspace.error, workspace.status)
  }

  const since = new Date()
  since.setMonth(since.getMonth() - 6)

  const [invoiceResult, orderResult] = await Promise.all([
    adminSupabase
      .from("invoices")
      .select("id, grand_total, total_amount, total, payment_status, status, created_at")
      .eq("organization_id", workspace.context.organizationId)
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: true })
      .limit(2000),
    adminSupabase
      .from("orders")
      .select("id, total_amount, status, order_status, created_at")
      .eq("organization_id", workspace.context.organizationId)
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: true })
      .limit(2000),
  ])

  if (invoiceResult.error || orderResult.error) {
    return fail("Analytics failed to load.", 500)
  }

  const monthly = new Map<string, { month: string; revenue: number; invoices: number; orders: number }>()

  for (const invoice of invoiceResult.data || []) {
    const key = monthKey(invoice.created_at)
    const current = monthly.get(key) || { month: key, revenue: 0, invoices: 0, orders: 0 }
    current.revenue += total(invoice)
    current.invoices += 1
    monthly.set(key, current)
  }

  for (const order of orderResult.data || []) {
    const key = monthKey(order.created_at)
    const current = monthly.get(key) || { month: key, revenue: 0, invoices: 0, orders: 0 }
    current.orders += 1
    monthly.set(key, current)
  }

  return NextResponse.json(
    {
      currency: workspace.context.currency,
      trend: Array.from(monthly.values()),
      totals: {
        revenue: (invoiceResult.data || []).reduce((sum, invoice) => sum + total(invoice), 0),
        invoices: invoiceResult.data?.length || 0,
        orders: orderResult.data?.length || 0,
      },
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
