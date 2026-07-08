"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import AppUpdateBanner from "@/components/AppUpdateBanner"
import { apiFetch } from "@/lib/api/client-fetch"
import { getCachedWorkspaceBootstrap, getOfflineData } from "@/lib/offline/db"

type AnyRow = Record<string, unknown>

type ProductRow = {
    id: string
    name: string | null
    sku: string | null
    category: string | null
    stock: number | null
    min_stock: number | null
    sale_rate: number | null
    purchase_rate: number | null
    price: number | null
    created_at: string | null
}

type DashboardState = {
    organizationName: string
    products: ProductRow[]
    invoices: AnyRow[]
    movements: AnyRow[]
    lowStockProducts: ProductRow[]
    counts: {
        products: number
        customers: number
        invoices: number
        warehouses: number
        orders: number
    }
    summaryMetrics: {
        totalRevenue: number
        todayRevenue: number
        paidRevenue: number
        pendingInvoices: number
        lowStockCount: number
        outOfStockCount: number
        inventoryValue: number
        costValue: number
        potentialProfit: number
        pendingOrders: number
        fulfillmentRate: number
        inventoryHealth: number
        collectionRate: number
        erpHealth: number
        weeklyRevenue: Array<{ label: string; value: number }>
    }
}

const weekLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

const emptyDashboard: DashboardState = {
    organizationName: "Business",
    products: [],
    invoices: [],
    movements: [],
    lowStockProducts: [],
    counts: {
        products: 0,
        customers: 0,
        invoices: 0,
        warehouses: 0,
        orders: 0,
    },
    summaryMetrics: {
        totalRevenue: 0,
        todayRevenue: 0,
        paidRevenue: 0,
        pendingInvoices: 0,
        lowStockCount: 0,
        outOfStockCount: 0,
        inventoryValue: 0,
        costValue: 0,
        potentialProfit: 0,
        pendingOrders: 0,
        fulfillmentRate: 0,
        inventoryHealth: 100,
        collectionRate: 0,
        erpHealth: 0,
        weeklyRevenue: weekLabels.map((label) => ({ label, value: 0 })),
    },
}

function numberFrom(row: AnyRow, fields: string[]) {
    for (const field of fields) {
        const value = row[field]
        if (value !== null && value !== undefined && value !== "") {
            return Number(value || 0)
        }
    }

    return 0
}

function stringFrom(row: AnyRow, fields: string[]) {
    for (const field of fields) {
        const value = row[field]
        if (typeof value === "string" && value.trim()) return value
    }

    return ""
}

function money(value: number) {
    return `Rs ${Math.round(value).toLocaleString()}`
}

function formatDate(value: unknown) {
    if (typeof value !== "string" || !value) return "-"
    return new Date(value).toLocaleDateString()
}

function statusText(value: unknown) {
    return typeof value === "string" && value ? value.replaceAll("_", " ") : "active"
}

function startOfWeek(date: Date) {
    const start = new Date(date)
    const day = start.getDay() || 7
    start.setDate(start.getDate() - day + 1)
    start.setHours(0, 0, 0, 0)
    return start
}

