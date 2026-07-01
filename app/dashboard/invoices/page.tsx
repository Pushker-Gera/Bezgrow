"use client"

import Link from "next/link"
import type { ReactNode } from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useDebounce } from "use-debounce"
import { getOrganizationId } from "@/lib/getOrganization"
import { createOfflineId, getOfflineData, putOfflineData, queueOfflineAction } from "@/lib/offline/db"
import { shouldSaveOffline } from "@/lib/offline/network"
import { supabase } from "@/lib/supabase"

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

function csvCell(value: string | number | null) {
  const text = String(value ?? "")
  return `"${text.replaceAll("\"", "\"\"")}"`
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

  const fetchBillingData = useCallback(async (orgId = organizationId) => {
    if (!orgId) return

    try {
      const [invoiceResult, customerResult, itemResult] = await Promise.all([
        supabase
          .from("invoices")
          .select("*")
          .eq("organization_id", orgId)
          .order("created_at", { ascending: false })
          .limit(1500),
        supabase
          .from("customers")
          .select("id,name,phone,email")
          .eq("organization_id", orgId)
          .is("deleted_at", null)
          .limit(1000),
        supabase
          .from("invoice_items")
          .select("invoice_id,quantity,line_total,gst_amount")
          .eq("organization_id", orgId)
          .limit(5000),
      ])

      if (invoiceResult.error) throw new Error(invoiceResult.error.message)
      if (customerResult.error) setNotice(customerResult.error.message)
      if (itemResult.error) setNotice(itemResult.error.message)

      const nextInvoices = (invoiceResult.data || []) as InvoiceRow[]
      const nextCustomers = (customerResult.data || []) as CustomerRow[]
      const nextItems = (itemResult.data || []) as InvoiceItemRow[]

      await putOfflineData(orgId, "invoices", nextInvoices)
      await putOfflineData(orgId, "customers", nextCustomers)
      await putOfflineData(orgId, "invoice_items", nextItems)
      setInvoices(nextInvoices)
      setCustomers(nextCustomers)
      setItems(nextItems)
    } catch (error) {
      const [cachedInvoices, cachedCustomers, cachedItems] = await Promise.all([
        getOfflineData<InvoiceRow[]>(orgId, "invoices", []),
        getOfflineData<CustomerRow[]>(orgId, "customers", []),
        getOfflineData<InvoiceItemRow[]>(orgId, "invoice_items", []),
      ])
      setInvoices(cachedInvoices)
      setCustomers(cachedCustomers)
      setItems(cachedItems)
      setNotice(
        typeof navigator !== "undefined" && !navigator.onLine
          ? "Offline mode: showing cached invoices."
          : error instanceof Error ? error.message : "Invoices failed to load."
      )
    }
  }, [organizationId])

  const initializeInvoices = useCallback(async () => {
    try {
      setLoading(true)
      const orgId = await getOrganizationId()

      if (!orgId) {
        setNotice("No organization is connected to this account.")
        return
      }

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
  }, [initializeInvoices])

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
      const metrics = itemMetrics.get(invoice.id) || { itemCount: 0, quantity: 0, tax: 0 }
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

  const totalPages = Math.max(1, Math.ceil(filteredInvoices.length / pageSize))
  const visibleInvoices = filteredInvoices.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  const analytics = useMemo(() => {
    const paid = enrichedInvoices.filter((invoice) => invoice.statusLabel === "paid")
    const partial = enrichedInvoices.filter((invoice) => invoice.statusLabel === "partial")
    const unpaid = enrichedInvoices.filter((invoice) => invoice.statusLabel === "unpaid")
    const overdue = enrichedInvoices.filter((invoice) => invoice.dueState === "overdue")
    const revenue = enrichedInvoices.reduce((sum, invoice) => sum + invoice.amount, 0)
    const paidRevenue = paid.reduce((sum, invoice) => sum + invoice.amount, 0)
    const outstanding = [...partial, ...unpaid, ...overdue].reduce((sum, invoice) => sum + invoice.amount, 0)
    const tax = enrichedInvoices.reduce((sum, invoice) => sum + invoice.tax, 0)
    const today = enrichedInvoices.filter(
      (invoice) => invoice.created_at && new Date(invoice.created_at).toDateString() === new Date().toDateString()
    )

    return {
      revenue,
      paidRevenue,
      outstanding,
      tax,
      invoiceCount: enrichedInvoices.length,
      paidCount: paid.length,
      partialCount: partial.length,
      unpaidCount: unpaid.length,
      overdueCount: overdue.length,
      todayCount: today.length,
      averageInvoice: enrichedInvoices.length ? revenue / enrichedInvoices.length : 0,
      collectionRate: revenue ? Math.round((paidRevenue / revenue) * 100) : 0,
    }
  }, [enrichedInvoices])

  async function updatePaymentStatus(invoiceId: string, status: string) {
    if (!organizationId) return
    setSavingId(invoiceId)
    setNotice("")

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const response = await fetch("/api/invoices/update-status", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
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
      if (!shouldSaveOffline(error)) {
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
      setNotice("Invoice status saved offline. Pending sync.")
      setSavingId(null)
      return
    }

    await fetchBillingData()
    setSavingId(null)
  }

  function exportCSV() {
    const header = [
      "Invoice",
      "Customer",
      "Status",
      "Payment Method",
      "Items",
      "Quantity",
      "Tax",
      "Amount",
      "Due Date",
      "Created",
    ]

    const rows = filteredInvoices.map((invoice) => [
      stringFrom(invoice, ["invoice_number"]),
      invoice.customerName,
      invoice.statusLabel,
      stringFrom(invoice, ["payment_method"]),
      invoice.itemCount,
      invoice.totalQuantity,
      invoice.tax,
      invoice.amount,
      formatDate(stringFrom(invoice, ["due_date"])),
      formatDate(invoice.created_at),
    ])

    const csv = [header, ...rows]
      .map((row) => row.map((cell) => csvCell(cell as string | number | null)).join(","))
      .join("\n")

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `invoices-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
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
                Enterprise Invoice Operations
              </div>
              <h1 className="text-3xl font-black leading-tight tracking-tight text-white sm:text-4xl md:text-5xl">
                Invoices, collections, tax, print, and audit control.
              </h1>
              <p className="mt-4 max-w-3xl text-base leading-7 text-neutral-400 sm:mt-5 sm:leading-8">
                Run global billing from one workspace with live invoice records, payment status control,
                due-date risk, customer ledgers, tax visibility, CSV export, and print-ready invoice routes.
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
              <Link
                href="/dashboard/billing"
                className="flex min-h-14 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] px-2 text-center text-sm font-black leading-tight text-white shadow-[0_18px_55px_rgba(0,0,0,0.25)] transition-all duration-300 hover:-translate-y-1 hover:border-cyan-400/30 hover:bg-cyan-500/10 sm:min-h-[82px] sm:rounded-[26px] sm:px-5 sm:text-xl"
              >
                Billing Hub
              </Link>
              <button
                onClick={exportCSV}
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
            ["Total Revenue", money(analytics.revenue), "text-cyan-200", "All invoice value"],
            ["Outstanding", money(analytics.outstanding), "text-amber-200", `${analytics.overdueCount} overdue`],
            ["Collection Rate", `${analytics.collectionRate}%`, "text-emerald-200", `${analytics.paidCount} paid invoices`],
            ["Tax Ledger", money(analytics.tax), "text-blue-200", "GST and tax visibility"],
          ].map(([label, value, color, helper]) => (
            <div
              key={label}
              className="group relative overflow-hidden rounded-lg border border-white/10 bg-gradient-to-br from-zinc-950 via-black to-zinc-950 p-4 transition-all duration-300 hover:-translate-y-1 hover:border-cyan-400/30 hover:shadow-[0_0_45px_rgba(34,211,238,0.12)] sm:rounded-[32px] sm:p-7"
            >
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.10),transparent_34%)] opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
              <div className="relative">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">{label}</p>
                <p className={`mt-4 text-3xl font-black tracking-tight sm:mt-5 sm:text-4xl ${color}`}>{value}</p>
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

        <section className="grid grid-cols-1 gap-6 2xl:grid-cols-[1fr,420px]">
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
              <div className="space-y-3 p-4 lg:hidden">
                {visibleInvoices.map((invoice) => (
                  <article key={invoice.id} className="rounded-lg border border-white/10 bg-white/[0.045] p-4 shadow-xl">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate text-base font-black text-white">{stringFrom(invoice, ["invoice_number"]) || "Invoice"}</h3>
                        <p className="mt-1 truncate text-xs text-neutral-500">{invoice.customerName} | {formatDate(invoice.created_at)}</p>
                      </div>
                      <p className="shrink-0 text-right text-lg font-black text-cyan-200">{money(invoice.amount)}</p>
                    </div>

                    {stringFrom(invoice, ["sync_status"]) && stringFrom(invoice, ["sync_status"]) !== "synced" ? (
                      <p className="mt-3 inline-flex rounded-full border border-amber-400/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.12em] text-amber-100">
                        Pending Sync
                      </p>
                    ) : null}

                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                        <p className="text-xs text-neutral-500">Payment</p>
                        <p className={`mt-2 inline-flex rounded-full border px-3 py-1 text-xs font-bold capitalize ${statusClass(invoice.statusLabel)}`}>
                          {savingId === invoice.id ? "Saving..." : invoice.statusLabel}
                        </p>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                        <p className="text-xs text-neutral-500">Due</p>
                        <p className={`mt-1 font-semibold capitalize ${invoice.dueState === "overdue" ? "text-red-300" : invoice.dueState === "due-soon" ? "text-amber-300" : "text-neutral-100"}`}>
                          {invoice.dueState.replace("-", " ")}
                        </p>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                        <p className="text-xs text-neutral-500">Items</p>
                        <p className="mt-1 font-black text-white">{invoice.itemCount} lines</p>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                        <p className="text-xs text-neutral-500">Tax</p>
                        <p className="mt-1 font-black text-sky-200">{money(invoice.tax)}</p>
                      </div>
                    </div>

                    <div className="mt-4">
                      <SelectShell
                        label="Payment status"
                        value={invoice.statusLabel}
                        onChange={(value) => void updatePaymentStatus(invoice.id, value)}
                      >
                        <option value="unpaid">Unpaid</option>
                        <option value="partial">Partial</option>
                        <option value="paid">Paid</option>
                        <option value="cancelled">Cancelled</option>
                      </SelectShell>
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-2">
                      <Link href={`/dashboard/invoices/${invoice.id}`} className="flex min-h-11 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-sm font-bold text-neutral-100">
                        View
                      </Link>
                      <Link href={`/dashboard/invoices/${invoice.id}/print`} className="flex min-h-11 items-center justify-center rounded-lg bg-white text-sm font-black text-black">
                        Print
                      </Link>
                    </div>
                  </article>
                ))}
              </div>

              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full min-w-[1080px]">
                  <thead className="border-b border-white/10 bg-white/[0.03]">
                    <tr className="text-left text-xs uppercase tracking-[0.18em] text-neutral-500">
                      <th className="px-6 py-4">Invoice</th>
                      <th className="px-6 py-4">Customer</th>
                      <th className="px-6 py-4">Status</th>
                      <th className="px-6 py-4">Items</th>
                      <th className="px-6 py-4">Due</th>
                      <th className="px-6 py-4 text-right">Amount</th>
                      <th className="px-6 py-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleInvoices.map((invoice) => (
                      <tr key={invoice.id} className="border-b border-white/5 transition-colors duration-300 hover:bg-cyan-500/[0.035]">
                        <td className="px-6 py-5">
                          <p className="font-bold text-white">{stringFrom(invoice, ["invoice_number"]) || "Invoice"}</p>
                          <p className="mt-1 text-xs text-neutral-500">{formatDate(invoice.created_at)}</p>
                          {stringFrom(invoice, ["sync_status"]) && stringFrom(invoice, ["sync_status"]) !== "synced" ? (
                            <p className="mt-2 inline-flex rounded-full border border-amber-400/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.12em] text-amber-100">
                              Pending Sync
                            </p>
                          ) : null}
                        </td>
                        <td className="px-6 py-5">
                          <p className="font-semibold text-white">{invoice.customerName}</p>
                          <p className="mt-1 text-xs text-neutral-500">{stringFrom(invoice, ["payment_method"]) || "No method"}</p>
                        </td>
                        <td className="px-6 py-5">
                          <SelectShell
                            label="Payment status"
                            value={invoice.statusLabel}
                            onChange={(value) => void updatePaymentStatus(invoice.id, value)}
                          >
                            <option value="unpaid">Unpaid</option>
                            <option value="partial">Partial</option>
                            <option value="paid">Paid</option>
                            <option value="cancelled">Cancelled</option>
                          </SelectShell>
                          <p className={`mt-2 inline-flex rounded-full border px-3 py-1 text-xs font-semibold capitalize ${statusClass(invoice.statusLabel)}`}>
                            {savingId === invoice.id ? "Saving..." : invoice.statusLabel}
                          </p>
                        </td>
                        <td className="px-6 py-5 text-sm text-neutral-300">
                          <p>{invoice.itemCount} lines</p>
                          <p className="mt-1 text-xs text-neutral-500">{invoice.totalQuantity} units</p>
                        </td>
                        <td className="px-6 py-5">
                          <p className="text-sm text-white">{formatDate(stringFrom(invoice, ["due_date"]))}</p>
                          <p className={`mt-1 text-xs capitalize ${invoice.dueState === "overdue" ? "text-red-300" : invoice.dueState === "due-soon" ? "text-amber-300" : "text-neutral-500"}`}>
                            {invoice.dueState.replace("-", " ")}
                          </p>
                        </td>
                        <td className="px-6 py-5 text-right">
                          <p className="text-xl font-black text-cyan-200">{money(invoice.amount)}</p>
                          <p className="mt-1 text-xs text-neutral-500">Tax {money(invoice.tax)}</p>
                        </td>
                        <td className="px-6 py-5">
                          <div className="flex justify-end gap-2">
                            <Link href={`/dashboard/invoices/${invoice.id}`} className="rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold text-white hover:border-cyan-400/30">
                              View
                            </Link>
                            <Link href={`/dashboard/invoices/${invoice.id}/print`} className="rounded-xl bg-white px-4 py-2 text-sm font-bold text-black hover:bg-cyan-100">
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

          <aside className="space-y-6">
            <div className="rounded-[36px] border border-cyan-400/20 bg-cyan-500/10 p-7 shadow-[0_0_60px_rgba(34,211,238,0.12)]">
              <h3 className="text-2xl font-black">Global Billing Features</h3>
              <div className="mt-6 space-y-4 text-sm text-neutral-300">
                {[
                  "Invoice creation with product and stock integration",
                  "GST/tax visibility and export-ready registers",
                  "Payment status workflow for unpaid, partial, paid, cancelled",
                  "A4, half-A4, and thermal print routes",
                  "Customer ledger and collection risk tracking",
                  "CSV export for accountants and operations teams",
                ].map((feature) => (
                  <div key={feature} className="rounded-2xl border border-white/10 bg-black/30 p-4">
                    {feature}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[36px] border border-white/10 bg-white/[0.035] p-7 backdrop-blur-2xl">
              <h3 className="text-2xl font-black">Launch Readiness</h3>
              <div className="mt-6 space-y-4">
                {[
                  ["Payment collection", analytics.collectionRate >= 70],
                  ["Tax ledger", analytics.tax > 0],
                  ["Customer mapping", customers.length > 0],
                  ["Invoice engine", analytics.invoiceCount > 0],
                ].map(([label, ready]) => (
                  <div key={String(label)} className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/30 px-4 py-4">
                    <span className="text-sm font-semibold text-white">{label}</span>
                    <span className={`rounded-full px-3 py-1 text-xs font-bold ${ready ? "bg-emerald-500/15 text-emerald-200" : "bg-amber-500/15 text-amber-200"}`}>
                      {ready ? "Ready" : "Needs data"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  )
}
