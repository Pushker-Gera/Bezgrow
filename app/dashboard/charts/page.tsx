"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import {
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    Line,
    LineChart,
    Pie,
    PieChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
    type PieLabelRenderProps,
} from "recharts"
import { apiFetch } from "@/lib/api/client-fetch"
import { getOrganizationId } from "@/lib/getOrganization"

type AnyRow = Record<string, unknown>

type ProductRow = {
    id: string
    name: string | null
    category: string | null
    stock: number | null
    min_stock: number | null
    sale_rate: number | null
    purchase_rate: number | null
    price: number | null
    expiry_date: string | null
}

type AnalyticsState = {
    products: ProductRow[]
    invoices: AnyRow[]
    customers: AnyRow[]
}

type ListResponse<T> = {
    data?: T[]
    error?: string
}

const emptyState: AnalyticsState = {
    products: [],
    invoices: [],
    customers: [],
}

const chartColors = ["#38bdf8", "#34d399", "#fbbf24", "#fb7185", "#a78bfa"]
const statusColors: Record<string, string> = {
    Healthy: "#34d399",
    "Low Stock": "#fbbf24",
    Valid: "#34d399",
    "Expiring Soon": "#fbbf24",
    Expired: "#fb7185",
}
const weekLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const darkTooltipProps = {
    contentStyle: {
        background: "#050606",
        border: "1px solid #64748b",
        borderRadius: 8,
        color: "#f8fafc",
        boxShadow: "0 12px 36px rgba(0,0,0,.55)",
    },
    labelStyle: { color: "#ffffff", fontWeight: 800 },
    itemStyle: { color: "#f8fafc" },
    wrapperStyle: { zIndex: 60, maxWidth: "calc(100% - 12px)", pointerEvents: "none" as const },
    cursor: { fill: "rgba(148,163,184,.12)", stroke: "rgba(226,232,240,.3)" },
    allowEscapeViewBox: { x: false, y: false },
}

function colorForCategory(name: string, index: number) {
    return statusColors[name] || chartColors[index % chartColors.length]
}

