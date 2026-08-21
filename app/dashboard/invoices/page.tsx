"use client"

import Link from "next/link"
import type { ReactNode } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useDebounce } from "use-debounce"
import { MoneyValue } from "@/components/MoneyValue"
import { apiFetch } from "@/lib/api/client-fetch"
import { getOrganizationId } from "@/lib/getOrganization"
import { createOfflineId, getOfflineData, putOfflineData, queueOfflineAction } from "@/lib/offline/db"
import { shouldUseWebOfflineFallback } from "@/lib/offline/network"
import { InvoiceExportModal } from "@/components/invoices/InvoiceExportModal"

type InvoiceRow = Record<string, unknown> & {
  id: string
  customer_id?: string | null
  created_at?: string | null
}

type CustomerRow = {
  id: string
  name: string | null
  phone?: string | null
  email?: string | null
}

type InvoiceItemRow = {
  invoice_id: string | null
  quantity: number | null
  line_total: number | null
  gst_amount: number | null
}

type ListResponse<T> = {
  data?: T[]
  pagination?: {
    total?: number
  }
  summary?: Partial<InvoiceSummary>
  error?: string
}

type InvoiceSummary = {
  revenue: number
  paidRevenue: number
  outstanding: number
  tax: number
  invoiceCount: number
  paidCount: number
  partialCount: number
  unpaidCount: number
  overdueCount: number
  todayCount: number
  averageInvoice: number
  collectionRate: number
}

type InvoiceWithMetrics = InvoiceRow & {
  customerName: string
  itemCount: number
  totalQuantity: number
  amount: number
  tax: number
  statusLabel: string
  dueState: "paid" | "overdue" | "due-soon" | "open"
}

const pageSize = 50

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

function dateFrom(row: Record<string, unknown>, fields: string[]) {
  const value = stringFrom(row, fields)
  return value ? new Date(value) : null
}

function money(value: number) {
  return `Rs ${Math.round(value).toLocaleString()}`
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-"
  return new Date(value).toLocaleDateString()
}

function normalizeStatus(invoice: InvoiceRow) {
  return stringFrom(invoice, ["payment_status", "status"]).toLowerCase() || "unpaid"
}

function dueState(invoice: InvoiceRow): InvoiceWithMetrics["dueState"] {
  const status = normalizeStatus(invoice)
  if (status === "paid") return "paid"

  const dueDate = dateFrom(invoice, ["due_date"])
  if (!dueDate) return "open"

  const today = new Date()
  const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

  if (dueDate < today) return "overdue"
  if (dueDate <= soon) return "due-soon"
  return "open"
}

function statusClass(status: string) {
  if (status === "paid") return "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
  if (status === "partial") return "border-amber-400/30 bg-amber-500/10 text-amber-200"
  if (status === "cancelled") return "border-red-400/30 bg-red-500/10 text-red-200"
  return "border-cyan-400/30 bg-cyan-500/10 text-cyan-200"
}

function SelectShell({
  value,
  onChange,
  children,
  label,
}: {
  value: string
  onChange: (value: string) => void
  children: ReactNode
  label: string
}) {
  return (
    <label className="relative block">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-14 w-full appearance-none rounded-2xl border border-white/10 bg-black/50 px-5 pr-14 text-sm font-semibold text-white outline-none transition-all duration-300 hover:border-cyan-400/30 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-500/10"
      >
        {children}
      </select>
      <span className="pointer-events-none absolute right-6 top-1/2 -translate-y-1/2 text-lg text-white/80">
       ⌄
      </span>
    </label>
  )
}

