"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams } from "next/navigation"
import { PrintEngine } from "@/components/print/PrintEngine"
import { readStoredPrintSettings } from "@/components/print/settings/defaults"
import type { PrintInvoice } from "@/components/print/types"
import { getCachedWorkspaceBootstrap, getOfflineData } from "@/lib/offline/db"
import { buildPrintInvoice, stringFrom, type PrintRow } from "@/lib/print-invoice-builder"
import { supabase } from "@/lib/supabase"

export default function PrintInvoicePage() {
  const params = useParams()
  const invoiceId = Array.isArray(params.id) ? params.id[0] : params.id
  const [invoice, setInvoice] = useState<PrintRow | null>(null)
  const [items, setItems] = useState<PrintRow[]>([])
  const [organization, setOrganization] = useState<PrintRow | null>(null)
  const [customer, setCustomer] = useState<PrintRow | null>(null)
  const [products, setProducts] = useState<PrintRow[]>([])
  const [loading, setLoading] = useState(true)

  const loadOfflineInvoice = useCallback(async () => {
    if (!invoiceId) return false
    const cachedWorkspace = getCachedWorkspaceBootstrap()
    const organizationId = cachedWorkspace?.organization?.id || cachedWorkspace?.membership?.organization_id || ""
    if (!organizationId) return false

    const cachedInvoices = await getOfflineData<PrintRow[]>(organizationId, "invoices", [])
    const offlineInvoice = cachedInvoices.find((row) => stringFrom(row, ["id"]) === invoiceId)
    if (!offlineInvoice) return false

    const [cachedItems, cachedOrganization, cachedCustomers, cachedProducts] = await Promise.all([
      getOfflineData<PrintRow[]>(organizationId, "invoice_items", []),
      getOfflineData<PrintRow | null>(organizationId, "organization", null),
      getOfflineData<PrintRow[]>(organizationId, "customers", []),
      getOfflineData<PrintRow[]>(organizationId, "products", []),
    ])
    const offlineItems = cachedItems.filter((row) => stringFrom(row, ["invoice_id"]) === invoiceId)
    const customerId = stringFrom(offlineInvoice, ["customer_id"])

    setInvoice(offlineInvoice)
    setItems(offlineItems)
    setOrganization(cachedOrganization)
    setCustomer(
      cachedCustomers.find((row) => stringFrom(row, ["id"]) === customerId || stringFrom(row, ["offline_local_id"]) === customerId) || null
    )
    setProducts(cachedProducts)
    return true
  }, [invoiceId])

  const fetchInvoice = useCallback(async () => {
    if (!invoiceId) {
      setLoading(false)
      return
    }

    let typedInvoice: PrintRow | null = null
    try {
      const { data: invoiceData } = await supabase.from("invoices").select("*").eq("id", invoiceId).single()
      typedInvoice = invoiceData as PrintRow | null
    } catch {
      typedInvoice = null
    }

    if (!typedInvoice) {
      const loadedOffline = await loadOfflineInvoice()
      setLoading(false)
      return loadedOffline
    }
    setInvoice(typedInvoice)

    const [{ data: itemRows }, { data: organizationData }, { data: customerData }] = await Promise.all([
      supabase.from("invoice_items").select("*").eq("invoice_id", invoiceId),
      typedInvoice?.organization_id
        ? supabase.from("organizations").select("*").eq("id", typedInvoice.organization_id).single()
        : Promise.resolve({ data: null }),
      typedInvoice?.customer_id
        ? supabase.from("customers").select("*").eq("id", typedInvoice.customer_id).single()
        : Promise.resolve({ data: null }),
    ])
    const typedItems = (itemRows || []) as PrintRow[]
    setItems(typedItems)
    setOrganization(organizationData as PrintRow | null)
    setCustomer(customerData as PrintRow | null)

    const productIds = Array.from(new Set(typedItems.map((item) => stringFrom(item, ["product_id"])).filter(Boolean)))
    if (productIds.length) {
      const { data } = await supabase.from("products").select("*").in("id", productIds)
      setProducts((data || []) as PrintRow[])
    }

    setLoading(false)
    return true
  }, [invoiceId, loadOfflineInvoice])

  useEffect(() => {
    queueMicrotask(() => {
      void fetchInvoice()
    })
  }, [fetchInvoice])

  const printInvoice = useMemo<PrintInvoice | null>(() => {
    if (!invoice) return null

    const origin = typeof window === "undefined" ? "https://www.bezgrow.com" : window.location.origin

    return buildPrintInvoice({ invoice, items, organization, customer, products, origin })
  }, [customer, invoice, items, organization, products])

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-black text-white">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-neutral-800 border-t-cyan-300" />
      </div>
    )
  }

  if (!printInvoice) {
    return <div className="flex min-h-dvh items-center justify-center bg-black text-white">Invoice not found.</div>
  }

  return <PrintEngine invoice={printInvoice} initialSettings={readStoredPrintSettings()} />
}
