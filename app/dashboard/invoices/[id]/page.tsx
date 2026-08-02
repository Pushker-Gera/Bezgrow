"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { getCachedWorkspaceBootstrap, getOfflineData } from "@/lib/offline/db"

type DataRow = Record<string, unknown> & {
  id: string
}

function stringFrom(row: Record<string, unknown> | null, fields: string[]) {
  if (!row) return ""
  for (const field of fields) {
    const value = row[field]
    if (typeof value === "string" && value.trim()) return value
  }
  return ""
}

function numberFrom(row: Record<string, unknown> | null, fields: string[]) {
  if (!row) return 0
  for (const field of fields) {
    const value = row[field]
    if (value !== null && value !== undefined && value !== "") return Number(value || 0)
  }
  return 0
}

function money(value: number) {
  return `Rs ${Math.round(value).toLocaleString("en-IN")}`
}

export default function InvoiceViewPage() {
  const params = useParams()
  const invoiceId = Array.isArray(params.id) ? params.id[0] : params.id
  const [invoice, setInvoice] = useState<DataRow | null>(null)
  const [customer, setCustomer] = useState<DataRow | null>(null)
  const [loading, setLoading] = useState(true)

  const loadOfflineInvoice = useCallback(async () => {
    if (!invoiceId) return false
    const cachedWorkspace = getCachedWorkspaceBootstrap()
    const organizationId = cachedWorkspace?.organization?.id || cachedWorkspace?.membership?.organization_id || ""
    if (!organizationId) return false

    const cachedInvoices = await getOfflineData<DataRow[]>(organizationId, "invoices", [])
    const offlineInvoice = cachedInvoices.find((row) => stringFrom(row, ["id"]) === invoiceId)
    if (!offlineInvoice) return false

    const cachedCustomers = await getOfflineData<DataRow[]>(organizationId, "customers", [])
    const customerId = stringFrom(offlineInvoice, ["customer_id"])

    setInvoice(offlineInvoice)
    setCustomer(
      cachedCustomers.find((row) => stringFrom(row, ["id"]) === customerId || stringFrom(row, ["offline_local_id"]) === customerId) || null
    )
    return true
  }, [invoiceId])

  const loadInvoice = useCallback(async () => {
    if (!invoiceId) {
      setLoading(false)
      return
    }

    if (await loadOfflineInvoice()) {
      setLoading(false)
      return
    }

    setLoading(false)
  }, [invoiceId, loadOfflineInvoice])

  useEffect(() => {
    queueMicrotask(() => {
      void loadInvoice()
    })
  }, [loadInvoice])

  const amount = numberFrom(invoice, ["grand_total", "total_amount", "total"])
  const customerName = stringFrom(customer, ["name"]) || stringFrom(invoice, ["customer_name"]) || "Walk-in customer"
  const invoiceNumber = stringFrom(invoice, ["invoice_number"]) || "Invoice"
  const printUrl = invoiceId ? `/dashboard/invoices/${invoiceId}/print` : "/dashboard/invoices"

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-black text-white">
        <div className="text-center">
          <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-neutral-800 border-t-cyan-300" />
          <p className="mt-5 text-lg font-semibold">Loading invoice details...</p>
        </div>
      </div>
    )
  }

  if (!invoice) {
    return <div className="flex min-h-dvh items-center justify-center bg-black text-white">Invoice not found.</div>
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-black px-5 py-10 text-white">
      <main className="w-full max-w-2xl rounded-[32px] border border-white/10 bg-white/[0.04] p-7">
        <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-200">Invoice Details</p>
        <h1 className="mt-3 text-4xl font-black">{invoiceNumber}</h1>
        <p className="mt-3 text-lg font-semibold text-white">{customerName}</p>
        <p className="mt-2 text-sm text-neutral-400">{money(amount)}</p>

        <div className="mt-7 grid gap-3 sm:grid-cols-3">
          <Link href="/dashboard/invoices" className="flex h-12 items-center justify-center rounded-2xl border border-white/10 font-bold">
            Back
          </Link>
          <Link href={printUrl} className="flex h-12 items-center justify-center rounded-2xl border border-cyan-400/25 bg-cyan-500/10 font-bold text-cyan-100">
            View / Print
          </Link>
          <Link href={`${printUrl}?share=whatsapp`} className="flex h-12 items-center justify-center rounded-2xl bg-white px-4 font-black text-black">
            Send on WhatsApp
          </Link>
        </div>
      </main>
    </div>
  )
}
