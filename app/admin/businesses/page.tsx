"use client"

import { useEffect, useMemo, useState } from "react"
import { useDebounce } from "use-debounce"
import { supabase } from "@/lib/supabase"

type Organization = Record<string, unknown> & {
  id: string
  name: string | null
  industry?: string | null
  currency?: string | null
  business_type?: string | null
  business_category?: string | null
  owner_id: string | null
  created_at: string | null
}

type Profile = {
  id: string
  email: string | null
  full_name?: string | null
  approved: boolean | null
  business_created: boolean | null
  is_suspended?: boolean | null
}

type ProductMetric = {
  id?: string | null
  organization_id?: string | null
  stock?: number | null
  min_stock?: number | null
  purchase_rate?: number | null
}

type InvoiceItemMetric = Record<string, unknown> & {
  organization_id?: string | null
  product_id?: string | null
  quantity?: number | null
}

type InvoiceMetric = Record<string, unknown> & {
  organization_id?: string | null
  payment_status?: string | null
  created_at?: string | null
}

type AdminMetricsResponse = {
  success: boolean
  error?: string
  organizations?: Organization[]
  profiles?: Profile[]
  products?: ProductMetric[]
  invoices?: InvoiceMetric[]
  invoiceItems?: InvoiceItemMetric[]
}

type BusinessView = Organization & {
  ownerName: string
  ownerEmail: string
  status: "Active" | "Pending" | "Suspended"
  productCount: number
  lowStockCount: number
  invoiceCount: number
  unpaidCount: number
  revenue: number
  grossProfit: number
  marginPercent: number
  lastInvoiceAt: string | null
  readiness: number
  risk: "Healthy" | "Watch" | "Action"
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-"
  return new Date(value).toLocaleDateString()
}

function money(value: number) {
  return `Rs ${Math.round(value).toLocaleString()}`
}

function numberFrom(row: Record<string, unknown>, fields: string[]) {
  for (const field of fields) {
    const value = row[field]
    if (value !== null && value !== undefined && value !== "") return Number(value || 0)
  }
  return 0
}

