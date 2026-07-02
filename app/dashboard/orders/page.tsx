"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { useDebounce } from "use-debounce"
import { apiFetch } from "@/lib/api/client-fetch"
import { getOrganizationId } from "@/lib/getOrganization"
import { createOfflineId, getOfflineData, putOfflineData, queueOfflineAction } from "@/lib/offline/db"
import { offlineFallbackMessage, shouldSaveOffline } from "@/lib/offline/network"

type Product = {
  id: string
  name: string
  price: number | null
  sale_rate?: number | null
  stock: number | null
  sku?: string | null
}

type OrderRow = Record<string, unknown> & {
  id: string
  created_at?: string | null
}
type ListResponse<T> = {
  data?: T[]
  error?: string
}

type OrderItem = {
  product_id: string
  name: string
  quantity: number
  unit_price: number
  total: number
}

type OrderPayload = {
  customer_name: string
  customer_phone: string | null
  customer_address: string | null
  courier_name: string | null
  tracking_number: string | null
  payment_mode: string
  sales_channel: string
  items: Array<{
    product_id: string
    quantity: number
    unit_price: number
    total: number
  }>
}

function money(value: number) {
  return `Rs ${Math.round(value).toLocaleString()}`
}

function stringFrom(row: Record<string, unknown>, fields: string[]) {
  for (const field of fields) {
    const value = row[field]
    if (typeof value === "string" && value.trim()) return value
  }
  return ""
}

function numberFrom(row: Record<string, unknown>, fields: string[]) {
  for (const field of fields) {
    const value = row[field]
    if (value !== null && value !== undefined && value !== "") return Number(value || 0)
  }
  return 0
}

function csvCell(value: string | number | null) {
  const text = String(value ?? "")
  return `"${text.replaceAll("\"", "\"\"")}"`
}

function offlineOrderNumber(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0")
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `OFFLINE-ORD-${stamp}`
}

