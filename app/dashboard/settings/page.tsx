"use client"

import { useEffect, useMemo, useState } from "react"
import { getOrganizationId } from "@/lib/getOrganization"
import { supabase } from "@/lib/supabase"

type Organization = Record<string, unknown> & {
  id: string
  name?: string | null
  industry?: string | null
  currency?: string | null
  business_type?: string | null
  business_category?: string | null
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

type InvoiceCorrectionItem = {
  id: string
  invoice_id: string | null
  product_id: string | null
  quantity: number | null
}

type ProductStockRow = {
  id: string
  stock: number | null
}

const featureCatalog = [
  ["batch_tracking", "Batch Tracking", "Track lots, expiry, manufacturing, and procurement batches."],
  ["expiry_tracking", "Expiry Tracking", "Alerts for pharmacy, grocery, cosmetics, and perishable inventory."],
  ["barcode_scanning", "Barcode Scanning", "Enable SKU/barcode workflows for retail and warehouse teams."],
  ["shipping_labels", "Shipping Labels", "Courier metadata, tracking numbers, and parcel-ready operations."],
  ["bulk_pricing", "Wholesale Billing", "Wholesale invoices, bulk pricing, and B2B billing flows."],
  ["size_variants", "Variants", "Size, color, and variant-ready inventory structures."],
  ["serial_numbers", "Serial Numbers", "Device, electronics, warranty, and serialized stock control."],
  ["warranty_tracking", "Warranty Tracking", "Capture warranty-ready sales and service workflows."],
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

export default function SettingsPage() {
  const [organizationId, setOrganizationId] = useState("")
  const [organization, setOrganization] = useState<Organization | null>(null)
  const [features, setFeatures] = useState<FeatureRow[]>([])
  const [recentInvoices, setRecentInvoices] = useState<InvoiceCorrectionRow[]>([])
  const [deletingInvoiceId, setDeletingInvoiceId] = useState("")
  const [deleteConfirmText, setDeleteConfirmText] = useState("")
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")
  const [form, setForm] = useState({
    name: "",
    industry: "",
    currency: "INR",
    businessType: "retail",
    businessCategory: "general",
  })

  async function initializeSettings() {
    const orgId = await getOrganizationId()
    if (!orgId) {
      setNotice("No organization is connected to this account.")
      return
    }

    setOrganizationId(orgId)
    const [orgResult, featureResult, invoiceResult] = await Promise.all([
      supabase.from("organizations").select("*").eq("id", orgId).single(),
      supabase.from("organization_features").select("*").eq("organization_id", orgId),
      supabase
        .from("invoices")
        .select("*")
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false })
        .limit(100),
    ])

    if (orgResult.error) setNotice(orgResult.error.message)
    if (featureResult.error) setNotice(featureResult.error.message)
    if (invoiceResult.error) setNotice(invoiceResult.error.message)

    if (orgResult.data) {
      const org = orgResult.data as Organization
      setOrganization(org)
      setForm({
        name: valueText(org.name || org.business_name),
        industry: valueText(org.industry),
        currency: valueText(org.currency) || "INR",
        businessType: valueText(org.business_type) || "retail",
        businessCategory: valueText(org.business_category) || "general",
      })
    }
    if (featureResult.data) setFeatures(featureResult.data as FeatureRow[])
    if (invoiceResult.data) setRecentInvoices(invoiceResult.data as InvoiceCorrectionRow[])
  }

  useEffect(() => {
    queueMicrotask(() => {
      void initializeSettings()
    })
  }, [])

  const enabledFeatureSet = useMemo(() => {
    return new Set(features.filter((feature) => feature.is_enabled).map((feature) => feature.feature_key))
  }, [features])

  const readiness = useMemo(() => {
    return [
      ["Business profile", Boolean(form.name.trim() && form.industry.trim())],
      ["Currency configured", Boolean(form.currency)],
      ["Industry features", enabledFeatureSet.size >= 3],
      ["Billing ready", enabledFeatureSet.has("bulk_pricing") || enabledFeatureSet.has("shipping_labels")],
      ["Inventory controls", enabledFeatureSet.has("batch_tracking") || enabledFeatureSet.has("barcode_scanning")],
    ]
  }, [enabledFeatureSet, form.currency, form.industry, form.name])

  async function saveOrganization() {
    if (!organizationId) return
    if (!form.name.trim()) {
      setNotice("Business name is required.")
      return
    }

    setSaving(true)
    const { error } = await supabase
      .from("organizations")
      .update({
        name: form.name.trim(),
        industry: form.industry.trim(),
        currency: form.currency,
        business_type: form.businessType,
        business_category: form.businessCategory,
      })
      .eq("id", organizationId)

    if (error) {
      setNotice(error.message)
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

    if (existing?.id) {
      const { error } = await supabase
        .from("organization_features")
        .update({ is_enabled: nextEnabled })
        .eq("id", existing.id)

      if (error) setNotice(error.message)
      return
    }

    const { error } = await supabase.from("organization_features").insert({
      organization_id: organizationId,
      feature_key: featureKey,
      is_enabled: nextEnabled,
    })

    if (error) setNotice(error.message)
  }

  async function deleteMistakenInvoice() {
    if (!organizationId || !deletingInvoiceId) return
    if (deleteConfirmText.trim().toUpperCase() !== "DELETE") {
      setNotice("Type DELETE to confirm invoice deletion.")
      return
    }

    setSaving(true)
    setNotice("")

    const invoice = recentInvoices.find((row) => row.id === deletingInvoiceId)
    if (!invoice) {
      setNotice("Select a valid invoice to delete.")
      setSaving(false)
      return
    }

    const { data: invoiceItems, error: itemError } = await supabase
      .from("invoice_items")
      .select("id,invoice_id,product_id,quantity")
      .eq("organization_id", organizationId)
      .eq("invoice_id", deletingInvoiceId)

    if (itemError) {
      setNotice(itemError.message)
      setSaving(false)
      return
    }

    const typedItems = (invoiceItems || []) as InvoiceCorrectionItem[]
    const productIds = Array.from(new Set(typedItems.map((item) => item.product_id).filter(Boolean))) as string[]

    if (productIds.length > 0) {
      const { data: products, error: productError } = await supabase
        .from("products")
        .select("id,stock")
        .eq("organization_id", organizationId)
        .in("id", productIds)

      if (productError) {
        setNotice(productError.message)
        setSaving(false)
        return
      }

      const productStockMap = new Map((products || []).map((product) => [product.id, product as ProductStockRow]))

      for (const item of typedItems) {
        if (!item.product_id) continue
        const product = productStockMap.get(item.product_id)
        if (!product) continue

        const previousStock = Number(product.stock || 0)
        const quantity = Number(item.quantity || 0)
        const nextStock = previousStock + quantity

        const { error: stockError } = await supabase
          .from("products")
          .update({ stock: nextStock })
          .eq("id", item.product_id)
          .eq("organization_id", organizationId)

        if (stockError) {
          setNotice(stockError.message)
          setSaving(false)
          return
        }

        await supabase.from("stock_movements").insert({
          organization_id: organizationId,
          product_id: item.product_id,
          type: "adjustment",
          quantity,
          previous_stock: previousStock,
          new_stock: nextStock,
          reason: `Invoice ${invoice.invoice_number || deletingInvoiceId} deleted and stock restored`,
        })

        productStockMap.set(item.product_id, { ...product, stock: nextStock })
      }
    }

    const { error: deleteItemsError } = await supabase
      .from("invoice_items")
      .delete()
      .eq("organization_id", organizationId)
      .eq("invoice_id", deletingInvoiceId)

    if (deleteItemsError) {
      setNotice(deleteItemsError.message)
      setSaving(false)
      return
    }

    const { error: deleteInvoiceError } = await supabase
      .from("invoices")
      .delete()
      .eq("organization_id", organizationId)
      .eq("id", deletingInvoiceId)

    if (deleteInvoiceError) {
      setNotice(deleteInvoiceError.message)
      setSaving(false)
      return
    }

    setNotice("Invoice deleted and stock restored successfully.")
    setDeletingInvoiceId("")
    setDeleteConfirmText("")
    await initializeSettings()
    setSaving(false)
  }

  return (
    <div className="relative min-h-screen overflow-y-auto overflow-x-hidden bg-black text-white">
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
              </div>
              <button onClick={saveOrganization} disabled={saving} className="mt-6 h-14 rounded-2xl bg-white px-7 font-black text-black disabled:opacity-50">
                {saving ? "Saving..." : "Save Organization"}
              </button>
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
                <select
                  value={deletingInvoiceId}
                  onChange={(event) => setDeletingInvoiceId(event.target.value)}
                  className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 text-sm font-semibold text-white outline-none focus:border-red-300/50"
                >
                  <option value="">Select invoice to delete</option>
                  {recentInvoices.map((invoice) => (
                    <option key={invoice.id} value={invoice.id}>
                      {invoice.invoice_number || invoice.id} - {stringFrom(invoice, ["customer_name"]) || "Customer"} - {money(numberFrom(invoice, ["grand_total", "total_amount", "total"]))} - {formatDate(invoice.created_at)}
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
                {recentInvoices.slice(0, 3).map((invoice) => (
                  <button
                    key={invoice.id}
                    onClick={() => setDeletingInvoiceId(invoice.id)}
                    className="rounded-2xl border border-white/10 bg-black/35 p-4 text-left hover:border-red-300/30"
                  >
                    <p className="truncate text-sm font-black">{invoice.invoice_number || invoice.id}</p>
                    <p className="mt-2 text-xs text-neutral-500">{formatDate(invoice.created_at)}</p>
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
