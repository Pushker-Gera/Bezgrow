"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { getOrganizationFeatures } from "@/lib/get-organization-features"
import { getOrganizationId } from "@/lib/getOrganization"
import { supabase } from "@/lib/supabase"

type ProductRow = {
    id: string
    name: string
    sku: string | null
    stock: number | null
    min_stock: number | null
    purchase_rate: number | null
    sale_rate: number | null
    price: number | null
    category: string | null
    warehouse_id: string | null
    batch_no: string | null
    barcode: string | null
    expiry_date: string | null
    created_at: string | null
}

type InventoryProduct = ProductRow & {
    currentStock: number
    soldQuantity: number
    inventoryValue: number
    warehouseName: string
}

type WarehouseRow = {
    id: string
    name: string
}

type StockMovementRow = {
    id: string
    quantity: number | null
    type: string | null
    created_at: string | null
    product_id: string | null
    warehouse_id: string | null
    products?: RelationName
    warehouses?: RelationName
}

type InvoiceRow = {
    id: string
    grand_total: number | null
    created_at: string | null
    invoice_items?: InvoiceItemRow[] | null
}

type InvoiceItemRow = {
    quantity: number | null
    product_name: string | null
    product_id: string | null
}

type InventoryStats = {
    totalSkus: number
    lowStock: number
    outOfStock: number
    soldUnits: number
    totalInvoices: number
    invoiceRevenue: number
    inventoryValue: number
}

type MovementView = {
    id: string
    product: string
    type: string
    quantity: number
    warehouse: string
    createdAt: string | null
}

type WarehouseStat = {
    name: string
    totalProducts: number
    totalStock: number
    inventoryValue: number
    percentage: number
}

type CategoryStat = {
    name: string
    stock: number
}

type RelationName =
    | { name: string | null }
    | { name: string | null }[]
    | null
    | undefined

const emptyStats: InventoryStats = {
    totalSkus: 0,
    lowStock: 0,
    outOfStock: 0,
    soldUnits: 0,
    totalInvoices: 0,
    invoiceRevenue: 0,
    inventoryValue: 0,
}

const movementLabels: Record<string, string> = {
    opening_stock: "Opening Stock",
    purchase: "Purchase",
    sale: "Sale",
    return: "Return",
    damage: "Damage",
    adjustment: "Adjustment",
    transfer: "Transfer",
    stock_in: "Stock Added",
}

function money(value: number) {
    return `Rs ${Math.round(value).toLocaleString()}`
}

function formatDate(value: string | null) {
    if (!value) return "-"
    return new Date(value).toLocaleDateString()
}

function csvCell(value: string | number | null) {
    const text = String(value ?? "")
    return `"${text.replaceAll("\"", "\"\"")}"`
}

function relationName(value: RelationName) {
    if (Array.isArray(value)) return value[0]?.name || null
    return value?.name || null
}

