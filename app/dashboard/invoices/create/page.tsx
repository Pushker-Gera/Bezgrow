"use client"

import Link from "next/link"
import type { ReactNode } from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { getOrganizationId } from "@/lib/getOrganization"
import { createWhatsAppInvoiceUrl } from "@/lib/invoice-share"
import { createOfflineId, getOfflineData, putOfflineData, queueOfflineAction } from "@/lib/offline/db"
import { shouldSaveOffline } from "@/lib/offline/network"
import { supabase } from "@/lib/supabase"
import { getWorkspaceBootstrap } from "@/lib/workspaceBootstrapClient"

type Customer = {
  id: string
  name: string
  phone?: string | null
  gst_number?: string | null
}

type OfflineInvoiceRow = Record<string, unknown> & {
  id: string
  invoice_number: string
  customer_id: string
  organization_id: string
  sync_status: string
}

type OfflineInvoiceItemRow = Record<string, unknown> & {
  id: string
  invoice_id: string
  product_id: string
}

type Product = {
  id: string
  name: string
  sale_rate: number | null
  price?: number | null
  gst: number | null
  stock: number | null
  sku?: string | null
  barcode?: string | null
  batch_no?: string | null
  expiry_date?: string | null
  min_stock?: number | null
}

type InvoiceItem = {
  id: string
  product_id: string
  quantity: number
  unit_price: number
  tax_percent: number
  discount_percent: number
}

type Notice = {
  title: string
  message: string
  type: "error" | "warning" | "success"
} | null

type ListResponse<T> = {
  data?: T[]
  error?: string
}

type InvoiceCreateResponse = {
  success: boolean
  error?: string
  invoice_id?: string
  invoice_number?: string
}

type InvoicePayload = {
  customer_id: string
  subtotal: number
  discount_amount: number
  discount_total: number
  taxable_amount: number
  tax_amount: number
  total_amount: number
  payment_status: string
  payment_method: string
  due_date: string | null
  notes: string | null
  invoice_type: string
  shipping_code: string | null
  courier_name: string | null
  tracking_number: string | null
}

type InvoiceItemPayload = {
  product_id: string
  quantity: number
  unit_price: number
  tax_percent: number
  discount_percent: number
  line_total: number
  gst_amount: number
  product_name: string
  stock_at_queue?: number
}

