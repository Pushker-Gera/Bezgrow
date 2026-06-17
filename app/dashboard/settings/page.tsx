"use client"

import { useEffect, useMemo, useState } from "react"
import { useDebounce } from "use-debounce"
import { readStoredPrintSettings, saveStoredPrintSettings } from "@/components/print/settings/defaults"
import type { PrintFormat, PrintSettings } from "@/components/print/types"
import { getOrganizationId } from "@/lib/getOrganization"
import { supabase } from "@/lib/supabase"

type Organization = Record<string, unknown> & {
  id: string
  name?: string | null
  industry?: string | null
  currency?: string | null
  business_type?: string | null
  business_category?: string | null
  gst_number?: string | null
  phone?: string | null
  email?: string | null
  fssai?: string | null
  website?: string | null
  address?: string | null
  branch_name?: string | null
}

type FeatureRow = {
  id?: string
  organization_id: string
  feature_key: string
  is_enabled: boolean
}

type InvoiceCorrectionRow = Record<string, unknown> & {
  id: string
  invoice_number?: string | null
  customer_name?: string | null
  created_at?: string | null
}

type ListResponse<T> = { data?: T[]; error?: string }
type WorkspaceResponse = {
  organization?: Organization
  features?: FeatureRow[] | string[]
  error?: string
}

const featureCatalog = [
  ["pos_billing", "POS Billing", "Fast counter billing for retail stores, malls, and walk-in checkout teams."],
  ["quick_checkout", "Quick Checkout", "Speed-focused billing flows for counters with high daily invoice volume."],
  ["gst_b2b", "GST B2B Billing", "Business invoices, buyer tax IDs, GST-ready line items, and tax visibility."],
  ["batch_tracking", "Batch Tracking", "Track lots, expiry, manufacturing, and procurement batches."],
  ["expiry_tracking", "Expiry Tracking", "Alerts for pharmacy, grocery, cosmetics, and perishable inventory."],
  ["barcode_scanning", "Barcode Scanning", "Enable SKU/barcode workflows for retail and warehouse teams."],
  ["thermal_printing", "Thermal Printing", "POS receipt layout support for counters, malls, and small format printers."],
  ["purchase_orders", "Purchase Orders", "Supplier purchasing, procurement controls, and incoming inventory planning."],
  ["warehouse_transfers", "Warehouse Transfers", "Move stock across branches, stores, warehouses, and fulfillment locations."],
  ["bulk_inventory", "Bulk Inventory", "High-volume stock operations for distributors and wholesale teams."],
  ["shipping_labels", "Shipping Labels", "Courier metadata, tracking numbers, and parcel-ready operations."],
  ["awb_tracking", "AWB Tracking", "Airway bill and courier reference tracking for shipped orders."],
  ["parcel_qr", "Parcel QR", "Parcel QR codes for packing, dispatch, and delivery handoff workflows."],
  ["bulk_pricing", "Wholesale Billing", "Wholesale invoices, bulk pricing, and B2B billing flows."],
  ["size_variants", "Variants", "Size, color, and variant-ready inventory structures."],
  ["color_variants", "Color Variants", "Color-level product variants for apparel, cosmetics, and catalog-heavy inventory."],
  ["serial_numbers", "Serial Numbers", "Device, electronics, warranty, and serialized stock control."],
  ["warranty_tracking", "Warranty Tracking", "Capture warranty-ready sales and service workflows."],
  ["prescription_required", "Prescription Required", "Medicine sale controls for prescription-only products."],
  ["prescription_upload", "Prescription Upload", "Attach prescription evidence to pharmacy customer billing."],
  ["kot_printing", "KOT Printing", "Kitchen order ticket workflows for restaurant and cafe operations."],
  ["table_management", "Table Management", "Table-aware order and billing workflows for dine-in businesses."],
  ["raw_materials", "Raw Materials", "Track input stock used for manufacturing, food, or assembled products."],
  ["recipe_tracking", "Recipe Tracking", "Connect recipes or bills of materials to stock consumption."],
  ["production_batches", "Production Batches", "Batch manufactured goods with cost, quantity, and traceability."],
  ["quotation_system", "Quotation System", "Create quotations before converting them into invoices."],
  ["service_invoices", "Service Invoices", "Service-led billing for consultants, repairs, agencies, and support teams."],
  ["weight_inventory", "Weight Inventory", "Weight-based stock for grocery, jewellery, loose goods, and bulk products."],
  ["weight_tracking", "Weight Tracking", "Track sold and remaining quantity by weight units."],
  ["purity_tracking", "Purity Tracking", "Jewellery purity and material-grade tracking for high-value inventory."],
]

