"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"

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

export default function Dashboard() {
    const [dashboard, setDashboard] = useState<DashboardState>(emptyDashboard)
    const [loading, setLoading] = useState(true)
    const [notice, setNotice] = useState("")

    async function loadDashboard() {
        try {
            setLoading(true)
            const response = await fetch("/api/dashboard/summary", {
                credentials: "include",
                cache: "no-store",
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
            setNotice(error instanceof Error ? error.message : "Dashboard failed to load.")
        } finally {
            setLoading(false)
        }
    }

    useEffect(() => {
        loadDashboard()
    }, [])

    const metrics = useMemo(
        () => ({ ...dashboard.summaryMetrics, lowStockProducts: dashboard.lowStockProducts }),
        [dashboard.lowStockProducts, dashboard.summaryMetrics]
    )

    const maxWeeklyRevenue = Math.max(1, ...metrics.weeklyRevenue.map((item) => item.value))
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
            label: "ERP Health",
            value: `${metrics.erpHealth}%`,
            meta: `${metrics.fulfillmentRate}% fulfillment`,
            accent: "from-amber-200 to-yellow-500",
            valueClass: "text-amber-200",
            href: "/dashboard/reports",
        },
    ]

    const operationLinks = [
        ["Create Invoice", "/dashboard/invoices/create", "Billing"],
        ["Manage Products", "/dashboard/products", "Catalog"],
        ["Inventory Hub", "/dashboard/inventory", "Warehouse"],
        ["Customers", "/dashboard/customers", "CRM"],
        ["Orders", "/dashboard/orders", "Fulfillment"],
        ["Reports", "/dashboard/reports", "Analytics"],
    ]

    const readiness = [
        {
            label: "Tenant data isolation",
            status: "Needs RLS audit",
            ok: false,
        },
        {
            label: "Invoice schema consistency",
            status: "Standardize totals",
            ok: false,
        },
        {
            label: "Inventory and billing data",
            status: loading ? "Syncing" : "Live",
            ok: !loading,
        },
        {
            label: "Global tax and currency",
            status: "Roadmap",
            ok: false,
        },
    ]

    return (
        <div className="inventory-grid-bg min-h-full overflow-x-hidden text-white">
            <div className="mx-auto max-w-[1900px] space-y-6 px-3 py-4 sm:px-5 lg:px-6">
                {loading && (
                    <div className="fixed right-6 top-24 z-50 rounded-full border border-white/10 bg-black/80 px-4 py-2 shadow-2xl backdrop-blur">
                        <div className="flex items-center gap-3">
                            <div className="h-4 w-4 rounded-full border-2 border-neutral-600 border-t-sky-300 animate-spin" />
                            <span className="text-sm text-neutral-300">Syncing dashboard</span>
                        </div>
                    </div>
                )}

                <section className="relative overflow-hidden rounded-lg border border-white/10 bg-black/70 p-6 shadow-2xl backdrop-blur-xl inventory-sheen lg:p-8">
                    <div className="relative z-10 grid gap-8 2xl:grid-cols-[1.1fr_0.9fr] 2xl:items-end">
                        <div>
                            <div className="flex flex-wrap gap-3">
                                <span className="rounded-full border border-sky-400/25 bg-sky-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-sky-200">
                                    Global ERP Command Center
                                </span>
                                <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-200">
                                    Inventory + Billing + CRM
                                </span>
                            </div>
                            <h1 className="mt-5 max-w-5xl text-4xl font-black tracking-tight md:text-6xl">
                                Operations Dashboard
                            </h1>
                            <p className="mt-4 max-w-4xl text-base leading-7 text-neutral-300">
                                Live business control for {dashboard.organizationName}: stock,
                                billing, orders, collections, customers, warehouse activity,
                                and global launch readiness.
                            </p>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-3">
                            {[
                                [`${metrics.erpHealth}%`, "ERP health"],
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

                <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
                    {kpiCards.map((card) => (
                        <Link
                            key={card.label}
                            href={card.href}
                            className="group relative flex min-h-[170px] flex-col overflow-hidden rounded-lg border border-white/10 bg-black/70 p-5 shadow-xl backdrop-blur transition-all duration-300 hover:-translate-y-1 hover:border-white/20"
                        >
                            <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${card.accent}`} />
                            <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">
                                {card.label}
                            </p>
                            <h2 className={`mt-5 text-4xl font-black tracking-tight ${card.valueClass}`}>
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
                                Global Launch Readiness
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
                                View hub
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