export default function InvoicesPage() {
  const [organizationId, setOrganizationId] = useState<string | null>(null)
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [invoiceSummary, setInvoiceSummary] = useState<Partial<InvoiceSummary>>({})
  const [customers, setCustomers] = useState<CustomerRow[]>([])
  const [items, setItems] = useState<InvoiceItemRow[]>([])
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [notice, setNotice] = useState("")
  const [search, setSearch] = useState("")
  const [debouncedSearch] = useDebounce(search, 300)
  const [statusFilter, setStatusFilter] = useState("all")
  const [periodFilter, setPeriodFilter] = useState("all")
  const [customerFilter, setCustomerFilter] = useState("all")
  const [riskFilter, setRiskFilter] = useState("all")
  const [currentPage, setCurrentPage] = useState(1)
  const [serverTotal, setServerTotal] = useState(0)
  const [exportKind, setExportKind] = useState<"csv" | "pdf" | null>(null)
  const skipNextInvoicesRefresh = useRef(false)
  const billingRequest = useRef<AbortController | null>(null)

  const fetchBillingData = useCallback(async (orgId = organizationId) => {
    if (!orgId) return

    billingRequest.current?.abort()
    const request = new AbortController()
    billingRequest.current = request
    const invoiceParams = new URLSearchParams({
      page: String(currentPage),
      limit: String(pageSize),
      search: debouncedSearch.trim(),
      status: statusFilter,
      period: periodFilter,
      customer_id: customerFilter,
    })
    const customerParams = new URLSearchParams({
      limit: "100",
      organization_id: orgId,
      sort: "name",
      direction: "asc",
    })

    try {
      const [invoiceResponse, customerResponse] = await Promise.all([
        apiFetch(`/api/invoices/list?${invoiceParams.toString()}`, {
          credentials: "include",
          cache: "no-store",
          signal: request.signal,
        }),
        apiFetch(`/api/customers/list?${customerParams.toString()}`, {
          credentials: "include",
          cache: "no-store",
          signal: request.signal,
        }),
      ])
      const invoiceResult = (await invoiceResponse.json()) as ListResponse<InvoiceRow>
      const customerResult = (await customerResponse.json()) as ListResponse<CustomerRow>

      if (!invoiceResponse.ok) throw new Error(invoiceResult.error || "Invoices failed to load.")
      if (!customerResponse.ok) setNotice(customerResult.error || "Customers failed to load.")

      const nextInvoices = invoiceResult.data || []
      const nextCustomers = customerResult.data || []

      if (invoiceResponse.headers.get("X-Bezgrow-Data-Source") !== "sqlite") {
        await putOfflineData(orgId, "invoices", nextInvoices)
      }
      if (customerResponse.headers.get("X-Bezgrow-Data-Source") !== "sqlite") {
        await putOfflineData(orgId, "customers", nextCustomers)
      }
      setInvoices(nextInvoices)
      setCustomers(nextCustomers)
      setItems([])
      setServerTotal(invoiceResult.pagination?.total || nextInvoices.length)
      setInvoiceSummary(invoiceResult.summary || {})
      if (customerResponse.ok) setNotice("")
    } catch (error) {
      if (request.signal.aborted) return
      if (!(await shouldUseWebOfflineFallback(error))) {
        setNotice(error instanceof Error ? error.message : "Invoices failed to load.")
        return
      }

      const [cachedInvoices, cachedCustomers, cachedItems] = await Promise.all([
        getOfflineData<InvoiceRow[]>(orgId, "invoices", []),
        getOfflineData<CustomerRow[]>(orgId, "customers", []),
        getOfflineData<InvoiceItemRow[]>(orgId, "invoice_items", []),
      ])
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      const weekStart = new Date(now)
      weekStart.setDate(now.getDate() - 7)
      const term = debouncedSearch.trim().toLowerCase()
      const matchingInvoices = cachedInvoices.filter((invoice) => {
        if (invoice.deleted_at) return false
        const text = [invoice.invoice_number, invoice.customer_name, invoice.payment_method, invoice.notes].join(" ").toLowerCase()
        if (term && !text.includes(term)) return false
        if (statusFilter !== "all" && normalizeStatus(invoice) !== statusFilter) return false
        if (customerFilter !== "all" && invoice.customer_id !== customerFilter) return false
        if (riskFilter !== "all" && dueState(invoice) !== riskFilter) return false
        const created = new Date(String(invoice.created_at || invoice.invoice_date || 0))
        if (periodFilter === "today" && created.toDateString() !== now.toDateString()) return false
        if (periodFilter === "week" && created < weekStart) return false
        if (periodFilter === "month" && created < monthStart) return false
        return true
      })
      const pageStart = (currentPage - 1) * pageSize
      const pageInvoices = matchingInvoices.slice(pageStart, pageStart + pageSize)
      const pageIds = new Set(pageInvoices.map((invoice) => invoice.id))
      setInvoices(pageInvoices)
      setCustomers(cachedCustomers.filter((customer) => !(customer as CustomerRow & { deleted_at?: string }).deleted_at).slice(0, 100))
      setItems(cachedItems.filter((item) => item.invoice_id && pageIds.has(item.invoice_id)))
      setServerTotal(matchingInvoices.length)
      setInvoiceSummary({})
      setNotice(
        typeof navigator !== "undefined" && !navigator.onLine
          ? "Offline mode: showing cached invoices."
          : error instanceof Error ? error.message : "Invoices failed to load."
      )
    } finally {
      if (billingRequest.current === request) billingRequest.current = null
    }
  }, [currentPage, customerFilter, debouncedSearch, organizationId, periodFilter, riskFilter, statusFilter])

  const initializeInvoices = useCallback(async () => {
    try {
      setLoading(true)
      const orgId = await getOrganizationId()

      if (!orgId) {
        setNotice("No business is connected to this account.")
        return
      }

      skipNextInvoicesRefresh.current = true
      setOrganizationId(orgId)
      await fetchBillingData(orgId)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Invoices failed to load.")
    } finally {
      setLoading(false)
    }
  }, [fetchBillingData])

  useEffect(() => {
    queueMicrotask(() => {
      void initializeInvoices()
    })
    // Initial invoice bootstrap intentionally runs once; filter changes use fetchBillingData below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!organizationId) return
    if (skipNextInvoicesRefresh.current) {
      skipNextInvoicesRefresh.current = false
      return
    }

    void fetchBillingData(organizationId)
  }, [fetchBillingData, organizationId])

  const customerMap = useMemo(() => {
    return new Map(customers.map((customer) => [customer.id, customer]))
  }, [customers])

  const itemMetrics = useMemo(() => {
    const map = new Map<string, { itemCount: number; quantity: number; tax: number }>()

    items.forEach((item) => {
      if (!item.invoice_id) return
      const current = map.get(item.invoice_id) || { itemCount: 0, quantity: 0, tax: 0 }
      current.itemCount += 1
      current.quantity += Number(item.quantity || 0)
      current.tax += Number(item.gst_amount || 0)
      map.set(item.invoice_id, current)
    })

    return map
  }, [items])

  const enrichedInvoices = useMemo<InvoiceWithMetrics[]>(() => {
    return invoices.map((invoice) => {
      const customer = invoice.customer_id ? customerMap.get(invoice.customer_id) : null
      const metrics = itemMetrics.get(invoice.id) || {
        itemCount: numberFrom(invoice, ["item_count"]),
        quantity: numberFrom(invoice, ["total_quantity"]),
        tax: numberFrom(invoice, ["item_tax"]),
      }
      const status = normalizeStatus(invoice)

      return {
        ...invoice,
        customerName: customer?.name || stringFrom(invoice, ["customer_name"]) || "Walk-in customer",
        itemCount: metrics.itemCount,
        totalQuantity: metrics.quantity,
        amount: numberFrom(invoice, ["grand_total", "total_amount", "total"]),
        tax: numberFrom(invoice, ["tax_amount", "tax_total"]) || metrics.tax,
        statusLabel: status,
        dueState: dueState(invoice),
      }
    })
  }, [customerMap, invoices, itemMetrics])

  const filteredInvoices = useMemo(() => {
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const startOfWeek = new Date(now)
    startOfWeek.setDate(now.getDate() - 7)

    return enrichedInvoices.filter((invoice) => {
      const term = debouncedSearch.trim().toLowerCase()
      const invoiceText = [
        stringFrom(invoice, ["invoice_number"]),
        invoice.customerName,
        stringFrom(invoice, ["payment_method"]),
        stringFrom(invoice, ["notes"]),
      ]
        .join(" ")
        .toLowerCase()

      if (term && !invoiceText.includes(term)) return false
      if (statusFilter !== "all" && invoice.statusLabel !== statusFilter) return false
      if (customerFilter !== "all" && invoice.customer_id !== customerFilter) return false
      if (riskFilter !== "all" && invoice.dueState !== riskFilter) return false

      const created = invoice.created_at ? new Date(invoice.created_at) : null
      if (periodFilter === "today" && created?.toDateString() !== now.toDateString()) return false
      if (periodFilter === "week" && (!created || created < startOfWeek)) return false
      if (periodFilter === "month" && (!created || created < startOfMonth)) return false

      return true
    })
  }, [customerFilter, debouncedSearch, enrichedInvoices, periodFilter, riskFilter, statusFilter])

  const totalPages = Math.max(1, Math.ceil((serverTotal || filteredInvoices.length) / pageSize))
  const visibleInvoices = filteredInvoices

  const analytics = useMemo(() => {
    const source = enrichedInvoices
    const rows = source.map((invoice) => {
      const amount = numberFrom(invoice, ["grand_total", "total_amount", "total"])
      const status = normalizeStatus(invoice)
      const paidAmount = numberFrom(invoice, ["paid_amount"]) || (status === "paid" ? amount : 0)
      return {
        invoice,
        amount,
        status,
        paidAmount: Math.min(amount, paidAmount),
        outstandingAmount: numberFrom(invoice, ["outstanding_amount", "due_amount"]) || Math.max(0, amount - paidAmount),
        tax: numberFrom(invoice, ["tax_amount", "tax_total", "item_tax"]),
        due: dueState(invoice),
      }
    })
    const paid = rows.filter((row) => row.status === "paid")
    const partial = rows.filter((row) => row.status === "partial")
    const unpaid = rows.filter((row) => row.status === "unpaid")
    const overdue = rows.filter((row) => row.due === "overdue")
    const revenue = rows.reduce((sum, row) => sum + row.amount, 0)
    const paidRevenue = rows.reduce((sum, row) => sum + row.paidAmount, 0)
    const outstanding = rows.reduce((sum, row) => sum + row.outstandingAmount, 0)
    const tax = rows.reduce((sum, row) => sum + row.tax, 0)
    const today = rows.filter(
      ({ invoice }) => invoice.created_at && new Date(invoice.created_at).toDateString() === new Date().toDateString()
    )

    const fallback = {
      revenue,
      paidRevenue,
      outstanding,
      tax,
      invoiceCount: source.length || serverTotal,
      paidCount: paid.length,
      partialCount: partial.length,
      unpaidCount: unpaid.length,
      overdueCount: overdue.length,
      todayCount: today.length,
      averageInvoice: rows.length ? revenue / rows.length : 0,
      collectionRate: revenue ? Math.round((paidRevenue / revenue) * 100) : 0,
    }
    return {
      ...fallback,
      ...invoiceSummary,
      invoiceCount: Number(invoiceSummary.invoiceCount ?? serverTotal ?? fallback.invoiceCount),
    }
  }, [enrichedInvoices, invoiceSummary, serverTotal])

  async function updatePaymentStatus(invoiceId: string, status: string) {
    if (!organizationId) return
    setSavingId(invoiceId)
    setNotice("")

    try {
      const response = await apiFetch("/api/invoices/update-status", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ invoice_id: invoiceId, payment_status: status }),
      })
      const result = (await response.json().catch(() => null)) as { success?: boolean; error?: string } | null

      if (!response.ok || !result?.success) {
        setNotice(result?.error || "Invoice status could not be updated.")
        setSavingId(null)
        return
      }
    } catch (error) {
      if (!(await shouldUseWebOfflineFallback(error))) {
        setNotice(error instanceof Error ? error.message : "Invoice status could not be updated.")
        setSavingId(null)
        return
      }

      const cachedInvoices = await getOfflineData<InvoiceRow[]>(organizationId, "invoices", invoices)
      const nextInvoices = cachedInvoices.map((invoice) =>
        invoice.id === invoiceId
          ? { ...invoice, payment_status: status, status, sync_status: "pending_update", updated_at: new Date().toISOString() }
          : invoice
      )
      await putOfflineData(organizationId, "invoices", nextInvoices)
      await queueOfflineAction({
        id: createOfflineId("invoice-status-action"),
        type: "update_invoice_status",
        organizationId,
        payload: { invoiceId, paymentStatus: status },
      })
      setInvoices(nextInvoices)
      setNotice("Invoice status saved locally.")
      setSavingId(null)
      return
    }

    setInvoices((current) =>
      current.map((invoice) =>
        invoice.id === invoiceId
          ? { ...invoice, payment_status: status, status, updated_at: new Date().toISOString() }
          : invoice
      )
    )
    setSavingId(null)
    void fetchBillingData(organizationId)
  }

  return (
    <div className="relative min-h-dvh overflow-y-auto overflow-x-hidden bg-black text-white">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="inventory-grid-bg absolute inset-0 opacity-40" />
        <div className="absolute left-[-160px] top-[-160px] h-[520px] w-[520px] rounded-full bg-cyan-500/10 blur-[170px] animate-pulse" />
        <div className="absolute bottom-[-180px] right-[-160px] h-[560px] w-[560px] rounded-full bg-blue-500/10 blur-[190px] animate-pulse" />
      </div>

      <main className="relative z-10 mx-auto max-w-[1800px] space-y-5 px-4 py-4 sm:space-y-8 sm:px-5 sm:py-6 lg:px-8">
        <section className="inventory-sheen relative overflow-hidden rounded-lg border border-white/10 bg-white/[0.035] p-5 shadow-[0_0_90px_rgba(0,0,0,0.5)] backdrop-blur-2xl sm:rounded-[40px] sm:p-7 lg:p-9">
          <div className="grid grid-cols-1 gap-8 2xl:grid-cols-[1fr,620px] 2xl:items-center">
            <div className="max-w-4xl">
              <div className="mb-5 inline-flex rounded-full border border-cyan-400/20 bg-cyan-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200">
                Invoice Register
              </div>
              <h1 className="text-3xl font-black leading-tight tracking-tight text-white sm:text-4xl md:text-5xl">
                Invoices, collections, tax, print, and audit control.
              </h1>
              <p className="mt-4 max-w-3xl text-base leading-7 text-neutral-400 sm:mt-5 sm:leading-8">
                Track invoices, payment status, due dates, customer bills, tax totals, CSV export, and print-ready invoice copies.
              </p>
            </div>

            <div className="rounded-lg border border-white/10 bg-black/30 p-4 shadow-[0_20px_70px_rgba(0,0,0,0.25)] sm:rounded-[34px] sm:p-5">
              <div className="grid grid-cols-3 gap-4">
                <div className="rounded-lg border border-white/10 bg-white/[0.035] p-3 sm:rounded-2xl sm:p-4">
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-neutral-500">Invoices</p>
                  <p className="mt-2 text-xl font-black text-white sm:text-2xl">{analytics.invoiceCount}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.035] p-3 sm:rounded-2xl sm:p-4">
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-neutral-500">Today</p>
                  <p className="mt-2 text-xl font-black text-cyan-200 sm:text-2xl">{analytics.todayCount}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/[0.035] p-3 sm:rounded-2xl sm:p-4">
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-neutral-500">Collect</p>
                  <p className="mt-2 text-xl font-black text-emerald-200 sm:text-2xl">{analytics.collectionRate}%</p>
                </div>
              </div>
              <div className="mt-5 grid grid-cols-3 gap-4">
              <button
                onClick={() => setExportKind("pdf")}
                className="flex min-h-14 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] px-2 text-center text-sm font-black leading-tight text-white shadow-[0_18px_55px_rgba(0,0,0,0.25)] transition-all duration-300 hover:-translate-y-1 hover:border-cyan-400/30 hover:bg-cyan-500/10 sm:min-h-[82px] sm:rounded-[26px] sm:px-5 sm:text-xl"
              >
                Export PDF
              </button>
              <button
                onClick={() => setExportKind("csv")}
                className="min-h-14 rounded-lg border border-white/10 bg-white/[0.06] px-2 text-center text-sm font-black leading-tight text-white shadow-[0_18px_55px_rgba(0,0,0,0.25)] transition-all duration-300 hover:-translate-y-1 hover:border-cyan-400/30 hover:bg-white/[0.09] sm:min-h-[82px] sm:rounded-[26px] sm:px-5 sm:text-xl"
              >
                Export CSV
              </button>
              <Link
                href="/dashboard/invoices/create"
                className="flex min-h-14 items-center justify-center rounded-lg bg-gradient-to-r from-cyan-400 to-blue-600 px-2 text-center text-sm font-black leading-tight text-black shadow-[0_20px_70px_rgba(34,211,238,0.35)] transition-all duration-300 hover:-translate-y-1 hover:scale-[1.02] sm:min-h-[82px] sm:rounded-[26px] sm:px-5 sm:text-xl"
              >
                Create Invoice
              </Link>
              </div>
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
            { label: "Total Revenue", value: analytics.revenue, color: "text-cyan-200", helper: "All invoice value", money: true },
            { label: "Outstanding", value: analytics.outstanding, color: "text-amber-200", helper: `${analytics.overdueCount} overdue`, money: true },
            { label: "Collection Rate", value: analytics.collectionRate, color: "text-emerald-200", helper: `${analytics.paidCount} paid invoices`, money: false },
            { label: "Tax Ledger", value: analytics.tax, color: "text-blue-200", helper: "GST and tax visibility", money: true },
          ].map(({ label, value, color, helper, money: isMoney }) => (
            <div
              key={label}
              className="group relative min-w-0 overflow-hidden rounded-lg border border-white/10 bg-gradient-to-br from-zinc-950 via-black to-zinc-950 p-4 transition-all duration-300 hover:-translate-y-1 hover:border-cyan-400/30 hover:shadow-[0_0_45px_rgba(34,211,238,0.12)] sm:rounded-[32px] sm:p-7"
            >
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.10),transparent_34%)] opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
              <div className="relative">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">{label}</p>
                <div className={`mt-4 min-w-0 font-black sm:mt-5 ${color}`}>
                  {isMoney ? <MoneyValue value={value} className="font-black" /> : <span className="text-3xl sm:text-4xl">{value}%</span>}
                </div>
                <p className="mt-3 text-sm text-neutral-500 sm:mt-4">{helper}</p>
              </div>
            </div>
          ))}
        </section>

        <section className="grid grid-cols-1 gap-5 xl:grid-cols-[1.3fr,0.7fr]">
          <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4 shadow-[0_0_70px_rgba(0,0,0,0.35)] backdrop-blur-2xl sm:rounded-[36px] sm:p-6">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr,1fr,1fr,1fr,1fr]">
              <input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  setCurrentPage(1)
                }}
                placeholder="Search invoice, customer, payment method..."
                className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 text-sm font-semibold text-white outline-none transition-all duration-300 placeholder:text-neutral-600 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-500/10"
              />
              <SelectShell label="Status" value={statusFilter} onChange={(value) => { setStatusFilter(value); setCurrentPage(1) }}>
                <option value="all">All status</option>
                <option value="paid">Paid</option>
                <option value="partial">Partial</option>
                <option value="unpaid">Unpaid</option>
                <option value="cancelled">Cancelled</option>
              </SelectShell>
              <SelectShell label="Period" value={periodFilter} onChange={(value) => { setPeriodFilter(value); setCurrentPage(1) }}>
                <option value="all">All dates</option>
                <option value="today">Today</option>
                <option value="week">Last 7 days</option>
                <option value="month">This month</option>
              </SelectShell>
              <SelectShell label="Customer" value={customerFilter} onChange={(value) => { setCustomerFilter(value); setCurrentPage(1) }}>
                <option value="all">All customers</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>{customer.name || "Unnamed customer"}</option>
                ))}
              </SelectShell>
              <SelectShell label="Risk" value={riskFilter} onChange={(value) => { setRiskFilter(value); setCurrentPage(1) }}>
                <option value="all">All risk</option>
                <option value="overdue">Overdue</option>
                <option value="due-soon">Due soon</option>
                <option value="open">Open</option>
                <option value="paid">Paid</option>
              </SelectShell>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 rounded-lg border border-white/10 bg-white/[0.035] p-4 backdrop-blur-2xl sm:rounded-[36px] sm:p-6">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">Today</p>
              <p className="mt-2 text-2xl font-black text-white sm:mt-3 sm:text-3xl">{analytics.todayCount}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">Average</p>
              <p className="mt-2 text-2xl font-black text-cyan-200 sm:mt-3 sm:text-3xl">{money(analytics.averageInvoice)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">Partial</p>
              <p className="mt-2 text-2xl font-black text-amber-200 sm:mt-3 sm:text-3xl">{analytics.partialCount}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">Unpaid</p>
              <p className="mt-2 text-2xl font-black text-red-200 sm:mt-3 sm:text-3xl">{analytics.unpaidCount}</p>
            </div>
          </div>
        </section>

        <section>
          <div className="overflow-hidden rounded-lg border border-white/10 bg-gradient-to-br from-zinc-950/95 to-black shadow-[0_0_80px_rgba(0,0,0,0.4)] sm:rounded-[36px]">
            <div className="flex flex-col gap-4 border-b border-white/10 p-4 md:flex-row md:items-center md:justify-between sm:p-6">
              <div>
                <h2 className="text-2xl font-black tracking-tight sm:text-3xl">Invoice Register</h2>
                <p className="mt-2 text-sm text-neutral-500">
                  {filteredInvoices.length} filtered records from {analytics.invoiceCount} total invoices.
                </p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => currentPage > 1 && setCurrentPage((page) => page - 1)}
                  className="h-11 rounded-xl border border-white/10 px-4 text-sm font-semibold text-white disabled:opacity-40"
                  disabled={currentPage === 1}
                >
                  Previous
                </button>
                <button
                  onClick={() => currentPage < totalPages && setCurrentPage((page) => page + 1)}
                  className="h-11 rounded-xl border border-white/10 px-4 text-sm font-semibold text-white disabled:opacity-40"
                  disabled={currentPage === totalPages}
                >
                  Next
                </button>
              </div>
            </div>

            {loading ? (
              <div className="p-12 text-center text-neutral-500">Loading invoices...</div>
            ) : visibleInvoices.length === 0 ? (
              <div className="p-12 text-center">
                <p className="text-lg font-semibold text-white">No invoices match this view.</p>
                <p className="mt-2 text-sm text-neutral-500">Create invoices or adjust filters to see billing records.</p>
              </div>
            ) : (
              <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1120px] text-sm">
                  <thead className="sticky top-0 z-10 border-b border-white/10 bg-zinc-950">
                    <tr className="text-left text-xs uppercase tracking-[0.18em] text-neutral-500">
                      <th className="px-4 py-3">Invoice #</th>
                      <th className="px-4 py-3">Date</th>
                      <th className="px-4 py-3">Customer</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3 text-right">Total</th>
                      <th className="px-4 py-3 text-right">Paid</th>
                      <th className="px-4 py-3 text-right">Due</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleInvoices.map((invoice) => (
                      <tr key={invoice.id} className="border-b border-white/5 transition-colors duration-300 hover:bg-cyan-500/[0.035]">
                        <td className="px-4 py-3">
                          <p className="font-bold text-white">{stringFrom(invoice, ["invoice_number"]) || "Invoice"}</p>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-neutral-300">
                          {formatDate(stringFrom(invoice, ["invoice_date", "date", "created_at"]))}
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-semibold text-white">{invoice.customerName}</p>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold capitalize ${statusClass(invoice.statusLabel)}`}>
                            {savingId === invoice.id ? "Saving..." : invoice.statusLabel}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-bold text-cyan-100">{money(invoice.amount)}</td>
                        <td className="px-4 py-3 text-right text-emerald-200">
                          {money(numberFrom(invoice, ["paid_amount"]) || (invoice.statusLabel === "paid" ? invoice.amount : 0))}
                        </td>
                        <td className="px-4 py-3 text-right text-amber-200">
                          {money(numberFrom(invoice, ["outstanding_amount"]) || Math.max(0, invoice.amount - (numberFrom(invoice, ["paid_amount"]) || (invoice.statusLabel === "paid" ? invoice.amount : 0))))}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-2">
                            <select
                            aria-label={`Update payment status for ${stringFrom(invoice, ["invoice_number"]) || "invoice"}`}
                            value={invoice.statusLabel}
                            disabled={savingId === invoice.id}
                            onChange={(event) => void updatePaymentStatus(invoice.id, event.target.value)}
                            className="h-9 rounded-lg border border-white/10 bg-black px-2 text-xs font-semibold text-white outline-none focus:border-cyan-300/60 disabled:opacity-50"
                          >
                            <option value="unpaid">Unpaid</option>
                            <option value="partial">Partial</option>
                            <option value="paid">Paid</option>
                            <option value="cancelled">Cancelled</option>
                          </select>
                            <Link href={`/dashboard/invoices/${invoice.id}`} className="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-white hover:border-cyan-400/30">
                              View
                            </Link>
                            <Link href={`/dashboard/invoices/${invoice.id}/print`} className="rounded-lg bg-white px-3 py-2 text-xs font-bold text-black hover:bg-cyan-100">
                              Print
                            </Link>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </div>

        </section>
      </main>
      {exportKind && organizationId && (
        <InvoiceExportModal
          kind={exportKind}
          organizationId={organizationId}
          customers={customers}
          initialSearch={debouncedSearch}
          initialStatus={statusFilter}
          initialPeriod={periodFilter}
          initialCustomerId={customerFilter}
          onClose={() => setExportKind(null)}
          onNotice={setNotice}
        />
      )}
    </div>
  )
}
