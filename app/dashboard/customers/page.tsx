"use client"

import { useEffect, useMemo, useState } from "react"
import { useDebounce } from "use-debounce"
import { getOrganizationId } from "@/lib/getOrganization"
import { createOfflineId, getOfflineData, putOfflineData, queueOfflineAction } from "@/lib/offline/db"
import { supabase } from "@/lib/supabase"

type Customer = {
  id: string
  name: string
  phone: string | null
  email: string | null
  address: string | null
  gst_number: string | null
  created_at: string
  updated_at?: string | null
  is_active: boolean
  organization_id: string
  total_sales: number | null
  last_purchase_at: string | null
  deleted_at: string | null
  customer_type: string | null
  sync_status?: string | null
  offline_local_id?: string | null
}

type InvoiceRow = Record<string, unknown>
type ListResponse<T> = {
  data?: T[]
  error?: string
}

type CustomerForm = {
  name: string
  phone: string
  email: string
  address: string
  gstNumber: string
  customerType: string
}

type CustomerSavePayload = {
  name: string
  phone: string | null
  email: string | null
  address: string | null
  gst_number: string | null
  customer_type: string
}

type CustomerWithLedger = Customer & {
  invoiceCount: number
  invoiceRevenue: number
  lastInvoiceAt: string | null
}

const emptyForm: CustomerForm = {
  name: "",
  phone: "",
  email: "",
  address: "",
  gstNumber: "",
  customerType: "retail",
}

function numberFrom(row: InvoiceRow, fields: string[]) {
  for (const field of fields) {
    const value = row[field]
    if (value !== null && value !== undefined && value !== "") {
      return Number(value || 0)
    }
  }

  return 0
}

function stringFrom(row: InvoiceRow, fields: string[]) {
  for (const field of fields) {
    const value = row[field]
    if (typeof value === "string" && value.trim()) return value
  }

  return ""
}

function money(value: number) {
  return `Rs ${Math.round(value).toLocaleString()}`
}

function csvCell(value: string | number | null) {
  const text = String(value ?? "")
  return `"${text.replaceAll("\"", "\"\"")}"`
}