export default function OrdersPage() {
  const [organizationId, setOrganizationId] = useState("")
  const [products, setProducts] = useState<Product[]>([])
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [customerName, setCustomerName] = useState("")
  const [customerPhone, setCustomerPhone] = useState("")
  const [customerAddress, setCustomerAddress] = useState("")
  const [courierName, setCourierName] = useState("")
  const [trackingNumber, setTrackingNumber] = useState("")
  const [channel, setChannel] = useState("direct")
  const [paymentMode, setPaymentMode] = useState("cod")
  const [selectedProductId, setSelectedProductId] = useState("")
  const [quantity, setQuantity] = useState(1)
  const [items, setItems] = useState<OrderItem[]>([])
  const [search, setSearch] = useState("")
  const [debouncedSearch] = useDebounce(search, 300)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState("")

  async function initialize() {
    setLoading(true)
    const orgId = await getOrganizationId()

    if (!orgId) {
      setNotice("No business is connected to this account.")
      setLoading(false)
      return
    }

    setOrganizationId(orgId)
    await Promise.all([fetchProducts(orgId), fetchOrders(orgId)])
    setLoading(false)
  }

  async function fetchProducts(orgId = organizationId) {
    if (!orgId) return
    try {
      const response = await apiFetch("/api/products/list?limit=100", {
        credentials: "include",
        cache: "no-store",
      })
      const result = (await response.json()) as ListResponse<Product>

      if (!response.ok) throw new Error(result.error || "Products failed to load.")
      setProducts(result.data || [])
      await putOfflineData(orgId, "products", result.data || [])
      await putOfflineData(orgId, "inventory_items", result.data || [])
    } catch (error) {
      setProducts(await getOfflineData<Product[]>(orgId, "products", []))
      setNotice(shouldSaveOffline(error) ? offlineFallbackMessage("Offline mode: showing cached products.", "Connection failed. Showing cached products.") : error instanceof Error ? error.message : "Products failed to load.")
    }
  }

  async function fetchOrders(orgId = organizationId) {
    if (!orgId) return
    try {
      const response = await apiFetch("/api/orders/list?limit=100", {
        credentials: "include",
        cache: "no-store",
      })
      const result = (await response.json()) as ListResponse<OrderRow>

      if (!response.ok) throw new Error(result.error || "Orders failed to load.")
      setOrders(result.data || [])
      await putOfflineData(orgId, "orders", result.data || [])
    } catch (error) {
      setOrders(await getOfflineData<OrderRow[]>(orgId, "orders", []))
      setNotice(shouldSaveOffline(error) ? offlineFallbackMessage("Offline mode: showing cached orders.", "Connection failed. Showing cached orders.") : error instanceof Error ? error.message : "Orders failed to load.")
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      void initialize()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedProduct = useMemo(
    () => products.find((product) => product.id === selectedProductId),
    [products, selectedProductId]
  )

  const grandTotal = useMemo(() => items.reduce((acc, item) => acc + item.total, 0), [items])
  const totalQuantity = useMemo(() => items.reduce((acc, item) => acc + item.quantity, 0), [items])

  const filteredOrders = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase()
    if (!term) return orders

    return orders.filter((order) =>
      [
        stringFrom(order, ["order_number"]),
        stringFrom(order, ["customer_name"]),
        stringFrom(order, ["customer_phone"]),
        stringFrom(order, ["courier_name"]),
        stringFrom(order, ["tracking_number"]),
      ]
        .join(" ")
        .toLowerCase()
        .includes(term)
    )
  }, [debouncedSearch, orders])

  const analytics = useMemo(() => {
    const orderValue = orders.reduce((sum, order) => sum + numberFrom(order, ["total_amount", "grand_total", "total"]), 0)
    const todayOrders = orders.filter(
      (order) => order.created_at && new Date(order.created_at).toDateString() === new Date().toDateString()
    )
    const shippingOrders = orders.filter((order) => stringFrom(order, ["tracking_number", "courier_name"]))

    return {
      orderValue,
      todayOrders: todayOrders.length,
      shippingOrders: shippingOrders.length,
      averageOrder: orders.length ? orderValue / orders.length : 0,
    }
  }, [orders])

  function addItem() {
    if (!selectedProduct || quantity <= 0) return

    const availableStock = Number(selectedProduct.stock || 0)
    const existingQuantity = items.find((item) => item.product_id === selectedProduct.id)?.quantity || 0
    if (quantity + existingQuantity > availableStock) {
      setNotice("Quantity is higher than available stock.")
      return
    }

    const unitPrice = Number(selectedProduct.sale_rate ?? selectedProduct.price ?? 0)
    const existingItem = items.find((item) => item.product_id === selectedProduct.id)

    if (existingItem) {
      setItems((prev) =>
        prev.map((item) => {
          if (item.product_id !== selectedProduct.id) return item
          const updatedQuantity = item.quantity + quantity
          return { ...item, quantity: updatedQuantity, total: updatedQuantity * item.unit_price }
        })
      )
    } else {
      setItems((prev) => [
        ...prev,
        {
          product_id: selectedProduct.id,
          name: selectedProduct.name,
          quantity,
          unit_price: unitPrice,
          total: quantity * unitPrice,
        },
      ])
    }

    setSelectedProductId("")
    setQuantity(1)
  }

  function removeItem(productId: string) {
    setItems((prev) => prev.filter((item) => item.product_id !== productId))
  }

  async function createOrderOffline(orderPayload: OrderPayload) {
    const now = new Date().toISOString()
    const localOrderId = createOfflineId("order")
    const orderNumber = offlineOrderNumber()
    const cachedProducts = await getOfflineData<Product[]>(organizationId, "products", products)
    const cachedOrders = await getOfflineData<OrderRow[]>(organizationId, "orders", [])
    const cachedOrderItems = await getOfflineData<Record<string, unknown>[]>(organizationId, "order_items", [])
    const quantityByProductId = new Map<string, number>()

    orderPayload.items.forEach((item) => {
      quantityByProductId.set(item.product_id, (quantityByProductId.get(item.product_id) || 0) + item.quantity)
    })

    for (const [productId, requestedQuantity] of quantityByProductId) {
      const product = cachedProducts.find((item) => item.id === productId)
      if (!product) throw new Error("One or more products are not available offline.")
      if (Number(product.stock || 0) < requestedQuantity) {
        throw new Error(`${product.name} has only ${Number(product.stock || 0)} in stock.`)
      }
    }

    const nextProducts = cachedProducts.map((product) => {
      const orderedQuantity = quantityByProductId.get(product.id) || 0
      return orderedQuantity > 0
        ? { ...product, stock: Number(product.stock || 0) - orderedQuantity, sync_status: "pending_update" }
        : product
    })
    const orderRecord: OrderRow = {
      id: localOrderId,
      organization_id: organizationId,
      order_number: orderNumber,
      customer_name: orderPayload.customer_name,
      customer_phone: orderPayload.customer_phone,
      customer_address: orderPayload.customer_address,
      courier_name: orderPayload.courier_name,
      tracking_number: orderPayload.tracking_number,
      payment_mode: orderPayload.payment_mode,
      sales_channel: orderPayload.sales_channel,
      total_amount: grandTotal,
      grand_total: grandTotal,
      total: grandTotal,
      sync_status: "pending_create",
      created_at: now,
      updated_at: now,
    }
    const orderItemRecords = orderPayload.items.map((item) => ({
      id: createOfflineId("order-item"),
      organization_id: organizationId,
      order_id: localOrderId,
      product_id: item.product_id,
      quantity: item.quantity,
      unit_price: item.unit_price,
      total: item.total,
      sync_status: "pending_create",
      created_at: now,
      updated_at: now,
    }))

    await Promise.all([
      putOfflineData(organizationId, "products", nextProducts),
      putOfflineData(organizationId, "inventory_items", nextProducts),
      putOfflineData(organizationId, "orders", [orderRecord, ...cachedOrders]),
      putOfflineData(organizationId, "order_items", [...orderItemRecords, ...cachedOrderItems]),
      queueOfflineAction({
        id: createOfflineId("order-action"),
        type: "create_order",
        organizationId,
        payload: {
          localOrderId,
          order: {
            customer_name: orderPayload.customer_name,
            customer_phone: orderPayload.customer_phone,
            customer_address: orderPayload.customer_address,
            courier_name: orderPayload.courier_name,
            tracking_number: orderPayload.tracking_number,
            payment_mode: orderPayload.payment_mode,
            sales_channel: orderPayload.sales_channel,
          },
          items: orderPayload.items,
        },
      }),
    ])

    setOrders([orderRecord, ...cachedOrders])
    setProducts(nextProducts)
    setCustomerName("")
    setCustomerPhone("")
    setCustomerAddress("")
    setCourierName("")
    setTrackingNumber("")
    setChannel("direct")
    setPaymentMode("cod")
    setItems([])
    setNotice(`${orderNumber} saved on this device. It will update online when the connection returns.`)
  }

  async function createOrder() {
    if (!organizationId) {
      setNotice("Business not found.")
      return
    }
    if (!customerName.trim()) {
      setNotice("Customer name is required.")
      return
    }
    if (items.length === 0) {
      setNotice("Add at least one product.")
      return
    }

    setLoading(true)
    setNotice("")

    const orderPayload: OrderPayload = {
      customer_name: customerName.trim(),
      customer_phone: customerPhone.trim() || null,
      customer_address: customerAddress.trim() || null,
      courier_name: courierName.trim() || null,
      tracking_number: trackingNumber.trim() || null,
      payment_mode: paymentMode,
      sales_channel: channel,
      items: items.map((item) => ({
        product_id: item.product_id,
        quantity: item.quantity,
        unit_price: item.unit_price,
        total: item.total,
      })),
    }

    try {
      const response = await apiFetch("/api/orders/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(orderPayload),
      })
      const result = (await response.json()) as { error?: string }

      if (!response.ok) {
        setNotice(result.error || "Failed to create order.")
        setLoading(false)
        return
      }
    } catch (error) {
      if (shouldSaveOffline(error)) {
        try {
          await createOrderOffline(orderPayload)
        } catch (offlineError) {
          setNotice(offlineError instanceof Error ? offlineError.message : "Failed to save order offline.")
        }
        setLoading(false)
        return
      }

      setNotice(error instanceof Error ? error.message : "Failed to create order.")
      setLoading(false)
      return
    }

    setCustomerName("")
    setCustomerPhone("")
    setCustomerAddress("")
    setCourierName("")
    setTrackingNumber("")
    setChannel("direct")
    setPaymentMode("cod")
    setItems([])
    await fetchOrders()
    setNotice("Order created successfully.")
    setLoading(false)
  }

  function exportOrders() {
    const rows = filteredOrders.map((order) => [
      stringFrom(order, ["order_number"]),
      stringFrom(order, ["customer_name"]),
      stringFrom(order, ["customer_phone"]),
      stringFrom(order, ["courier_name"]),
      stringFrom(order, ["tracking_number"]),
      numberFrom(order, ["total_amount", "grand_total", "total"]),
      order.created_at ? new Date(order.created_at).toLocaleString() : "",
    ])
    const csv = [["Order", "Customer", "Phone", "Courier", "Tracking", "Amount", "Created"], ...rows]
      .map((row) => row.map((cell) => csvCell(cell as string | number | null)).join(","))
      .join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `orders-${new Date().toISOString().slice(0, 10)}.csv`
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

      <main className="relative z-10 mx-auto max-w-[1800px] space-y-8 px-5 py-6 lg:px-8">
        <section className="inventory-sheen rounded-[40px] border border-white/10 bg-white/[0.035] p-8 shadow-[0_0_90px_rgba(0,0,0,0.5)] backdrop-blur-2xl lg:p-10">
          <div className="flex flex-col gap-8 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="mb-5 inline-flex rounded-full border border-cyan-400/20 bg-cyan-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200">
                Fulfillment Operations
              </div>
              <h1 className="max-w-6xl text-4xl font-black leading-tight tracking-tight md:text-6xl">
                Orders, shipping, customer flow, and fulfillment control.
              </h1>
              <p className="mt-5 max-w-4xl text-lg leading-8 text-neutral-400">
                Create global-ready orders with products, stock visibility, customer delivery data,
                courier tracking, COD/payment channels, and export-ready operations.
              </p>
            </div>
            <div className="grid w-full gap-4 sm:grid-cols-2 xl:w-[420px]">
              <button
                onClick={exportOrders}
                className="min-h-[82px] rounded-[28px] border border-white/10 bg-white/[0.06] px-6 text-xl font-black transition-all duration-300 hover:-translate-y-1 hover:border-cyan-400/30"
              >
                Export Orders
              </button>
              <Link
                href="/dashboard/orders"
                className="flex min-h-[82px] items-center justify-center rounded-[28px] bg-gradient-to-r from-cyan-400 to-blue-600 px-6 text-center text-xl font-black text-black shadow-[0_20px_70px_rgba(34,211,238,0.3)]"
              >
                Label Center
              </Link>
            </div>
          </div>
        </section>

        {notice && (
          <div className="rounded-3xl border border-cyan-400/25 bg-cyan-500/10 px-6 py-4 text-sm text-cyan-100">
            {notice}
          </div>
        )}

        <section className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-4">
          {[
            ["Products", products.length, "text-white", "Order-ready catalog"],
            ["Order Value", money(analytics.orderValue), "text-cyan-200", `${orders.length} total orders`],
            ["Today", analytics.todayOrders, "text-emerald-200", "Same-day activity"],
            ["Shipping", analytics.shippingOrders, "text-blue-200", `AOV ${money(analytics.averageOrder)}`],
          ].map(([label, value, color, helper]) => (
            <div key={label} className="rounded-[32px] border border-white/10 bg-gradient-to-br from-zinc-950 via-black to-zinc-950 p-7">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">{label}</p>
              <p className={`mt-5 text-4xl font-black tracking-tight ${color}`}>{value}</p>
              <p className="mt-4 text-sm text-neutral-500">{helper}</p>
            </div>
          ))}
        </section>

        <section className="grid grid-cols-1 gap-6 2xl:grid-cols-[1fr,420px]">
          <div className="space-y-6 rounded-[36px] border border-white/10 bg-white/[0.035] p-7 backdrop-blur-2xl">
            <div>
              <h2 className="text-3xl font-black">Create Order</h2>
              <p className="mt-2 text-sm text-neutral-500">Customer, fulfillment, shipping, payment, and line items.</p>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Customer name" className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none focus:border-cyan-400/40" />
              <input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="Customer phone" className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none focus:border-cyan-400/40" />
              <input value={courierName} onChange={(e) => setCourierName(e.target.value)} placeholder="Courier name" className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none focus:border-cyan-400/40" />
              <input value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} placeholder="Tracking number" className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none focus:border-cyan-400/40" />
              <select value={channel} onChange={(e) => setChannel(e.target.value)} className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none">
                <option value="direct">Direct Sale</option>
                <option value="marketplace">Marketplace</option>
                <option value="website">Website</option>
                <option value="wholesale">Wholesale</option>
              </select>
              <select value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)} className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none">
                <option value="cod">Cash on Delivery</option>
                <option value="prepaid">Prepaid</option>
                <option value="upi">UPI</option>
                <option value="card">Card</option>
                <option value="bank_transfer">Bank Transfer</option>
              </select>
              <textarea value={customerAddress} onChange={(e) => setCustomerAddress(e.target.value)} placeholder="Customer delivery address" rows={4} className="md:col-span-2 rounded-2xl border border-white/10 bg-black/50 px-5 py-4 outline-none focus:border-cyan-400/40" />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr,160px,180px]">
              <select value={selectedProductId} onChange={(e) => setSelectedProductId(e.target.value)} className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none">
                <option value="">Select product</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name} {product.sku ? `- ${product.sku}` : ""} - {money(Number(product.sale_rate ?? product.price ?? 0))} ({product.stock || 0} stock)
                  </option>
                ))}
              </select>
              <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none" />
              <button onClick={addItem} className="h-14 rounded-2xl bg-white font-bold text-black">Add Product</button>
            </div>

            <div className="space-y-3">
              {items.map((item) => (
                <div key={item.product_id} className="flex flex-col gap-4 rounded-3xl border border-white/10 bg-black/40 p-5 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="font-bold text-white">{item.name}</p>
                    <p className="mt-1 text-sm text-neutral-500">Qty {item.quantity} x {money(item.unit_price)}</p>
                  </div>
                  <div className="flex items-center gap-5">
                    <p className="text-xl font-black text-cyan-200">{money(item.total)}</p>
                    <button onClick={() => removeItem(item.product_id)} className="rounded-xl border border-red-400/20 px-4 py-2 text-sm font-semibold text-red-300">
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <aside className="space-y-6">
            <div className="sticky top-6 rounded-[36px] border border-cyan-400/20 bg-cyan-500/10 p-7 shadow-[0_0_60px_rgba(34,211,238,0.12)]">
              <h2 className="text-3xl font-black">Order Summary</h2>
              <div className="mt-7 space-y-4 text-sm">
                <div className="flex justify-between"><span className="text-neutral-400">Lines</span><span>{items.length}</span></div>
                <div className="flex justify-between"><span className="text-neutral-400">Quantity</span><span>{totalQuantity}</span></div>
                <div className="flex justify-between"><span className="text-neutral-400">Channel</span><span className="capitalize">{channel}</span></div>
                <div className="border-t border-white/10 pt-5">
                  <div className="flex items-center justify-between text-2xl font-black">
                    <span>Total</span>
                    <span className="text-cyan-200">{money(grandTotal)}</span>
                  </div>
                </div>
              </div>
              <button
                onClick={createOrder}
                disabled={loading}
                className="mt-7 h-16 w-full rounded-2xl bg-gradient-to-r from-cyan-400 to-blue-600 text-lg font-black text-black shadow-[0_20px_70px_rgba(34,211,238,0.3)] disabled:opacity-50"
              >
                {loading ? "Saving..." : "Create Order"}
              </button>
            </div>
          </aside>
        </section>

        <section className="overflow-hidden rounded-[36px] border border-white/10 bg-gradient-to-br from-zinc-950/95 to-black">
          <div className="flex flex-col gap-4 border-b border-white/10 p-6 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-3xl font-black">Order Register</h2>
              <p className="mt-2 text-sm text-neutral-500">{filteredOrders.length} orders visible.</p>
            </div>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search orders, customer, tracking..." className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none md:w-[420px]" />
          </div>
          <div className="divide-y divide-white/5">
            {filteredOrders.map((order) => (
              <div key={order.id} className="grid gap-4 px-6 py-5 md:grid-cols-[1fr,180px,180px,150px] md:items-center">
                <div>
                  <p className="font-bold text-white">{stringFrom(order, ["order_number"]) || "Order"}</p>
                  <p className="mt-1 text-sm text-neutral-500">{stringFrom(order, ["customer_name"]) || "Customer"} - {stringFrom(order, ["customer_phone"]) || "No phone"}</p>
                </div>
                <p className="text-sm text-neutral-400">{stringFrom(order, ["courier_name"]) || "No courier"}</p>
                <p className="text-xl font-black text-cyan-200">{money(numberFrom(order, ["total_amount", "grand_total", "total"]))}</p>
                <p className="text-right text-sm text-neutral-500">{order.created_at ? new Date(order.created_at).toLocaleDateString() : "-"}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}
