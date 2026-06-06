"use client"

import { useEffect, useMemo, useState } from "react"
import { supabase } from "@/lib/supabase"

type OrganizationRow = { id: string; name: string | null; created_at?: string | null }
type ProductRow = { organization_id?: string | null; stock?: number | null; min_stock?: number | null; price?: number | null; sale_rate?: number | null }
type InvoiceRow = Record<string, unknown> & { organization_id?: string | null; payment_status?: string | null; created_at?: string | null }
type OrderRow = Record<string, unknown> & { status?: string | null; created_at?: string | null }
type LogRow = { id: string; action: string | null; description: string | null; created_at: string | null }
type AdminMetricsResponse = {
  success: boolean
  error?: string
  organizations?: OrganizationRow[]
  usersCount?: number
  products?: ProductRow[]
  invoices?: InvoiceRow[]
  orders?: OrderRow[]
  logs?: LogRow[]
}

function numberFrom(row: Record<string, unknown>, fields: string[]) {
  for (const field of fields) {
    const value = row[field]
    if (value !== null && value !== undefined && value !== "") return Number(value || 0)
  }
  return 0
}

function money(value: number) {
  return `Rs ${Math.round(value).toLocaleString()}`
}

function withinRange(value: string | null | undefined, days: string) {
  if (days === "all") return true
  if (!value) return false
  const date = new Date(value)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - Number(days))
  return date >= cutoff
}