export default function Dashboard() {
    const [dashboard, setDashboard] = useState<DashboardState>(emptyDashboard)
    const [loading, setLoading] = useState(true)
    const [notice, setNotice] = useState("")
    const dashboardRequestRef = useRef<AbortController | null>(null)
    const lastDashboardLoadRef = useRef(0)

    const loadDashboard = useCallback(async (options: { silent?: boolean; force?: boolean } = {}) => {
        const now = Date.now()
        if (!options.force && dashboardRequestRef.current) return
        if (!options.force && options.silent && now - lastDashboardLoadRef.current < 60000) return

        dashboardRequestRef.current?.abort()
        const controller = new AbortController()
        dashboardRequestRef.current = controller
        lastDashboardLoadRef.current = now

        try {
            if (!options.silent) setLoading(true)
            const response = await apiFetch("/api/dashboard/summary", {
                credentials: "include",
                cache: "no-store",
                signal: controller.signal,
            })
            const payload = await response.json()

            if (!response.ok) {
                setNotice(payload.error || "Dashboard failed to load.")
                return
            }

            setDashboard({
                organizationName: payload.workspace?.organizationName || "Business",
                products: (payload.recentProducts || []) as ProductRow[],
                invoices: (payload.recentInvoices || []) as AnyRow[],
                movements: (payload.recentMovements || []) as AnyRow[],
                lowStockProducts: (payload.lowStockProducts || []) as ProductRow[],
                counts: {
                    products: Number(payload.metrics?.productCount || 0),
                    customers: Number(payload.metrics?.customerCount || 0),
                    invoices: Number(payload.metrics?.invoiceCount || 0),
                    warehouses: Number(payload.metrics?.warehouseCount || 0),
                    orders: Number(payload.metrics?.orderCount || 0),
                },
                summaryMetrics: {
                    ...emptyDashboard.summaryMetrics,
                    ...(payload.metrics || {}),
                },
            })
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") return
            const cached = getCachedWorkspaceBootstrap()
            const organizationId = cached?.organization?.id || cached?.membership?.organization_id || null

            if (!organizationId) {
                setNotice(error instanceof Error ? error.message : "Dashboard failed to load.")
                return
            }

            const [products, customers, invoices, orders, movements] = await Promise.all([
                getOfflineData<ProductRow[]>(organizationId, "products", []),
                getOfflineData<AnyRow[]>(organizationId, "customers", []),
                getOfflineData<AnyRow[]>(organizationId, "invoices", []),
                getOfflineData<AnyRow[]>(organizationId, "orders", []),
                getOfflineData<AnyRow[]>(organizationId, "stock_movements", []),
            ])
            const today = new Date()
            const weekStart = startOfWeek(today)
            const lowStockProducts = products.filter((product) => Number(product.stock || 0) <= Number(product.min_stock ?? 5))
            const outOfStockProducts = products.filter((product) => Number(product.stock || 0) <= 0)
            const totalRevenue = invoices.reduce((sum, invoice) => sum + numberFrom(invoice, ["grand_total", "total_amount", "total"]), 0)
            const todayRevenue = invoices
                .filter((invoice) => stringFrom(invoice, ["created_at", "date"]).slice(0, 10) === today.toISOString().slice(0, 10))
                .reduce((sum, invoice) => sum + numberFrom(invoice, ["grand_total", "total_amount", "total"]), 0)
            const paidRevenue = invoices
                .filter((invoice) => stringFrom(invoice, ["payment_status", "status"]).toLowerCase() === "paid")
                .reduce((sum, invoice) => sum + numberFrom(invoice, ["grand_total", "total_amount", "total"]), 0)
            const inventoryValue = products.reduce((sum, product) => sum + Number(product.stock || 0) * Number(product.sale_rate || product.price || 0), 0)
            const costValue = products.reduce((sum, product) => sum + Number(product.stock || 0) * Number(product.purchase_rate || 0), 0)
            const weeklyRevenue = weekLabels.map((label, index) => {
                const day = new Date(weekStart)
                day.setDate(weekStart.getDate() + index)
                const dayKey = day.toISOString().slice(0, 10)
                const value = invoices
                    .filter((invoice) => stringFrom(invoice, ["created_at", "date"]).slice(0, 10) === dayKey)
                    .reduce((sum, invoice) => sum + numberFrom(invoice, ["grand_total", "total_amount", "total"]), 0)
                return { label, value }
            })
            const pendingInvoices = invoices.filter((invoice) => {
                const status = stringFrom(invoice, ["payment_status", "status"]).toLowerCase()
                return status && status !== "paid" && status !== "cancelled"
            }).length
            const inventoryHealth = products.length ? Math.round(((products.length - lowStockProducts.length) / products.length) * 100) : 100
            const collectionRate = totalRevenue ? Math.round((paidRevenue / totalRevenue) * 100) : 0

            setDashboard({
                organizationName: cached?.organization?.name || "Business",
                products: products.slice(0, 5),
                invoices: invoices.slice(0, 5),
                movements: movements.slice(0, 6),
                lowStockProducts,
                counts: {
                    products: products.length,
                    customers: customers.length,
                    invoices: invoices.length,
                    warehouses: 0,
                    orders: orders.length,
                },
                summaryMetrics: {
                    ...emptyDashboard.summaryMetrics,
                    totalRevenue,
                    todayRevenue,
                    paidRevenue,
                    pendingInvoices,
                    lowStockCount: lowStockProducts.length,
                    outOfStockCount: outOfStockProducts.length,
                    inventoryValue,
                    costValue,
                    potentialProfit: inventoryValue - costValue,
                    pendingOrders: orders.filter((order) => stringFrom(order, ["status"]).toLowerCase() === "pending").length,
                    fulfillmentRate: 0,
                    inventoryHealth,
                    collectionRate,
                    erpHealth: Math.round((inventoryHealth + collectionRate) / 2),
                    weeklyRevenue,
                },
            })
            setNotice(
                typeof navigator !== "undefined" && !navigator.onLine
                    ? "Offline mode: dashboard loaded from local data."
                    : error instanceof Error ? error.message : "Dashboard loaded from local cache."
            )
        } finally {
            if (dashboardRequestRef.current === controller) dashboardRequestRef.current = null
            if (!options.silent) setLoading(false)
        }
    }, [])

    useEffect(() => {
        void loadDashboard({ force: true })
    }, [loadDashboard])

    useEffect(() => {
        const refreshOnFocus = () => {
            if (document.visibilityState === "hidden") return
            void loadDashboard({ silent: true })
        }

        window.addEventListener("focus", refreshOnFocus)
        document.addEventListener("visibilitychange", refreshOnFocus)

        return () => {
            window.removeEventListener("focus", refreshOnFocus)
            document.removeEventListener("visibilitychange", refreshOnFocus)
        }
    }, [loadDashboard])

    const metrics = useMemo(
        () => ({ ...dashboard.summaryMetrics, lowStockProducts: dashboard.lowStockProducts }),
        [dashboard.lowStockProducts, dashboard.summaryMetrics]
    )

    const maxWeeklyRevenue = Math.max(1, ...metrics.weeklyRevenue.map((item) => item.value))
    const hasWeeklyRevenue = metrics.weeklyRevenue.some((item) => item.value > 0)
    const recentProducts = dashboard.products.slice(0, 5)
    const recentInvoices = dashboard.invoices.slice(0, 5)
    const recentMovements = dashboard.movements.slice(0, 6)

    const kpiCards = [
        {
            label: "Revenue",
            value: money(metrics.totalRevenue),
            meta: `${money(metrics.todayRevenue)} today`,
            accent: "from-emerald-200 to-green-500",
            valueClass: "text-emerald-200",
            href: "/dashboard/invoices",
        },
        {
            label: "Inventory Value",
            value: money(metrics.inventoryValue),
            meta: `${money(metrics.potentialProfit)} potential margin`,
            accent: "from-sky-200 to-blue-500",
            valueClass: "text-sky-200",
            href: "/dashboard/inventory",
        },
        {
            label: "Products",
            value: dashboard.counts.products,
            meta: `${metrics.lowStockCount} low stock`,
            accent: "from-white to-neutral-400",
            valueClass: "text-white",
            href: "/dashboard/products",
        },
        {
            label: "Customers",
            value: dashboard.counts.customers,
            meta: `${dashboard.counts.invoices} invoices`,
            accent: "from-cyan-200 to-blue-500",
            valueClass: "text-cyan-200",
            href: "/dashboard/customers",
        },
        {
            label: "Business Health",
            value: `${metrics.erpHealth}%`,
            meta: `${metrics.fulfillmentRate}% fulfillment`,
            accent: "from-amber-200 to-yellow-500",
            valueClass: "text-amber-200",
            href: "/dashboard/charts",
        },
    ]

    const operationLinks = [
        ["Create Invoice", "/dashboard/invoices/create", "Billing"],
        ["Products", "/dashboard/products", "Stock list"],
        ["Stock", "/dashboard/inventory", "Inventory"],
        ["Customers", "/dashboard/customers", "Customer list"],
        ["Orders", "/dashboard/orders", "Delivery"],
        ["Reports", "/dashboard/charts", "Analytics"],
    ]

    const readiness = [
        {
            label: "Business data ready",
            status: "Stored for this workspace",
            ok: true,
        },
        {
            label: "Invoices and totals",
            status: dashboard.counts.invoices > 0 ? "Ready" : "Add first invoice",
            ok: dashboard.counts.invoices > 0,
        },
        {
            label: "Stock and billing data",
            status: loading ? "Updating" : "Ready",
            ok: !loading,
        },
        {
            label: "Currency",
            status: "Configured",
            ok: true,
        },
    ]

    const setupSteps = [
        {
            label: "Business created",
            helper: dashboard.organizationName,
            href: "/dashboard/settings",
            done: true,
        },
        {
            label: "Add products",
            helper: "Create your stock list",
            href: "/dashboard/products",
            done: dashboard.counts.products > 0,
        },
        {
            label: "Add customers",
            helper: "Save regular buyers",
            href: "/dashboard/customers",
            done: dashboard.counts.customers > 0,
        },
        {
            label: "Create first invoice",
            helper: "Start billing",
            href: "/dashboard/invoices/create",
            done: dashboard.counts.invoices > 0,
        },
    ]
    const showSetupGuide = setupSteps.some((step) => !step.done)

    return (
        <div className="inventory-grid-bg min-h-full overflow-x-hidden text-white">
            <div className="mx-auto max-w-[1900px] space-y-6 px-3 py-4 sm:px-5 lg:px-6">
                {loading && (
                    <div className="fixed right-6 top-24 z-50 rounded-full border border-white/10 bg-black/80 px-4 py-2 shadow-2xl backdrop-blur">
                        <div className="flex items-center gap-3">
                            <div className="h-4 w-4 rounded-full border-2 border-neutral-600 border-t-sky-300 animate-spin" />
                            <span className="text-sm text-neutral-300">Updating dashboard</span>
                        </div>
                    </div>
                )}
                <AppUpdateBanner />

                <section className="relative overflow-hidden rounded-lg border border-white/10 bg-black/70 p-6 shadow-2xl backdrop-blur-xl inventory-sheen lg:p-8">
                    <div className="relative z-10 grid gap-8 2xl:grid-cols-[1.1fr_0.9fr] 2xl:items-end">
                        <div>
                            <div className="flex flex-wrap gap-3">
                                <span className="rounded-full border border-sky-400/25 bg-sky-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-sky-200">
                                    Business Overview
                                </span>
                                <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-200">
                                    Stock + Billing + Customers
                                </span>
                            </div>
                            <h1 className="mt-5 max-w-5xl text-3xl font-black tracking-tight sm:text-4xl md:text-6xl">
                                Operations Dashboard
                            </h1>
                            <p className="mt-4 max-w-4xl text-base leading-7 text-neutral-300">
                                Live business control for {dashboard.organizationName}: sales,
                                stock, collections, customers, orders, and daily activity.
                            </p>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-3">
                            {[
                                [`${metrics.erpHealth}%`, "business health"],
                                [`${dashboard.counts.warehouses}`, "warehouses"],
                                [`${metrics.pendingInvoices}`, "pending bills"],
                            ].map(([value, label]) => (
                                <div
                                    key={label}
                                    className="rounded-lg border border-white/10 bg-white/[0.04] p-5 transition-all duration-300 hover:-translate-y-1 hover:border-sky-300/30"
                                >
                                    <p className="text-3xl font-black">{value}</p>
                                    <p className="mt-2 text-xs uppercase tracking-[0.16em] text-neutral-500">
                                        {label}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="relative z-10 mt-7 grid gap-3 border-t border-white/10 pt-5 md:grid-cols-3 xl:grid-cols-6">
                        {operationLinks.map(([label, href, meta]) => (
                            <Link
                                key={href}
                                href={href}
                                className="rounded-lg border border-white/10 bg-white/[0.05] px-4 py-4 transition-all duration-300 hover:-translate-y-1 hover:border-sky-300/40 hover:bg-white/[0.08]"
                            >
                                <p className="font-bold">{label}</p>
                                <p className="mt-1 text-xs uppercase tracking-[0.16em] text-neutral-500">
                                    {meta}
                                </p>
                            </Link>
                        ))}
                    </div>

                    {notice && (
                        <div className="relative z-10 mt-5 rounded-lg border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
                            {notice}
                        </div>
                    )}
                </section>

                {showSetupGuide && (
                    <section className="rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] p-5 shadow-2xl backdrop-blur-xl">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <p className="text-xs font-black uppercase tracking-[0.18em] text-emerald-200">2-minute setup</p>
                                <h2 className="mt-2 text-2xl font-black text-white">Get ready to create your first bill</h2>
                                <p className="mt-2 text-sm leading-6 text-neutral-400">
                                    Complete these basics once. Bezgrow will feel much faster after products and customers are saved.
                                </p>
                            </div>
                            <Link href="/dashboard/invoices/create" className="flex h-12 items-center justify-center rounded-lg bg-white px-5 text-sm font-black text-black">
                                Start Billing
                            </Link>
                        </div>
                        <div className="mt-5 grid gap-3 md:grid-cols-4">
                            {setupSteps.map((step, index) => (
                                <Link
                                    key={step.label}
                                    href={step.href}
                                    className={`rounded-lg border p-4 transition-all hover:-translate-y-1 ${step.done ? "border-emerald-400/20 bg-emerald-400/10" : "border-white/10 bg-black/35 hover:border-emerald-300/30"}`}
                                >
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-xs font-black uppercase tracking-[0.16em] text-neutral-500">Step {index + 1}</span>
                                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-black ${step.done ? "bg-emerald-300 text-black" : "bg-white/10 text-white"}`}>
                                            {step.done ? "Done" : "Next"}
                                        </span>
                                    </div>
                                    <p className="mt-4 font-black text-white">{step.label}</p>
                                    <p className="mt-2 text-xs text-neutral-500">{step.helper}</p>
                                </Link>
                            ))}
                        </div>
                    </section>
                )}

                <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
                    {kpiCards.map((card) => (
                        <Link
                            key={card.label}
                            href={card.href}
                            className="group relative flex min-h-[148px] flex-col overflow-hidden rounded-lg border border-white/10 bg-black/70 p-4 shadow-xl backdrop-blur transition-all duration-300 hover:-translate-y-1 hover:border-white/20 sm:min-h-[170px] sm:p-5"
                        >
                            <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${card.accent}`} />
                            <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">
                                {card.label}
                            </p>
                            <h2 className={`mt-4 text-3xl font-black tracking-tight sm:mt-5 sm:text-4xl ${card.valueClass}`}>
                                {card.value}
                            </h2>
                            <p className="mt-auto pt-5 text-xs text-neutral-500">{card.meta}</p>
                        </Link>
                    ))}
                </section>

                <section className="grid grid-cols-1 gap-6 2xl:grid-cols-[1.45fr_0.8fr]">
                    <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                        <div className="flex flex-col gap-4 border-b border-white/10 pb-5 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <p className="text-xs uppercase tracking-[0.18em] text-emerald-300">
                                    Revenue Intelligence
                                </p>
                                <h2 className="mt-2 text-2xl font-black">
                                    Weekly Billing Flow
                                </h2>
                            </div>
                            <div className="grid grid-cols-3 gap-3 text-center">
                                <div className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3">
                                    <p className="text-sm font-black text-emerald-200">
                                        {metrics.collectionRate}%
                                    </p>
                                    <p className="text-[10px] uppercase tracking-[0.12em] text-neutral-500">
                                        collection
                                    </p>
                                </div>
                                <div className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3">
                                    <p className="text-sm font-black text-sky-200">
                                        {metrics.inventoryHealth}%
                                    </p>
                                    <p className="text-[10px] uppercase tracking-[0.12em] text-neutral-500">
                                        stock
                                    </p>
                                </div>
                                <div className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3">
                                    <p className="text-sm font-black text-amber-200">
                                        {metrics.fulfillmentRate}%
                                    </p>
                                    <p className="text-[10px] uppercase tracking-[0.12em] text-neutral-500">
                                        orders
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="mt-6 h-[300px] rounded-lg border border-white/10 bg-white/[0.03] p-5">
                            {hasWeeklyRevenue ? (
                                <div className="flex h-full items-end gap-3">
                                    {metrics.weeklyRevenue.map((item) => (
                                        <div key={item.label} className="flex h-full flex-1 flex-col justify-end gap-3">
                                            <div className="flex flex-1 items-end">
                                                <div
                                                    className="w-full rounded-t-lg bg-gradient-to-t from-sky-500 via-cyan-300 to-emerald-200 shadow-lg shadow-sky-500/20 transition-all duration-700 hover:opacity-80"
                                                    style={{
                                                        height: `${Math.max(8, (item.value / maxWeeklyRevenue) * 100)}%`,
                                                    }}
                                                    title={`${item.label}: ${money(item.value)}`}
                                                />
                                            </div>
                                            <p className="text-center text-xs uppercase tracking-[0.14em] text-neutral-500">
                                                {item.label}
                                            </p>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="flex h-full flex-col items-center justify-center rounded-lg border border-dashed border-white/10 bg-black/25 text-center">
                                    <p className="text-lg font-black text-white">No weekly billing yet</p>
                                    <p className="mt-2 max-w-md text-sm text-neutral-500">
                                        Create invoices and this chart will show day-wise billing movement automatically.
                                    </p>
                                    <Link href="/dashboard/invoices/create" className="mt-5 rounded-lg bg-white px-4 py-2 text-sm font-black text-black">
                                        Create invoice
                                    </Link>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="space-y-6">
                        <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                            <p className="text-xs uppercase tracking-[0.18em] text-red-300">
                                Attention Required
                            </p>
                            <div className="mt-4 space-y-3">
                                {metrics.lowStockProducts.slice(0, 5).map((product) => (
                                    <Link
                                        key={product.id}
                                        href="/dashboard/products"
                                        className="flex items-center justify-between rounded-lg border border-red-400/20 bg-red-400/10 p-4"
                                    >
                                        <div className="min-w-0">
                                            <p className="truncate font-semibold">{product.name || "Product"}</p>
                                            <p className="text-xs text-neutral-500">
                                                SKU {product.sku || "N/A"}
                                            </p>
                                        </div>
                                        <p className="text-xl font-black text-red-200">
                                            {product.stock || 0}
                                        </p>
                                    </Link>
                                ))}
                                {metrics.lowStockProducts.length === 0 && (
                                    <p className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">
                                        No low-stock products right now.
                                    </p>
                                )}
                            </div>
                        </div>

                        <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                            <p className="text-xs uppercase tracking-[0.18em] text-sky-300">
                                Business Safety
                            </p>
                            <div className="mt-4 space-y-3">
                                {readiness.map((item) => (
                                    <div
                                        key={item.label}
                                        className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.04] p-4"
                                    >
                                        <div>
                                            <p className="font-semibold">{item.label}</p>
                                            <p className="text-xs text-neutral-500">{item.status}</p>
                                        </div>
                                        <span className={`h-3 w-3 rounded-full ${item.ok ? "bg-emerald-300" : "bg-amber-300"}`} />
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </section>

                <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
                    <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                        <div className="flex items-center justify-between">
                            <h2 className="text-xl font-black">Recent Products</h2>
                            <Link href="/dashboard/products" className="text-sm text-sky-200 hover:text-sky-100">
                                View all
                            </Link>
                        </div>
                        <div className="mt-4 space-y-3">
                            {recentProducts.length === 0 && (
                                <p className="rounded-lg border border-white/10 bg-white/[0.03] p-5 text-neutral-500">
                                    No products added yet.
                                </p>
                            )}
                            {recentProducts.map((product) => (
                                <div key={product.id} className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                    <p className="font-semibold">{product.name || "Product"}</p>
                                    <p className="mt-1 text-xs text-neutral-500">
                                        Stock {product.stock || 0} | {product.category || "General"}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                        <div className="flex items-center justify-between">
                            <h2 className="text-xl font-black">Recent Invoices</h2>
                            <Link href="/dashboard/invoices" className="text-sm text-sky-200 hover:text-sky-100">
                                View all
                            </Link>
                        </div>
                        <div className="mt-4 space-y-3">
                            {recentInvoices.length === 0 && (
                                <p className="rounded-lg border border-white/10 bg-white/[0.03] p-5 text-neutral-500">
                                    No invoices generated yet.
                                </p>
                            )}
                            {recentInvoices.map((invoice) => (
                                <div key={String(invoice.id)} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                    <div>
                                        <p className="font-semibold">
                                            {stringFrom(invoice, ["invoice_number"]) || "Invoice"}
                                        </p>
                                        <p className="mt-1 text-xs text-neutral-500">
                                            {formatDate(invoice.created_at)}
                                        </p>
                                    </div>
                                    <p className="font-black text-emerald-200">
                                        {money(numberFrom(invoice, ["grand_total", "total_amount", "total"]))}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                        <div className="flex items-center justify-between">
                            <h2 className="text-xl font-black">Stock Activity</h2>
                            <Link href="/dashboard/inventory" className="text-sm text-sky-200 hover:text-sky-100">
                                View stock
                            </Link>
                        </div>
                        <div className="mt-4 space-y-3">
                            {recentMovements.length === 0 && (
                                <p className="rounded-lg border border-white/10 bg-white/[0.03] p-5 text-neutral-500">
                                    No stock activity recorded yet.
                                </p>
                            )}
                            {recentMovements.map((movement) => (
                                <div key={String(movement.id)} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                    <div>
                                        <p className="font-semibold capitalize">
                                            {statusText(movement.type)}
                                        </p>
                                        <p className="mt-1 text-xs text-neutral-500">
                                            {formatDate(movement.created_at)}
                                        </p>
                                    </div>
                                    <p className={Number(movement.quantity || 0) < 0 ? "font-black text-red-200" : "font-black text-emerald-200"}>
                                        {Number(movement.quantity || 0) > 0 ? "+" : ""}
                                        {Number(movement.quantity || 0)}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>
            </div>
        </div>
    )
}