function xmlCell(value: string | number | null | undefined) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")

  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function exportExcelWorkbook(rows: Array<Record<string, string | number | null>>, fileName: string) {
  const headers = Object.keys(rows[0])
  const worksheetRows = [
    headers.map((header) => `<Cell><Data ss:Type="String">${xmlCell(header)}</Data></Cell>`).join(""),
    ...rows.map((row) =>
      headers
        .map((header) => {
          const value = row[header]
          const isNumber = typeof value === "number" && Number.isFinite(value)
          return `<Cell><Data ss:Type="${isNumber ? "Number" : "String"}">${xmlCell(value)}</Data></Cell>`
        })
        .join("")
    ),
  ]
    .map((cells) => `<Row>${cells}</Row>`)
    .join("")
  const workbook = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Worksheet ss:Name="Customers">
    <Table>${worksheetRows}</Table>
  </Worksheet>
</Workbook>`

  downloadBlob(new Blob([workbook], { type: "application/vnd.ms-excel;charset=utf-8" }), `${fileName}.xls`)
}

function formatDate(value: string | null) {
  if (!value) return "-"
  return new Date(value).toLocaleDateString()
}

function formFromCustomer(customer: Customer): CustomerForm {
  return {
    name: customer.name || "",
    phone: customer.phone || "",
    email: customer.email || "",
    address: customer.address || "",
    gstNumber: customer.gst_number || "",
    customerType: customer.customer_type || "retail",
  }
}

export default function CustomersPage() {
  const [organizationId, setOrganizationId] = useState<string | null>(null)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")
  const [search, setSearch] = useState("")
  const [debouncedSearch] = useDebounce(search, 350)
  const [statusFilter, setStatusFilter] = useState("active")
  const [typeFilter, setTypeFilter] = useState("all")
  const [gstFilter, setGstFilter] = useState("all")
  const [currentPage, setCurrentPage] = useState(1)
  const [form, setForm] = useState<CustomerForm>(emptyForm)
  const [showFormModal, setShowFormModal] = useState(false)
  const [editCustomer, setEditCustomer] = useState<Customer | null>(null)
  const [detailCustomer, setDetailCustomer] = useState<CustomerWithLedger | null>(null)
  const [confirmCustomer, setConfirmCustomer] = useState<Customer | null>(null)
  const [exportType, setExportType] = useState<"csv" | "excel">("csv")

  const pageSize = 50

  async function initializeCustomers() {
    try {
      setLoading(true)
      const orgId = await getOrganizationId()

      if (!orgId) {
        setNotice("No organization is connected to this account.")
        return
      }

      setOrganizationId(orgId)
      await fetchData(orgId)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Customers failed to load.")
    } finally {
      setLoading(false)
    }
  }

  async function fetchData(orgId = organizationId) {
    if (!orgId) return

    const {
      data: { session },
    } = await supabase.auth.getSession()
    const headers = session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined
    const customerParams = new URLSearchParams({
      limit: "100",
      organization_id: orgId,
      search: debouncedSearch.trim(),
      sort: "created_at",
      direction: "desc",
    })
    const invoiceParams = new URLSearchParams({ limit: "100", organization_id: orgId })

    try {
      const [customersResponse, invoicesResponse] = await Promise.all([
        fetch(`/api/customers/list?${customerParams.toString()}`, { headers, cache: "no-store" }),
        fetch(`/api/invoices/list?${invoiceParams.toString()}`, { headers, cache: "no-store" }),
      ])

      const customersResult = (await customersResponse.json()) as ListResponse<Customer>
      const invoicesResult = (await invoicesResponse.json()) as ListResponse<InvoiceRow>

      if (!customersResponse.ok) throw new Error(customersResult.error || "Customers failed to load.")
      if (!invoicesResponse.ok) setNotice(invoicesResult.error || "Invoices failed to load.")

      let nextCustomers = customersResult.data || []
      await putOfflineData(orgId, "customers", nextCustomers)
      await putOfflineData(orgId, "invoices", invoicesResult.data || [])
      if (statusFilter === "active") nextCustomers = nextCustomers.filter((customer) => customer.is_active)
      if (statusFilter === "inactive") nextCustomers = nextCustomers.filter((customer) => !customer.is_active)
      setCustomers(nextCustomers)
      setInvoices(invoicesResult.data || [])
    } catch (error) {
      let cachedCustomers = await getOfflineData<Customer[]>(orgId, "customers", [])
      const cachedInvoices = await getOfflineData<InvoiceRow[]>(orgId, "invoices", [])
      if (statusFilter === "active") cachedCustomers = cachedCustomers.filter((customer) => customer.is_active)
      if (statusFilter === "inactive") cachedCustomers = cachedCustomers.filter((customer) => !customer.is_active)
      setCustomers(cachedCustomers)
      setInvoices(cachedInvoices)
      setNotice(
        navigator.onLine
          ? error instanceof Error ? error.message : "Customers failed to load."
          : "Offline mode: showing cached customers."
      )
    }
  }

  function updateForm<K extends keyof CustomerForm>(field: K, value: CustomerForm[K]) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  function openAddModal() {
    setEditCustomer(null)
    setForm(emptyForm)
    setShowFormModal(true)
  }

  function openEditModal(customer: Customer) {
    setEditCustomer(customer)
    setForm(formFromCustomer(customer))
    setShowFormModal(true)
  }

  async function saveCustomerOffline(payload: CustomerSavePayload) {
    if (!organizationId) return
    const now = new Date().toISOString()
    const localCustomerId = editCustomer?.id || createOfflineId("customer")
    const nextCustomer: Customer = {
      ...(editCustomer || {}),
      id: localCustomerId,
      name: payload.name,
      phone: payload.phone || null,
      email: payload.email || null,
      address: payload.address || null,
      gst_number: payload.gst_number,
      customer_type: payload.customer_type || "retail",
      organization_id: organizationId,
      is_active: editCustomer?.is_active ?? true,
      created_at: editCustomer?.created_at || now,
      updated_at: now,
      total_sales: editCustomer?.total_sales ?? 0,
      last_purchase_at: editCustomer?.last_purchase_at ?? null,
      deleted_at: editCustomer?.deleted_at ?? null,
      sync_status: editCustomer ? "pending_update" : "pending_create",
      offline_local_id: localCustomerId,
    }
    const cachedCustomers = await getOfflineData<Customer[]>(organizationId, "customers", [])
    const alreadyExists = cachedCustomers.some((customer) => customer.id === localCustomerId)
    const nextCustomers = alreadyExists
      ? cachedCustomers.map((customer) => (customer.id === localCustomerId ? nextCustomer : customer))
      : [nextCustomer, ...cachedCustomers]

    await putOfflineData(organizationId, "customers", nextCustomers)
    await queueOfflineAction({
      id: createOfflineId("customer-action"),
      type: "save_customer",
      organizationId,
      payload: {
        localCustomerId,
        customer: editCustomer && !editCustomer.id.startsWith("offline-") ? { id: editCustomer.id, ...payload } : payload,
      },
    })

    setCustomers(nextCustomers)
    setShowFormModal(false)
    setEditCustomer(null)
    setForm(emptyForm)
    setNotice("Customer saved offline. Pending sync.")
  }

  async function saveCustomer() {
    if (!organizationId) return
    if (!form.name.trim()) {
      setNotice("Customer name is required.")
      return
    }

    setSaving(true)
    setNotice("")

    const payload = {
      name: form.name.trim(),
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      address: form.address.trim() || null,
      gst_number: form.gstNumber.trim() || null,
      customer_type: form.customerType || "retail",
    }

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const response = await fetch("/api/customers/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          id: editCustomer?.id,
          ...payload,
        }),
      })
      const result = (await response.json()) as { error?: string }

      if (!response.ok) {
        setNotice(result.error || "Customer could not be saved.")
        setSaving(false)
        return
      }
    } catch (error) {
      if (navigator.onLine) {
        setNotice(error instanceof Error ? error.message : "Customer could not be saved.")
        setSaving(false)
        return
      }

      await saveCustomerOffline(payload)
      setSaving(false)
      return
    }

    setShowFormModal(false)
    setEditCustomer(null)
    setForm(emptyForm)
    await fetchData()
    setNotice(editCustomer ? "Customer updated successfully." : "Customer created successfully.")
    setSaving(false)
  }

  async function toggleCustomerStatus(customer: Customer, active: boolean) {
    if (!organizationId) return

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const response = await fetch("/api/customers/status", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ id: customer.id, active }),
      })
      const result = (await response.json()) as { error?: string }

      if (!response.ok) {
        setNotice(result.error || "Customer status could not be updated.")
        return
      }
    } catch (error) {
      if (navigator.onLine) {
        setNotice(error instanceof Error ? error.message : "Customer status could not be updated.")
        return
      }

      await saveCustomerStatusOffline(customer, { active })
      return
    }

    await fetchData()
    setNotice(active ? "Customer activated." : "Customer deactivated.")
  }

  async function saveCustomerStatusOffline(customer: Customer, status: { active?: boolean; archive?: boolean }) {
    if (!organizationId) return

    const now = new Date().toISOString()
    const cachedCustomers = await getOfflineData<Customer[]>(organizationId, "customers", [])
    const nextCustomers = cachedCustomers.map((cachedCustomer) =>
      cachedCustomer.id === customer.id
        ? {
            ...cachedCustomer,
            is_active: status.archive ? false : status.active ?? cachedCustomer.is_active,
            deleted_at: status.archive ? now : null,
            sync_status: "pending_update",
            updated_at: now,
          }
        : cachedCustomer
    )

    await putOfflineData(organizationId, "customers", nextCustomers)
    await queueOfflineAction({
      id: createOfflineId("customer-status"),
      type: "customer_status",
      organizationId,
      payload: {
        customerId: customer.id,
        status: {
          id: customer.id.startsWith("offline-") ? undefined : customer.id,
          ...status,
        },
      },
    })

    const visibleCustomers = nextCustomers.filter((cachedCustomer) => {
      if (statusFilter === "active") return cachedCustomer.is_active && !cachedCustomer.deleted_at
      if (statusFilter === "inactive") return !cachedCustomer.is_active && !cachedCustomer.deleted_at
      return !cachedCustomer.deleted_at
    })
    setCustomers(visibleCustomers)
    setConfirmCustomer(null)
    setNotice(status.archive ? "Customer archived offline. Pending sync." : "Customer status saved offline. Pending sync.")
  }

  async function archiveCustomer() {
    if (!confirmCustomer || !organizationId) return

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const response = await fetch("/api/customers/status", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ id: confirmCustomer.id, archive: true }),
      })
      const result = (await response.json()) as { error?: string }

      if (!response.ok) {
        setNotice(result.error || "Customer could not be archived.")
        return
      }
    } catch (error) {
      if (navigator.onLine) {
        setNotice(error instanceof Error ? error.message : "Customer could not be archived.")
        return
      }

      await saveCustomerStatusOffline(confirmCustomer, { archive: true })
      return
    }

    setConfirmCustomer(null)
    await fetchData()
    setNotice("Customer archived.")
  }

  useEffect(() => {
    initializeCustomers()
    // CRM bootstrap intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!organizationId) return
    setCurrentPage(1)
    fetchData()
    // Refresh follows filters and debounced search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, statusFilter, organizationId])

  const customersWithLedger = useMemo<CustomerWithLedger[]>(() => {
    return customers.map((customer) => {
      const customerInvoices = invoices.filter((invoice) => {
        const customerId = stringFrom(invoice, ["customer_id"])
        return customerId === customer.id
      })
      const invoiceRevenue = customerInvoices.reduce(
        (sum, invoice) => sum + numberFrom(invoice, ["grand_total", "total_amount", "total"]),
        0
      )
      const latestInvoice = customerInvoices[0]
      const totalSales = invoiceRevenue || Number(customer.total_sales || 0)

      return {
        ...customer,
        total_sales: totalSales,
        invoiceCount: customerInvoices.length,
        invoiceRevenue: totalSales,
        lastInvoiceAt: stringFrom(latestInvoice || {}, ["created_at"]) || customer.last_purchase_at,
      }
    })
  }, [customers, invoices])

  const customerTypes = useMemo(
    () =>
      Array.from(
        new Set(customersWithLedger.map((customer) => customer.customer_type || "retail"))
      ),
    [customersWithLedger]
  )

  const filteredCustomers = useMemo(() => {
    return customersWithLedger.filter((customer) => {
      if (typeFilter !== "all" && (customer.customer_type || "retail") !== typeFilter) return false
      if (gstFilter === "gst" && !customer.gst_number) return false
      if (gstFilter === "nonGst" && customer.gst_number) return false
      return true
    })
  }, [customersWithLedger, gstFilter, typeFilter])

  const paginatedCustomers = filteredCustomers.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  )
  const totalPages = Math.max(1, Math.ceil(filteredCustomers.length / pageSize))

  const metrics = useMemo(() => {
    const totalCustomers = customersWithLedger.length
    const activeCustomers = customersWithLedger.filter((customer) => customer.is_active).length
    const gstCustomers = customersWithLedger.filter((customer) => customer.gst_number).length
    const totalRevenue = customersWithLedger.reduce(
      (sum, customer) => sum + customer.invoiceRevenue,
      0
    )
    const averageRevenue = totalCustomers > 0 ? totalRevenue / totalCustomers : 0
    const repeatCustomers = customersWithLedger.filter((customer) => customer.invoiceCount > 1).length

    return {
      totalCustomers,
      activeCustomers,
      inactiveCustomers: totalCustomers - activeCustomers,
      gstCustomers,
      totalRevenue,
      averageRevenue,
      repeatCustomers,
    }
  }, [customersWithLedger])

  function exportCustomers() {
    if (filteredCustomers.length === 0) {
      setNotice("No customers available to export.")
      return
    }

    const rows = filteredCustomers.map((customer) => ({
      Name: customer.name,
      Phone: customer.phone || "",
      Email: customer.email || "",
      Address: customer.address || "",
      GST: customer.gst_number || "",
      Type: customer.customer_type || "retail",
      Status: customer.is_active ? "Active" : "Inactive",
      Revenue: customer.invoiceRevenue,
      Invoices: customer.invoiceCount,
      "Last Purchase": customer.lastInvoiceAt || "",
      "Created At": customer.created_at,
    }))
    const fileName = `customers-export-${new Date().toISOString()}`

    if (exportType === "excel") {
      exportExcelWorkbook(rows, fileName)
      return
    }

    const headers = Object.keys(rows[0])
    const csv = [
      headers.map(csvCell).join(","),
      ...rows.map((row) =>
        headers.map((header) => csvCell(String(row[header as keyof typeof row] ?? ""))).join(",")
      ),
    ].join("\n")
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8;" }), `${fileName}.csv`)
  }

  return (
    <div className="inventory-grid-bg min-h-full overflow-x-hidden text-white">
      <div className="mx-auto max-w-[1900px] space-y-6 px-3 py-4 sm:px-5 lg:px-6">
        <section className="relative overflow-hidden rounded-lg border border-white/10 bg-black/70 p-6 shadow-2xl backdrop-blur-xl inventory-sheen lg:p-8">
          <div className="relative z-10 grid gap-8 2xl:grid-cols-[1.1fr_0.9fr] 2xl:items-end">
            <div>
              <div className="flex flex-wrap gap-3">
                <span className="rounded-full border border-sky-400/25 bg-sky-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-sky-200">
                  Global CRM Ledger
                </span>
                <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-200">
                  Billing-Linked Customers
                </span>
              </div>
              <h1 className="mt-5 max-w-5xl text-4xl font-black tracking-tight md:text-6xl">
                Customers
              </h1>
              <p className="mt-4 max-w-4xl text-base leading-7 text-neutral-300">
                Professional CRM for retail, wholesale, GST customers, recurring buyers,
                billing history, account health, and globally scalable customer operations.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              {[
                [`${metrics.activeCustomers}`, "active accounts"],
                [money(metrics.totalRevenue), "customer revenue"],
                [`${metrics.repeatCustomers}`, "repeat buyers"],
              ].map(([value, label]) => (
                <div key={label} className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
                  <p className="text-2xl font-black">{value}</p>
                  <p className="mt-2 text-xs uppercase tracking-[0.16em] text-neutral-500">
                    {label}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="relative z-10 mt-7 grid gap-4 border-t border-white/10 pt-5 2xl:grid-cols-[1fr_auto] 2xl:items-center">
            <div className="grid gap-3 lg:grid-cols-[minmax(360px,1.5fr)_minmax(190px,0.8fr)_minmax(190px,0.8fr)_minmax(190px,0.8fr)]">
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search customer, phone, email, GST"
                className="h-14 min-w-0 rounded-lg border border-white/10 bg-black/60 px-5 text-base outline-none transition-all placeholder:text-neutral-500 focus:border-sky-300/60"
              />
              <SelectShell>
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  className="h-14 w-full appearance-none rounded-lg border border-white/10 bg-black/60 py-0 pl-5 pr-16 text-base outline-none focus:border-sky-300/60"
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                  <option value="all">All status</option>
                </select>
              </SelectShell>
              <SelectShell>
                <select
                  value={typeFilter}
                  onChange={(event) => setTypeFilter(event.target.value)}
                  className="h-14 w-full appearance-none rounded-lg border border-white/10 bg-black/60 py-0 pl-5 pr-16 text-base outline-none focus:border-sky-300/60"
                >
                  <option value="all">All types</option>
                  {customerTypes.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </SelectShell>
              <SelectShell>
                <select
                  value={gstFilter}
                  onChange={(event) => setGstFilter(event.target.value)}
                  className="h-14 w-full appearance-none rounded-lg border border-white/10 bg-black/60 py-0 pl-5 pr-16 text-base outline-none focus:border-sky-300/60"
                >
                  <option value="all">GST status</option>
                  <option value="gst">GST only</option>
                  <option value="nonGst">Non-GST</option>
                </select>
              </SelectShell>
            </div>

            <div className="grid gap-3 sm:grid-cols-3 2xl:flex">
              <button
                onClick={openAddModal}
                className="h-14 min-w-[170px] rounded-lg bg-gradient-to-r from-sky-300 to-emerald-300 px-6 text-base font-black text-black shadow-xl shadow-sky-500/20 transition-all hover:-translate-y-1"
              >
                Add Customer
              </button>
              <button
                onClick={exportCustomers}
                className="h-14 min-w-[150px] rounded-lg border border-white/10 bg-white/[0.05] px-5 text-base font-bold transition-all hover:-translate-y-1 hover:border-emerald-300/40"
              >
                Export
              </button>
              <SelectShell>
                <select
                  value={exportType}
                  onChange={(event) => setExportType(event.target.value as "csv" | "excel")}
                  className="h-14 w-full appearance-none rounded-lg border border-white/10 bg-black/60 py-0 pl-5 pr-16 text-base outline-none"
                >
                  <option value="csv">CSV</option>
                  <option value="excel">Excel</option>
                </select>
              </SelectShell>
            </div>
          </div>

          {notice && (
            <div className="relative z-10 mt-5 rounded-lg border border-sky-400/20 bg-sky-400/10 px-4 py-3 text-sm text-sky-100">
              {notice}
            </div>
          )}
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-6">
          {[
            ["Total Customers", metrics.totalCustomers, "text-white"],
            ["Active", metrics.activeCustomers, "text-emerald-200"],
            ["Inactive", metrics.inactiveCustomers, "text-red-200"],
            ["GST Customers", metrics.gstCustomers, "text-sky-200"],
            ["Revenue", money(metrics.totalRevenue), "text-emerald-200"],
            ["Avg Value", money(metrics.averageRevenue), "text-amber-200"],
          ].map(([label, value, color]) => (
            <div key={label} className="rounded-lg border border-white/10 bg-black/70 p-5 shadow-xl">
              <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">{label}</p>
              <p className={`mt-4 text-3xl font-black ${color}`}>{value}</p>
            </div>
          ))}
        </section>

        <section className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-white/10 pb-4">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-sky-300">Customer Ledger</p>
              <h2 className="mt-2 text-2xl font-black">CRM Accounts</h2>
            </div>
            <p className="text-sm text-neutral-500">
              {filteredCustomers.length} visible accounts
            </p>
          </div>

          {loading ? (
            <div className="flex justify-center py-16">
              <div className="h-10 w-10 rounded-full border-2 border-neutral-700 border-t-white animate-spin" />
            </div>
          ) : (
            <>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[1040px] border-separate border-spacing-y-2 text-sm">
                  <thead className="text-left text-xs uppercase tracking-[0.16em] text-neutral-500">
                    <tr>
                      <th className="px-3 py-2">Customer</th>
                      <th className="px-3 py-2">Contact</th>
                      <th className="px-3 py-2">GST</th>
                      <th className="px-3 py-2">Revenue</th>
                      <th className="px-3 py-2">Last Purchase</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedCustomers.length === 0 && (
                      <tr>
                        <td colSpan={7} className="rounded-lg border border-white/10 bg-white/[0.03] py-14 text-center text-neutral-500">
                          No customers found for the selected filters.
                        </td>
                      </tr>
                    )}
                    {paginatedCustomers.map((customer) => (
                      <tr key={customer.id} className="bg-white/[0.035] transition-all hover:bg-white/[0.065]">
                        <td className="rounded-l-lg px-3 py-4">
                          <p className="font-semibold">{customer.name}</p>
                          <p className="mt-1 text-xs capitalize text-neutral-500">
                            {customer.customer_type || "retail"}
                          </p>
                        </td>
                        <td className="px-3 py-4">
                          <p>{customer.phone || "-"}</p>
                          <p className="mt-1 text-xs text-neutral-500">{customer.email || "-"}</p>
                        </td>
                        <td className="px-3 py-4">
                          {customer.gst_number ? (
                            <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-bold text-emerald-200">
                              {customer.gst_number}
                            </span>
                          ) : (
                            <span className="text-neutral-500">Non-GST</span>
                          )}
                        </td>
                        <td className="px-3 py-4">
                          <p className="font-black text-emerald-200">{money(customer.invoiceRevenue)}</p>
                          <p className="mt-1 text-xs text-neutral-500">{customer.invoiceCount} invoices</p>
                        </td>
                        <td className="px-3 py-4 text-neutral-300">{formatDate(customer.lastInvoiceAt)}</td>
                        <td className="px-3 py-4">
                          <span className={`rounded-full border px-3 py-1 text-xs font-bold ${customer.is_active ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200" : "border-red-400/20 bg-red-400/10 text-red-200"}`}>
                            {customer.is_active ? "Active" : "Inactive"}
                          </span>
                        </td>
                        <td className="rounded-r-lg px-3 py-4 text-right">
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => setDetailCustomer(customer)}
                              className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-semibold hover:bg-white/[0.08]"
                            >
                              View
                            </button>
                            <button
                              onClick={() => openEditModal(customer)}
                              className="rounded-lg border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-xs font-semibold text-sky-200"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() =>
                                customer.is_active
                                  ? toggleCustomerStatus(customer, false)
                                  : toggleCustomerStatus(customer, true)
                              }
                              className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-200"
                            >
                              {customer.is_active ? "Deactivate" : "Activate"}
                            </button>
                            <button
                              onClick={() => setConfirmCustomer(customer)}
                              className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs font-semibold text-red-200"
                            >
                              Archive
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-5 flex items-center justify-between border-t border-white/10 pt-4">
                <button
                  disabled={currentPage === 1}
                  onClick={() => setCurrentPage((page) => Math.max(page - 1, 1))}
                  className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-sm disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="text-sm text-neutral-400">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  disabled={currentPage === totalPages}
                  onClick={() => setCurrentPage((page) => Math.min(page + 1, totalPages))}
                  className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-sm disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      {showFormModal && (
        <CustomerFormModal
          form={form}
          editMode={Boolean(editCustomer)}
          saving={saving}
          onChange={updateForm}
          onClose={() => {
            setShowFormModal(false)
            setEditCustomer(null)
            setForm(emptyForm)
          }}
          onSave={saveCustomer}
        />
      )}

      {detailCustomer && (
        <CustomerDetailModal
          customer={detailCustomer}
          onClose={() => setDetailCustomer(null)}
        />
      )}

      {confirmCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-lg border border-white/10 bg-[#050606] p-6 shadow-2xl">
            <h2 className="text-xl font-black text-red-200">Archive Customer</h2>
            <p className="mt-3 text-sm leading-6 text-neutral-400">
              Archive {confirmCustomer.name}? They will be removed from active CRM workflows.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setConfirmCustomer(null)}
                className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={archiveCustomer}
                className="rounded-lg bg-red-500 px-4 py-2 text-sm font-bold text-white hover:bg-red-400"
              >
                Archive
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SelectShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-w-0">
      {children}
      <span className="pointer-events-none absolute right-6 top-1/2 h-3 w-3 -translate-y-1/2 rotate-45 border-b-2 border-r-2 border-white" />
    </div>
  )
}

