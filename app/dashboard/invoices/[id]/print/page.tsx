"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams } from "next/navigation"
import { PrintEngine } from "@/components/print/PrintEngine"
import { readStoredPrintSettings } from "@/components/print/settings/defaults"
import type { PrintInvoice } from "@/components/print/types"
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

  const fetchInvoice = useCallback(async () => {
    if (!invoiceId) {
      setLoading(false)
      return
    }

    const { data: invoiceData } = await supabase.from("invoices").select("*").eq("id", invoiceId).single()
    const typedInvoice = invoiceData as PrintRow | null
    setInvoice(typedInvoice)

    const { data: itemRows } = await supabase.from("invoice_items").select("*").eq("invoice_id", invoiceId)
    const typedItems = (itemRows || []) as PrintRow[]
    setItems(typedItems)

    if (typedInvoice?.organization_id) {
      const { data } = await supabase.from("organizations").select("*").eq("id", typedInvoice.organization_id).single()
      setOrganization(data as PrintRow | null)
    }

    if (typedInvoice?.customer_id) {
      const { data } = await supabase.from("customers").select("*").eq("id", typedInvoice.customer_id).single()
      setCustomer(data as PrintRow | null)
    }

    const productIds = Array.from(new Set(typedItems.map((item) => stringFrom(item, ["product_id"])).filter(Boolean)))
    if (productIds.length) {
      const { data } = await supabase.from("products").select("*").in("id", productIds)
      setProducts((data || []) as PrintRow[])
    }

    setLoading(false)
  }, [invoiceId])

  useEffect(() => {
    queueMicrotask(() => {
      void fetchInvoice()
    })
  }, [fetchInvoice])

  const printInvoice = useMemo<PrintInvoice | null>(() => {
    if (!invoice) return null

    const origin = typeof window === "undefined" ? "https://bezgrow.com" : window.location.origin

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
