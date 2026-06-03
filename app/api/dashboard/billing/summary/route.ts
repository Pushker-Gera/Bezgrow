import { NextResponse } from "next/server"
import { fail } from "@/lib/api/responses"
import { requireWorkspace } from "@/lib/api/tenant"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

function amount(row: Record<string, unknown>) {
  return Number(row.grand_total || row.total_amount || row.total || 0)
}

export async function GET(request: Request) {
  const workspace = await requireWorkspace(request)

  if (!workspace.ok) {
    return fail(workspace.error, workspace.status)
  }

  const { data, error, count } = await adminSupabase
    .from("invoices")
    .select("id, invoice_number, customer_name, payment_status, status, grand_total, total_amount, total, due_date, created_at", {
      count: "exact",
    })
    .eq("organization_id", workspace.context.organizationId)
    .order("created_at", { ascending: false })
    .limit(500)

  if (error) {
    return fail("Billing summary failed to load.", 500)
  }

  const invoices = data || []
  const paid = invoices.filter((invoice) =>
    ["paid", "completed", "success"].includes(
      String(invoice.payment_status || invoice.status || "").toLowerCase()
    )
  )
  const open = invoices.filter((invoice) =>
    ["unpaid", "pending", "overdue", "partial", ""].includes(
      String(invoice.payment_status || invoice.status || "").toLowerCase()
    )
  )

  return NextResponse.json(
    {
      currency: workspace.context.currency,
      locale: workspace.context.locale,
      timezone: workspace.context.timezone,
      metrics: {
        invoiceCount: count || invoices.length,
        revenue: invoices.reduce((sum, invoice) => sum + amount(invoice), 0),
        paidRevenue: paid.reduce((sum, invoice) => sum + amount(invoice), 0),
        outstanding: open.reduce((sum, invoice) => sum + amount(invoice), 0),
        collectionRate: invoices.length ? Math.round((paid.length / invoices.length) * 100) : 0,
        openInvoices: open.length,
      },
      recentInvoices: invoices.slice(0, 10),
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