function valueText(value: unknown) {
  return typeof value === "string" ? value : ""
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

function formatDate(value: string | null | undefined) {
  if (!value) return "-"
  return new Date(value).toLocaleDateString()
}

function money(value: number) {
  return `Rs ${Math.round(value).toLocaleString()}`
}

function normalizeFeatures(features: WorkspaceResponse["features"], organizationId: string) {
  if (!Array.isArray(features)) return []

  return features.map((feature) => {
    if (typeof feature === "string") {
      return {
        organization_id: organizationId,
        feature_key: feature,
        is_enabled: true,
      }
    }

    return feature
  })
}

export default function SettingsPage() {
  const [organizationId, setOrganizationId] = useState("")
  const [organization, setOrganization] = useState<Organization | null>(null)
  const [features, setFeatures] = useState<FeatureRow[]>([])
  const [recentInvoices, setRecentInvoices] = useState<InvoiceCorrectionRow[]>([])
  const [invoiceSearch, setInvoiceSearch] = useState("")
  const [debouncedInvoiceSearch] = useDebounce(invoiceSearch, 300)
  const [deletingInvoiceId, setDeletingInvoiceId] = useState("")
  const [deleteConfirmText, setDeleteConfirmText] = useState("")
  const [printSettings, setPrintSettings] = useState<PrintSettings>(() => readStoredPrintSettings())
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")
  const [form, setForm] = useState({
    name: "",
    industry: "",
    currency: "INR",
    businessType: "retail",
    businessCategory: "general",
    gstNumber: "",
    phone: "",
    email: "",
    fssai: "",
    website: "",
    address: "",
    branchName: "Main Branch",
  })

  async function loadCorrectionInvoices(orgId: string, searchTerm = "") {
    const {
      data: { session },
    } = await supabase.auth.getSession()
    const headers = session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined
    const invoiceParams = new URLSearchParams({ limit: "100", organization_id: orgId })

    if (searchTerm.trim()) invoiceParams.set("search", searchTerm.trim())

    const invoiceResponse = await fetch(`/api/invoices/list?${invoiceParams.toString()}`, {
      headers,
      cache: "no-store",
    })
    const invoices = (await invoiceResponse.json()) as ListResponse<InvoiceCorrectionRow>

    if (!invoiceResponse.ok) {
      setNotice(invoices.error || `Invoices failed to load. HTTP ${invoiceResponse.status}`)
      setRecentInvoices([])
      return
    }

    setRecentInvoices(invoices.data || [])
  }

  async function initializeSettings() {
    const orgId = await getOrganizationId()
    if (!orgId) {
      setNotice("No organization is connected to this account.")
      return
    }

    setOrganizationId(orgId)
    const {
      data: { session },
    } = await supabase.auth.getSession()
    const headers = session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined
    const [workspaceResponse, invoiceResponse] = await Promise.all([
      fetch("/api/workspace/bootstrap", { headers, cache: "no-store" }),
      fetch(`/api/invoices/list?${new URLSearchParams({ limit: "100", organization_id: orgId }).toString()}`, { headers, cache: "no-store" }),
    ])
    const workspace = (await workspaceResponse.json()) as WorkspaceResponse
    const invoices = (await invoiceResponse.json()) as ListResponse<InvoiceCorrectionRow>

    if (!workspaceResponse.ok) setNotice(workspace.error || "Workspace settings failed to load.")
    if (!invoiceResponse.ok) setNotice(invoices.error || `Invoices failed to load. HTTP ${invoiceResponse.status}`)

    if (workspace.organization) {
      const org = workspace.organization
      setOrganization(org)
      setForm({
        name: valueText(org.name || org.business_name),
        industry: valueText(org.industry),
        currency: valueText(org.currency) || "INR",
        businessType: valueText(org.business_type) || "retail",
        businessCategory: valueText(org.business_category) || "general",
        gstNumber: valueText(org.gst_number),
        phone: valueText(org.phone),
        email: valueText(org.email),
        fssai: valueText(org.fssai),
        website: valueText(org.website),
        address: valueText(org.address),
        branchName: valueText(org.branch_name) || "Main Branch",
      })
    }
    setFeatures(normalizeFeatures(workspace.features, orgId))
    setRecentInvoices(invoices.data || [])
  }

  useEffect(() => {
    queueMicrotask(() => {
      void initializeSettings()
    })
  }, [])

  useEffect(() => {
    if (!organizationId) return
    queueMicrotask(() => {
      void loadCorrectionInvoices(organizationId, debouncedInvoiceSearch)
    })
  }, [debouncedInvoiceSearch, organizationId])

  function updatePrintSettings(next: Partial<PrintSettings>) {
    const updated = { ...printSettings, ...next }
    setPrintSettings(updated)
    saveStoredPrintSettings(updated)
  }

  const enabledFeatureSet = useMemo(() => {
    return new Set(features.filter((feature) => feature.is_enabled).map((feature) => feature.feature_key))
  }, [features])

  const readiness = useMemo(() => {
    return [
      ["Business profile", Boolean(form.name.trim() && form.industry.trim())],
      ["Currency configured", Boolean(form.currency)],
      ["Industry features", enabledFeatureSet.size >= 3],
      ["Billing ready", enabledFeatureSet.has("pos_billing") || enabledFeatureSet.has("bulk_pricing") || enabledFeatureSet.has("shipping_labels")],
      ["Inventory controls", enabledFeatureSet.has("batch_tracking") || enabledFeatureSet.has("barcode_scanning")],
    ]
  }, [enabledFeatureSet, form.currency, form.industry, form.name])

  const filteredCorrectionInvoices = useMemo(() => {
    const term = invoiceSearch.trim().toLowerCase()
    if (!term) return recentInvoices

    return recentInvoices.filter((invoice) =>
      [
        invoice.id,
        stringFrom(invoice, ["invoice_number"]),
        stringFrom(invoice, ["customer_name"]),
        formatDate(invoice.created_at),
      ]
        .join(" ")
        .toLowerCase()
        .includes(term)
    )
  }, [invoiceSearch, recentInvoices])

  async function saveOrganization() {
    if (!organizationId) return
    if (!form.name.trim()) {
      setNotice("Business name is required.")
      return
    }

    setSaving(true)
    const {
      data: { session },
    } = await supabase.auth.getSession()
    const response = await fetch("/api/settings/update-organization", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({
        name: form.name.trim(),
        industry: form.industry.trim(),
        currency: form.currency,
        business_type: form.businessType,
        business_category: form.businessCategory,
        gst_number: form.gstNumber.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        fssai: form.fssai.trim(),
        website: form.website.trim(),
        address: form.address.trim(),
        branch_name: form.branchName.trim() || "Main Branch",
      }),
    })
    const result = (await response.json()) as { error?: string }

    if (!response.ok) {
      setNotice(result.error || "Settings could not be saved.")
      setSaving(false)
      return
    }

    setNotice("Settings saved successfully.")
    await initializeSettings()
    setSaving(false)
  }

  async function toggleFeature(featureKey: string) {
    if (!organizationId) return
    const existing = features.find((feature) => feature.feature_key === featureKey)
    const nextEnabled = !existing?.is_enabled

    setFeatures((current) => {
      if (existing) {
        return current.map((feature) =>
          feature.feature_key === featureKey ? { ...feature, is_enabled: nextEnabled } : feature
        )
      }

      return [
        ...current,
        {
          organization_id: organizationId,
          feature_key: featureKey,
          is_enabled: nextEnabled,
        },
      ]
    })

    const {
      data: { session },
    } = await supabase.auth.getSession()
    const response = await fetch("/api/settings/toggle-feature", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({ feature_key: featureKey, is_enabled: nextEnabled }),
    })
    const result = (await response.json()) as { error?: string }

    if (!response.ok) {
      setNotice(result.error || "Feature could not be updated.")
      await initializeSettings()
    }
  }

  async function deleteMistakenInvoice() {
    if (!organizationId || !deletingInvoiceId) return
    if (deleteConfirmText.trim().toUpperCase() !== "DELETE") {
      setNotice("Type DELETE to confirm invoice deletion.")
      return
    }

    setSaving(true)
    setNotice("")

    if (!recentInvoices.some((row) => row.id === deletingInvoiceId)) {
      setNotice("Select a valid invoice to delete.")
      setSaving(false)
      return
    }

    const {
      data: { session },
    } = await supabase.auth.getSession()
    const deleteParams = new URLSearchParams({ organization_id: organizationId })
    const response = await fetch(`/api/invoices/delete-with-stock-restore?${deleteParams.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({ invoice_id: deletingInvoiceId, confirmation: "DELETE" }),
    })
    const result = (await response.json()) as { error?: string }

    if (!response.ok) {
      setNotice(result.error || "Invoice could not be deleted.")
      setSaving(false)
      return
    }

    setNotice("Invoice deleted and stock restored successfully.")
    setDeletingInvoiceId("")
    setDeleteConfirmText("")
    setInvoiceSearch("")
    await initializeSettings()
    setSaving(false)
  }

  return (
    <div className="relative min-h-dvh overflow-y-auto overflow-x-hidden bg-black text-white">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="inventory-grid-bg absolute inset-0 opacity-40" />
        <div className="absolute left-[-160px] top-[-160px] h-[520px] w-[520px] rounded-full bg-cyan-500/10 blur-[170px] animate-pulse" />
        <div className="absolute bottom-[-180px] right-[-160px] h-[560px] w-[560px] rounded-full bg-blue-500/10 blur-[190px] animate-pulse" />
      </div>

      <main className="relative z-10 mx-auto max-w-[1800px] space-y-8 px-5 py-6 lg:px-8">
        <section className="inventory-sheen rounded-[40px] border border-white/10 bg-white/[0.035] p-8 shadow-[0_0_90px_rgba(0,0,0,0.5)] backdrop-blur-2xl lg:p-10">
          <div className="max-w-5xl">
            <div className="mb-5 inline-flex rounded-full border border-cyan-400/20 bg-cyan-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200">
              Workspace Control Center
            </div>
            <h1 className="text-4xl font-black leading-tight tracking-tight md:text-6xl">
              Settings for global ERP scale, billing, inventory, and launch readiness.
            </h1>
            <p className="mt-5 max-w-4xl text-lg leading-8 text-neutral-400">
              Configure organization identity, currency, business type, industry features,
              invoice behavior, inventory modules, and operational readiness.
            </p>
          </div>
        </section>

        {notice && (
          <div className="rounded-3xl border border-cyan-400/25 bg-cyan-500/10 px-6 py-4 text-sm text-cyan-100">
            {notice}
          </div>
        )}

        <section className="grid grid-cols-1 gap-6 2xl:grid-cols-[1fr,420px]">
          <div className="space-y-6">
            <div className="rounded-[36px] border border-white/10 bg-white/[0.035] p-7 backdrop-blur-2xl">
              <h2 className="text-3xl font-black">Organization Profile</h2>
              <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
                <input value={form.name} onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))} placeholder="Business name" className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none focus:border-cyan-400/40" />
                <input value={form.industry} onChange={(e) => setForm((current) => ({ ...current, industry: e.target.value }))} placeholder="Industry" className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none focus:border-cyan-400/40" />
                <select value={form.currency} onChange={(e) => setForm((current) => ({ ...current, currency: e.target.value }))} className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none">
                  <option value="INR">Indian Rupee (INR)</option>
                  <option value="USD">US Dollar (USD)</option>
                  <option value="EUR">Euro (EUR)</option>
                  <option value="GBP">British Pound (GBP)</option>
                </select>
                <select value={form.businessType} onChange={(e) => setForm((current) => ({ ...current, businessType: e.target.value }))} className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none">
                  <option value="retail">Retail</option>
                  <option value="wholesale">Wholesale</option>
                  <option value="pharmacy">Pharmacy</option>
                  <option value="ecommerce">E-commerce</option>
                  <option value="manufacturing">Manufacturing</option>
                </select>
                <select value={form.businessCategory} onChange={(e) => setForm((current) => ({ ...current, businessCategory: e.target.value }))} className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none md:col-span-2">
                  <option value="general">General</option>
                  <option value="medical">Medical / Pharmacy</option>
                  <option value="electronics">Electronics</option>
                  <option value="fashion">Fashion / Garments</option>
                  <option value="grocery">Grocery / FMCG</option>
                  <option value="cosmetics">Cosmetics</option>
                </select>
                <input value={form.gstNumber} onChange={(e) => setForm((current) => ({ ...current, gstNumber: e.target.value }))} placeholder="GST number" className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none focus:border-cyan-400/40" />
                <input value={form.phone} onChange={(e) => setForm((current) => ({ ...current, phone: e.target.value }))} placeholder="Business phone" className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none focus:border-cyan-400/40" />
                <input value={form.email} onChange={(e) => setForm((current) => ({ ...current, email: e.target.value }))} placeholder="Business email" type="email" className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none focus:border-cyan-400/40" />
                <input value={form.fssai} onChange={(e) => setForm((current) => ({ ...current, fssai: e.target.value }))} placeholder="FSSAI number" className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none focus:border-cyan-400/40" />
                <input value={form.website} onChange={(e) => setForm((current) => ({ ...current, website: e.target.value }))} placeholder="Website" className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none focus:border-cyan-400/40" />
                <input value={form.branchName} onChange={(e) => setForm((current) => ({ ...current, branchName: e.target.value }))} placeholder="Branch name" className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none focus:border-cyan-400/40" />
                <textarea value={form.address} onChange={(e) => setForm((current) => ({ ...current, address: e.target.value }))} placeholder="Business address" className="min-h-28 rounded-2xl border border-white/10 bg-black/50 px-5 py-4 outline-none focus:border-cyan-400/40 md:col-span-2" />
              </div>
              <button onClick={saveOrganization} disabled={saving} className="mt-6 h-14 rounded-2xl bg-white px-7 font-black text-black disabled:opacity-50">
                {saving ? "Saving..." : "Save Organization"}
              </button>
            </div>

            <div className="rounded-[36px] border border-cyan-400/20 bg-cyan-500/[0.06] p-7 backdrop-blur-2xl">
              <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
                <div>
                  <h2 className="text-3xl font-black">Print Settings</h2>
                  <p className="mt-2 text-sm text-neutral-500">Configure default invoice printing behavior for A4, half A4, and thermal formats.</p>
                </div>
                <span className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-4 py-2 text-xs font-black uppercase tracking-[0.16em] text-cyan-100">
                  Local Default
                </span>
              </div>

              <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
                <select
                  value={printSettings.defaultFormat}
                  onChange={(event) => updatePrintSettings({ defaultFormat: event.target.value as PrintFormat })}
                  className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 text-sm font-semibold text-white outline-none"
                >
                  <option value="a4">Full A4 Invoice</option>
                  <option value="half-compact">Half A4 Compact</option>
                  <option value="half-top">Half A4 Top Format</option>
                  <option value="thermal">Thermal Receipt</option>
                </select>
                <select
                  value={printSettings.thermalWidth}
                  onChange={(event) => updatePrintSettings({ thermalWidth: event.target.value as PrintSettings["thermalWidth"] })}
                  className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 text-sm font-semibold text-white outline-none"
                >
                  <option value="auto">Auto Thermal Width</option>
                  <option value="58mm">58mm Thermal</option>
                  <option value="80mm">80mm Thermal</option>
                </select>
                <select
                  value={printSettings.fontSize}
                  onChange={(event) => updatePrintSettings({ fontSize: event.target.value as PrintSettings["fontSize"] })}
                  className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 text-sm font-semibold text-white outline-none"
                >
                  <option value="small">Small Font</option>
                  <option value="standard">Standard Font</option>
                  <option value="large">Large Font</option>
                </select>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-5">
                {[
                  ["showLogo", "Logo"],
                  ["showQr", "QR"],
                  ["showBarcode", "Barcode"],
                  ["showHsn", "HSN"],
                  ["showGstDetails", "GST Details"],
                  ["showSignature", "Signature"],
                  ["showWatermark", "Watermark"],
                  ["blackAndWhite", "Black & White"],
                  ["pharmaMode", "Pharma Mode"],
                  ["autoPrintAfterSave", "Auto Print"],
                ].map(([key, label]) => (
                  <label key={key} className="flex min-h-12 items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/35 px-4 text-sm font-bold">
                    <span>{label}</span>
                    <input
                      type="checkbox"
                      checked={Boolean(printSettings[key as keyof PrintSettings])}
                      onChange={(event) => updatePrintSettings({ [key]: event.target.checked } as Partial<PrintSettings>)}
                      className="h-4 w-4 accent-cyan-400"
                    />
                  </label>
                ))}
              </div>
            </div>

            <div className="rounded-[36px] border border-white/10 bg-white/[0.035] p-7 backdrop-blur-2xl">
              <h2 className="text-3xl font-black">ERP Feature Modules</h2>
              <p className="mt-2 text-sm text-neutral-500">Turn on the capabilities needed for your industry and global workflows.</p>
              <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
                {featureCatalog.map(([key, title, description]) => {
                  const enabled = enabledFeatureSet.has(key)
                  return (
                    <button
                      key={key}
                      onClick={() => void toggleFeature(key)}
                      className={`rounded-3xl border p-5 text-left transition-all duration-300 ${enabled ? "border-cyan-400/35 bg-cyan-500/10" : "border-white/10 bg-black/35 hover:border-white/20"}`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-lg font-black text-white">{title}</p>
                          <p className="mt-2 text-sm leading-6 text-neutral-500">{description}</p>
                        </div>
                        <span className={`rounded-full px-3 py-1 text-xs font-bold ${enabled ? "bg-cyan-400 text-black" : "bg-white/10 text-white"}`}>
                          {enabled ? "On" : "Off"}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="rounded-[36px] border border-red-400/20 bg-red-500/[0.04] p-7 backdrop-blur-2xl">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <h2 className="text-3xl font-black">Invoice Correction Center</h2>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-neutral-500">
                    Delete an invoice created by mistake and restore product stock from its invoice items. Use only for wrong bills, duplicate bills, or test invoices.
                  </p>
                </div>
                <span className="rounded-full border border-red-400/20 bg-red-500/10 px-4 py-2 text-xs font-black uppercase tracking-[0.16em] text-red-200">
                  Controlled Delete
                </span>
              </div>

              <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-[1fr,220px,180px]">
                <input
                  value={invoiceSearch}
                  onChange={(event) => setInvoiceSearch(event.target.value)}
                  placeholder="Search customer name, invoice number, or invoice id"
                  className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 text-sm font-semibold text-white outline-none focus:border-red-300/50 xl:col-span-3"
                />
                <select
                  value={deletingInvoiceId}
                  onChange={(event) => setDeletingInvoiceId(event.target.value)}
                  className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 text-sm font-semibold text-white outline-none focus:border-red-300/50"
                >
                  <option value="">Select invoice to delete</option>
                  {filteredCorrectionInvoices.length === 0 && (
                    <option value="" disabled>
                      No invoices found
                    </option>
                  )}
                  {filteredCorrectionInvoices.map((invoice) => (
                    <option key={invoice.id} value={invoice.id}>
                      {stringFrom(invoice, ["customer_name"]) || "Customer"} - {invoice.invoice_number || "Invoice"} - {formatDate(invoice.created_at)} - ID {invoice.id} - {money(numberFrom(invoice, ["grand_total", "total_amount", "total"]))}
                    </option>
                  ))}
                </select>
                <input
                  value={deleteConfirmText}
                  onChange={(event) => setDeleteConfirmText(event.target.value)}
                  placeholder="Type DELETE"
                  className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 text-sm font-semibold text-white outline-none focus:border-red-300/50"
                />
                <button
                  onClick={() => void deleteMistakenInvoice()}
                  disabled={saving || !deletingInvoiceId}
                  className="h-14 rounded-2xl border border-red-400/25 bg-red-500/10 px-6 font-black text-red-100 disabled:opacity-40"
                >
                  Delete Invoice
                </button>
              </div>

              <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-3">
                {filteredCorrectionInvoices.length === 0 && (
                  <div className="rounded-2xl border border-white/10 bg-black/35 p-4 text-sm font-semibold text-neutral-400 md:col-span-3">
                    {recentInvoices.length === 0 ? "No invoices found" : "No invoices match this search."}
                  </div>
                )}
                {filteredCorrectionInvoices.slice(0, 3).map((invoice) => (
                  <button
                    key={invoice.id}
                    onClick={() => setDeletingInvoiceId(invoice.id)}
                    className="rounded-2xl border border-white/10 bg-black/35 p-4 text-left hover:border-red-300/30"
                  >
                    <p className="truncate text-sm font-black">{stringFrom(invoice, ["customer_name"]) || "Customer"}</p>
                    <p className="mt-2 truncate text-xs text-neutral-500">{invoice.invoice_number || "Invoice"} - {formatDate(invoice.created_at)}</p>
                    <p className="mt-1 truncate text-xs text-neutral-600">ID {invoice.id}</p>
                    <p className="mt-1 text-sm font-bold text-cyan-200">{money(numberFrom(invoice, ["grand_total", "total_amount", "total"]))}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <aside className="space-y-6">
            <div className="rounded-[36px] border border-cyan-400/20 bg-cyan-500/10 p-7 shadow-[0_0_60px_rgba(34,211,238,0.12)]">
              <h2 className="text-3xl font-black">Launch Readiness</h2>
              <div className="mt-7 space-y-4">
                {readiness.map(([label, ready]) => (
                  <div key={String(label)} className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/30 px-4 py-4">
                    <span className="text-sm font-semibold text-white">{label}</span>
                    <span className={`rounded-full px-3 py-1 text-xs font-bold ${ready ? "bg-emerald-500/15 text-emerald-200" : "bg-amber-500/15 text-amber-200"}`}>
                      {ready ? "Ready" : "Pending"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[36px] border border-white/10 bg-white/[0.035] p-7 backdrop-blur-2xl">
              <h2 className="text-3xl font-black">Workspace</h2>
              <div className="mt-6 space-y-4 text-sm text-neutral-400">
                <p>ID: {organization?.id || "-"}</p>
                <p>Currency: {form.currency}</p>
                <p>Enabled modules: {enabledFeatureSet.size}</p>
                <p>Business type: {form.businessType}</p>
              </div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  )
}
