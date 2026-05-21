"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { getOrganizationId } from "@/lib/getOrganization"
import { supabase } from "@/lib/supabase"

type DataRow = Record<string, unknown> & {
  id: string
  created_at?: string | null
}

function numberFrom(row: Record<string, unknown>, fields: string[]) {
  for (const field of fields) {
    const value = row[field]
    if (value !== null && value !== undefined && value !== "") return Number(value || 0)
  }

  return 0
}

function stringFrom(row: Record<string, unknown>, fields: string[]) {
  for (const field of fields) {
    const value = row[field]
    if (typeof value === "string" && value.trim()) return value
  }

  return ""
}

function money(value: number) {
  return `Rs ${Math.round(value).toLocaleString()}`
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-"
  return new Date(value).toLocaleDateString()
}

function statusOf(row: Record<string, unknown>) {
  return stringFrom(row, ["payment_status", "status"]).toLowerCase() || "unpaid"
}

function isThisMonth(value: string | null | undefined) {
  if (!value) return false
  const date = new Date(value)
  const now = new Date()
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()
}

function readinessClass(ready: boolean) {
  return ready ? "bg-emerald-500/15 text-emerald-200" : "bg-amber-500/15 text-amber-200"
}

export default function BillingPage() {
  const [invoices, setInvoices] = useState<DataRow[]>([])
  const [customers, setCustomers] = useState<DataRow[]>([])
  const [products, setProducts] = useState<DataRow[]>([])
  const [orders, setOrders] = useState<DataRow[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState("")

  async function initializeBilling() {
    try {
      setLoading(true)
      const orgId = await getOrganizationId()

      if (!orgId) {
        setNotice("No organization is connected to this account.")
        return
      }

      const [invoiceResult, customerResult, productResult, orderResult] = await Promise.all([
        supabase
          .from("invoices")
          .select("*")
          .eq("organization_id", orgId)
          .order("created_at", { ascending: false })
          .limit(1000),
        supabase
          .from("customers")
          .select("*")
          .eq("organization_id", orgId)
          .is("deleted_at", null)
          .limit(1000),
        supabase
          .from("products")
          .select("*")
          .eq("organization_id", orgId)
          .is("deleted_at", null)
          .limit(1000),
        supabase
          .from("orders")
          .select("*")
          .eq("organization_id", orgId)
          .order("created_at", { ascending: false })
          .limit(1000),
      ])

      if (invoiceResult.error) setNotice(invoiceResult.error.message)
      if (customerResult.error) setNotice(customerResult.error.message)
      if (productResult.error) setNotice(productResult.error.message)
      if (orderResult.error) setNotice(orderResult.error.message)

      setInvoices((invoiceResult.data || []) as DataRow[])
      setCustomers((customerResult.data || []) as DataRow[])
      setProducts((productResult.data || []) as DataRow[])
      setOrders((orderResult.data || []) as DataRow[])
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Billing data failed to load.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      void initializeBilling()
    })
  }, [])

  const analytics = useMemo(() => {
    const revenue = invoices.reduce((sum, invoice) => sum + numberFrom(invoice, ["grand_total", "total_amount", "total"]), 0)
    const monthlyRevenue = invoices
      .filter((invoice) => isThisMonth(invoice.created_at))
      .reduce((sum, invoice) => sum + numberFrom(invoice, ["grand_total", "total_amount", "total"]), 0)
    const paidInvoices = invoices.filter((invoice) => statusOf(invoice) === "paid")
    const unpaidInvoices = invoices.filter((invoice) => statusOf(invoice) === "unpaid")
    const partialInvoices = invoices.filter((invoice) => statusOf(invoice) === "partial")
    const tax = invoices.reduce((sum, invoice) => sum + numberFrom(invoice, ["tax_amount", "tax_total"]), 0)
    const outstanding = [...unpaidInvoices, ...partialInvoices].reduce(
      (sum, invoice) => sum + numberFrom(invoice, ["grand_total", "total_amount", "total"]),
      0
    )
    const inventoryValue = products.reduce(
      (sum, product) =>
        sum + numberFrom(product, ["stock", "quantity"]) * numberFrom(product, ["sale_rate", "price", "mrp"]),
      0
    )
    const lowStock = products.filter(
      (product) => numberFrom(product, ["stock", "quantity"]) <= numberFrom(product, ["min_stock"])
    )
    const avgInvoice = invoices.length ? revenue / invoices.length : 0
    const collectionRate = revenue
      ? Math.round((paidInvoices.reduce((sum, invoice) => sum + numberFrom(invoice, ["grand_total", "total_amount", "total"]), 0) / revenue) * 100)
      : 0

    return {
      revenue,
      monthlyRevenue,
      outstanding,
      tax,
      inventoryValue,
      avgInvoice,
      collectionRate,
      invoiceCount: invoices.length,
      paidCount: paidInvoices.length,
      unpaidCount: unpaidInvoices.length,
      partialCount: partialInvoices.length,
      lowStockCount: lowStock.length,
      customerCount: customers.length,
      productCount: products.length,
      orderCount: orders.length,
    }
  }, [customers.length, invoices, orders.length, products])

  const recentInvoices = invoices.slice(0, 6)

  const weeklyBars = useMemo(() => {
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date()
      date.setDate(date.getDate() - (6 - index))
      const total = invoices
        .filter((invoice) => invoice.created_at && new Date(invoice.created_at).toDateString() === date.toDateString())
        .reduce((sum, invoice) => sum + numberFrom(invoice, ["grand_total", "total_amount", "total"]), 0)

      return {
        label: date.toLocaleDateString(undefined, { weekday: "short" }),
        total,
      }
    })
  }, [invoices])

  const maxWeekValue = Math.max(...weeklyBars.map((bar) => bar.total), 1)

  return (
    <div className="relative min-h-screen overflow-y-auto overflow-x-hidden bg-black text-white">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="inventory-grid-bg absolute inset-0 opacity-40" />
        <div className="absolute left-[-160px] top-[-150px] h-[520px] w-[520px] rounded-full bg-cyan-500/10 blur-[170px] animate-pulse" />
        <div className="absolute bottom-[-190px] right-[-160px] h-[580px] w-[580px] rounded-full bg-blue-500/10 blur-[190px] animate-pulse" />
      </div>

      <main className="relative z-10 mx-auto max-w-[1800px] space-y-8 px-5 py-6 lg:px-8">
        <section className="inventory-sheen relative overflow-hidden rounded-[40px] border border-white/10 bg-white/[0.035] p-7 shadow-[0_0_90px_rgba(0,0,0,0.5)] backdrop-blur-2xl lg:p-10">
          <div className="grid gap-8 xl:grid-cols-[1.4fr,0.6fr] xl:items-end">
            <div>
              <div className="mb-5 inline-flex rounded-full border border-cyan-400/20 bg-cyan-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200">
                Global Billing Command Center
              </div>
              <h1 className="max-w-6xl text-4xl font-black leading-tight tracking-tight text-white md:text-6xl">
                Billing, collections, tax, inventory value, and launch readiness.
              </h1>
              <p className="mt-5 max-w-4xl text-base leading-8 text-neutral-400 md:text-lg">
                A professional ERP billing hub for global SaaS scaling: live revenue, payment risk,
                GST/tax visibility, invoice creation, print workflows, product readiness, and operational controls.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <Link
                href="/dashboard/invoices/create"
                className="flex h-14 items-center justify-center rounded-2xl bg-gradient-to-r from-cyan-400 to-blue-600 px-6 font-bold text-black shadow-[0_18px_55px_rgba(34,211,238,0.28)] transition-all duration-300 hover:scale-[1.02]"
              >
                Create Invoice
              </Link>
              <Link
                href="/dashboard/invoices"
                className="flex h-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] px-6 font-semibold text-white transition-all duration-300 hover:border-cyan-400/30 hover:bg-cyan-500/10"
              >
                Manage Invoices
              </Link>
            </div>
          </div>
        </section>

        {notice && (
          <div className="rounded-3xl border border-amber-400/25 bg-amber-500/10 px-6 py-4 text-sm text-amber-100">
            {notice}
          </div>
        )}

        <section className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-4">
          {[
            ["Revenue", money(analytics.revenue), "text-cyan-200", `${analytics.invoiceCount} invoices`],
            ["Outstanding", money(analytics.outstanding), "text-amber-200", `${analytics.unpaidCount} unpaid, ${analytics.partialCount} partial`],
            ["Collection", `${analytics.collectionRate}%`, "text-emerald-200", `${analytics.paidCount} paid invoices`],
            ["Inventory Value", money(analytics.inventoryValue), "text-blue-200", `${analytics.lowStockCount} low stock alerts`],
          ].map(([label, value, color, helper]) => (
            <div
              key={label}
              className="group relative overflow-hidden rounded-[32px] border border-white/10 bg-gradient-to-br from-zinc-950 via-black to-zinc-950 p-7 transition-all duration-300 hover:-translate-y-1 hover:border-cyan-400/30 hover:shadow-[0_0_45px_rgba(34,211,238,0.12)]"
            >
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.10),transparent_34%)] opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
              <div className="relative">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">{label}</p>
                <p className={`mt-5 text-4xl font-black tracking-tight ${color}`}>{value}</p>
                <p className="mt-4 text-sm text-neutral-500">{helper}</p>
              </div>
            </div>
          ))}
        </section>

        <section className="grid grid-cols-1 gap-6 2xl:grid-cols-[1fr,420px]">
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              <div className="rounded-[36px] border border-white/10 bg-white/[0.035] p-7 shadow-[0_0_70px_rgba(0,0,0,0.35)] backdrop-blur-2xl">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-3xl font-black tracking-tight">Revenue Pulse</h2>
                    <p className="mt-2 text-sm text-neutral-500">Last 7 days billing movement.</p>
                  </div>
                  <p className="rounded-2xl border border-cyan-400/20 bg-cyan-500/10 px-4 py-2 text-sm font-bold text-cyan-200">
                    {money(analytics.monthlyRevenue)} month
                  </p>
                </div>

                <div className="mt-8 flex h-64 items-end gap-3">
                  {weeklyBars.map((bar) => (
                    <div key={bar.label} className="flex flex-1 flex-col items-center gap-3">
                      <div className="flex h-48 w-full items-end rounded-2xl border border-white/10 bg-black/35 p-2">
                        <div
                          className="w-full rounded-xl bg-gradient-to-t from-cyan-500 to-blue-300 shadow-[0_0_35px_rgba(34,211,238,0.18)] transition-all duration-500"
                          style={{ height: `${Math.max(8, (bar.total / maxWeekValue) * 100)}%` }}
                        />
                      </div>
                      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">{bar.label}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-[36px] border border-white/10 bg-white/[0.035] p-7 shadow-[0_0_70px_rgba(0,0,0,0.35)] backdrop-blur-2xl">
                <h2 className="text-3xl font-black tracking-tight">Billing Intelligence</h2>
                <div className="mt-7 grid grid-cols-2 gap-4">
                  {[
                    ["Avg Invoice", money(analytics.avgInvoice)],
                    ["Tax Ledger", money(analytics.tax)],
                    ["Customers", analytics.customerCount],
                    ["Orders", analytics.orderCount],
                    ["Products", analytics.productCount],
                    ["Low Stock", analytics.lowStockCount],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-3xl border border-white/10 bg-black/35 p-5">
                      <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">{label}</p>
                      <p className="mt-3 text-2xl font-black text-white">{value}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="overflow-hidden rounded-[36px] border border-white/10 bg-gradient-to-br from-zinc-950/95 to-black shadow-[0_0_80px_rgba(0,0,0,0.4)]">
              <div className="flex flex-col gap-4 border-b border-white/10 p-6 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-3xl font-black tracking-tight">Recent Billing Activity</h2>
                  <p className="mt-2 text-sm text-neutral-500">Latest invoices, status, amount, and print actions.</p>
                </div>
                <Link
                  href="/dashboard/invoices"
                  className="flex h-12 items-center justify-center rounded-2xl border border-white/10 px-5 text-sm font-semibold text-white transition-all duration-300 hover:border-cyan-400/30 hover:bg-cyan-500/10"
                >
                  Open Register
                </Link>
              </div>

              {loading ? (
                <div className="p-12 text-center text-neutral-500">Loading billing engine...</div>
              ) : recentInvoices.length === 0 ? (
                <div className="p-12 text-center">
                  <p className="text-lg font-semibold text-white">No invoices yet.</p>
                  <p className="mt-2 text-sm text-neutral-500">Create your first invoice to activate the billing dashboard.</p>
                </div>
              ) : (
                <div className="divide-y divide-white/5">
                  {recentInvoices.map((invoice) => {
                    const status = statusOf(invoice)
                    const amount = numberFrom(invoice, ["grand_total", "total_amount", "total"])

                    return (
                      <div key={invoice.id} className="grid gap-4 px-6 py-5 transition-colors duration-300 hover:bg-cyan-500/[0.035] md:grid-cols-[1fr,160px,160px,150px] md:items-center">
                        <div>
                          <p className="font-bold text-white">{stringFrom(invoice, ["invoice_number"]) || "Invoice"}</p>
                          <p className="mt-1 text-xs text-neutral-500">{formatDate(invoice.created_at)}</p>
                        </div>
                        <span className={`w-fit rounded-full px-3 py-1 text-xs font-bold capitalize ${readinessClass(status === "paid")}`}>
                          {status}
                        </span>
                        <p className="text-xl font-black text-cyan-200 md:text-right">{money(amount)}</p>
                        <div className="flex gap-2 md:justify-end">
                          <Link href={`/dashboard/invoices/${invoice.id}`} className="rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold text-white hover:border-cyan-400/30">
                            View
                          </Link>
                          <Link href={`/dashboard/invoices/${invoice.id}/print`} className="rounded-xl bg-white px-4 py-2 text-sm font-bold text-black hover:bg-cyan-100">
                            Print
                          </Link>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          <aside className="space-y-6">
            <div className="rounded-[36px] border border-cyan-400/20 bg-cyan-500/10 p-7 shadow-[0_0_60px_rgba(34,211,238,0.12)]">
              <h3 className="text-2xl font-black">Professional Billing Stack</h3>
              <div className="mt-6 space-y-4 text-sm text-neutral-300">
                {[
                  "GST and tax-aware invoice workflow",
                  "Payment collection status tracking",
                  "Inventory-linked product billing",
                  "Customer ledger and invoice history",
                  "A4, half-A4, and thermal print support",
                  "CSV-ready accounting records",
                ].map((feature) => (
                  <div key={feature} className="rounded-2xl border border-white/10 bg-black/30 p-4">
                    {feature}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[36px] border border-white/10 bg-white/[0.035] p-7 backdrop-blur-2xl">
              <h3 className="text-2xl font-black">Global Launch Checklist</h3>
              <div className="mt-6 space-y-4">
                {[
                  ["Products connected", analytics.productCount > 0],
                  ["Customers connected", analytics.customerCount > 0],
                  ["Invoices active", analytics.invoiceCount > 0],
                  ["Tax ledger visible", analytics.tax > 0],
                  ["Collections measurable", analytics.collectionRate > 0],
                  ["Inventory risk tracked", analytics.lowStockCount >= 0],
                ].map(([label, ready]) => (
                  <div key={String(label)} className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/30 px-4 py-4">
                    <span className="text-sm font-semibold text-white">{label}</span>
                    <span className={`rounded-full px-3 py-1 text-xs font-bold ${readinessClass(Boolean(ready))}`}>
                      {ready ? "Ready" : "Pending"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[36px] border border-white/10 bg-gradient-to-br from-zinc-950 to-black p-7">
              <h3 className="text-2xl font-black">Next Build Priorities</h3>
              <div className="mt-6 space-y-3 text-sm text-neutral-400">
                <p>1. Add multi-currency and country tax profiles.</p>
                <p>2. Add payment gateway reconciliation.</p>
                <p>3. Add recurring invoice reminders and customer ledger follow-ups.</p>
                <p>4. Add accountant exports for GST, VAT, and sales ledgers.</p>
              </div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  )
}