export default function InventoryPage() {
    const [organizationId, setOrganizationId] = useState("")
    const [features, setFeatures] = useState<string[]>([])
    const [products, setProducts] = useState<InventoryProduct[]>([])
    const [warehouses, setWarehouses] = useState<WarehouseRow[]>([])
    const [movements, setMovements] = useState<MovementView[]>([])
    const [warehouseStats, setWarehouseStats] = useState<WarehouseStat[]>([])
    const [categoryStats, setCategoryStats] = useState<CategoryStat[]>([])
    const [stats, setStats] = useState<InventoryStats>(emptyStats)
    const [search, setSearch] = useState("")
    const [statusFilter, setStatusFilter] = useState("all")
    const [loading, setLoading] = useState(true)
    const [actionLoading, setActionLoading] = useState(false)
    const [notice, setNotice] = useState("")
    const [showAddStockModal, setShowAddStockModal] = useState(false)
    const [showTransferModal, setShowTransferModal] = useState(false)
    const [selectedProductId, setSelectedProductId] = useState("")
    const [quantity, setQuantity] = useState("")
    const [warehouseId, setWarehouseId] = useState("")
    const [expiryDate, setExpiryDate] = useState("")
    const [batchNo, setBatchNo] = useState("")
    const [barcode, setBarcode] = useState("")
    const [shippingQr, setShippingQr] = useState("")

    const hasBatchTracking = features.includes("batch_tracking")
    const hasBarcodeScanning = features.includes("barcode_scanning")
    const hasShippingLabels = features.includes("shipping_labels")

    async function fetchInventoryData(orgId: string) {
        setLoading(true)
        setNotice("")

        const productsQuery = supabase
            .from("products")
            .select(`
                id,
                name,
                sku,
                stock,
                min_stock,
                purchase_rate,
                sale_rate,
                price,
                category,
                warehouse_id,
                batch_no,
                barcode,
                expiry_date,
                created_at
            `)
            .eq("organization_id", orgId)
            .is("deleted_at", null)
            .order("created_at", { ascending: false })

        const invoicesQuery = supabase
            .from("invoices")
            .select(`
                id,
                grand_total,
                created_at,
                invoice_items (
                    quantity,
                    product_name,
                    product_id
                )
            `)
            .eq("organization_id", orgId)

        const warehousesQuery = supabase
            .from("warehouses")
            .select("id, name")
            .eq("organization_id", orgId)
            .eq("is_active", true)
            .order("created_at", { ascending: true })

        const movementsQuery = supabase
            .from("stock_movements")
            .select(`
                id,
                quantity,
                type,
                created_at,
                product_id,
                warehouse_id,
                products ( name ),
                warehouses ( name )
            `)
            .eq("organization_id", orgId)
            .order("created_at", { ascending: false })
            .limit(30)

        const [productsResult, invoicesResult, warehousesResult, movementsResult] =
            await Promise.all([
                productsQuery,
                invoicesQuery,
                warehousesQuery,
                movementsQuery,
            ])

        if (productsResult.error) {
            setNotice(productsResult.error.message)
            setLoading(false)
            return
        }

        const productRows = (productsResult.data || []) as ProductRow[]
        const invoiceRows = (invoicesResult.data || []) as InvoiceRow[]
        const warehouseRows = (warehousesResult.data || []) as WarehouseRow[]
        const movementRows = (movementsResult.data || []) as StockMovementRow[]
        const warehouseNameById = new Map(
            warehouseRows.map((warehouse) => [warehouse.id, warehouse.name])
        )
        const invoiceItems = invoiceRows.flatMap(
            (invoice) => invoice.invoice_items || []
        )

        const normalizedProducts = productRows.map((product) => {
            const soldQuantity = invoiceItems
                .filter((item) => {
                    const productName = product.name.toLowerCase().trim()
                    const itemName = item.product_name?.toLowerCase().trim()
                    return item.product_id === product.id || itemName === productName
                })
                .reduce((sum, item) => sum + Number(item.quantity || 0), 0)
            const currentStock = Number(product.stock || 0)
            const unitValue = Number(
                product.sale_rate || product.price || product.purchase_rate || 0
            )

            return {
                ...product,
                currentStock,
                soldQuantity,
                inventoryValue: currentStock * unitValue,
                warehouseName:
                    warehouseNameById.get(product.warehouse_id || "") ||
                    "Unassigned",
            }
        })

        const lowStockProducts = normalizedProducts.filter((product) => {
            const threshold = Number(product.min_stock ?? 5)
            return product.currentStock <= threshold
        })
        const outOfStockProducts = normalizedProducts.filter(
            (product) => product.currentStock <= 0
        )
        const soldUnits = invoiceItems.reduce(
            (sum, item) => sum + Number(item.quantity || 0),
            0
        )
        const inventoryValue = normalizedProducts.reduce(
            (sum, product) => sum + product.inventoryValue,
            0
        )
        const invoiceRevenue = invoiceRows.reduce(
            (sum, invoice) => sum + Number(invoice.grand_total || 0),
            0
        )

        const warehouseMap = new Map<string, WarehouseStat>()
        normalizedProducts.forEach((product) => {
            const current = warehouseMap.get(product.warehouseName) || {
                name: product.warehouseName,
                totalProducts: 0,
                totalStock: 0,
                inventoryValue: 0,
                percentage: 0,
            }

            current.totalProducts += 1
            current.totalStock += product.currentStock
            current.inventoryValue += product.inventoryValue
            warehouseMap.set(product.warehouseName, current)
        })

        const warehouseList = Array.from(warehouseMap.values())
        const highestWarehouseStock = Math.max(
            1,
            ...warehouseList.map((warehouse) => warehouse.totalStock)
        )

        const categoryMap = new Map<string, number>()
        normalizedProducts.forEach((product) => {
            const category = product.category || "General"
            categoryMap.set(
                category,
                (categoryMap.get(category) || 0) + product.currentStock
            )
        })

        setProducts(normalizedProducts)
        setWarehouses(warehouseRows)
        setWarehouseId((current) => current || warehouseRows[0]?.id || "")
        setStats({
            totalSkus: normalizedProducts.length,
            lowStock: lowStockProducts.length,
            outOfStock: outOfStockProducts.length,
            soldUnits,
            totalInvoices: invoiceRows.length,
            invoiceRevenue,
            inventoryValue,
        })
        setWarehouseStats(
            warehouseList.map((warehouse) => ({
                ...warehouse,
                percentage: Math.round(
                    (warehouse.totalStock / highestWarehouseStock) * 100
                ),
            }))
        )
        setCategoryStats(
            Array.from(categoryMap.entries())
                .map(([name, stock]) => ({ name, stock }))
                .sort((a, b) => b.stock - a.stock)
                .slice(0, 6)
        )
        setMovements(
            movementRows.map((movement) => ({
                id: movement.id,
                product: relationName(movement.products) || "Unknown product",
                type: movementLabels[movement.type || ""] || movement.type || "Movement",
                quantity: Number(movement.quantity || 0),
                warehouse:
                    relationName(movement.warehouses) ||
                    warehouseNameById.get(movement.warehouse_id || "") ||
                    "Unassigned",
                createdAt: movement.created_at,
            }))
        )
        setLoading(false)
    }

    async function initializeInventory() {
        try {
            const orgId = await getOrganizationId()

            if (!orgId) {
                setNotice("No organization is connected to this account.")
                setLoading(false)
                return
            }

            setOrganizationId(orgId)
            const orgFeatures = await getOrganizationFeatures(orgId)
            setFeatures(orgFeatures)
            await fetchInventoryData(orgId)
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "Inventory failed to load.")
            setLoading(false)
        }
    }

    async function applyStockChange(mode: "add" | "transfer") {
        setNotice("")
        const product = products.find((item) => item.id === selectedProductId)
        const qty = Number(quantity)

        if (!product || !organizationId || !qty || qty <= 0) {
            setNotice("Select a product and enter a quantity greater than zero.")
            return
        }

        if (warehouses.length > 0 && !warehouseId) {
            setNotice("Select a warehouse for this stock movement.")
            return
        }

        const nextStock =
            mode === "add" ? product.currentStock + qty : product.currentStock - qty

        if (nextStock < 0) {
            setNotice("Transfer quantity cannot be greater than available stock.")
            return
        }

        setActionLoading(true)

        try {
            const {
                data: { session },
            } = await supabase.auth.getSession()
            const response = await fetch("/api/inventory/simple-movement", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
                },
                body: JSON.stringify({
                    product_id: product.id,
                    quantity: qty,
                    mode,
                    warehouse_id: warehouseId || null,
                    expiry_date: mode === "add" ? expiryDate || null : null,
                    batch_no: mode === "add" && hasBatchTracking ? batchNo || product.batch_no || null : null,
                    barcode: mode === "add" && hasBarcodeScanning ? barcode || product.barcode || null : null,
                    shipping_qr: hasShippingLabels ? shippingQr || null : null,
                }),
            })
            const result = (await response.json()) as { error?: string; warning?: string }
            if (!response.ok) throw new Error(result.error || "Stock update failed.")

            await fetchInventoryData(organizationId)
            resetActionForm()
            setShowAddStockModal(false)
            setShowTransferModal(false)
            setNotice(result.warning || (mode === "add" ? "Stock added successfully." : "Inventory transferred successfully."))
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "Stock update failed.")
        } finally {
            setActionLoading(false)
        }
    }

    function resetActionForm() {
        setSelectedProductId("")
        setQuantity("")
        setExpiryDate("")
        setBatchNo("")
        setBarcode("")
        setShippingQr("")
    }

    function exportInventoryCsv() {
        if (filteredProducts.length === 0) {
            setNotice("No inventory rows are available to export.")
            return
        }

        const headers = [
            "Product",
            "SKU",
            "Category",
            "Stock",
            "Minimum Stock",
            "Sold Quantity",
            "Warehouse",
            "Inventory Value",
            "Expiry Date",
        ]
        const rows = filteredProducts.map((product) => [
            product.name,
            product.sku || "",
            product.category || "",
            product.currentStock,
            product.min_stock ?? "",
            product.soldQuantity,
            product.warehouseName,
            Math.round(product.inventoryValue),
            product.expiry_date || "",
        ])
        const csv = [headers, ...rows]
            .map((row) => row.map(csvCell).join(","))
            .join("\n")
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
        const url = URL.createObjectURL(blob)
        const link = document.createElement("a")

        link.href = url
        link.download = `inventory-export-${new Date().toISOString()}.csv`
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
    }

    useEffect(() => {
        initializeInventory()
        // The inventory bootstrap intentionally runs once on page load.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const filteredProducts = useMemo(() => {
        const term = search.trim().toLowerCase()

        return products.filter((product) => {
            const matchesSearch =
                !term ||
                product.name.toLowerCase().includes(term) ||
                (product.sku || "").toLowerCase().includes(term) ||
                (product.category || "").toLowerCase().includes(term) ||
                product.warehouseName.toLowerCase().includes(term)

            if (!matchesSearch) return false
            if (statusFilter === "low") {
                return product.currentStock <= Number(product.min_stock ?? 5)
            }
            if (statusFilter === "out") return product.currentStock <= 0
            if (statusFilter === "healthy") {
                return product.currentStock > Number(product.min_stock ?? 5)
            }

            return true
        })
    }, [products, search, statusFilter])

    const filteredMovements = useMemo(() => {
        const term = search.trim().toLowerCase()
        if (!term) return movements

        return movements.filter(
            (movement) =>
                movement.product.toLowerCase().includes(term) ||
                movement.warehouse.toLowerCase().includes(term) ||
                movement.type.toLowerCase().includes(term)
        )
    }, [movements, search])

    const lowStockProducts = useMemo(
        () =>
            products
                .filter((product) => product.currentStock <= Number(product.min_stock ?? 5))
                .slice(0, 8),
        [products]
    )

    const topProducts = useMemo(
        () =>
            [...products]
                .sort((a, b) => b.currentStock - a.currentStock)
                .slice(0, 5),
        [products]
    )

    const healthPercentage =
        stats.totalSkus > 0
            ? Math.round(((stats.totalSkus - stats.lowStock) / stats.totalSkus) * 100)
            : 0

    const stockRisk = stats.totalSkus > 0
        ? Math.round(((stats.lowStock + stats.outOfStock) / stats.totalSkus) * 100)
        : 0

    const statCards = [
        {
            label: "Total SKUs",
            value: stats.totalSkus,
            accent: "from-white to-neutral-400",
            meta: `${filteredProducts.length} in current view`,
        },
        {
            label: "Low Stock",
            value: stats.lowStock,
            accent: "from-amber-200 to-yellow-500",
            meta: `${stockRisk}% portfolio risk`,
        },
        {
            label: "Out of Stock",
            value: stats.outOfStock,
            accent: "from-red-200 to-rose-500",
            meta: "Immediate replenishment",
        },
        {
            label: "Sold Units",
            value: stats.soldUnits,
            accent: "from-sky-200 to-blue-500",
            meta: `${stats.totalInvoices} billed orders`,
        },
        {
            label: "Inventory Value",
            value: money(stats.inventoryValue),
            accent: "from-emerald-200 to-green-500",
            meta: `${money(stats.invoiceRevenue)} invoice revenue`,
        },
    ]

    const launchSignals = [
        `${warehouses.length} active warehouses`,
        `${features.length} enabled business modules`,
        `${filteredMovements.length} movement records visible`,
    ]

    if (loading) {
        return (
            <div className="inventory-grid-bg flex min-h-dvh items-center justify-center text-white">
                <div className="relative overflow-hidden rounded-lg border border-white/10 bg-black/70 p-8 shadow-2xl inventory-sheen">
                    <div className="flex items-center gap-4">
                        <div className="h-9 w-9 rounded-full border-2 border-emerald-400/30 border-t-emerald-300 animate-spin" />
                        <div>
                            <p className="text-sm uppercase tracking-[0.24em] text-emerald-200">
                                Inventory Cloud
                            </p>
                            <p className="mt-1 text-neutral-400">
                                Loading live stock intelligence
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="inventory-grid-bg min-h-dvh overflow-y-auto overflow-x-hidden text-white">
            <div className="mx-auto max-w-[1800px] space-y-6 px-4 py-5 sm:px-6 lg:px-8">
                <section className="relative overflow-hidden rounded-lg border border-white/10 bg-black/70 p-6 shadow-2xl backdrop-blur-xl inventory-sheen lg:p-8">
                    <div className="relative z-10 grid gap-8 xl:grid-cols-[1.15fr_0.85fr] xl:items-end">
                        <div>
                            <div className="flex flex-wrap items-center gap-3">
                                <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-200">
                                    Global Inventory Cloud
                                </span>
                                <span className="rounded-full border border-sky-400/20 bg-sky-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-sky-200">
                                    Live Supabase Data
                                </span>
                            </div>

                            <h1 className="mt-5 max-w-5xl text-4xl font-black tracking-tight text-white md:text-6xl">
                                Inventory Management
                            </h1>

                            <p className="mt-4 max-w-4xl text-base leading-7 text-neutral-300">
                                Enterprise stock control for products, warehouses,
                                invoice-linked sales, replenishment alerts, and valuation
                                across your SaaS operating system.
                            </p>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-3">
                            {launchSignals.map((signal) => (
                                <div
                                    key={signal}
                                    className="rounded-lg border border-white/10 bg-white/[0.04] p-4 shadow-lg transition-all duration-300 hover:-translate-y-1 hover:border-emerald-300/30 hover:bg-white/[0.07]"
                                >
                                    <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">
                                        Signal
                                    </p>
                                    <p className="mt-2 text-sm font-semibold text-neutral-100">
                                        {signal}
                                    </p>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="relative z-10 mt-7 flex flex-col gap-3 border-t border-white/10 pt-5 lg:flex-row lg:items-center lg:justify-between">
                        <div className="grid gap-3 sm:grid-cols-[minmax(220px,1fr)_180px] lg:min-w-[560px]">
                            <input
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder="Search product, SKU, category, warehouse"
                                className="h-12 rounded-lg border border-white/10 bg-black/60 px-4 text-sm outline-none transition-all focus:border-emerald-300/60 focus:ring-2 focus:ring-emerald-400/10"
                            />
                            <select
                                value={statusFilter}
                                onChange={(event) => setStatusFilter(event.target.value)}
                                className="h-12 rounded-lg border border-white/10 bg-black/60 px-4 text-sm outline-none transition-all focus:border-emerald-300/60 focus:ring-2 focus:ring-emerald-400/10"
                            >
                                <option value="all">All stock</option>
                                <option value="healthy">Healthy</option>
                                <option value="low">Low stock</option>
                                <option value="out">Out of stock</option>
                            </select>
                        </div>

                        <div className="flex flex-wrap gap-3">
                            <button
                                onClick={() => setShowAddStockModal(true)}
                                className="h-12 rounded-lg bg-emerald-400 px-5 text-sm font-bold text-black shadow-lg shadow-emerald-500/20 transition-all duration-300 hover:-translate-y-1 hover:bg-emerald-300"
                            >
                                Add Stock
                            </button>
                            <button
                                onClick={() => setShowTransferModal(true)}
                                className="h-12 rounded-lg border border-white/10 bg-white/[0.05] px-5 text-sm font-bold transition-all duration-300 hover:-translate-y-1 hover:border-sky-300/40 hover:bg-white/[0.08]"
                            >
                                Transfer
                            </button>
                            <button
                                onClick={exportInventoryCsv}
                                className="h-12 rounded-lg border border-white/10 bg-white/[0.05] px-5 text-sm font-bold transition-all duration-300 hover:-translate-y-1 hover:border-amber-300/40 hover:bg-white/[0.08]"
                            >
                                Export CSV
                            </button>
                            <Link
                                href="/dashboard/products"
                                className="flex h-12 items-center rounded-lg border border-white/10 bg-white/[0.05] px-5 text-sm font-bold transition-all duration-300 hover:-translate-y-1 hover:border-white/25 hover:bg-white/[0.08]"
                            >
                                Products
                            </Link>
                        </div>
                    </div>

                    {notice && (
                        <div className="relative z-10 mt-5 rounded-lg border border-sky-400/20 bg-sky-400/10 px-4 py-3 text-sm text-sky-100">
                            {notice}
                        </div>
                    )}
                </section>

                <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
                    {statCards.map((item, index) => (
                        <div
                            key={item.label}
                            className="group relative overflow-hidden rounded-lg border border-white/10 bg-black/70 p-5 shadow-xl backdrop-blur transition-all duration-300 hover:-translate-y-1 hover:border-white/20"
                            style={{ animationDelay: `${index * 80}ms` }}
                        >
                            <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${item.accent}`} />
                            <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">
                                {item.label}
                            </p>
                            <h2 className={`mt-4 text-3xl font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r ${item.accent}`}>
                                {item.value}
                            </h2>
                            <p className="mt-3 text-xs text-neutral-500">
                                {item.meta}
                            </p>
                        </div>
                    ))}
                </section>

                <section className="grid grid-cols-1 gap-6 2xl:grid-cols-[1.55fr_0.7fr]">
                    <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                        <div className="flex flex-col gap-3 border-b border-white/10 pb-4 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <p className="text-xs uppercase tracking-[0.18em] text-emerald-300">
                                    Stock Register
                                </p>
                                <h2 className="mt-2 text-2xl font-black">
                                    Live Product Ledger
                                </h2>
                            </div>
                            <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-neutral-300">
                                <span className="h-2 w-2 rounded-full bg-emerald-300 animate-pulse" />
                                {filteredProducts.length} visible rows
                            </div>
                        </div>

                        <div className="mt-4 overflow-x-auto">
                            <table className="w-full min-w-[980px] border-separate border-spacing-y-2 text-sm">
                                <thead className="text-left text-xs uppercase tracking-[0.16em] text-neutral-500">
                                    <tr>
                                        <th className="px-3 py-2">Product</th>
                                        <th className="px-3 py-2">Category</th>
                                        <th className="px-3 py-2">Stock</th>
                                        <th className="px-3 py-2">Minimum</th>
                                        <th className="px-3 py-2">Sold</th>
                                        <th className="px-3 py-2">Warehouse</th>
                                        <th className="px-3 py-2">Value</th>
                                        <th className="px-3 py-2">Expiry</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredProducts.length === 0 && (
                                        <tr>
                                            <td colSpan={8} className="rounded-lg border border-white/10 bg-white/[0.03] py-12 text-center text-neutral-500">
                                                No inventory products found.
                                            </td>
                                        </tr>
                                    )}

                                    {filteredProducts.map((product) => {
                                        const isLow =
                                            product.currentStock <= Number(product.min_stock ?? 5)
                                        const isOut = product.currentStock <= 0

                                        return (
                                            <tr
                                                key={product.id}
                                                className="rounded-lg bg-white/[0.035] transition-all duration-300 hover:bg-white/[0.065]"
                                            >
                                                <td className="rounded-l-lg px-3 py-4">
                                                    <p className="font-semibold text-white">
                                                        {product.name}
                                                    </p>
                                                    <p className="mt-1 text-xs text-neutral-500">
                                                        SKU: {product.sku || "N/A"}
                                                    </p>
                                                </td>
                                                <td className="px-3 py-4 text-neutral-300">
                                                    {product.category || "General"}
                                                </td>
                                                <td className="px-3 py-4">
                                                    <span className={`inline-flex min-w-16 justify-center rounded-full border px-3 py-1 text-xs font-bold ${isOut ? "border-red-400/30 bg-red-400/10 text-red-200" : isLow ? "border-amber-400/30 bg-amber-400/10 text-amber-200" : "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"}`}>
                                                        {product.currentStock}
                                                    </span>
                                                </td>
                                                <td className="px-3 py-4 text-neutral-400">
                                                    {product.min_stock ?? 5}
                                                </td>
                                                <td className="px-3 py-4 text-sky-300">
                                                    {product.soldQuantity}
                                                </td>
                                                <td className="px-3 py-4 text-neutral-300">
                                                    {product.warehouseName}
                                                </td>
                                                <td className="px-3 py-4 font-semibold text-emerald-200">
                                                    {money(product.inventoryValue)}
                                                </td>
                                                <td className="rounded-r-lg px-3 py-4 text-neutral-400">
                                                    {formatDate(product.expiry_date)}
                                                </td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div className="space-y-6">
                        <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <p className="text-xs uppercase tracking-[0.18em] text-emerald-300">
                                        Health Index
                                    </p>
                                    <h2 className="mt-2 text-2xl font-black">
                                        Portfolio Stability
                                    </h2>
                                </div>
                                <span className="text-4xl font-black text-emerald-200">
                                    {healthPercentage}%
                                </span>
                            </div>
                            <div className="mt-5 h-3 overflow-hidden rounded-full bg-white/10">
                                <div
                                    className="h-full rounded-full bg-gradient-to-r from-emerald-300 via-sky-300 to-amber-300 transition-all duration-700"
                                    style={{ width: `${healthPercentage}%` }}
                                />
                            </div>
                            <div className="mt-5 grid grid-cols-2 gap-3">
                                <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                    <p className="text-xs text-neutral-500">Revenue</p>
                                    <p className="mt-2 text-lg font-black text-sky-200">
                                        {money(stats.invoiceRevenue)}
                                    </p>
                                </div>
                                <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                    <p className="text-xs text-neutral-500">Risk</p>
                                    <p className="mt-2 text-lg font-black text-amber-200">
                                        {stockRisk}%
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                            <div className="flex items-center justify-between">
                                <h2 className="text-xl font-black">Low Stock Alerts</h2>
                                <span className="rounded-full border border-red-400/25 bg-red-400/10 px-3 py-1 text-xs font-bold text-red-200">
                                    {lowStockProducts.length}
                                </span>
                            </div>
                            <div className="mt-4 max-h-[330px] space-y-3 overflow-y-auto pr-1">
                                {lowStockProducts.length === 0 && (
                                    <p className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">
                                        All current stock levels are healthy.
                                    </p>
                                )}
                                {lowStockProducts.map((product) => (
                                    <div
                                        key={product.id}
                                        className="flex items-center justify-between rounded-lg border border-red-400/20 bg-red-400/10 p-4"
                                    >
                                        <div className="min-w-0">
                                            <p className="truncate font-semibold">{product.name}</p>
                                            <p className="text-xs text-neutral-500">
                                                Minimum: {product.min_stock ?? 5}
                                            </p>
                                        </div>
                                        <p className="text-2xl font-black text-red-200">
                                            {product.currentStock}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                            <h2 className="text-xl font-black">Highest Stock Products</h2>
                            <div className="mt-4 space-y-3">
                                {topProducts.map((product, index) => (
                                    <div
                                        key={product.id}
                                        className="grid grid-cols-[44px_1fr_auto] items-center gap-3 rounded-lg border border-white/10 bg-white/[0.04] p-3"
                                    >
                                        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-sky-400/20 bg-sky-400/10 text-sm font-black text-sky-200">
                                            {index + 1}
                                        </div>
                                        <div className="min-w-0">
                                            <p className="truncate font-semibold">{product.name}</p>
                                            <p className="text-xs text-neutral-500">
                                                {product.category || "General"}
                                            </p>
                                        </div>
                                        <p className="text-xl font-black">
                                            {product.currentStock}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </section>

                <section className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                    <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                        <div className="flex items-center justify-between gap-4">
                            <div>
                                <p className="text-xs uppercase tracking-[0.18em] text-sky-300">
                                    Audit Trail
                                </p>
                                <h2 className="mt-2 text-2xl font-black">Recent Stock Movements</h2>
                            </div>
                            <span className="rounded-full border border-sky-400/20 bg-sky-400/10 px-3 py-1 text-xs font-bold text-sky-200">
                                {filteredMovements.length}
                            </span>
                        </div>
                        <div className="mt-5 overflow-hidden rounded-lg border border-white/10">
                            <div className="grid grid-cols-4 bg-white/[0.04] px-4 py-3 text-xs uppercase tracking-[0.16em] text-neutral-500">
                                <span>Product</span>
                                <span>Movement</span>
                                <span>Qty</span>
                                <span>Warehouse</span>
                            </div>
                            <div className="divide-y divide-white/5">
                                {filteredMovements.length === 0 && (
                                    <p className="p-6 text-center text-neutral-500">
                                        No stock movements recorded yet.
                                    </p>
                                )}
                                {filteredMovements.map((movement) => (
                                    <div
                                        key={movement.id}
                                        className="grid grid-cols-4 items-center px-4 py-4 text-sm transition-colors hover:bg-white/[0.04]"
                                    >
                                        <span className="truncate pr-3 font-semibold">
                                            {movement.product}
                                        </span>
                                        <span className="truncate pr-3 text-sky-300">
                                            {movement.type}
                                        </span>
                                        <span className={movement.quantity < 0 ? "text-red-300" : "text-green-300"}>
                                            {movement.quantity > 0 ? `+${movement.quantity}` : movement.quantity}
                                        </span>
                                        <span className="truncate text-neutral-400">
                                            {movement.warehouse}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 gap-6">
                        <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                            <p className="text-xs uppercase tracking-[0.18em] text-emerald-300">
                                Fulfillment Network
                            </p>
                            <h2 className="mt-2 text-2xl font-black">Warehouse Performance</h2>
                            <div className="mt-5 space-y-5">
                                {warehouseStats.length === 0 && (
                                    <p className="rounded-lg border border-white/10 bg-white/[0.03] p-5 text-neutral-500">
                                        No warehouse analytics available.
                                    </p>
                                )}
                                {warehouseStats.map((warehouse) => (
                                    <div key={warehouse.name} className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
                                        <div className="flex items-center justify-between text-sm">
                                            <span className="font-semibold">{warehouse.name}</span>
                                            <span>{warehouse.totalStock} units</span>
                                        </div>
                                        <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                                            <div
                                                className="h-full rounded-full bg-gradient-to-r from-emerald-300 to-sky-300 transition-all duration-700"
                                                style={{ width: `${warehouse.percentage}%` }}
                                            />
                                        </div>
                                        <p className="mt-1 text-xs text-neutral-500">
                                            {warehouse.totalProducts} products, {money(warehouse.inventoryValue)}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                            <p className="text-xs uppercase tracking-[0.18em] text-amber-300">
                                Merchandising Mix
                            </p>
                            <h2 className="mt-2 text-2xl font-black">Category Distribution</h2>
                            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                                {categoryStats.length === 0 && (
                                    <p className="rounded-lg border border-white/10 bg-white/[0.03] p-5 text-neutral-500">
                                        No category analytics available.
                                    </p>
                                )}
                                {categoryStats.map((category) => (
                                    <div
                                        key={category.name}
                                        className="rounded-lg border border-white/10 bg-white/[0.035] p-4 transition-all duration-300 hover:-translate-y-1 hover:border-amber-300/30"
                                    >
                                        <p className="font-semibold">{category.name}</p>
                                        <p className="mt-2 text-2xl font-black text-amber-200">
                                            {category.stock}
                                        </p>
                                        <p className="text-xs uppercase tracking-[0.14em] text-neutral-500">
                                            stock units
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </section>
            </div>

            {(showAddStockModal || showTransferModal) && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
                    <div className="relative w-full max-w-xl overflow-hidden rounded-lg border border-white/10 bg-[#050606] p-6 shadow-2xl inventory-sheen">
                        <div className="flex items-center justify-between">
                            <h2 className="text-2xl font-bold">
                                {showAddStockModal ? "Add Stock" : "Transfer Inventory"}
                            </h2>
                            <button
                                onClick={() => {
                                    resetActionForm()
                                    setShowAddStockModal(false)
                                    setShowTransferModal(false)
                                }}
                                className="relative z-10 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-neutral-300 transition-colors hover:text-white"
                            >
                                Close
                            </button>
                        </div>

                        <div className="relative z-10 mt-5 space-y-4">
                            <select
                                value={selectedProductId}
                                onChange={(event) => setSelectedProductId(event.target.value)}
                                className="w-full rounded-lg border border-white/10 bg-black px-4 py-3 outline-none transition-all focus:border-emerald-300"
                            >
                                <option value="">Select product</option>
                                {products.map((product) => (
                                    <option key={product.id} value={product.id}>
                                        {product.name} - stock {product.currentStock}
                                    </option>
                                ))}
                            </select>

                            <input
                                type="number"
                                min="1"
                                value={quantity}
                                onChange={(event) => setQuantity(event.target.value)}
                                placeholder="Quantity"
                                className="w-full rounded-lg border border-white/10 bg-black px-4 py-3 outline-none transition-all focus:border-emerald-300"
                            />

                            <select
                                value={warehouseId}
                                onChange={(event) => setWarehouseId(event.target.value)}
                                className="w-full rounded-lg border border-white/10 bg-black px-4 py-3 outline-none transition-all focus:border-emerald-300"
                            >
                                {warehouses.length === 0 && (
                                    <option value="">No warehouse configured</option>
                                )}
                                {warehouses.map((warehouse) => (
                                    <option key={warehouse.id} value={warehouse.id}>
                                        {warehouse.name}
                                    </option>
                                ))}
                            </select>

                            {showAddStockModal && (
                                <label className="block text-xs font-semibold uppercase tracking-[0.16em] text-neutral-400">
                                    Expiry date
                                    <input
                                        type="date"
                                        value={expiryDate}
                                        onChange={(event) => setExpiryDate(event.target.value)}
                                        className="mt-2 w-full rounded-lg border border-white/10 bg-black px-4 py-3 text-base normal-case tracking-normal text-white outline-none transition-all focus:border-emerald-300"
                                    />
                                </label>
                            )}

                            {showAddStockModal && hasBatchTracking && (
                                <input
                                    value={batchNo}
                                    onChange={(event) => setBatchNo(event.target.value)}
                                    placeholder="Batch number"
                                    className="w-full rounded-lg border border-white/10 bg-black px-4 py-3 outline-none transition-all focus:border-emerald-300"
                                />
                            )}

                            {showAddStockModal && hasBarcodeScanning && (
                                <input
                                    value={barcode}
                                    onChange={(event) => setBarcode(event.target.value)}
                                    placeholder="Barcode"
                                    className="w-full rounded-lg border border-white/10 bg-black px-4 py-3 outline-none transition-all focus:border-emerald-300"
                                />
                            )}

                            {showAddStockModal && hasShippingLabels && (
                                <input
                                    value={shippingQr}
                                    onChange={(event) => setShippingQr(event.target.value)}
                                    placeholder="Shipping QR or parcel code"
                                    className="w-full rounded-lg border border-white/10 bg-black px-4 py-3 outline-none transition-all focus:border-emerald-300"
                                />
                            )}

                            <button
                                disabled={actionLoading}
                                onClick={() =>
                                    applyStockChange(showAddStockModal ? "add" : "transfer")
                                }
                                className="w-full rounded-lg bg-emerald-400 px-5 py-3 font-bold text-black transition-all hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                {actionLoading
                                    ? "Saving..."
                                    : showAddStockModal
                                    ? "Save Stock Entry"
                                    : "Transfer Stock"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