function createClientId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }

  return `item-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function newItem(): InvoiceItem {
  return {
    id: createClientId(),
    product_id: "",
    quantity: 1,
    unit_price: 0,
    tax_percent: 0,
    discount_percent: 0,
  }
}

function money(value: number) {
  return `Rs ${Math.round(value).toLocaleString()}`
}

function offlineInvoiceNumber(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0")
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `OFFLINE-${stamp}`
}

function inputClass(extra = "") {
  return `h-14 w-full rounded-2xl border border-white/10 bg-black/50 px-5 text-sm font-semibold text-white outline-none transition-all duration-300 placeholder:text-neutral-600 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-500/10 ${extra}`
}

function FieldLabel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-[11px] font-black uppercase tracking-[0.18em] text-neutral-500">
        {label}
      </span>
      {children}
    </label>
  )
}

export default function CreateInvoicePage() {
  const [features, setFeatures] = useState<string[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [selectedCustomer, setSelectedCustomer] = useState("")
  const [invoiceMode, setInvoiceMode] = useState<"gst" | "no_gst">("gst")
  const [invoiceType, setInvoiceType] = useState("standard")
  const [paymentStatus, setPaymentStatus] = useState("unpaid")
  const [paymentMethod, setPaymentMethod] = useState("cash")
  const [dueDate, setDueDate] = useState("")
  const [invoiceNotes, setInvoiceNotes] = useState("")
  const [shippingCode, setShippingCode] = useState("")
  const [courierName, setCourierName] = useState("")
  const [trackingNumber, setTrackingNumber] = useState("")
  const [items, setItems] = useState<InvoiceItem[]>([newItem()])
  const [barcodeInput, setBarcodeInput] = useState("")
  const [scanQuantity, setScanQuantity] = useState(1)
  const [sendSmsMessage, setSendSmsMessage] = useState(true)
  const [smsBillLink, setSmsBillLink] = useState("")
  const [organizationId, setOrganizationId] = useState("")
  const [organizationName, setOrganizationName] = useState("Bezgrow")
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  const hasShippingLabels = features.includes("shipping_labels")
  const hasBatchTracking = features.includes("batch_tracking")
  const hasExpiryTracking = features.includes("expiry_tracking")
  const hasBarcodeScanning = features.includes("barcode_scanning")
  const hasWholesaleBilling = features.includes("bulk_pricing")

  async function initialize() {
    const orgId = await getOrganizationId()

    if (!orgId) {
      setNotice({
        title: "Organization Error",
        message: "No organization found for this account.",
        type: "error",
      })
      return
    }

    setOrganizationId(orgId)
    const workspace = await getWorkspaceBootstrap()
    if (!workspace?.success) {
      throw new Error(workspace?.error || "Internet required to refresh login.")
    }
    setFeatures(Array.isArray(workspace.features) ? workspace.features : [])
    setOrganizationName(workspace.organization?.name || "Bezgrow")
    await Promise.all([fetchCustomers(orgId), fetchProducts(orgId)])
  }

  async function fetchCustomers(orgId = organizationId) {
    if (!orgId) return
    const {
      data: { session },
    } = await supabase.auth.getSession()

    try {
      const response = await fetch("/api/customers/list?limit=100", {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
        cache: "no-store",
      })
      const payload = (await response.json()) as ListResponse<Customer>

      if (!response.ok) throw new Error(payload.error || "Customers failed to load.")
      const nextCustomers = (payload.data || []).filter((customer) => customer.name)
      setCustomers(nextCustomers)
      await putOfflineData(orgId, "customers", nextCustomers)
    } catch (error) {
      const cachedCustomers = await getOfflineData<Customer[]>(orgId, "customers", [])
      setCustomers(cachedCustomers.filter((customer) => customer.name))
      if (!navigator.onLine) {
        setNotice({ title: "Offline Customers", message: "Showing locally cached customers.", type: "warning" })
      } else {
        setNotice({ title: "Customers failed", message: error instanceof Error ? error.message : "Customers failed to load.", type: "error" })
      }
    }
  }

  async function fetchProducts(orgId = organizationId) {
    if (!orgId) return
    const {
      data: { session },
    } = await supabase.auth.getSession()

    try {
      const response = await fetch("/api/products/list?limit=100&sort=name&direction=asc", {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
        cache: "no-store",
      })
      const payload = (await response.json()) as ListResponse<Product>

      if (!response.ok) throw new Error(payload.error || "Products failed to load.")
      setProducts(payload.data || [])
      await putOfflineData(orgId, "products", payload.data || [])
      await putOfflineData(orgId, "inventory_items", payload.data || [])
    } catch (error) {
      const cachedProducts = await getOfflineData<Product[]>(orgId, "products", [])
      setProducts(cachedProducts)
      if (!navigator.onLine) {
        setNotice({ title: "Offline Products", message: "Showing locally cached products and stock.", type: "warning" })
      } else {
        setNotice({ title: "Products failed", message: error instanceof Error ? error.message : "Products failed to load.", type: "error" })
      }
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      void initialize().catch((error) => {
        console.error("Initialize error:", error)

        setNotice({
          title: "Initialization Failed",
          message: error instanceof Error ? error.message : "Unknown error",
          type: "error",
        })
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const productsMap = useMemo(() => new Map(products.map((product) => [product.id, product])), [products])
  const selectedCustomerRecord = useMemo(
    () => customers.find((customer) => customer.id === selectedCustomer) || null,
    [customers, selectedCustomer]
  )

  const totals = useMemo(() => {
    let subtotal = 0
    let discount = 0
    let tax = 0

    items.forEach((item) => {
      const lineBase = item.quantity * item.unit_price
      const discountAmount = (lineBase * item.discount_percent) / 100
      const discountedBase = lineBase - discountAmount
      const lineTax = invoiceMode === "no_gst" ? 0 : (discountedBase * item.tax_percent) / 100

      subtotal += lineBase
      discount += discountAmount
      tax += lineTax
    })

    const taxableAmount = Math.max(0, subtotal - discount)

    return { subtotal, discount, taxableAmount, tax, grandTotal: taxableAmount + tax }
  }, [invoiceMode, items])

  const totalItems = items.reduce((acc, item) => acc + item.quantity, 0)
  const lowStockProducts = products.filter((product) => Number(product.stock || 0) <= Number(product.min_stock || 0))
  const outOfStockProducts = products.filter((product) => Number(product.stock || 0) <= 0)

  function addItem() {
    setItems((current) => [...current, newItem()])
  }

  function productToItem(product: Product, quantity = 1): InvoiceItem {
    return {
      id: createClientId(),
      product_id: product.id,
      quantity,
      unit_price: Number(product.sale_rate ?? product.price ?? 0),
      tax_percent: invoiceMode === "no_gst" ? 0 : Number(product.gst || 0),
      discount_percent: 0,
    }
  }

  function addProductByScan(product: Product, quantity = 1) {
    setItems((current) => {
      const existing = current.find((item) => item.product_id === product.id)

      if (existing) {
        return current.map((item) =>
          item.product_id === product.id ? { ...item, quantity: item.quantity + quantity } : item
        )
      }

      const emptyIndex = current.findIndex((item) => !item.product_id)
      const scannedItem = productToItem(product, quantity)

      if (emptyIndex >= 0) {
        return current.map((item, index) => (index === emptyIndex ? scannedItem : item))
      }

      return [...current, scannedItem]
    })
  }

  function handleBarcodeScan() {
    const code = barcodeInput.trim().toLowerCase()
    if (!code) return

    const product = products.find(
      (item) =>
        item.barcode?.toLowerCase() === code ||
        item.sku?.toLowerCase() === code
    )

    if (!product) {
      setNotice({
        title: "Barcode Not Found",
        message: "No product matches this barcode or SKU.",
        type: "warning",
      })
      return
    }

    addProductByScan(product, Math.max(1, scanQuantity))
    setBarcodeInput("")
    setNotice({
      title: "Product Scanned",
      message: `${product.name} x ${Math.max(1, scanQuantity)} was added to the bill.`,
      type: "success",
    })
  }

  function removeItem(id: string) {
    setItems((current) => (current.length === 1 ? [newItem()] : current.filter((item) => item.id !== id)))
  }

  const resetInvoiceForm = useCallback(() => {
    setSelectedCustomer("")
    setInvoiceMode("gst")
    setInvoiceType("standard")
    setPaymentStatus("unpaid")
    setPaymentMethod("cash")
    setDueDate("")
    setInvoiceNotes("")
    setShippingCode("")
    setCourierName("")
    setTrackingNumber("")
    setItems([newItem()])
    setBarcodeInput("")
    setScanQuantity(1)
    setSmsBillLink("")
  }, [])

  function updateItem<K extends keyof InvoiceItem>(id: string, field: K, value: InvoiceItem[K]) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, [field]: value } : item)))
  }

  function selectProduct(itemId: string, productId: string) {
    const product = productsMap.get(productId)
    updateItem(itemId, "product_id", productId)

    if (!product) return

    updateItem(itemId, "unit_price", Number(product.sale_rate ?? product.price ?? 0))
    updateItem(itemId, "tax_percent", invoiceMode === "no_gst" ? 0 : Number(product.gst || 0))

    if (hasExpiryTracking && product.expiry_date && new Date(product.expiry_date) < new Date()) {
      setNotice({ title: "Expired Product", message: `${product.name} has expired inventory.`, type: "warning" })
    }
    if (Number(product.stock || 0) <= 0) {
      setNotice({ title: "Out Of Stock", message: `${product.name} is currently out of stock.`, type: "warning" })
    }
  }

  function validateSaleableStock() {
    const requested = new Map<string, number>()

    items.forEach((item) => {
      if (!item.product_id) return
      requested.set(item.product_id, (requested.get(item.product_id) || 0) + Number(item.quantity || 0))
    })

    const validationErrors: string[] = []
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    requested.forEach((quantity, productId) => {
      const product = productsMap.get(productId)
      if (!product) return

      const stock = Number(product.stock || 0)
      if (quantity > stock) {
        validationErrors.push(`${product.name} has only ${stock} in stock, but ${quantity} is selected.`)
      }

      if (hasExpiryTracking && product.expiry_date) {
        const expiry = new Date(product.expiry_date)
        expiry.setHours(0, 0, 0, 0)
        if (expiry < today) {
          validationErrors.push(`${product.name} is expired and cannot be billed.`)
        }
      }
    })

    return validationErrors
  }

  function switchInvoiceMode(mode: "gst" | "no_gst") {
    setInvoiceMode(mode)
    if (mode === "no_gst") {
      setItems((current) => current.map((item) => ({ ...item, tax_percent: 0 })))
      setInvoiceType("no_gst")
    } else {
      setInvoiceType("gst")
      setItems((current) =>
        current.map((item) => ({
          ...item,
          tax_percent: Number(productsMap.get(item.product_id)?.gst || item.tax_percent || 0),
        }))
      )
    }
  }

  function createWhatsAppBillLink(invoiceId: string, invoiceNumber: string) {
    return createWhatsAppInvoiceUrl({
      customerName: selectedCustomerRecord?.name || "Customer",
      customerPhone: selectedCustomerRecord?.phone,
      enterpriseName: organizationName,
      invoiceNumber,
      amount: totals.grandTotal,
      invoiceUrl: `${window.location.origin}/public/invoices/${invoiceId}/pdf`,
    })
  }

  async function saveInvoiceOffline(invoicePayload: InvoicePayload, invoiceItems: InvoiceItemPayload[], printAfterSave: boolean) {
    if (!organizationId) throw new Error("No cached organization is available for offline billing.")

    const now = new Date().toISOString()
    const offlineClientId = createOfflineId("invoice-client")
    const localInvoiceId = createOfflineId("invoice")
    const invoiceNumber = offlineInvoiceNumber()
    const currentProducts = await getOfflineData<Product[]>(organizationId, "products", products)
    const quantityByProductId = new Map<string, number>()

    invoiceItems.forEach((item) => {
      quantityByProductId.set(item.product_id, (quantityByProductId.get(item.product_id) || 0) + item.quantity)
    })

    const nextProducts = currentProducts.map((product) => {
      const quantity = quantityByProductId.get(product.id) || 0
      return quantity > 0 ? { ...product, stock: Number(product.stock || 0) - quantity } : product
    })
    const productBeforeById = new Map(currentProducts.map((product) => [product.id, product]))

    const invoiceRecord: OfflineInvoiceRow = {
      id: localInvoiceId,
      organization_id: organizationId,
      invoice_number: invoiceNumber,
      customer_id: invoicePayload.customer_id,
      customer_name: selectedCustomerRecord?.name || "Customer",
      subtotal: invoicePayload.subtotal,
      discount_amount: invoicePayload.discount_amount,
      discount_total: invoicePayload.discount_total,
      taxable_amount: invoicePayload.taxable_amount,
      tax_amount: invoicePayload.tax_amount,
      total_amount: invoicePayload.total_amount,
      grand_total: invoicePayload.total_amount,
      total: invoicePayload.total_amount,
      payment_status: invoicePayload.payment_status,
      status: invoicePayload.payment_status,
      payment_method: invoicePayload.payment_method,
      due_date: invoicePayload.due_date,
      date: now.slice(0, 10),
      notes: invoicePayload.notes,
      invoice_type: invoicePayload.invoice_type,
      shipping_code: invoicePayload.shipping_code,
      courier_name: invoicePayload.courier_name,
      tracking_number: invoicePayload.tracking_number,
      sync_status: "pending_create",
      offline_client_id: offlineClientId,
      created_at: now,
      updated_at: now,
    }

    const itemRecords: OfflineInvoiceItemRow[] = invoiceItems.map((item) => ({
      id: createOfflineId("invoice-item"),
      organization_id: organizationId,
      invoice_id: localInvoiceId,
      product_id: item.product_id,
      product_name: item.product_name,
      quantity: item.quantity,
      unit_price: item.unit_price,
      tax_percent: item.tax_percent,
      discount_percent: item.discount_percent,
      line_total: item.line_total,
      gst_amount: item.gst_amount,
      sync_status: "pending_create",
      created_at: now,
    }))

    const cachedInvoices = await getOfflineData<OfflineInvoiceRow[]>(organizationId, "invoices", [])
    const cachedItems = await getOfflineData<OfflineInvoiceItemRow[]>(organizationId, "invoice_items", [])
    const cachedMovements = await getOfflineData<Record<string, unknown>[]>(organizationId, "stock_movements", [])
    const movementRecords = Array.from(quantityByProductId.entries()).map(([productId, quantity]) => {
      const product = productBeforeById.get(productId)
      const previousStock = Number(product?.stock || 0)

      return {
        id: createOfflineId("stock-movement"),
        organization_id: organizationId,
        product_id: productId,
        product_name: product?.name || "",
        type: "sale",
        quantity: -quantity,
        previous_stock: previousStock,
        new_stock: previousStock - quantity,
        reason: `Invoice ${invoiceNumber}`,
        reference_no: invoiceNumber,
        sync_status: "pending_create",
        created_at: now,
        updated_at: now,
      }
    })
    const queuedItems = invoiceItems.map((item) => ({
      ...item,
      stock_at_queue: Number(productsMap.get(item.product_id)?.stock ?? 0),
    }))

    await Promise.all([
      putOfflineData(organizationId, "products", nextProducts),
      putOfflineData(organizationId, "inventory_items", nextProducts),
      putOfflineData(organizationId, "invoices", [invoiceRecord, ...cachedInvoices]),
      putOfflineData(organizationId, "invoice_items", [...itemRecords, ...cachedItems]),
      putOfflineData(organizationId, "stock_movements", [...movementRecords, ...cachedMovements]),
      queueOfflineAction({
        id: offlineClientId,
        type: "create_invoice",
        organizationId,
        payload: {
          offlineClientId,
          localInvoiceId,
          invoice: invoicePayload,
          items: queuedItems,
        },
      }),
    ])

    setProducts(nextProducts)
    resetInvoiceForm()

    if (printAfterSave) {
      setLoading(false)
      window.location.href = `/dashboard/invoices/${localInvoiceId}/print`
      return
    }

    setNotice({
      title: "Invoice Saved Offline",
      message: `${invoiceNumber} is pending sync. Local stock was reduced.`,
      type: "warning",
    })
    setLoading(false)
  }

  async function saveInvoice(printAfterSave = false) {
    if (loading) return
    if (!selectedCustomer || items.length === 0) {
      setNotice({ title: "Incomplete Invoice", message: "Select a customer and add at least one product.", type: "warning" })
      return
    }
    if (items.some((item) => !item.product_id || item.quantity <= 0)) {
      setNotice({ title: "Invalid Products", message: "Select valid products and quantities for all invoice rows.", type: "warning" })
      return
    }

    const stockValidationErrors = validateSaleableStock()
    if (stockValidationErrors.length > 0) {
      setNotice({
        title: "Stock Validation Failed",
        message: stockValidationErrors.slice(0, 3).join(" "),
        type: "error",
      })
      return
    }

    setLoading(true)
    setNotice(null)
    setSmsBillLink("")

    const invoicePayload: InvoicePayload = {
      customer_id: selectedCustomer,
      subtotal: totals.subtotal,
      discount_amount: totals.discount,
      discount_total: totals.discount,
      taxable_amount: totals.taxableAmount,
      tax_amount: totals.tax,
      total_amount: totals.grandTotal,
      payment_status: paymentStatus,
      payment_method: paymentMethod,
      due_date: dueDate || null,
      notes: invoiceNotes || null,
      invoice_type: invoiceMode === "no_gst" ? "no_gst" : invoiceType,
      shipping_code: hasShippingLabels ? shippingCode || null : null,
      courier_name: hasShippingLabels ? courierName || null : null,
      tracking_number: hasShippingLabels ? trackingNumber || null : null,
    }

    const invoiceItems: InvoiceItemPayload[] = items.map((item) => {
      const lineBase = item.quantity * item.unit_price
      const discountAmount = (lineBase * item.discount_percent) / 100
      const discountedBase = lineBase - discountAmount
      const gstAmount = invoiceMode === "no_gst" ? 0 : discountedBase * (item.tax_percent / 100)

      return {
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price: item.unit_price,
        tax_percent: invoiceMode === "no_gst" ? 0 : item.tax_percent,
        discount_percent: item.discount_percent,
        line_total: discountedBase,
        gst_amount: gstAmount,
        product_name: productsMap.get(item.product_id)?.name || "",
      }
    })

    let data: InvoiceCreateResponse

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const response = await fetch("/api/invoices/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          ...invoicePayload,
          items: invoiceItems,
        }),
      })
      data = (await response.json()) as InvoiceCreateResponse

      if (!response.ok || !data.success) {
        setNotice({ title: "Transaction Failed", message: data.error || "Invoice transaction failed.", type: "error" })
        setLoading(false)
        return
      }
    } catch (error) {
      if (!shouldSaveOffline(error)) {
        setNotice({ title: "Transaction Failed", message: error instanceof Error ? error.message : "Invoice transaction failed.", type: "error" })
        setLoading(false)
        return
      }

      await saveInvoiceOffline(invoicePayload, invoiceItems, printAfterSave)
      return
    }

    if (!data.success) {
      setNotice({ title: "Transaction Failed", message: data.error || "Invoice transaction failed.", type: "error" })
      setLoading(false)
      return
    }

    await fetchProducts()

    let whatsappPhoneMissing = false
    if (data?.invoice_id && sendSmsMessage) {
      const link = createWhatsAppBillLink(data.invoice_id, data.invoice_number || "Invoice")
      if (link) {
        setSmsBillLink(link)
      } else {
        whatsappPhoneMissing = true
      }
    }

    if (printAfterSave && data?.invoice_id) {
      resetInvoiceForm()
      setLoading(false)
      window.location.href = `/dashboard/invoices/${data.invoice_id}/print`
      return
    }

    setNotice(
      whatsappPhoneMissing
        ? { title: "WhatsApp Not Ready", message: "Customer phone number required.", type: "warning" }
        : { title: "Invoice Created", message: "Invoice created successfully.", type: "success" }
    )
    resetInvoiceForm()
    setLoading(false)
  }

  useEffect(() => {
    function resetReturnedPage(event: PageTransitionEvent) {
      const navigationEntry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
      if (event.persisted || navigationEntry?.type === "back_forward") {
        resetInvoiceForm()
        setNotice(null)
      }
      setLoading(false)
    }

    window.addEventListener("pageshow", resetReturnedPage)
    return () => window.removeEventListener("pageshow", resetReturnedPage)
  }, [resetInvoiceForm])

  return (
    <div className="relative min-h-dvh overflow-y-auto overflow-x-hidden bg-black text-white">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="inventory-grid-bg absolute inset-0 opacity-40" />
        <div className="absolute left-[-160px] top-[-160px] h-[520px] w-[520px] rounded-full bg-cyan-500/10 blur-[170px] animate-pulse" />
        <div className="absolute bottom-[-180px] right-[-160px] h-[560px] w-[560px] rounded-full bg-blue-500/10 blur-[190px] animate-pulse" />
      </div>

      <main className="relative z-10 mx-auto max-w-[1800px] space-y-5 px-4 py-4 sm:space-y-8 sm:px-5 sm:py-6 lg:px-8">
        <section className="inventory-sheen rounded-lg border border-white/10 bg-white/[0.035] p-5 shadow-[0_0_90px_rgba(0,0,0,0.5)] backdrop-blur-2xl sm:rounded-[40px] sm:p-8 lg:p-10">
          <div className="flex flex-col gap-8 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="mb-5 inline-flex rounded-full border border-cyan-400/20 bg-cyan-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200">
                Global Invoice Studio
              </div>
              <h1 className="max-w-6xl text-3xl font-black leading-tight tracking-tight sm:text-4xl md:text-6xl">
                Create GST and non-GST bills with inventory intelligence.
              </h1>
              <p className="mt-4 max-w-4xl text-base leading-7 text-neutral-400 sm:mt-5 sm:text-lg sm:leading-8">
                Build professional invoices with products, discounts, payment terms, due dates,
                optional GST, shipping metadata, stock checks, and print-ready output.
              </p>
            </div>
            <div className="grid w-full gap-4 sm:grid-cols-2 xl:w-[420px]">
              <Link href="/dashboard/invoices" className="flex min-h-14 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] px-5 text-base font-black sm:min-h-[82px] sm:rounded-[28px] sm:px-6 sm:text-xl">
                Invoice Register
              </Link>
              <Link href="/dashboard/billing" className="flex min-h-14 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] px-5 text-base font-black sm:min-h-[82px] sm:rounded-[28px] sm:px-6 sm:text-xl">
                Billing Hub
              </Link>
            </div>
          </div>
        </section>

        {notice && (
          <div className={`rounded-3xl border px-6 py-4 text-sm ${notice.type === "error" ? "border-red-400/25 bg-red-500/10 text-red-100" : notice.type === "warning" ? "border-amber-400/25 bg-amber-500/10 text-amber-100" : "border-emerald-400/25 bg-emerald-500/10 text-emerald-100"}`}>
            <span className="font-bold">{notice.title}: </span>{notice.message}
            {smsBillLink && (
              <a href={smsBillLink} target="_blank" rel="noreferrer" className="ml-3 font-black underline decoration-cyan-300/60 underline-offset-4">
                Send on WhatsApp
              </a>
            )}
          </div>
        )}

        <section className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-4">
          {[
            ["Total Items", totalItems, "text-white", "Units on bill"],
            ["Products", products.length, "text-cyan-200", "Available catalog"],
            ["Low Stock", lowStockProducts.length, "text-amber-200", "Needs attention"],
            ["Out Of Stock", outOfStockProducts.length, "text-red-200", "Cannot fulfill"],
          ].map(([label, value, color, helper]) => (
            <div key={label} className="rounded-lg border border-white/10 bg-gradient-to-br from-zinc-950 via-black to-zinc-950 p-4 sm:rounded-[32px] sm:p-7">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">{label}</p>
              <p className={`mt-4 text-3xl font-black tracking-tight sm:mt-5 sm:text-4xl ${color}`}>{value}</p>
              <p className="mt-3 text-sm text-neutral-500 sm:mt-4">{helper}</p>
            </div>
          ))}
        </section>

        <section className="grid grid-cols-1 gap-6 2xl:grid-cols-[1fr,420px]">
          <div className="space-y-6">
            <div className="rounded-lg border border-white/10 bg-white/[0.035] p-5 backdrop-blur-2xl sm:rounded-[36px] sm:p-7">
              <h2 className="text-2xl font-black sm:text-3xl">Invoice Configuration</h2>
              <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                <FieldLabel label="Customer">
                  <select value={selectedCustomer} onChange={(e) => setSelectedCustomer(e.target.value)} className={inputClass()}>
                    <option value="">Choose customer</option>
                    {customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>{customer.name}</option>
                    ))}
                  </select>
                </FieldLabel>
                <FieldLabel label="Bill Mode">
                  <div className="grid grid-cols-2 gap-3 rounded-2xl border border-white/10 bg-black/35 p-2">
                    <button onClick={() => switchInvoiceMode("gst")} className={`rounded-xl px-4 py-3 text-sm font-black ${invoiceMode === "gst" ? "bg-cyan-400 text-black" : "text-white"}`}>
                      GST Bill
                    </button>
                    <button onClick={() => switchInvoiceMode("no_gst")} className={`rounded-xl px-4 py-3 text-sm font-black ${invoiceMode === "no_gst" ? "bg-white text-black" : "text-white"}`}>
                      No GST Bill
                    </button>
                  </div>
                </FieldLabel>
                <FieldLabel label="Invoice Type">
                  <select value={invoiceType} onChange={(e) => setInvoiceType(e.target.value)} className={inputClass()}>
                    <option value="standard">Standard Invoice</option>
                    <option value="gst">GST Invoice</option>
                    <option value="no_gst">Without GST Bill</option>
                    <option value="proforma">Proforma Invoice</option>
                    {hasWholesaleBilling && <option value="wholesale">Wholesale Invoice</option>}
                    {hasShippingLabels && <option value="shipping">Shipping Invoice</option>}
                  </select>
                </FieldLabel>
                <FieldLabel label="Payment Status">
                  <select value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)} className={inputClass()}>
                    <option value="unpaid">Unpaid</option>
                    <option value="partial">Partial</option>
                    <option value="paid">Paid</option>
                  </select>
                </FieldLabel>
                <FieldLabel label="Payment Method">
                  <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} className={inputClass()}>
                    <option value="cash">Cash</option>
                    <option value="upi">UPI</option>
                    <option value="card">Card</option>
                    <option value="bank_transfer">Bank Transfer</option>
                  </select>
                </FieldLabel>
                <FieldLabel label="Due Date">
                  <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputClass()} />
                </FieldLabel>
                <FieldLabel label="Customer Message">
                  <label className="flex h-14 items-center gap-3 rounded-2xl border border-white/10 bg-black/50 px-5 text-sm font-semibold text-white">
                    <input
                      type="checkbox"
                      checked={sendSmsMessage}
                      onChange={(event) => setSendSmsMessage(event.target.checked)}
                      className="h-4 w-4 accent-cyan-400"
                    />
                    Show WhatsApp share after save
                  </label>
                </FieldLabel>
              </div>
              {hasShippingLabels && (
                <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-3">
                  <FieldLabel label="Shipping Code">
                    <input value={shippingCode} onChange={(e) => setShippingCode(e.target.value)} placeholder="Shipping code" className={inputClass()} />
                  </FieldLabel>
                  <FieldLabel label="Courier Name">
                    <input value={courierName} onChange={(e) => setCourierName(e.target.value)} placeholder="Courier name" className={inputClass()} />
                  </FieldLabel>
                  <FieldLabel label="Tracking Number">
                    <input value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} placeholder="Tracking number" className={inputClass()} />
                  </FieldLabel>
                </div>
              )}
              <FieldLabel label="Invoice Notes">
                <textarea value={invoiceNotes} onChange={(e) => setInvoiceNotes(e.target.value)} rows={4} placeholder="Invoice notes, payment terms, dispatch details..." className={`${inputClass("mt-5 h-auto py-4")} resize-none`} />
              </FieldLabel>
            </div>

            <div className="rounded-lg border border-white/10 bg-white/[0.035] p-5 backdrop-blur-2xl sm:rounded-[36px] sm:p-7">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-2xl font-black sm:text-3xl">Invoice Items</h2>
                  <p className="mt-2 text-sm text-neutral-500">Responsive product rows with stock, batch, barcode, discount, and tax control.</p>
                </div>
                <button onClick={addItem} className="h-14 w-full rounded-lg bg-white px-6 font-black text-black md:w-auto md:rounded-2xl">Add Product</button>
              </div>

              <div className="mt-6 rounded-lg border border-cyan-400/20 bg-cyan-500/10 p-4 sm:rounded-[28px] sm:p-5">
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-cyan-200">
                  Retail Barcode Scanner
                </p>
                <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1fr,150px,180px]">
                  <FieldLabel label="Barcode / SKU">
                    <input
                      value={barcodeInput}
                      onChange={(event) => setBarcodeInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault()
                          handleBarcodeScan()
                        }
                      }}
                      placeholder="Scan barcode or type SKU, then press Enter"
                      className={inputClass()}
                    />
                  </FieldLabel>
                  <FieldLabel label="Scan Qty">
                    <input
                      type="number"
                      min={1}
                      value={scanQuantity}
                      onChange={(event) => setScanQuantity(Math.max(1, Number(event.target.value) || 1))}
                      className={inputClass()}
                    />
                  </FieldLabel>
                  <button
                    onClick={handleBarcodeScan}
                    className="h-14 rounded-lg bg-cyan-400 px-6 font-black text-black lg:mt-[27px] lg:rounded-2xl"
                  >
                    Add Scan
                  </button>
                </div>
                <p className="mt-3 text-xs text-neutral-400">
                  Works with USB barcode scanners that type into the focused field, ideal for malls, supermarkets, retail counters, and POS billing.
                </p>
              </div>

              <div className="mt-6 space-y-4">
                {items.map((item) => {
                  const product = productsMap.get(item.product_id)
                  const lineBase = item.quantity * item.unit_price
                  const discountAmount = (lineBase * item.discount_percent) / 100
                  const lineTax = invoiceMode === "no_gst" ? 0 : ((lineBase - discountAmount) * item.tax_percent) / 100
                  const lineTotal = lineBase - discountAmount + lineTax

                  return (
                    <div key={item.id} className="rounded-lg border border-white/10 bg-black/40 p-4 sm:rounded-[30px] sm:p-5">
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-[1fr,120px,140px,120px,130px,150px]">
                        <FieldLabel label="Product">
                          <select value={item.product_id} onChange={(e) => selectProduct(item.id, e.target.value)} className={inputClass()}>
                            <option value="">Select product</option>
                            {products.map((product) => (
                              <option key={product.id} value={product.id}>
                                {product.name} {product.sku ? `- ${product.sku}` : ""} ({product.stock || 0} stock)
                              </option>
                            ))}
                          </select>
                        </FieldLabel>
                        <FieldLabel label="Qty">
                          <input type="number" min={1} value={item.quantity} onChange={(e) => updateItem(item.id, "quantity", Math.max(1, Number(e.target.value) || 1))} className={inputClass()} />
                        </FieldLabel>
                        <FieldLabel label="Rate">
                          <input type="number" min={0} value={item.unit_price} onChange={(e) => updateItem(item.id, "unit_price", Math.max(0, Number(e.target.value) || 0))} className={inputClass()} />
                        </FieldLabel>
                        <FieldLabel label="GST %">
                          <input type="number" min={0} max={100} disabled={invoiceMode === "no_gst"} value={invoiceMode === "no_gst" ? 0 : item.tax_percent} onChange={(e) => updateItem(item.id, "tax_percent", Math.max(0, Number(e.target.value) || 0))} className={inputClass("disabled:opacity-50")} />
                        </FieldLabel>
                        <FieldLabel label="Discount %">
                          <input type="number" min={0} max={100} value={item.discount_percent} onChange={(e) => updateItem(item.id, "discount_percent", Math.min(100, Math.max(0, Number(e.target.value) || 0)))} className={inputClass()} />
                        </FieldLabel>
                        <FieldLabel label="Line Total">
                          <div className="flex h-14 items-center justify-between rounded-lg border border-cyan-400/20 bg-cyan-500/10 px-5 font-black text-cyan-200 sm:rounded-2xl">
                            {money(lineTotal)}
                          </div>
                        </FieldLabel>
                      </div>
                      <div className="mt-4 flex flex-col gap-3 text-xs text-neutral-500 md:flex-row md:items-center md:justify-between">
                        <div className="flex flex-wrap gap-3">
                          {product && <span>Stock {product.stock || 0}</span>}
                          {product?.batch_no && hasBatchTracking && <span>Batch {product.batch_no}</span>}
                          {product?.barcode && hasBarcodeScanning && <span>Barcode {product.barcode}</span>}
                          {product?.expiry_date && hasExpiryTracking && <span>Expiry {new Date(product.expiry_date).toLocaleDateString()}</span>}
                          {invoiceMode === "no_gst" && <span className="text-cyan-200">GST disabled for this bill</span>}
                        </div>
                        <button onClick={() => removeItem(item.id)} className="min-h-11 w-full rounded-lg border border-red-400/20 px-4 py-2 font-semibold text-red-300 md:w-fit md:rounded-xl">
                          Remove
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          <aside className="space-y-6">
            <div className="rounded-lg border border-cyan-400/20 bg-cyan-500/10 p-5 shadow-[0_0_60px_rgba(34,211,238,0.12)] sm:rounded-[36px] sm:p-7 lg:sticky lg:top-6">
              <h2 className="text-2xl font-black sm:text-3xl">Bill Summary</h2>
              <div className="mt-7 space-y-4 text-sm">
                <div className="flex justify-between"><span className="text-neutral-400">Mode</span><span>{invoiceMode === "no_gst" ? "Without GST" : "GST Bill"}</span></div>
                <div className="flex justify-between"><span className="text-neutral-400">Lines</span><span>{items.length}</span></div>
                <div className="flex justify-between"><span className="text-neutral-400">Quantity</span><span>{totalItems}</span></div>
                <div className="flex justify-between"><span className="text-neutral-400">Subtotal</span><span>{money(totals.subtotal)}</span></div>
                <div className="flex justify-between"><span className="text-neutral-400">Discount</span><span>{money(totals.discount)}</span></div>
                <div className="flex justify-between"><span className="text-neutral-400">Taxable Amount</span><span>{money(totals.taxableAmount)}</span></div>
                <div className="flex justify-between"><span className="text-neutral-400">GST</span><span>{money(totals.tax)}</span></div>
                <div className="border-t border-white/10 pt-5">
                  <div className="flex items-center justify-between text-2xl font-black">
                    <span>Total</span>
                    <span className="text-cyan-200">{money(totals.grandTotal)}</span>
                  </div>
                </div>
              </div>
              <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button onClick={() => void saveInvoice(false)} disabled={loading} className="h-14 rounded-lg bg-white text-base font-black text-black disabled:opacity-50 sm:h-16 sm:rounded-2xl sm:text-lg">
                  {loading ? "Saving..." : "Save Invoice"}
                </button>
                <button onClick={() => void saveInvoice(true)} disabled={loading} className="h-14 rounded-lg bg-gradient-to-r from-cyan-400 to-blue-600 text-base font-black text-black shadow-[0_20px_70px_rgba(34,211,238,0.28)] disabled:opacity-50 sm:h-16 sm:rounded-2xl sm:text-lg">
                  {loading ? "Saving..." : "Save & Print"}
                </button>
              </div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  )
}