function pieLabel({ name, percent }: PieLabelRenderProps) {
    const percentage = Math.round(Number(percent || 0) * 100)
    return percentage >= 5 ? `${String(name || "")}: ${percentage}%` : ""
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

function isExpired(product: ProductRow) {
    return Boolean(product.expiry_date && new Date(product.expiry_date) < new Date())
}

function isExpiringSoon(product: ProductRow) {
    if (!product.expiry_date) return false
    const expiry = new Date(product.expiry_date)
    const now = new Date()
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    return expiry > now && expiry < future
}

export default function AnalyticsPage() {
    const [state, setState] = useState<AnalyticsState>(emptyState)
    const [loading, setLoading] = useState(true)
    const [notice, setNotice] = useState("")

    async function loadAnalytics() {
        const controller = new AbortController()
        const timeoutId = globalThis.setTimeout(() => controller.abort(), 15_000)
        try {
            setLoading(true)
            const orgId = await getOrganizationId()

            if (!orgId) {
                setNotice("No business is connected to this account.")
                return
            }

            const [productsResponse, invoicesResponse, customersResponse] = await Promise.all([
                apiFetch(`/api/products/list?${new URLSearchParams({ organization_id: orgId, limit: "500", sort: "created_at", direction: "desc" }).toString()}`, { cache: "no-store", signal: controller.signal }),
                apiFetch(`/api/invoices/list?${new URLSearchParams({ organization_id: orgId, limit: "500", sort: "created_at", direction: "desc" }).toString()}`, { cache: "no-store", signal: controller.signal }),
                apiFetch(`/api/customers/list?${new URLSearchParams({ organization_id: orgId, limit: "500", sort: "created_at", direction: "desc" }).toString()}`, { cache: "no-store", signal: controller.signal }),
            ])

            const [productsResult, invoicesResult, customersResult] = await Promise.all([
                productsResponse.json() as Promise<ListResponse<ProductRow>>,
                invoicesResponse.json() as Promise<ListResponse<AnyRow>>,
                customersResponse.json() as Promise<ListResponse<AnyRow>>,
            ])

            const firstError =
                (!productsResponse.ok && productsResult.error) ||
                (!invoicesResponse.ok && invoicesResult.error) ||
                (!customersResponse.ok && customersResult.error)

            if (firstError) setNotice(firstError)

            setState({
                products: productsResult.data || [],
                invoices: invoicesResult.data || [],
                customers: customersResult.data || [],
            })
        } catch (error) {
            setNotice(error instanceof DOMException && error.name === "AbortError"
                ? "Reports did not finish loading within 15 seconds. Retry after checking the local database in Settings → Desktop Diagnostics."
                : error instanceof Error ? error.message : "Analytics failed to load.")
        } finally {
            globalThis.clearTimeout(timeoutId)
            setLoading(false)
        }
    }

    useEffect(() => {
        loadAnalytics()
    }, [])

    const analytics = useMemo(() => {
        const totalRevenue = state.invoices.reduce(
            (sum, invoice) => sum + numberFrom(invoice, ["grand_total", "total_amount", "total"]),
            0
        )
        const inventoryValue = state.products.reduce((sum, product) => {
            const rate = Number(product.sale_rate || product.price || product.purchase_rate || 0)
            return sum + Number(product.stock || 0) * rate
        }, 0)
        const costValue = state.products.reduce((sum, product) => {
            return sum + Number(product.stock || 0) * Number(product.purchase_rate || 0)
        }, 0)
        const lowStock = state.products.filter(
            (product) => Number(product.stock || 0) <= Number(product.min_stock ?? 5)
        )
        const expired = state.products.filter(isExpired)
        const expiringSoon = state.products.filter(isExpiringSoon)
        const paidInvoices = state.invoices.filter((invoice) =>
            ["paid", "completed", "success"].includes(
                stringFrom(invoice, ["payment_status", "status"]).toLowerCase()
            )
        )
        const unpaidInvoices = state.invoices.filter((invoice) => {
            const status = stringFrom(invoice, ["payment_status", "status"]).toLowerCase()
            return status !== "paid" && status !== "completed" && status !== "success" && status !== "cancelled"
        })

        const weeklyRevenue = weekLabels.map((label) => ({ label, revenue: 0 }))
        state.invoices.forEach((invoice) => {
            const createdAt = stringFrom(invoice, ["created_at"])
            if (!createdAt) return
            const day = new Date(createdAt).getDay()
            const index = [6, 0, 1, 2, 3, 4, 5][day]
            weeklyRevenue[index].revenue += numberFrom(invoice, ["grand_total", "total_amount", "total"])
        })

        const categoryMap = new Map<string, { name: string; stock: number; value: number }>()
        state.products.forEach((product) => {
            const category = product.category || "General"
            const current = categoryMap.get(category) || { name: category, stock: 0, value: 0 }
            const stock = Number(product.stock || 0)
            const rate = Number(product.sale_rate || product.price || 0)
            current.stock += stock
            current.value += stock * rate
            categoryMap.set(category, current)
        })

        const productProfit = [...state.products]
            .map((product) => ({
                name: product.name || "Product",
                profit: Number(product.sale_rate || product.price || 0) - Number(product.purchase_rate || 0),
                stock: Number(product.stock || 0),
            }))
            .sort((a, b) => b.profit - a.profit)
            .slice(0, 8)

        return {
            totalRevenue,
            inventoryValue,
            costValue,
            potentialProfit: inventoryValue - costValue,
            lowStock,
            expired,
            expiringSoon,
            paidInvoices,
            unpaidInvoices,
            weeklyRevenue,
            categories: Array.from(categoryMap.values()).sort((a, b) => b.value - a.value).slice(0, 6),
            productProfit,
            stockPie: [
                { name: "Healthy", value: Math.max(0, state.products.length - lowStock.length) },
                { name: "Low Stock", value: lowStock.length },
            ],
            expiryPie: [
                { name: "Valid", value: Math.max(0, state.products.length - expired.length - expiringSoon.length) },
                { name: "Expiring Soon", value: expiringSoon.length },
                { name: "Expired", value: expired.length },
            ],
        }
    }, [state])

    const collectionRate =
        analytics.totalRevenue > 0
            ? Math.round(
                (analytics.paidInvoices.reduce(
                    (sum, invoice) => sum + numberFrom(invoice, ["grand_total", "total_amount", "total"]),
                    0
                ) /
                    analytics.totalRevenue) *
                100
            )
            : 0
    const stockHealth =
        state.products.length > 0
            ? Math.round(((state.products.length - analytics.lowStock.length) / state.products.length) * 100)
            : 0
    const hasWeeklyRevenue = analytics.weeklyRevenue.some((item) => item.revenue > 0)
    const hasStockPie = analytics.stockPie.some((item) => item.value > 0)
    const hasCategoryValue = analytics.categories.some((item) => item.value > 0)
    const hasProductProfit = analytics.productProfit.some((item) => item.profit !== 0)
    const hasExpiryPie = analytics.expiryPie.some((item) => item.value > 0)

    return (
        <div className="inventory-grid-bg min-h-full overflow-x-hidden text-white">
            <div className="mx-auto max-w-[1900px] space-y-6 px-3 py-4 sm:px-5 lg:px-6">
                <section className="relative overflow-hidden rounded-lg border border-white/10 bg-black/70 p-6 shadow-2xl backdrop-blur-xl inventory-sheen lg:p-8">
                    <div className="relative z-10 grid gap-8 2xl:grid-cols-[1.15fr_0.85fr] 2xl:items-end">
                        <div>
                            <div className="flex flex-wrap gap-3">
                                <span className="rounded-full border border-sky-400/25 bg-sky-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-sky-200">
                                    Reports
                                </span>
                                <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-200">
                                    Business Insights
                                </span>
                            </div>
                            <h1 className="mt-5 max-w-5xl text-4xl font-black tracking-tight md:text-6xl">
                                Reports
                            </h1>
                            <p className="mt-4 max-w-4xl text-base leading-7 text-neutral-300">
                                Business reports for revenue, inventory value,
                                stock health, customer growth, collections, margin, and expiry risk.
                            </p>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-3">
                            {[
                                [`${collectionRate}%`, "collection"],
                                [`${stockHealth}%`, "stock health"],
                                [state.customers.length.toLocaleString(), "customers"],
                            ].map(([value, label]) => (
                                <div key={label} className="rounded-lg border border-white/10 bg-white/[0.04] p-5">
                                    <p className="text-3xl font-black">{value}</p>
                                    <p className="mt-2 text-xs uppercase tracking-[0.16em] text-neutral-500">{label}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                    {notice && (
                        <div className="relative z-10 mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
                            <span>{notice}</span>
                            <button type="button" onClick={() => void loadAnalytics()} disabled={loading} className="min-h-10 rounded-lg border border-amber-200/25 bg-black/25 px-4 font-black text-amber-50 disabled:opacity-50">Retry reports</button>
                        </div>
                    )}
                </section>

                {loading ? (
                    <div className="flex justify-center rounded-lg border border-white/10 bg-black/70 py-16">
                        <div className="h-10 w-10 rounded-full border-2 border-neutral-700 border-t-white animate-spin" />
                    </div>
                ) : (
                    <>
                        <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
                            {[
                                ["Revenue", money(analytics.totalRevenue), "text-emerald-200"],
                                ["Inventory Value", money(analytics.inventoryValue), "text-sky-200"],
                                ["Potential Profit", money(analytics.potentialProfit), "text-amber-200"],
                                ["Customers", state.customers.length, "text-white"],
                                ["Expiry Risk", analytics.expired.length + analytics.expiringSoon.length, "text-red-200"],
                            ].map(([label, value, color]) => (
                                <div key={label} className="rounded-lg border border-white/10 bg-black/70 p-5 shadow-xl">
                                    <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">{label}</p>
                                    <p className={`mt-4 text-3xl font-black ${color}`}>{value}</p>
                                </div>
                            ))}
                        </section>

                        <section className="grid grid-cols-1 gap-6 2xl:grid-cols-[1.35fr_0.9fr]">
                            <ChartCard title="Weekly Revenue Flow" subtitle="Billing totals from live invoices">
                                {hasWeeklyRevenue ? (
                                    <div data-report-chart="weekly-revenue">
                                        <ResponsiveContainer width="100%" height={320}>
                                            <BarChart data={analytics.weeklyRevenue}>
                                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                                                <XAxis dataKey="label" stroke="#cbd5e1" tick={{ fill: "#e2e8f0" }} />
                                                <YAxis stroke="#cbd5e1" tick={{ fill: "#e2e8f0" }} />
                                                <Tooltip {...darkTooltipProps} />
                                                <Bar dataKey="revenue" name="Revenue" fill="#38bdf8" radius={[8, 8, 0, 0]} />
                                            </BarChart>
                                        </ResponsiveContainer>
                                        <ChartSummary
                                            caption="Weekly revenue summary"
                                            rows={analytics.weeklyRevenue.map((item) => ({ label: item.label, value: money(item.revenue) }))}
                                        />
                                    </div>
                                ) : <ChartEmpty message="No invoice revenue has been recorded yet." actionHref="/dashboard/invoices/create" actionText="Create invoice" />}
                            </ChartCard>

                            <ChartCard title="Stock Health" subtitle="Healthy versus low-stock product mix">
                                {hasStockPie ? (
                                    <div data-report-chart="stock-health">
                                        <ResponsiveContainer width="100%" height={320}>
                                            <PieChart>
                                                <Pie data={analytics.stockPie} dataKey="value" nameKey="name" innerRadius={62} outerRadius={96} label={pieLabel} labelLine={{ stroke: "#cbd5e1" }}>
                                                    {analytics.stockPie.map((entry, index) => (
                                                        <Cell key={entry.name} fill={colorForCategory(entry.name, index)} />
                                                    ))}
                                                </Pie>
                                                <PieValueTooltip data={analytics.stockPie} />
                                            </PieChart>
                                        </ResponsiveContainer>
                                        <PieLegendSummary data={analytics.stockPie} />
                                    </div>
                                ) : <ChartEmpty message="Add products to activate stock health analytics." actionHref="/dashboard/products" actionText="Add product" />}
                            </ChartCard>
                        </section>

                        <section className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
                            <ChartCard title="Category Value" subtitle="Inventory value by product category">
                                {hasCategoryValue ? (
                                    <div data-report-chart="category-value">
                                        <ResponsiveContainer width="100%" height={340}>
                                            <BarChart data={analytics.categories}>
                                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                                                <XAxis dataKey="name" stroke="#cbd5e1" tick={{ fill: "#e2e8f0" }} />
                                                <YAxis stroke="#cbd5e1" tick={{ fill: "#e2e8f0" }} />
                                                <Tooltip {...darkTooltipProps} />
                                                <Bar dataKey="value" name="Inventory value" fill="#34d399" radius={[8, 8, 0, 0]} />
                                            </BarChart>
                                        </ResponsiveContainer>
                                        <ChartSummary caption="Category inventory value summary" rows={analytics.categories.map((item) => ({ label: item.name, value: money(item.value), detail: `${item.stock} units` }))} />
                                    </div>
                                ) : <ChartEmpty message="No category inventory value yet." actionHref="/dashboard/products" actionText="Manage products" />}
                            </ChartCard>

                            <ChartCard title="Product Margin Leaders" subtitle="Top profit per unit by product">
                                {hasProductProfit ? (
                                    <div data-report-chart="product-margin">
                                        <ResponsiveContainer width="100%" height={340}>
                                            <LineChart data={analytics.productProfit}>
                                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                                                <XAxis dataKey="name" stroke="#cbd5e1" tick={{ fill: "#e2e8f0" }} />
                                                <YAxis stroke="#cbd5e1" tick={{ fill: "#e2e8f0" }} />
                                                <Tooltip {...darkTooltipProps} />
                                                <Line type="monotone" dataKey="profit" name="Profit per unit" stroke="#fbbf24" strokeWidth={3} dot={{ r: 4 }} />
                                            </LineChart>
                                        </ResponsiveContainer>
                                        <ChartSummary caption="Product margin summary" rows={analytics.productProfit.map((item) => ({ label: item.name, value: money(item.profit), detail: `${item.stock} in stock` }))} />
                                    </div>
                                ) : <ChartEmpty message="Set purchase and sale rates to see margin leaders." actionHref="/dashboard/products" actionText="Update products" />}
                            </ChartCard>
                        </section>

                        <section className="grid grid-cols-1 gap-6 2xl:grid-cols-[0.8fr_1.2fr]">
                            <ChartCard title="Expiry Risk" subtitle="Valid, expiring soon, and expired products">
                                {hasExpiryPie ? (
                                    <div data-report-chart="expiry-risk">
                                        <ResponsiveContainer width="100%" height={320}>
                                            <PieChart>
                                                <Pie data={analytics.expiryPie} dataKey="value" nameKey="name" outerRadius={94} label={pieLabel} labelLine={{ stroke: "#cbd5e1" }}>
                                                    {analytics.expiryPie.map((entry, index) => (
                                                        <Cell key={entry.name} fill={colorForCategory(entry.name, index)} />
                                                    ))}
                                                </Pie>
                                                <PieValueTooltip data={analytics.expiryPie} />
                                            </PieChart>
                                        </ResponsiveContainer>
                                        <PieLegendSummary data={analytics.expiryPie} />
                                    </div>
                                ) : <ChartEmpty message="Add products with expiry dates to track expiry risk." actionHref="/dashboard/products" actionText="Manage products" />}
                            </ChartCard>

                            <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                                <p className="text-xs uppercase tracking-[0.18em] text-sky-300">Business Readiness</p>
                                <div className="mt-4 grid gap-3 md:grid-cols-2">
                                    {[
                                        ["Private Business Data", "Reports show the current business only"],
                                        ["Revenue Totals", "Invoices are counted consistently across billing views"],
                                        ["Inventory Intelligence", `${analytics.lowStock.length} low-stock products`],
                                        ["Customer Records", `${state.customers.length} customer accounts`],
                                        ["Payment Review", `${analytics.unpaidInvoices.length} unpaid or partially paid invoices`],
                                        ["Daily Review", "Check revenue, stock risk, and unpaid work before closing"],
                                    ].map(([title, body]) => (
                                        <div key={title} className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                            <p className="font-semibold">{title}</p>
                                            <p className="mt-2 text-sm leading-6 text-neutral-400">{body}</p>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </section>
                    </>
                )}
            </div>
        </div>
    )
}

function ChartCard({
    title,
    subtitle,
    children,
}: {
    title: string
    subtitle: string
    children: React.ReactNode
}) {
    return (
        <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
            <div className="mb-5 border-b border-white/10 pb-4">
                <p className="text-xs uppercase tracking-[0.18em] text-sky-300">{title}</p>
                <p className="mt-2 text-sm text-neutral-500">{subtitle}</p>
            </div>
            {children}
        </div>
    )
}

function PieLegendSummary({ data }: { data: Array<{ name: string; value: number }> }) {
    const total = data.reduce((sum, item) => sum + item.value, 0)
    return (
        <div className="mt-3 grid gap-2 sm:grid-cols-2" role="list" aria-label="Chart legend and values">
            {data.map((item, index) => {
                const percentage = total > 0 ? Math.round((item.value / total) * 100) : 0
                return (
                    <div key={item.name} role="listitem" className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm">
                        <span className="flex min-w-0 items-center gap-2 font-semibold text-slate-100">
                            <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: colorForCategory(item.name, index) }} aria-hidden="true" />
                            <span className="truncate">{item.name}</span>
                        </span>
                        <span className="shrink-0 text-slate-200">{item.value} · {percentage}%</span>
                    </div>
                )
            })}
        </div>
    )
}

function PieValueTooltip({ data }: { data: Array<{ name: string; value: number }> }) {
    const total = data.reduce((sum, item) => sum + item.value, 0)
    return (
        <Tooltip
            {...darkTooltipProps}
            formatter={(value, name) => {
                const count = Number(value || 0)
                const percentage = total > 0 ? Math.round((count / total) * 100) : 0
                return [`${count} (${percentage}%)`, String(name)]
            }}
        />
    )
}

function ChartSummary({
    caption,
    rows,
}: {
    caption: string
    rows: Array<{ label: string; value: string; detail?: string }>
}) {
    return (
        <div className="mt-3 max-h-44 overflow-auto rounded-lg border border-white/10">
            <table className="w-full min-w-[320px] border-collapse text-left text-xs text-slate-200">
                <caption className="sr-only">{caption}</caption>
                <thead className="sticky top-0 bg-slate-950 text-slate-100">
                    <tr><th className="px-3 py-2 font-semibold">Category</th><th className="px-3 py-2 font-semibold">Value</th><th className="px-3 py-2 font-semibold">Details</th></tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr key={`${row.label}-${row.value}`} className="border-t border-white/10">
                            <th scope="row" className="px-3 py-2 font-medium text-white">{row.label}</th>
                            <td className="px-3 py-2">{row.value}</td>
                            <td className="px-3 py-2 text-slate-300">{row.detail || "—"}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

function ChartEmpty({
    message,
    actionHref,
    actionText,
}: {
    message: string
    actionHref: string
    actionText: string
}) {
    return (
        <div className="flex h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-white/10 bg-white/[0.03] px-6 text-center">
            <p className="text-lg font-black text-white">Chart ready</p>
            <p className="mt-2 max-w-sm text-sm leading-6 text-neutral-500">{message}</p>
            <Link href={actionHref} className="mt-5 rounded-lg bg-white px-4 py-2 text-sm font-black text-black">
                {actionText}
            </Link>
        </div>
    )
}
