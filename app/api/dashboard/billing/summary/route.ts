import { NextResponse } from "next/server"
import { fail } from "@/lib/api/responses"
import { requireWorkspace } from "@/lib/api/tenant"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const baseInvoiceColumns = [
  "id",
  "invoice_number",
  "customer_id",
  "customer_name",
  "payment_status",
  "status",
  "grand_total",
  "total_amount",
  "total",
  "tax_amount",
  "tax_total",
  "due_date",
  "created_at",
]

const requiredInvoiceColumns = new Set(["id", "invoice_number", "customer_id", "created_at"])

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

function createdAt(row: Record<string, unknown>) {
  return typeof row.created_at === "string" ? row.created_at : null
}

function statusFrom(row: Record<string, unknown>) {
  return String(row.payment_status || row.status || "").toLowerCase()
}

function missingColumnFromError(error: { message?: string } | null) {
  if (!error?.message) return null
  const quotedColumnMatch =
    error.message.match(/column [a-zA-Z0-9_]+\.([a-zA-Z0-9_]+) does not exist/i) ||
    error.message.match(/column "([^"]+)" does not exist/i) ||
    error.message.match(/Could not find the '([^']+)' column/i)

  return quotedColumnMatch?.[1] || null
}

export async function GET(request: Request) {
  const workspace = await requireWorkspace(request)

  if (!workspace.ok) {
    return fail(workspace.error, workspace.status)
  }

  const orgId = workspace.context.organizationId
  let selectColumns = [...baseInvoiceColumns]

  const runInvoiceQuery = async () =>
    adminSupabase
      .from("invoices")
      .select(selectColumns.join(","), {
        count: "exact",
      })
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(500)

  let invoiceResult = await runInvoiceQuery()
  for (let attempt = 0; invoiceResult.error && attempt < baseInvoiceColumns.length; attempt += 1) {
    const missingColumn = missingColumnFromError(invoiceResult.error)
    if (!missingColumn || requiredInvoiceColumns.has(missingColumn) || !selectColumns.includes(missingColumn)) break

    selectColumns = selectColumns.filter((column) => column !== missingColumn)
    invoiceResult = await runInvoiceQuery()
  }

  const [customerResult, productResult, orderResult] = await Promise.all([
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

  const invoices = (invoiceResult.data || []) as unknown as Array<Record<string, unknown>>
  const customerIds = Array.from(
    new Set(
      invoices
        .map((invoice) => (typeof invoice.customer_id === "string" ? invoice.customer_id : ""))
        .filter(Boolean)
    )
  )
  const customerMap = new Map<string, { name?: string | null; phone?: string | null; email?: string | null }>()

  if (customerIds.length > 0) {
    const { data: customers } = await adminSupabase
      .from("customers")
      .select("id,name,phone,email")
      .eq("organization_id", orgId)
      .in("id", customerIds)

    ;(customers || []).forEach((customer) => {
      customerMap.set(customer.id, customer)
    })
  }

  const enrichedInvoices = invoices.map((invoice) => {
    const customerId = typeof invoice.customer_id === "string" ? invoice.customer_id : ""
    const customer = customerMap.get(customerId)

    return {
      ...invoice,
      customer_name: invoice.customer_name || customer?.name || null,
      customer_phone: invoice.customer_phone || customer?.phone || null,
      customer_email: invoice.customer_email || customer?.email || null,
    }
  })
  const products = (productResult.error ? [] : productResult.data || []) as Array<Record<string, unknown>>
  const paid = enrichedInvoices.filter((invoice) => ["paid", "completed", "success"].includes(statusFrom(invoice)))
  const unpaid = enrichedInvoices.filter((invoice) => ["unpaid", "pending", "overdue", ""].includes(statusFrom(invoice)))
  const partial = enrichedInvoices.filter((invoice) => statusFrom(invoice) === "partial")
  const open = enrichedInvoices.filter((invoice) => ["unpaid", "pending", "overdue", "partial", ""].includes(statusFrom(invoice)))
  const weeklyRevenue = Array.from({ length: 7 }, (_, index) => {
    const date = new Date()
    date.setDate(date.getDate() - (6 - index))
    const dayKey = date.toDateString()

    return {
      label: date.toLocaleDateString(undefined, { weekday: "short" }),
      total: enrichedInvoices
        .filter((invoice) => {
          const value = createdAt(invoice)
          return value && new Date(value).toDateString() === dayKey
        })
        .reduce((sum, invoice) => sum + amount(invoice), 0),
    }
  })
  const inventoryValue = products.reduce(
    (sum, product) =>
      sum + Number(product.stock || 0) * Number(product.sale_rate || product.price || product.mrp || 0),
    0
  )
  const lowStock = products.filter((product) => Number(product.stock || 0) <= Number(product.min_stock ?? 5))
  const revenue = enrichedInvoices.reduce((sum, invoice) => sum + amount(invoice), 0)
  const paidRevenue = paid.reduce((sum, invoice) => sum + amount(invoice), 0)

  return NextResponse.json(
    {
      currency: workspace.context.currency,
      locale: workspace.context.locale,
      timezone: workspace.context.timezone,
      metrics: {
        invoiceCount: invoiceResult.count || enrichedInvoices.length,
        revenue,
        monthlyRevenue: enrichedInvoices.filter((invoice) => isThisMonth(createdAt(invoice))).reduce((sum, invoice) => sum + amount(invoice), 0),
        paidRevenue,
        outstanding: open.reduce((sum, invoice) => sum + amount(invoice), 0),
        tax: enrichedInvoices.reduce((sum, invoice) => sum + taxAmount(invoice), 0),
        inventoryValue,
        averageInvoice: enrichedInvoices.length ? revenue / enrichedInvoices.length : 0,
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
      recentInvoices: enrichedInvoices.slice(0, 10),
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