function CustomerFormModal({
  form,
  editMode,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  form: CustomerForm
  editMode: boolean
  saving: boolean
  onChange: <K extends keyof CustomerForm>(field: K, value: CustomerForm[K]) => void
  onClose: () => void
  onSave: () => void
}) {
  const inputClass =
    "w-full rounded-lg border border-white/10 bg-black px-4 py-3 text-sm outline-none transition-all focus:border-sky-300"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
      <div className="w-full max-w-3xl overflow-hidden rounded-lg border border-white/10 bg-[#050606] shadow-2xl inventory-sheen">
        <div className="sticky top-0 z-30 flex items-center justify-between border-b border-white/10 bg-[#050606]/95 p-5 backdrop-blur-xl">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-sky-300">CRM Account</p>
            <h2 className="mt-2 text-2xl font-black">
              {editMode ? "Edit Customer" : "Add Customer"}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-white/10 bg-white/[0.06] px-5 py-3 text-sm font-bold text-neutral-100"
          >
            Back
          </button>
        </div>

        <div className="grid gap-4 p-5 md:grid-cols-2">
          <input className={inputClass} placeholder="Customer name" value={form.name} onChange={(event) => onChange("name", event.target.value)} />
          <input className={inputClass} placeholder="Phone" value={form.phone} onChange={(event) => onChange("phone", event.target.value)} />
          <input className={inputClass} placeholder="Email" value={form.email} onChange={(event) => onChange("email", event.target.value)} />
          <input className={inputClass} placeholder="GST number" value={form.gstNumber} onChange={(event) => onChange("gstNumber", event.target.value)} />
          <SelectShell>
            <select
              value={form.customerType}
              onChange={(event) => onChange("customerType", event.target.value)}
              className="w-full appearance-none rounded-lg border border-white/10 bg-black py-3 pl-4 pr-14 text-sm outline-none transition-all focus:border-sky-300"
            >
              <option value="retail">Retail</option>
              <option value="wholesale">Wholesale</option>
              <option value="enterprise">Enterprise</option>
              <option value="distributor">Distributor</option>
            </select>
          </SelectShell>
          <textarea className={`${inputClass} min-h-28 md:col-span-2`} placeholder="Billing address" value={form.address} onChange={(event) => onChange("address", event.target.value)} />
        </div>

        <div className="mx-5 rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">
          Customer records connect to billing, GST classification, account status,
          purchase history, and global CRM analytics.
        </div>

        <div className="border-t border-white/10 bg-[#050606]/95 p-5">
          <button
            disabled={saving}
            onClick={onSave}
            className="w-full rounded-lg bg-gradient-to-r from-sky-300 to-emerald-300 px-5 py-4 font-black text-black disabled:opacity-60"
          >
            {saving ? "Saving..." : editMode ? "Save Customer" : "Create Customer"}
          </button>
        </div>
      </div>
    </div>
  )
}

