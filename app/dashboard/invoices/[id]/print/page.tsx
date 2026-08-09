"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams } from "next/navigation"
import { PrintEngine } from "@/components/print/PrintEngine"
import { loadStoredPrintSettings, readStoredPrintSettings } from "@/components/print/settings/defaults"
import type { PrintInvoice, PrintSettings } from "@/components/print/types"
import { resolveBusinessLogoUrl } from "@/lib/business-logo"
import { getCachedWorkspaceBootstrap, getOfflineData } from "@/lib/offline/db"
import { buildPrintInvoice, resolvePrintOrganization, stringFrom, type PrintRow } from "@/lib/print-invoice-builder"

type StoredPrintJob = {
  invoiceId: string
  format: PrintSettings["defaultFormat"]
  settings: PrintSettings
  terms: string[]
  createdAt: number
}

function readPrintRequest() {
  if (typeof window === "undefined") return { printOnly: false, jobId: "", job: null as StoredPrintJob | null }
  const query = new URLSearchParams(window.location.search)
  const printOnly = query.get("printOnly") === "1"
  const jobId = query.get("printJob") || ""
  if (!printOnly || !jobId) return { printOnly, jobId, job: null as StoredPrintJob | null }
  try {
    const raw = window.localStorage.getItem(`bezgrow.invoice-print-job.${jobId}`)
    const job = raw ? JSON.parse(raw) as StoredPrintJob : null
    if (!job || Date.now() - Number(job.createdAt || 0) > 10 * 60 * 1000) return { printOnly, jobId, job: null }
    return { printOnly, jobId, job }
  } catch {
    return { printOnly, jobId, job: null as StoredPrintJob | null }
  }
}

export default function PrintInvoicePage() {
  const params = useParams()
  const invoiceId = Array.isArray(params.id) ? params.id[0] : params.id
  const [invoice, setInvoice] = useState<PrintRow | null>(null)
  const [items, setItems] = useState<PrintRow[]>([])
  const [organization, setOrganization] = useState<PrintRow | null>(null)
  const [customer, setCustomer] = useState<PrintRow | null>(null)
  const [products, setProducts] = useState<PrintRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState("")
  const [printSettings, setPrintSettings] = useState<PrintSettings>(() => readStoredPrintSettings())
  const [printRequest] = useState(readPrintRequest)

  const loadOfflineInvoice = useCallback(async () => {
    if (!invoiceId) return false
    const cachedWorkspace = getCachedWorkspaceBootstrap()
    const organizationId = cachedWorkspace?.organization?.id || cachedWorkspace?.membership?.organization_id || ""
    if (!organizationId) return false

    const cachedInvoices = await getOfflineData<PrintRow[]>(organizationId, "invoices", [])
    const offlineInvoice = cachedInvoices.find((row) => stringFrom(row, ["id"]) === invoiceId)
    if (!offlineInvoice) return false

    const [cachedItems, cachedOrganization, cachedSettings, cachedCustomers, cachedProducts, storedPrintSettings] = await Promise.all([
      getOfflineData<PrintRow[]>(organizationId, "invoice_items", []),
      getOfflineData<PrintRow | null>(organizationId, "organization", null),
      getOfflineData<Record<string, unknown>>(organizationId, "settings", {}),
      getOfflineData<PrintRow[]>(organizationId, "customers", []),
      getOfflineData<PrintRow[]>(organizationId, "products", []),
      loadStoredPrintSettings(organizationId),
    ])
    const offlineItems = cachedItems.filter((row) => stringFrom(row, ["invoice_id"]) === invoiceId)
    const customerId = stringFrom(offlineInvoice, ["customer_id"])

    setInvoice(offlineInvoice)
    setItems(offlineItems)
    const resolvedOrganization = resolvePrintOrganization(
      cachedSettings.organization as Record<string, unknown> | null,
      cachedWorkspace?.organization as Record<string, unknown> | null,
      cachedOrganization
    )
    const logoUrl = await resolveBusinessLogoUrl(stringFrom(resolvedOrganization, ["logo_path"])).catch(() => "")
    setOrganization(resolvedOrganization ? { ...resolvedOrganization, logo_url: logoUrl } : null)
    setCustomer(
      cachedCustomers.find((row) => stringFrom(row, ["id"]) === customerId || stringFrom(row, ["offline_local_id"]) === customerId) || null
    )
    setProducts(cachedProducts)
    setPrintSettings(printRequest.job?.invoiceId === invoiceId ? printRequest.job.settings : storedPrintSettings)
    return true
  }, [invoiceId, printRequest.job])

  const fetchInvoice = useCallback(async () => {
    if (!invoiceId) {
      setLoading(false)
      return
    }

    if (await loadOfflineInvoice()) {
      setLoading(false)
      return true
    }

    setLoading(false)
    return false
  }, [invoiceId, loadOfflineInvoice])

  useEffect(() => {
    let active = true
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined
    queueMicrotask(() => {
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = globalThis.setTimeout(() => reject(new Error("The local invoice did not finish loading within 15 seconds.")), 15_000)
      })
      void Promise.race([fetchInvoice(), timeout])
        .catch((error) => {
          if (active) setLoadError(error instanceof Error ? error.message : "The local invoice could not be loaded.")
        })
        .finally(() => {
          if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId)
          if (active) setLoading(false)
        })
    })
    return () => {
      active = false
      if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId)
    }
  }, [fetchInvoice])

  const printInvoice = useMemo<PrintInvoice | null>(() => {
    if (!invoice) return null

    const origin = typeof window === "undefined" ? "https://www.bezgrow.com" : window.location.origin

    const built = buildPrintInvoice({ invoice, items, organization, customer, products, origin })
    if (printRequest.job?.invoiceId === built.id) {
      return { ...built, terms: printRequest.job.terms }
    }
    return built
  }, [customer, invoice, items, organization, printRequest.job, products])

  useEffect(() => {
    if (!printRequest.jobId) return
    const timeout = globalThis.setTimeout(() => {
      window.localStorage.removeItem(`bezgrow.invoice-print-job.${printRequest.jobId}`)
    }, 5 * 60 * 1000)
    return () => globalThis.clearTimeout(timeout)
  }, [printRequest.jobId])

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-black text-white">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-neutral-800 border-t-cyan-300" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-black px-5 text-white">
        <div className="max-w-lg rounded-3xl border border-red-400/25 bg-red-500/10 p-7 text-center">
          <h1 className="text-2xl font-black">Invoice print preview could not load.</h1>
          <p className="mt-3 text-sm leading-6 text-red-100">{loadError}</p>
          <button type="button" onClick={() => window.location.reload()} className="mt-5 min-h-12 rounded-2xl bg-white px-5 text-sm font-black text-black">Retry preview</button>
        </div>
      </div>
    )
  }

  if (!printInvoice) {
    return <div className="flex min-h-dvh items-center justify-center bg-black text-white">Invoice not found.</div>
  }

  return <PrintEngine invoice={printInvoice} initialSettings={printSettings} publicMode={printRequest.printOnly} />
}