function downloadCsv(filename: string, rows: Array<Record<string, string | number>>) {
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

export default function AdminBusinessesPage() {
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [products, setProducts] = useState<ProductMetric[]>([])
  const [invoices, setInvoices] = useState<InvoiceMetric[]>([])
  const [invoiceItems, setInvoiceItems] = useState<InvoiceItemMetric[]>([])
  const [search, setSearch] = useState("")
  const [debouncedSearch] = useDebounce(search, 300)
  const [statusFilter, setStatusFilter] = useState("all")
  const [riskFilter, setRiskFilter] = useState("all")
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [notice, setNotice] = useState("")

  async function fetchBusinesses() {
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
      setNotice(payload.error || "Admin metrics failed to load.")
      setLoading(false)
      return
    }

    setOrganizations(payload.organizations || [])
    setProfiles(payload.profiles || [])
    setProducts(payload.products || [])
    setInvoices(payload.invoices || [])
    setInvoiceItems(payload.invoiceItems || [])
    setLoading(false)
  }

  useEffect(() => {
    queueMicrotask(() => {
      void fetchBusinesses()
    })
  }, [])

  const profileMap = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles])

  const businesses = useMemo<BusinessView[]>(() => {
    return organizations.map((org) => {
      const owner = org.owner_id ? profileMap.get(org.owner_id) : null
      const orgProducts = products.filter((product) => product.organization_id === org.id)
      const orgInvoices = invoices.filter((invoice) => invoice.organization_id === org.id)
      const orgInvoiceItems = invoiceItems.filter((item) => item.organization_id === org.id)
      const productCostMap = new Map(
        orgProducts
          .filter((product) => product.id)
          .map((product) => [String(product.id), Number(product.purchase_rate || 0)])
      )
      const unpaidCount = orgInvoices.filter((invoice) => String(invoice.payment_status || "").toLowerCase() !== "paid").length
      const revenue = orgInvoices.reduce((sum, invoice) => sum + numberFrom(invoice, ["grand_total", "total_amount", "total"]), 0)
      const costOfGoods = orgInvoiceItems.reduce((sum, item) => {
        const cost = item.product_id ? productCostMap.get(String(item.product_id)) || 0 : 0
        return sum + cost * Number(item.quantity || 0)
      }, 0)
      const grossProfit = revenue - costOfGoods
      const marginPercent = revenue > 0 ? Math.round((grossProfit / revenue) * 100) : 0
      const lowStockCount = orgProducts.filter((product) => Number(product.stock || 0) <= Number(product.min_stock || 0)).length
      const status = owner?.is_suspended ? "Suspended" : owner?.approved === false ? "Pending" : "Active"
      const readinessChecks = [
        Boolean(org.name),
        Boolean(owner?.email),
        orgProducts.length > 0,
        orgInvoices.length > 0,
        status === "Active",
      ]
      const readiness = Math.round((readinessChecks.filter(Boolean).length / readinessChecks.length) * 100)
      const risk: BusinessView["risk"] = status !== "Active" || unpaidCount > 5 ? "Action" : lowStockCount > 0 || readiness < 80 ? "Watch" : "Healthy"

      return {
        ...org,
        ownerName: owner?.full_name || owner?.email?.split("@")[0] || "Unknown Owner",
        ownerEmail: owner?.email || "No email",
        status,
        productCount: orgProducts.length,
        lowStockCount,
        invoiceCount: orgInvoices.length,
        unpaidCount,
        revenue,
        grossProfit,
        marginPercent,
        lastInvoiceAt: orgInvoices[0]?.created_at || null,
        readiness,
        risk,
      }
    })
  }, [invoiceItems, invoices, organizations, products, profileMap])

  const filteredBusinesses = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase()
    return businesses.filter((business) => {
      const text = [
        business.name,
        business.industry,
        business.business_type,
        business.business_category,
        business.ownerName,
        business.ownerEmail,
        business.currency,
      ]
        .join(" ")
        .toLowerCase()
      const matchesSearch = !term || text.includes(term)
      const matchesStatus = statusFilter === "all" || business.status.toLowerCase() === statusFilter
      const matchesRisk = riskFilter === "all" || business.risk.toLowerCase() === riskFilter
      return matchesSearch && matchesStatus && matchesRisk
    })
  }, [businesses, debouncedSearch, riskFilter, statusFilter])

  async function setBusinessLifecycle(business: BusinessView, action: "activate" | "suspend") {
    if (!business.owner_id) {
      setNotice("This organization has no owner profile attached.")
      return
    }

    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (action === "suspend" && !window.confirm(`Suspend ${business.name || "this business"}?`)) {
      return
    }

    setActionLoading(`${action}:${business.id}`)
    const response = await fetch("/api/admin/business-lifecycle", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({ ownerId: business.owner_id, businessName: business.name, organizationId: business.id, action }),
    })
    const payload = (await response.json()) as { success: boolean; error?: string; message?: string }
    setActionLoading(null)

    if (!payload.success) {
      setNotice(payload.error || "Business lifecycle update failed.")
      return
    }

    setNotice(payload.message || "Business updated.")
    await fetchBusinesses()
  }

  function exportBusinesses() {
    downloadCsv(
      `admin-businesses-${new Date().toISOString().slice(0, 10)}.csv`,
      filteredBusinesses.map((business) => ({
        business: business.name || "Untitled Business",
        owner: business.ownerName,
        email: business.ownerEmail,
        status: business.status,
        risk: business.risk,
        readiness: business.readiness,
        products: business.productCount,
        invoices: business.invoiceCount,
        unpaid: business.unpaidCount,
        revenue: Math.round(business.revenue),
        grossProfit: Math.round(business.grossProfit),
        marginPercent: business.marginPercent,
        currency: business.currency || "INR",
      }))
    )
  }

  const stats = {
    total: businesses.length,
    active: businesses.filter((business) => business.status === "Active").length,
    action: businesses.filter((business) => business.risk === "Action").length,
    revenue: businesses.reduce((sum, business) => sum + business.revenue, 0),
    grossProfit: businesses.reduce((sum, business) => sum + business.grossProfit, 0),
  }

  return (
    <div className="space-y-8 text-white">
      <section className="inventory-sheen rounded-[40px] border border-white/10 bg-white/[0.035] p-8 shadow-[0_0_90px_rgba(0,0,0,0.5)]">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="mb-4 text-xs font-bold uppercase tracking-[0.24em] text-cyan-200">Organization Control</p>
            <h1 className="max-w-5xl text-4xl font-black leading-tight md:text-6xl">Businesses, workspaces, owners, risk, and revenue.</h1>
            <p className="mt-5 max-w-3xl text-neutral-400">Operate every customer workspace with live owner status, stock health, billing activity, readiness, and lifecycle controls.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <button onClick={exportBusinesses} className="h-14 rounded-2xl border border-white/10 px-6 font-black text-white">Export CSV</button>
            <button onClick={() => void fetchBusinesses()} className="h-14 rounded-2xl bg-white px-6 font-black text-black">Refresh</button>
          </div>
        </div>
      </section>

      {notice && <div className="rounded-3xl border border-cyan-400/25 bg-cyan-500/10 px-6 py-4 text-sm text-cyan-100">{notice}</div>}

      <section className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-4">
        {[
          ["Total Businesses", stats.total, "text-white", "Customer workspaces"],
          ["Active", stats.active, "text-emerald-200", "Licensed and live"],
          ["Action Needed", stats.action, "text-red-200", "Risk or suspended"],
          ["Platform Revenue", money(stats.revenue), "text-cyan-200", "Invoice total"],
          ["Gross Profit", money(stats.grossProfit), "text-emerald-200", "After product cost"],
        ].map(([label, value, color, helper]) => (
          <div key={label} className="rounded-[32px] border border-white/10 bg-gradient-to-br from-zinc-950 via-black to-zinc-950 p-7">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">{label}</p>
            <p className={`mt-5 text-4xl font-black ${color}`}>{value}</p>
            <p className="mt-3 text-sm text-neutral-500">{helper}</p>
          </div>
        ))}
      </section>

      <section className="rounded-[36px] border border-white/10 bg-white/[0.035] p-6">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr,190px,190px]">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search business, owner, industry, category, currency..." className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none" />
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none">
            <option value="all">All status</option>
            <option value="active">Active</option>
            <option value="pending">Pending</option>
            <option value="suspended">Suspended</option>
          </select>
          <select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value)} className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none">
            <option value="all">All risk</option>
            <option value="healthy">Healthy</option>
            <option value="watch">Watch</option>
            <option value="action">Action</option>
          </select>
        </div>
      </section>

      <section className="overflow-hidden rounded-[36px] border border-white/10 bg-gradient-to-br from-zinc-950/95 to-black">
        <div className="border-b border-white/10 p-6">
          <h2 className="text-3xl font-black">Business Register</h2>
          <p className="mt-2 text-sm text-neutral-500">{filteredBusinesses.length} organizations visible with live billing and inventory signals.</p>
        </div>
        {loading ? (
          <div className="p-12 text-center text-neutral-500">Loading businesses...</div>
        ) : filteredBusinesses.length ? (
          <div className="divide-y divide-white/5">
            {filteredBusinesses.map((business) => (
              <div key={business.id} className="grid gap-5 px-6 py-6 2xl:grid-cols-[1.25fr,1.15fr,170px,190px] 2xl:items-center">
                <div>
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="text-xl font-bold">{business.name || "Untitled Business"}</p>
                    <span className={`rounded-full px-3 py-1 text-xs font-black ${business.risk === "Healthy" ? "bg-emerald-400/15 text-emerald-200" : business.risk === "Watch" ? "bg-amber-400/15 text-amber-200" : "bg-red-400/15 text-red-200"}`}>{business.risk}</span>
                  </div>
                  <p className="mt-1 text-sm text-neutral-400">{business.ownerName} - {business.ownerEmail}</p>
                  <p className="mt-1 text-xs text-neutral-500">{business.industry || business.business_type || "General"} - {business.business_category || "All categories"} - {business.currency || "INR"}</p>
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-2xl border border-white/10 bg-black/35 p-3">
                    <p className="text-neutral-500">Revenue</p>
                    <p className="mt-1 font-black text-cyan-200">{money(business.revenue)}</p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/35 p-3">
                    <p className="text-neutral-500">Gross Profit</p>
                    <p className={`mt-1 font-black ${business.grossProfit >= 0 ? "text-emerald-200" : "text-red-200"}`}>{money(business.grossProfit)}</p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/35 p-3">
                    <p className="text-neutral-500">Margin</p>
                    <p className={`mt-1 font-black ${business.marginPercent >= 20 ? "text-emerald-200" : business.marginPercent > 0 ? "text-amber-200" : "text-neutral-300"}`}>{business.marginPercent}%</p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/35 p-3">
                    <p className="text-neutral-500">Readiness</p>
                    <p className="mt-1 font-black">{business.readiness}%</p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/35 p-3">
                    <p className="text-neutral-500">Products</p>
                    <p className="mt-1 font-black">{business.productCount}</p>
                  </div>
                  <div className="rounded-2xl border border-white/10 bg-black/35 p-3">
                    <p className="text-neutral-500">Invoices</p>
                    <p className="mt-1 font-black">{business.invoiceCount}</p>
                  </div>
                </div>
                <div>
                  <p className="text-sm text-neutral-500">Created {formatDate(business.created_at)}</p>
                  <p className="mt-2 text-sm text-neutral-500">Last invoice {formatDate(business.lastInvoiceAt)}</p>
                  <span className="mt-3 inline-flex rounded-full border border-cyan-400/20 bg-cyan-500/10 px-3 py-1 text-xs font-bold text-cyan-200">{business.status}</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-1">
                  <button
                    disabled={actionLoading === `activate:${business.id}`}
                    onClick={() => void setBusinessLifecycle(business, "activate")}
                    className="h-11 rounded-xl bg-white px-4 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {actionLoading === `activate:${business.id}` ? "Activating..." : "Activate"}
                  </button>
                  <button
                    disabled={actionLoading === `suspend:${business.id}`}
                    onClick={() => void setBusinessLifecycle(business, "suspend")}
                    className="h-11 rounded-xl border border-red-400/20 px-4 text-sm font-bold text-red-200 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {actionLoading === `suspend:${business.id}` ? "Suspending..." : "Suspend"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-12 text-center text-neutral-500">No businesses match this view.</div>
        )}
      </section>
    </div>
  )
}