function CustomerDetailModal({
  customer,
  onClose,
}: {
  customer: CustomerWithLedger
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/75 backdrop-blur-sm">
      <div className="h-full w-full max-w-2xl overflow-y-auto border-l border-white/10 bg-[#050606] shadow-2xl">
        <div className="sticky top-0 z-30 flex items-start justify-between border-b border-white/10 bg-[#050606]/95 p-5 backdrop-blur-xl">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-sky-300">Customer Profile</p>
            <h2 className="mt-2 text-3xl font-black">{customer.name}</h2>
            <p className="mt-1 text-sm text-neutral-500 capitalize">
              {customer.customer_type || "retail"} account
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-white/10 bg-white/[0.06] px-5 py-3 text-sm font-bold"
          >
            Back
          </button>
        </div>

        <div className="grid gap-4 p-5 sm:grid-cols-2">
          {[
            ["Revenue", money(customer.invoiceRevenue)],
            ["Invoices", customer.invoiceCount],
            ["Last Purchase", formatDate(customer.lastInvoiceAt)],
            ["Status", customer.is_active ? "Active" : "Inactive"],
            ["Phone", customer.phone || "-"],
            ["Email", customer.email || "-"],
            ["GST", customer.gst_number || "Non-GST"],
            ["Created", formatDate(customer.created_at)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-neutral-500">{label}</p>
              <p className="mt-2 font-semibold text-neutral-100">{value}</p>
            </div>
          ))}
          <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4 sm:col-span-2">
            <p className="text-xs uppercase tracking-[0.14em] text-neutral-500">Address</p>
            <p className="mt-2 leading-6 text-neutral-100">{customer.address || "-"}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