function exportCsv(filename: string, rows: Array<Record<string, string | number>>) {
  if (!rows.length) return
  const headers = Object.keys(rows[0])
  const escape = (value: string | number) => `"${String(value).replaceAll("\"", "\"\"")}"`
  const csv = [headers.join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n")
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export default function AdminAnalyticsPage() {
  const [organizations, setOrganizations] = useState<OrganizationRow[]>([])
  const [usersCount, setUsersCount] = useState(0)
  const [products, setProducts] = useState<ProductRow[]>([])
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [activityLogs, setActivityLogs] = useState<LogRow[]>([])
  const [range, setRange] = useState("90")
  const [metric, setMetric] = useState<"revenue" | "invoices" | "tax">("revenue")
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState("")

  async function fetchAnalytics() {
    setLoading(true)
    setNotice("")

    const {
      data: { session },
    } = await supabase.auth.getSession()

    const response = await fetch("/api/admin/metrics", {
      headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
      cache: "no-store",
    })
    const payload = (await response.json()) as AdminMetricsResponse

    if (!payload.success) {
      setNotice(payload.error || "Admin analytics failed to load.")
      setLoading(false)
      return
    }

    setOrganizations(payload.organizations || [])
    setUsersCount(payload.usersCount || 0)
    setProducts(payload.products || [])
    setInvoices(payload.invoices || [])
    setOrders(payload.orders || [])
    setActivityLogs(payload.logs || [])
    setLoading(false)
  }

  useEffect(() => {
    queueMicrotask(() => {
      void fetchAnalytics()
    })
  }, [])

  const analytics = useMemo(() => {
    const scopedInvoices = invoices.filter((invoice) => withinRange(invoice.created_at, range))
    const scopedOrders = orders.filter((order) => withinRange(order.created_at, range))
    const revenue = scopedInvoices.reduce((sum, invoice) => sum + numberFrom(invoice, ["grand_total", "total_amount", "total"]), 0)
    const tax = scopedInvoices.reduce((sum, invoice) => sum + numberFrom(invoice, ["tax_amount", "tax_total"]), 0)
    const paidInvoices = scopedInvoices.filter((invoice) => String(invoice.payment_status || "").toLowerCase() === "paid")
    const unpaidInvoices = scopedInvoices.filter((invoice) => String(invoice.payment_status || "").toLowerCase() !== "paid")
    const inventoryValue = products.reduce((sum, product) => {
      const price = Number(product.sale_rate ?? product.price ?? 0)
      return sum + Number(product.stock || 0) * price
    }, 0)
    const lowStock = products.filter((product) => Number(product.stock || 0) <= Number(product.min_stock || 0))
    const activeOrganizations = new Set(scopedInvoices.map((invoice) => invoice.organization_id).filter(Boolean)).size
    const collectionRate = scopedInvoices.length ? Math.round((paidInvoices.length / scopedInvoices.length) * 100) : 0
    const inventoryHealth = products.length ? Math.round(((products.length - lowStock.length) / products.length) * 100) : 0
    const platformHealth = Math.round((collectionRate + inventoryHealth + (organizations.length ? Math.round((activeOrganizations / organizations.length) * 100) : 0)) / 3)

    const monthBars = Array.from({ length: 6 }, (_, index) => {
      const date = new Date()
      date.setMonth(date.getMonth() - (5 - index))
      const month = date.toLocaleDateString(undefined, { month: "short" })
      const key = `${date.getFullYear()}-${date.getMonth()}`
      const monthInvoices = invoices.filter((invoice) => {
        if (!invoice.created_at) return false
        const invoiceDate = new Date(invoice.created_at)
        return invoiceDate.getMonth() === date.getMonth() && invoiceDate.getFullYear() === date.getFullYear()
      })
      const total = monthInvoices.reduce((sum, invoice) => {
        if (metric === "invoices") return sum + 1
        if (metric === "tax") return sum + numberFrom(invoice, ["tax_amount", "tax_total"])
        return sum + numberFrom(invoice, ["grand_total", "total_amount", "total"])
      }, 0)
      return { key, month, total }
    })

    const organizationRevenue = organizations
      .map((organization) => {
        const orgInvoices = scopedInvoices.filter((invoice) => invoice.organization_id === organization.id)
        const total = orgInvoices.reduce((sum, invoice) => sum + numberFrom(invoice, ["grand_total", "total_amount", "total"]), 0)
        return { id: organization.id, name: organization.name || "Untitled Business", total, invoices: orgInvoices.length }
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 6)

    return {
      revenue,
      tax,
      invoiceCount: scopedInvoices.length,
      orderCount: scopedOrders.length,
      paidCount: paidInvoices.length,
      unpaidCount: unpaidInvoices.length,
      averageRevenue: organizations.length ? revenue / organizations.length : 0,
      collectionRate,
      inventoryValue,
      lowStockCount: lowStock.length,
      inventoryHealth,
      activeOrganizations,
      platformHealth,
      monthBars,
      maxMonth: Math.max(...monthBars.map((bar) => bar.total), 1),
      organizationRevenue,
    }
  }, [invoices, metric, orders, organizations, products, range])

  const hasMonthTrend = analytics.monthBars.some((bar) => bar.total > 0)

  function exportSnapshot() {
    exportCsv(`admin-analytics-${new Date().toISOString().slice(0, 10)}.csv`, [
      {
        range: range === "all" ? "All time" : `${range} days`,
        revenue: Math.round(analytics.revenue),
        tax: Math.round(analytics.tax),
        invoices: analytics.invoiceCount,
        paid: analytics.paidCount,
        unpaid: analytics.unpaidCount,
        collection_rate: analytics.collectionRate,
        inventory_value: Math.round(analytics.inventoryValue),
        inventory_health: analytics.inventoryHealth,
        platform_health: analytics.platformHealth,
      },
    ])
  }

  return (
    <div className="space-y-8 text-white">
      <section className="inventory-sheen rounded-[40px] border border-white/10 bg-white/[0.035] p-8 shadow-[0_0_90px_rgba(0,0,0,0.5)]">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="mb-4 text-xs font-bold uppercase tracking-[0.24em] text-cyan-200">Platform Intelligence</p>
            <h1 className="max-w-5xl text-4xl font-black leading-tight md:text-6xl">SaaS analytics, billing health, and scale signals.</h1>
            <p className="mt-5 max-w-3xl text-neutral-400">Track live organizations, users, invoices, revenue, collection rate, inventory health, orders, and admin activity.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <button onClick={exportSnapshot} className="h-14 rounded-2xl border border-white/10 px-6 font-black">Export Snapshot</button>
            <button onClick={() => void fetchAnalytics()} className="h-14 rounded-2xl bg-white px-6 font-black text-black">Refresh</button>
          </div>
        </div>
      </section>

      {notice && <div className="rounded-3xl border border-amber-400/25 bg-amber-500/10 px-6 py-4 text-sm text-amber-100">{notice}</div>}

      <section className="rounded-[32px] border border-white/10 bg-white/[0.035] p-5">
        <div className="grid gap-4 md:grid-cols-[1fr,220px,220px]">
          <div className="rounded-2xl border border-white/10 bg-black/35 px-5 py-4">
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-neutral-500">Current View</p>
            <p className="mt-2 text-lg font-black">{range === "all" ? "All-time platform data" : `Last ${range} days`}</p>
          </div>
          <select value={range} onChange={(event) => setRange(event.target.value)} className="h-16 rounded-2xl border border-white/10 bg-black/50 px-5 font-bold outline-none">
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last 365 days</option>
            <option value="all">All time</option>
          </select>
          <select value={metric} onChange={(event) => setMetric(event.target.value as typeof metric)} className="h-16 rounded-2xl border border-white/10 bg-black/50 px-5 font-bold outline-none">
            <option value="revenue">Revenue trend</option>
            <option value="invoices">Invoice volume</option>
            <option value="tax">Tax trend</option>
          </select>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-4">
        {[
          ["Revenue", money(analytics.revenue), "text-cyan-200", `${analytics.invoiceCount} invoices`],
          ["Businesses", organizations.length, "text-white", `${analytics.activeOrganizations} active billers`],
          ["Collection", `${analytics.collectionRate}%`, "text-emerald-200", `${analytics.paidCount} paid / ${analytics.unpaidCount} open`],
          ["Health", `${analytics.platformHealth}%`, "text-amber-200", `${analytics.inventoryHealth}% inventory health`],
        ].map(([label, value, color, helper]) => (
          <div key={label} className="rounded-[32px] border border-white/10 bg-gradient-to-br from-zinc-950 via-black to-zinc-950 p-7">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">{label}</p>
            <p className={`mt-5 text-4xl font-black ${color}`}>{value}</p>
            <p className="mt-3 text-sm text-neutral-500">{helper}</p>
          </div>
        ))}
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr,420px]">
        <div className="rounded-[36px] border border-white/10 bg-white/[0.035] p-7">
          <h2 className="text-3xl font-black">Six Month Trend</h2>
          <p className="mt-2 text-sm text-neutral-500">Metric changes instantly from the selector above.</p>
          <div className="mt-8 h-72">
            {hasMonthTrend ? (
              <div className="flex h-full items-end gap-4">
                {analytics.monthBars.map((bar, index) => (
                  <div key={`${bar.key}-${index}`} className="flex flex-1 flex-col items-center gap-3">
                    <div className="flex h-56 w-full items-end rounded-2xl border border-white/10 bg-black/40 p-2">
                      <div
                        className="w-full rounded-xl bg-gradient-to-t from-cyan-500 to-blue-300"
                        style={{ height: `${Math.max(8, (bar.total / analytics.maxMonth) * 100)}%` }}
                        title={`${bar.month}: ${metric === "invoices" ? bar.total : money(bar.total)}`}
                      />
                    </div>
                    <p className="text-xs font-bold uppercase tracking-[0.16em] text-neutral-500">{bar.month}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center rounded-3xl border border-dashed border-white/10 bg-black/35 px-6 text-center">
                <p className="text-lg font-black text-white">No trend data yet</p>
                <p className="mt-2 max-w-sm text-sm leading-6 text-neutral-500">
                  Platform billing charts will activate after businesses create invoices.
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="rounded-[36px] border border-white/10 bg-white/[0.035] p-7">
          <h2 className="text-3xl font-black">Operating Metrics</h2>
          <div className="mt-6 space-y-4">
            {[
              ["Users", usersCount],
              ["Orders", analytics.orderCount],
              ["Tax Ledger", money(analytics.tax)],
              ["Avg / Business", money(analytics.averageRevenue)],
              ["Inventory Value", money(analytics.inventoryValue)],
              ["Low Stock SKUs", analytics.lowStockCount],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/35 px-4 py-4">
                <span className="text-sm text-neutral-400">{label}</span>
                <span className="font-black text-white">{value}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="rounded-[36px] border border-white/10 bg-gradient-to-br from-zinc-950/95 to-black p-7">
          <h2 className="text-3xl font-black">Top Businesses</h2>
          <div className="mt-6 space-y-3">
            {analytics.organizationRevenue.length ? (
              analytics.organizationRevenue.map((business) => (
                <div key={business.id} className="rounded-2xl border border-white/10 bg-black/35 p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="font-black">{business.name}</p>
                      <p className="mt-1 text-xs text-neutral-500">{business.invoices} invoices</p>
                    </div>
                    <p className="font-black text-cyan-200">{money(business.total)}</p>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-neutral-500">No billing data in this range.</p>
            )}
          </div>
        </div>

        <div className="rounded-[36px] border border-white/10 bg-gradient-to-br from-zinc-950/95 to-black p-7">
          <h2 className="text-3xl font-black">Recent Platform Activity</h2>
          <div className="mt-6 space-y-3">
            {loading ? (
              <div className="text-neutral-500">Loading activity...</div>
            ) : activityLogs.length ? (
              activityLogs.map((log) => (
                <div key={log.id} className="rounded-2xl border border-white/10 bg-black/35 p-4">
                  <p className="font-bold">{log.action || "Platform Activity"}</p>
                  <p className="mt-2 text-sm text-neutral-500">{log.description || "Activity recorded."}</p>
                  <p className="mt-3 text-xs text-neutral-600">{log.created_at ? new Date(log.created_at).toLocaleString() : ""}</p>
                </div>
              ))
            ) : (
              <div className="text-neutral-500">No activity logs yet.</div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
