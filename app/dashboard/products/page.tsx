"use client"

import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { useDebounce } from "use-debounce"
import { apiFetch } from "@/lib/api/client-fetch"
import { getOrganizationFeatures } from "@/lib/get-organization-features"
import { getOrganizationId } from "@/lib/getOrganization"
import { createOfflineId, getOfflineData, putOfflineData, queueOfflineAction } from "@/lib/offline/db"
import { offlineFallbackMessage, shouldSaveOffline } from "@/lib/offline/network"

type ProductRow = {
    id: string
    organization_id: string
    name: string
    description: string | null
    sku: string | null
    barcode: string | null
    category: string | null
    unit: string | null
    supplier: string | null
    warehouse: string | null
    manufacturer: string | null
    price: number | null
    stock: number | null
    batch_no: string | null
    mrp: number | null
    purchase_rate: number | null
    sale_rate: number | null
    gst: number | null
    expiry_date: string | null
    purchase_date: string | null
    min_stock: number | null
    created_at: string | null
    deleted_at?: string | null
    updated_at?: string | null
    sync_status?: string | null
    offline_local_id?: string | null
    local_id?: string | null
    server_id?: string | null
}

type StockMovement = {
    id: string
    product_id?: string | null
    type: string | null
    quantity: number | null
    previous_stock: number | null
    new_stock: number | null
    reason: string | null
    reference_no: string | null
    created_at: string | null
}

type ProductForm = {
    name: string
    description: string
    manufacturer: string
    sku: string
    barcode: string
    category: string
    unit: string
    supplier: string
    warehouse: string
    price: string
    stock: string
    minStock: string
    batchNo: string
    mrp: string
    purchaseRate: string
    saleRate: string
    gst: string
    expiry: string
    purchaseDate: string
}

type Analytics = {
    totalProducts: number
    lowStockCount: number
    outOfStockCount: number
    expiredCount: number
    expiringSoonCount: number
    totalInventoryValue: number
    totalCostValue: number
    totalPotentialProfit: number
    categoriesCount: number
    suppliersCount: number
    warehousesCount: number
}

type ProductsListResponse = {
    data?: ProductRow[]
    pagination?: {
        total?: number
    }
    error?: string
}

type ProductActionResponse = {
    success: boolean
    error?: string
    product?: {
        id: string
    }
}

const emptyForm: ProductForm = {
    name: "",
    description: "",
    manufacturer: "",
    sku: "",
    barcode: "",
    category: "",
    unit: "pcs",
    supplier: "",
    warehouse: "Main Warehouse",
    price: "",
    stock: "",
    minStock: "5",
    batchNo: "",
    mrp: "",
    purchaseRate: "",
    saleRate: "",
    gst: "",
    expiry: "",
    purchaseDate: "",
}

function numberValue(value: string) {
    return value.trim() === "" ? null : Number(value)
}

function validateNumberInput(label: string, value: string) {
    if (value.trim() === "") return null
    return Number.isFinite(Number(value)) ? null : `${label} must be a valid number.`
}

function isValidIsoDate(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const [year, month, day] = value.split("-").map(Number)
    const date = new Date(Date.UTC(year, month - 1, day))
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function normalizeDateInput(value: string) {
    const trimmed = value.trim()
    if (!trimmed) return null

    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return isValidIsoDate(trimmed) ? trimmed : null
    }

    const parts = trimmed.split(/[/-]/).map((part) => part.trim())
    if (parts.length !== 3) return null

    const [day, month, year] = parts
    if (!day || !month || !year || year.length !== 4) return null

    const normalized = `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
    return isValidIsoDate(normalized) ? normalized : null
}

function dateInputValue(value: string | null) {
    if (!value) return ""
    return normalizeDateInput(value.slice(0, 10)) || ""
}

function money(value: number) {
    return `Rs ${Math.round(value).toLocaleString()}`
}

function formatDate(value: string | null) {
    if (!value) return "-"
    const normalized = normalizeDateInput(value.slice(0, 10))
    if (!normalized) return "-"
    const [year, month, day] = normalized.split("-")
    return `${day}/${month}/${year}`
}

function csvCell(value: string | number | null) {
    const text = String(value ?? "")
    return `"${text.replaceAll("\"", "\"\"")}"`
}

const productCacheKey = "bezgrow:products:last"

function readCachedProducts() {
    if (typeof window === "undefined") return []
    try {
        const cached = JSON.parse(sessionStorage.getItem(productCacheKey) || "[]") as ProductRow[]
        return Array.isArray(cached) ? cached : []
    } catch {
        sessionStorage.removeItem(productCacheKey)
        return []
    }
}

function writeCachedProducts(rows: ProductRow[]) {
    if (typeof window === "undefined") return
    sessionStorage.setItem(productCacheKey, JSON.stringify(rows.slice(0, 50)))
}

function buildAnalytics(rows: ProductRow[]): Analytics {
    const categories = new Set(rows.map((row) => row.category).filter(Boolean))
    const suppliers = new Set(rows.map((row) => row.supplier).filter(Boolean))
    const warehouses = new Set(rows.map((row) => row.warehouse).filter(Boolean))
    const lowStockRows = rows.filter(
        (row) => Number(row.stock || 0) <= Number(row.min_stock ?? 5)
    )
    const outOfStockRows = rows.filter((row) => Number(row.stock || 0) <= 0)
    const expiredRows = rows.filter(isExpired)
    const expiringSoonRows = rows.filter(isExpiringSoon)
    const totalInventoryValue = rows.reduce((sum, row) => {
        const stock = Number(row.stock || 0)
        const sale = Number(row.sale_rate || row.price || 0)
        return sum + stock * sale
    }, 0)
    const totalCostValue = rows.reduce((sum, row) => {
        const stock = Number(row.stock || 0)
        const purchase = Number(row.purchase_rate || 0)
        return sum + stock * purchase
    }, 0)

    return {
        totalProducts: rows.length,
        lowStockCount: lowStockRows.length,
        outOfStockCount: outOfStockRows.length,
        expiredCount: expiredRows.length,
        expiringSoonCount: expiringSoonRows.length,
        totalInventoryValue,
        totalCostValue,
        totalPotentialProfit: totalInventoryValue - totalCostValue,
        categoriesCount: categories.size,
        suppliersCount: suppliers.size,
        warehousesCount: warehouses.size,
    }
}

function formFromProduct(product: ProductRow): ProductForm {
    return {
        name: product.name || "",
        description: product.description || "",
        manufacturer: product.manufacturer || "",
        sku: product.sku || "",
        barcode: product.barcode || "",
        category: product.category || "",
        unit: product.unit || "pcs",
        supplier: product.supplier || "",
        warehouse: product.warehouse || "Main Warehouse",
        price: product.price == null ? "" : String(product.price),
        stock: product.stock == null ? "" : String(product.stock),
        minStock: product.min_stock == null ? "5" : String(product.min_stock),
        batchNo: product.batch_no || "",
        mrp: product.mrp == null ? "" : String(product.mrp),
        purchaseRate: product.purchase_rate == null ? "" : String(product.purchase_rate),
        saleRate: product.sale_rate == null ? "" : String(product.sale_rate),
        gst: product.gst == null ? "" : String(product.gst),
        expiry: dateInputValue(product.expiry_date),
        purchaseDate: dateInputValue(product.purchase_date),
    }
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

export default function ProductsPage() {
    const [organizationId, setOrganizationId] = useState<string | null>(null)
    const [features, setFeatures] = useState<string[]>([])
    const [products, setProducts] = useState<ProductRow[]>(() => readCachedProducts())
    const [analytics, setAnalytics] = useState<Analytics>(() => buildAnalytics(readCachedProducts()))
    const [stockMovements, setStockMovements] = useState<StockMovement[]>([])
    const [movementLoading, setMovementLoading] = useState(false)
    const [saving, setSaving] = useState(false)
    const [notice, setNotice] = useState("")
    const [search, setSearch] = useState("")
    const [debouncedSearch] = useDebounce(search, 350)
    const [selectedCategory, setSelectedCategory] = useState("all")
    const [selectedSupplier, setSelectedSupplier] = useState("all")
    const [stockStatusFilter, setStockStatusFilter] = useState("all")
    const [activeFilter, setActiveFilter] = useState("all")
    const [sortField, setSortField] = useState<keyof ProductRow>("created_at")
    const [sortAsc, setSortAsc] = useState(false)
    const [currentPage, setCurrentPage] = useState(1)
    const [showFormModal, setShowFormModal] = useState(false)
    const [editProduct, setEditProduct] = useState<ProductRow | null>(null)
    const [viewProduct, setViewProduct] = useState<ProductRow | null>(null)
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
    const [form, setForm] = useState<ProductForm>(emptyForm)
    const [formError, setFormError] = useState("")
    const skipNextProductsRefresh = useRef(false)

    const itemsPerPage = 50
    const hasExpiryTracking = features.includes("expiry_tracking")
    const hasBatchTracking = features.includes("batch_tracking")
    const hasBarcodeScanning = features.includes("barcode_scanning")
    const hasShippingLabels = features.includes("shipping_labels")
    const hasVariants = features.includes("size_variants")
    const hasSerialNumbers = features.includes("serial_numbers")
    const hasWarrantyTracking = features.includes("warranty_tracking")

    async function initializeProducts() {
        try {
            const orgId = await getOrganizationId()

            if (!orgId) {
                setNotice("No business is connected to this account.")
                setProducts([])
                return
            }

            skipNextProductsRefresh.current = true
            setOrganizationId(orgId)
            void getOrganizationFeatures(orgId).then((orgFeatures) => {
                setFeatures(Array.from(new Set(orgFeatures)))
            })
            await fetchProducts(orgId)
        } catch (error) {
            setNotice(error instanceof Error ? error.message : "Products failed to load.")
        }
    }

    async function fetchProducts(orgId = organizationId, forceFresh = false) {
        if (!orgId) {
            setProducts([])
            return
        }

        const params = new URLSearchParams({
            page: String(currentPage),
            limit: String(itemsPerPage),
            sort: String(sortField),
            direction: sortAsc ? "asc" : "desc",
        })

        if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim())
        if (forceFresh) params.set("_t", String(Date.now()))

        try {
            const response = await apiFetch(`/api/products/list?${params.toString()}`, {
                credentials: "include",
                cache: forceFresh ? "no-store" : "default",
            })
            const payload = (await response.json()) as ProductsListResponse

            if (!response.ok) {
                throw new Error(payload.error || "Products failed to load.")
            }

            const rows = payload.data || []
            await putOfflineData(orgId, "products", rows)
            await putOfflineData(orgId, "inventory_items", rows)
            setAnalytics(buildAnalytics(rows))
            writeCachedProducts(rows)
            setProducts(rows)
            setNotice("")
        } catch (error) {
            const cachedProducts = await getOfflineData<ProductRow[]>(orgId, "products", [])
            setAnalytics(buildAnalytics(cachedProducts))
            setProducts(cachedProducts)
            writeCachedProducts(cachedProducts)
            setNotice(
                shouldSaveOffline(error)
                    ? offlineFallbackMessage("Offline mode: showing cached products.", "Connection failed. Showing cached products.")
                    : error instanceof Error ? error.message : "Products failed to load."
            )
        }
    }

    async function refreshData() {
        if (!organizationId) return
        await fetchProducts(organizationId, true)
    }

    async function fetchStockMovements(productId: string) {
        if (!organizationId) return

        setMovementLoading(true)
        const movements = await getOfflineData<StockMovement[]>(organizationId, "stock_movements", [])
        setStockMovements(
            movements
                .filter((movement) => movement.product_id === productId)
                .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
                .slice(0, 20)
        )
        setMovementLoading(false)
    }

    function updateForm<K extends keyof ProductForm>(field: K, value: ProductForm[K]) {
        setFormError("")
        setForm((current) => ({ ...current, [field]: value }))
    }

    function openAddModal() {
        setEditProduct(null)
        setForm(emptyForm)
        setFormError("")
        setShowFormModal(true)
    }

    function openEditModal(product: ProductRow) {
        setEditProduct(product)
        setForm(formFromProduct(product))
        setFormError("")
        setShowFormModal(true)
    }

    async function saveProduct() {
        if (saving) return

        if (!organizationId) {
            setFormError("Business not found. Please refresh and try again.")
            return
        }
        if (!form.name.trim()) {
            setFormError("Product name is required.")
            return
        }
        if (!form.saleRate.trim()) {
            setFormError("Sale rate is required.")
            return
        }

        const expiryDate = normalizeDateInput(form.expiry)
        const purchaseDate = normalizeDateInput(form.purchaseDate)
        if (form.expiry.trim() && !expiryDate) {
            setFormError("Expiry date must be a valid date.")
            return
        }
        if (form.purchaseDate.trim() && !purchaseDate) {
            setFormError("Purchase date must be a valid date.")
            return
        }
        if (expiryDate && purchaseDate && purchaseDate > expiryDate) {
            setFormError("Purchase date cannot be after expiry date.")
            return
        }

        const numberError = [
            ["Stock", form.stock],
            ["Minimum stock", form.minStock],
            ["Purchase rate", form.purchaseRate],
            ["Sale rate", form.saleRate],
            ["MRP", form.mrp],
            ["GST", form.gst],
            ["Fallback price", form.price],
        ]
            .map(([label, value]) => validateNumberInput(label, value))
            .find(Boolean)

        if (numberError) {
            setFormError(numberError)
            return
        }
        if (Number(form.saleRate) <= 0) {
            setFormError("Sale rate must be greater than 0.")
            return
        }

        setSaving(true)
        setNotice("")
        setFormError("")

        const stockValue = Number(form.stock || 0)
        const payload = {
            name: form.name.trim(),
            description: form.description.trim() || null,
            manufacturer: form.manufacturer.trim() || null,
            sku: form.sku.trim() || null,
            barcode: form.barcode.trim() || null,
            category: form.category.trim() || null,
            unit: form.unit || "pcs",
            supplier: form.supplier.trim() || null,
            warehouse: form.warehouse.trim() || "Main Warehouse",
            price: numberValue(form.price),
            stock: stockValue,
            min_stock: numberValue(form.minStock),
            batch_no: form.batchNo.trim() || null,
            mrp: numberValue(form.mrp),
            purchase_rate: numberValue(form.purchaseRate),
            sale_rate: numberValue(form.saleRate),
            gst: numberValue(form.gst),
            expiry_date: expiryDate,
            purchase_date: purchaseDate,
        }

        try {
            const response = await apiFetch(editProduct ? "/api/products/update" : "/api/products/create", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(editProduct ? { id: editProduct.id, ...payload } : payload),
            })
            const result = (await response.json().catch(() => ({
                success: false,
                error: "Product save returned an invalid response.",
            }))) as ProductActionResponse

            if (!response.ok || !result.success) {
                setFormError(result.error || "Product could not be saved.")
                setSaving(false)
                return
            }

            setShowFormModal(false)
            setEditProduct(null)
            setForm(emptyForm)
            await refreshData()
            setSaving(false)
            setNotice(editProduct ? "Product updated successfully." : "Product created successfully.")
        } catch (error) {
            if (shouldSaveOffline(error)) {
                await saveProductOffline(payload)
                setSaving(false)
                return
            }

            setFormError(error instanceof Error ? error.message : "Product could not be saved. Please check your connection and try again.")
            setSaving(false)
        }
    }

    async function saveProductOffline(payload: Omit<ProductRow, "id" | "organization_id" | "created_at">) {
        if (!organizationId) return
        const now = new Date().toISOString()
        const localProductId = editProduct?.id || createOfflineId("product")
        const nextProduct: ProductRow = {
            ...(editProduct || {}),
            ...payload,
            id: localProductId,
            organization_id: organizationId,
            created_at: editProduct?.created_at || now,
            deleted_at: null,
            sync_status: editProduct ? "pending_update" : "pending_create",
            offline_local_id: localProductId,
            updated_at: now,
        } as ProductRow
        const cachedProducts = await getOfflineData<ProductRow[]>(organizationId, "products", products)
        const exists = cachedProducts.some((product) => product.id === localProductId)
        const nextProducts = exists
            ? cachedProducts.map((product) => (product.id === localProductId ? nextProduct : product))
            : [nextProduct, ...cachedProducts]

        await putOfflineData(organizationId, "products", nextProducts)
        await putOfflineData(organizationId, "inventory_items", nextProducts)
        await queueOfflineAction({
            id: createOfflineId("product-action"),
            type: "save_product",
            organizationId,
            payload: {
                localProductId,
                serverProductId: editProduct && !editProduct.id.startsWith("offline-") ? editProduct.id : null,
                product: payload,
            },
        })

        setProducts(nextProducts)
        setAnalytics(buildAnalytics(nextProducts))
        writeCachedProducts(nextProducts)
        setShowFormModal(false)
        setEditProduct(null)
        setForm(emptyForm)
        setNotice(editProduct ? "Product updated offline. Pending sync." : "Product created offline. Pending sync.")
    }

    async function confirmDelete() {
        if (!confirmDeleteId || !organizationId) return

        const idToDelete = confirmDeleteId
        const now = new Date().toISOString()
        setConfirmDeleteId(null)

        const archiveOffline = async () => {
            const cachedProducts = await getOfflineData<ProductRow[]>(organizationId, "products", products)
            const nextProducts = cachedProducts.map((product) =>
                product.id === idToDelete ? { ...product, sync_status: "pending_delete", deleted_at: now, updated_at: now } : product
            )
            await putOfflineData(organizationId, "products", nextProducts)
            await putOfflineData(organizationId, "inventory_items", nextProducts)
            await queueOfflineAction({
                id: createOfflineId("product-archive"),
                type: "archive_product",
                organizationId,
                payload: { productId: idToDelete },
            })
            setProducts(nextProducts.filter((product) => product.id !== idToDelete))
            setAnalytics(buildAnalytics(nextProducts.filter((product) => product.id !== idToDelete)))
            setNotice("Product archived offline. Pending sync.")
        }

        if (shouldSaveOffline()) {
            await archiveOffline()
            return
        }

        setProducts((current) => current.filter((product) => product.id !== idToDelete))

        try {
            const response = await apiFetch("/api/products/archive", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ id: idToDelete }),
            })
            const payload = (await response.json()) as ProductActionResponse

            if (!response.ok || !payload.success) {
                setNotice(payload.error || "Product could not be archived.")
                await fetchProducts(undefined, true)
                return
            }

            await fetchProducts(undefined, true)
            setNotice("Product moved to trash.")
        } catch (error) {
            if (shouldSaveOffline(error)) {
                await archiveOffline()
                return
            }

            setNotice(error instanceof Error ? error.message : "Product could not be archived.")
            await fetchProducts(undefined, true)
        }
    }

    function exportProductsCSV() {
        if (filteredProducts.length === 0) {
            setNotice("No products available to export.")
            return
        }

        const headers = [
            "Name",
            "SKU",
            "Barcode",
            "Category",
            "Supplier",
            "Warehouse",
            "Stock",
            "Minimum Stock",
            "Purchase Rate",
            "Sale Rate",
            "MRP",
            "GST",
            "Profit Per Unit",
            "Inventory Value",
            "Expiry Date",
        ]
        const rows = filteredProducts.map((product) => {
            const sale = Number(product.sale_rate || product.price || 0)
            const purchase = Number(product.purchase_rate || 0)
            const stock = Number(product.stock || 0)

            return [
                product.name,
                product.sku || "",
                product.barcode || "",
                product.category || "",
                product.supplier || "",
                product.warehouse || "",
                stock,
                product.min_stock ?? 5,
                purchase,
                sale,
                product.mrp ?? "",
                product.gst ?? "",
                sale - purchase,
                sale * stock,
                product.expiry_date || "",
            ]
        })
        const csv = [headers, ...rows]
            .map((row) => row.map(csvCell).join(","))
            .join("\n")
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
        const url = URL.createObjectURL(blob)
        const link = document.createElement("a")

        link.href = url
        link.download = `product-master-export-${new Date().toISOString()}.csv`
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
    }

    useEffect(() => {
        initializeProducts()
        // Product master bootstrap intentionally runs once on page load.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        setCurrentPage(1)
    }, [search, selectedCategory, selectedSupplier, stockStatusFilter, activeFilter])

    useEffect(() => {
        if (!organizationId) return
        if (skipNextProductsRefresh.current) {
            skipNextProductsRefresh.current = false
            return
        }
        fetchProducts()
        // Data refresh follows debounced search and pagination state.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedSearch, currentPage, organizationId])

    const categories = useMemo(
        () => Array.from(new Set(products.map((product) => product.category).filter(Boolean))) as string[],
        [products]
    )

    const suppliers = useMemo(
        () => Array.from(new Set(products.map((product) => product.supplier).filter(Boolean))) as string[],
        [products]
    )

    const filteredProducts = useMemo(() => {
        let rows = [...products]

        if (selectedCategory !== "all") {
            rows = rows.filter((product) => product.category === selectedCategory)
        }
        if (selectedSupplier !== "all") {
            rows = rows.filter((product) => product.supplier === selectedSupplier)
        }
        if (stockStatusFilter === "inStock") {
            rows = rows.filter((product) => Number(product.stock || 0) > 0)
        }
        if (stockStatusFilter === "outOfStock") {
            rows = rows.filter((product) => Number(product.stock || 0) <= 0)
        }
        if (activeFilter === "low") {
            rows = rows.filter(
                (product) => Number(product.stock || 0) <= Number(product.min_stock ?? 5)
            )
        }
        if (activeFilter === "expired") {
            rows = rows.filter(isExpired)
        }
        if (activeFilter === "expiringSoon") {
            rows = rows.filter(isExpiringSoon)
        }

        rows.sort((a, b) => {
            const aValue = a[sortField]
            const bValue = b[sortField]

            if (aValue == null && bValue == null) return 0
            if (aValue == null) return sortAsc ? -1 : 1
            if (bValue == null) return sortAsc ? 1 : -1
            if (aValue < bValue) return sortAsc ? -1 : 1
            if (aValue > bValue) return sortAsc ? 1 : -1
            return 0
        })

        return rows
    }, [
        activeFilter,
        products,
        selectedCategory,
        selectedSupplier,
        sortAsc,
        sortField,
        stockStatusFilter,
    ])

    const totalPages = Math.max(1, currentPage + (products.length === itemsPerPage ? 1 : 0))

    const productHealth =
        analytics.totalProducts > 0
            ? Math.round(
                ((analytics.totalProducts - analytics.lowStockCount) /
                    analytics.totalProducts) *
                100
            )
            : 0

    const statCards = [
        {
            label: "Products",
            value: analytics.totalProducts,
            meta: `${analytics.categoriesCount} categories`,
            filter: "all",
            accent: "from-white to-neutral-400",
        },
        {
            label: "Low Stock",
            value: analytics.lowStockCount,
            meta: `${analytics.outOfStockCount} out of stock`,
            filter: "low",
            accent: "from-amber-200 to-yellow-500",
        },
        {
            label: "Expiry Risk",
            value: analytics.expiredCount + analytics.expiringSoonCount,
            meta: `${analytics.expiringSoonCount} expiring in 30 days`,
            filter: "expiringSoon",
            accent: "from-red-200 to-rose-500",
        },
        {
            label: "Inventory Value",
            value: money(analytics.totalInventoryValue),
            meta: `${money(analytics.totalPotentialProfit)} potential margin`,
            filter: "all",
            accent: "from-emerald-200 to-green-500",
        },
        {
            label: "Suppliers",
            value: analytics.suppliersCount,
            meta: `${analytics.warehousesCount} warehouse labels`,
            filter: "all",
            accent: "from-sky-200 to-blue-500",
        },
    ]

    const erpModules = [
        "Product records",
        "SKU and barcode control",
        "Pricing and GST",
        "Supplier mapping",
        "Warehouse labels",
        "Stock movement audit",
        hasExpiryTracking ? "Expiry tracking" : "Expiry fields ready",
        hasBatchTracking ? "Batch tracking" : "Batch fields ready",
        hasShippingLabels ? "Shipping label workflow" : "Shipping-ready workflow",
    ]

    return (
        <div className="inventory-grid-bg min-h-full overflow-x-hidden text-white">
            <div className="mx-auto max-w-[1900px] space-y-6 px-3 py-4 sm:px-5 lg:px-6">
                <section className="relative overflow-hidden rounded-lg border border-white/10 bg-black/70 p-6 shadow-2xl backdrop-blur-xl inventory-sheen lg:p-8">
                    <div className="relative z-10 grid gap-8 xl:grid-cols-[1.15fr_0.85fr] xl:items-end">
                        <div>
                            <div className="mb-4">
                                <Link
                                    href="/dashboard"
                                    className="inline-flex h-11 items-center rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-bold text-neutral-200 transition-all duration-300 hover:-translate-y-1 hover:border-sky-300/40 hover:bg-white/[0.08]"
                                >
                                    Back to Dashboard
                                </Link>
                            </div>
                            <div className="flex flex-wrap gap-3">
                                <span className="rounded-full border border-sky-400/25 bg-sky-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-sky-200">
                                    Product List
                                </span>
                                <span className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-200">
                                    Stock + Billing
                                </span>
                            </div>

                            <h1 className="mt-5 max-w-5xl text-4xl font-black tracking-tight text-white md:text-6xl">
                                Products
                            </h1>

                            <p className="mt-4 max-w-4xl text-base leading-7 text-neutral-300">
                                A professional product list for SKUs, pricing, GST,
                                batches, expiry, suppliers, warehouse labels, billing
                                readiness, and stock audit trails.
                            </p>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-3">
                            {[
                                `${analytics.totalProducts} active SKUs`,
                                `${analytics.suppliersCount} suppliers`,
                                `${productHealth}% stock health`,
                            ].map((signal) => (
                                <div
                                    key={signal}
                                    className="rounded-lg border border-white/10 bg-white/[0.04] p-4 shadow-lg transition-all duration-300 hover:-translate-y-1 hover:border-sky-300/30 hover:bg-white/[0.07]"
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

                    <div className="relative z-10 mt-7 grid min-w-0 grid-cols-1 gap-4 border-t border-white/10 pt-5">
                        <div className="grid w-full min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,0.85fr)_minmax(0,0.85fr)_minmax(0,0.7fr)]">
                            <input
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder="Search product, SKU, category, supplier"
                                className="h-14 min-w-0 rounded-lg border border-white/10 bg-black/60 px-5 text-base outline-none transition-all placeholder:text-neutral-500 focus:border-sky-300/60 focus:ring-2 focus:ring-sky-400/10"
                            />
                            <div className="relative min-w-0">
                                <select
                                    value={selectedCategory}
                                    onChange={(event) => setSelectedCategory(event.target.value)}
                                    className="h-14 w-full appearance-none rounded-lg border border-white/10 bg-black/60 py-0 pl-5 pr-16 text-base outline-none transition-all focus:border-sky-300/60"
                                >
                                    <option value="all">All categories</option>
                                    {categories.map((item) => (
                                        <option key={item} value={item}>
                                            {item}
                                        </option>
                                    ))}
                                </select>
                                <span className="pointer-events-none absolute right-6 top-1/2 h-3 w-3 -translate-y-1/2 rotate-45 border-b-2 border-r-2 border-white" />
                            </div>
                            <div className="relative min-w-0">
                                <select
                                    value={selectedSupplier}
                                    onChange={(event) => setSelectedSupplier(event.target.value)}
                                    className="h-14 w-full appearance-none rounded-lg border border-white/10 bg-black/60 py-0 pl-5 pr-16 text-base outline-none transition-all focus:border-sky-300/60"
                                >
                                    <option value="all">All suppliers</option>
                                    {suppliers.map((item) => (
                                        <option key={item} value={item}>
                                            {item}
                                        </option>
                                    ))}
                                </select>
                                <span className="pointer-events-none absolute right-6 top-1/2 h-3 w-3 -translate-y-1/2 rotate-45 border-b-2 border-r-2 border-white" />
                            </div>
                            <div className="relative min-w-0">
                                <select
                                    value={stockStatusFilter}
                                    onChange={(event) => setStockStatusFilter(event.target.value)}
                                    className="h-14 w-full appearance-none rounded-lg border border-white/10 bg-black/60 py-0 pl-5 pr-16 text-base outline-none transition-all focus:border-sky-300/60"
                                >
                                    <option value="all">All stock</option>
                                    <option value="inStock">In stock</option>
                                    <option value="outOfStock">Out of stock</option>
                                </select>
                                <span className="pointer-events-none absolute right-6 top-1/2 h-3 w-3 -translate-y-1/2 rotate-45 border-b-2 border-r-2 border-white" />
                            </div>
                        </div>

                        <div className="grid w-full max-w-full min-w-0 grid-cols-1 gap-3 md:grid-cols-3">
                            <button
                                onClick={openAddModal}
                                className="h-14 w-full min-w-0 rounded-lg bg-gradient-to-r from-sky-300 to-emerald-300 px-6 text-base font-black text-black shadow-xl shadow-sky-500/20 transition-all duration-300 hover:-translate-y-1 hover:shadow-emerald-500/20"
                            >
                                Add Product
                            </button>
                            <button
                                onClick={exportProductsCSV}
                                className="h-14 w-full min-w-0 rounded-lg border border-white/10 bg-white/[0.05] px-5 text-base font-bold transition-all duration-300 hover:-translate-y-1 hover:border-emerald-300/40 hover:bg-white/[0.08]"
                            >
                                Export CSV
                            </button>
                            <Link
                                href="/dashboard/inventory"
                                className="flex h-14 w-full min-w-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] px-5 text-base font-bold transition-all duration-300 hover:-translate-y-1 hover:border-white/25 hover:bg-white/[0.08]"
                            >
                                Inventory
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
                    {statCards.map((item) => (
                        <button
                            key={item.label}
                            onClick={() => setActiveFilter(item.filter)}
                            className="group relative overflow-hidden rounded-lg border border-white/10 bg-black/70 p-5 text-left shadow-xl backdrop-blur transition-all duration-300 hover:-translate-y-1 hover:border-white/20"
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
                        </button>
                    ))}
                </section>

                <section className="grid grid-cols-1 gap-6 2xl:grid-cols-[1.55fr_0.7fr]">
                    <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                        <div className="flex flex-col gap-3 border-b border-white/10 pb-4 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <p className="text-xs uppercase tracking-[0.18em] text-sky-300">
                                    Product Ledger
                                </p>
                                <h2 className="mt-2 text-2xl font-black">
                                    Product Catalog
                                </h2>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {["all", "low", "expired", "expiringSoon"].map((filter) => (
                                    <button
                                        key={filter}
                                        onClick={() => setActiveFilter(filter)}
                                        className={`rounded-lg border px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] transition-all ${activeFilter === filter
                                            ? "border-sky-300/50 bg-sky-300/15 text-sky-100"
                                            : "border-white/10 bg-white/[0.04] text-neutral-400 hover:text-white"
                                            }`}
                                    >
                                        {filter === "all"
                                            ? "All"
                                            : filter === "expiringSoon"
                                                ? "30d Expiry"
                                                : filter}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="mt-4 space-y-3 lg:hidden">
                            {filteredProducts.length === 0 && (
                                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-6 text-center text-sm text-neutral-500">
                                    No products found for the selected filters.
                                </div>
                            )}

                            {filteredProducts.map((product) => {
                                const sale = Number(product.sale_rate || product.price || 0)
                                const purchase = Number(product.purchase_rate || 0)
                                const stock = Number(product.stock || 0)
                                const lowStock = stock <= Number(product.min_stock ?? 5)
                                const expired = isExpired(product)
                                const expiring = isExpiringSoon(product)

                                return (
                                    <article key={product.id} className="rounded-lg border border-white/10 bg-white/[0.045] p-4 shadow-xl">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <h3 className="truncate text-base font-black text-white">{product.name}</h3>
                                                <p className="mt-1 truncate text-xs text-neutral-500">
                                                    SKU {product.sku || "N/A"} | {product.category || "General"}
                                                </p>
                                            </div>
                                            <span className={`shrink-0 rounded-full border px-3 py-1 text-xs font-black ${stock <= 0
                                                ? "border-red-400/30 bg-red-400/10 text-red-200"
                                                : lowStock
                                                    ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                                                    : "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                                                }`}>
                                                {stock} {product.unit || "pcs"}
                                            </span>
                                        </div>

                                        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                                            <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                                                <p className="text-xs text-neutral-500">Price</p>
                                                <p className="mt-1 font-black text-emerald-200">{money(sale)}</p>
                                            </div>
                                            <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                                                <p className="text-xs text-neutral-500">Margin</p>
                                                <p className="mt-1 font-black text-sky-200">{money(sale - purchase)}</p>
                                            </div>
                                            <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                                                <p className="text-xs text-neutral-500">Supplier</p>
                                                <p className="mt-1 truncate font-semibold text-neutral-100">{product.supplier || "-"}</p>
                                            </div>
                                            <div className="rounded-lg border border-white/10 bg-black/30 p-3">
                                                <p className="text-xs text-neutral-500">Expiry</p>
                                                <p className={`mt-1 truncate font-semibold ${expired ? "text-red-300" : expiring ? "text-amber-300" : "text-neutral-100"}`}>
                                                    {formatDate(product.expiry_date)}
                                                </p>
                                            </div>
                                        </div>

                                        <div className="mt-4 grid grid-cols-3 gap-2">
                                            <button
                                                onClick={async () => {
                                                    setViewProduct(product)
                                                    await fetchStockMovements(product.id)
                                                }}
                                                className="min-h-11 rounded-lg border border-white/10 bg-white/[0.05] text-sm font-bold text-neutral-100"
                                            >
                                                View
                                            </button>
                                            <button
                                                onClick={() => openEditModal(product)}
                                                className="min-h-11 rounded-lg border border-sky-400/20 bg-sky-400/10 text-sm font-bold text-sky-100"
                                            >
                                                Edit
                                            </button>
                                            <button
                                                onClick={() => setConfirmDeleteId(product.id)}
                                                className="min-h-11 rounded-lg border border-red-400/20 bg-red-400/10 text-sm font-bold text-red-100"
                                            >
                                                Delete
                                            </button>
                                        </div>
                                    </article>
                                )
                            })}
                        </div>

                        <div className="mt-4 hidden overflow-x-auto lg:block">
                            <table className="w-full min-w-[1120px] border-separate border-spacing-y-2 text-sm">
                                <thead className="text-left text-xs uppercase tracking-[0.16em] text-neutral-500">
                                    <tr>
                                        {[
                                            ["name", "Product"],
                                            ["sale_rate", "Pricing"],
                                            ["category", "Category"],
                                            ["stock", "Stock"],
                                            ["supplier", "Supplier"],
                                            ["warehouse", "Warehouse"],
                                            ["expiry_date", "Expiry"],
                                        ].map(([field, label]) => (
                                            <th
                                                key={field}
                                                className="cursor-pointer px-3 py-2"
                                                onClick={() => {
                                                    setSortField(field as keyof ProductRow)
                                                    setSortAsc(sortField === field ? !sortAsc : true)
                                                }}
                                            >
                                                {label}
                                            </th>
                                        ))}
                                        <th className="px-3 py-2 text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredProducts.length === 0 && (
                                        <tr>
                                            <td colSpan={8} className="rounded-lg border border-white/10 bg-white/[0.03] py-14 text-center text-neutral-500">
                                                No products found for the selected filters.
                                            </td>
                                        </tr>
                                    )}

                                    {filteredProducts.map((product) => {
                                        const sale = Number(product.sale_rate || product.price || 0)
                                        const purchase = Number(product.purchase_rate || 0)
                                        const stock = Number(product.stock || 0)
                                        const lowStock = stock <= Number(product.min_stock ?? 5)
                                        const expired = isExpired(product)
                                        const expiring = isExpiringSoon(product)

                                        return (
                                            <tr
                                                key={product.id}
                                                className="bg-white/[0.035] transition-all duration-300 hover:bg-white/[0.065]"
                                            >
                                                <td className="rounded-l-lg px-3 py-4">
                                                    <p className="font-semibold text-white">{product.name}</p>
                                                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-neutral-500">
                                                        <span>SKU: {product.sku || "N/A"}</span>
                                                        {product.barcode && <span>Barcode: {product.barcode}</span>}
                                                    </div>
                                                </td>
                                                <td className="px-3 py-4">
                                                    <p className="font-semibold text-emerald-200">
                                                        {money(sale)}
                                                    </p>
                                                    <p className="text-xs text-neutral-500">
                                                        Margin {money(sale - purchase)}
                                                    </p>
                                                </td>
                                                <td className="px-3 py-4 text-neutral-300">
                                                    {product.category || "General"}
                                                </td>
                                                <td className="px-3 py-4">
                                                    <span className={`inline-flex min-w-16 justify-center rounded-full border px-3 py-1 text-xs font-bold ${stock <= 0
                                                        ? "border-red-400/30 bg-red-400/10 text-red-200"
                                                        : lowStock
                                                            ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
                                                            : "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                                                        }`}>
                                                        {stock}
                                                    </span>
                                                    <p className="mt-1 text-xs text-neutral-500">
                                                        Min {product.min_stock ?? 5} {product.unit || "pcs"}
                                                    </p>
                                                </td>
                                                <td className="px-3 py-4 text-neutral-300">
                                                    {product.supplier || "-"}
                                                </td>
                                                <td className="px-3 py-4 text-neutral-300">
                                                    {product.warehouse || "Main Warehouse"}
                                                </td>
                                                <td className="px-3 py-4">
                                                    <p className={expired ? "font-semibold text-red-300" : expiring ? "font-semibold text-amber-300" : "text-neutral-300"}>
                                                        {formatDate(product.expiry_date)}
                                                    </p>
                                                    {product.batch_no && (
                                                        <p className="mt-1 text-xs text-neutral-500">
                                                            Batch {product.batch_no}
                                                        </p>
                                                    )}
                                                </td>
                                                <td className="rounded-r-lg px-3 py-4 text-right">
                                                    <div className="flex justify-end gap-2">
                                                        <button
                                                            onClick={async () => {
                                                                setViewProduct(product)
                                                                await fetchStockMovements(product.id)
                                                            }}
                                                            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-neutral-200 hover:bg-white/[0.08]"
                                                        >
                                                            View
                                                        </button>
                                                        <button
                                                            onClick={() => openEditModal(product)}
                                                            className="rounded-lg border border-sky-400/20 bg-sky-400/10 px-3 py-2 text-xs font-semibold text-sky-200 hover:bg-sky-400/15"
                                                        >
                                                            Edit
                                                        </button>
                                                        <button
                                                            onClick={() => setConfirmDeleteId(product.id)}
                                                            className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs font-semibold text-red-200 hover:bg-red-400/15"
                                                        >
                                                            Delete
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>

                        <div className="mt-5 flex items-center justify-between border-t border-white/10 pt-4">
                            <button
                                onClick={() => setCurrentPage((page) => Math.max(page - 1, 1))}
                                disabled={currentPage === 1}
                                className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-sm disabled:opacity-40"
                            >
                                Previous
                            </button>
                            <span className="text-sm text-neutral-400">
                                Page {currentPage} of {totalPages}
                            </span>
                            <button
                                onClick={() => setCurrentPage((page) => Math.min(page + 1, totalPages))}
                                disabled={currentPage === totalPages}
                                className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-sm disabled:opacity-40"
                            >
                                Next
                            </button>
                        </div>
                    </div>

                    <div className="space-y-6">
                        <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <p className="text-xs uppercase tracking-[0.18em] text-emerald-300">
                                        Product Health
                                    </p>
                                    <h2 className="mt-2 text-2xl font-black">
                                        Catalog Stability
                                    </h2>
                                </div>
                                <span className="text-4xl font-black text-emerald-200">
                                    {productHealth}%
                                </span>
                            </div>
                            <div className="mt-5 h-3 overflow-hidden rounded-full bg-white/10">
                                <div
                                    className="h-full rounded-full bg-gradient-to-r from-emerald-300 via-sky-300 to-amber-300 transition-all duration-700"
                                    style={{ width: `${productHealth}%` }}
                                />
                            </div>
                            <div className="mt-5 grid grid-cols-2 gap-3">
                                <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                    <p className="text-xs text-neutral-500">Cost Value</p>
                                    <p className="mt-2 text-lg font-black text-sky-200">
                                        {money(analytics.totalCostValue)}
                                    </p>
                                </div>
                                <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                    <p className="text-xs text-neutral-500">Potential Profit</p>
                                    <p className="mt-2 text-lg font-black text-emerald-200">
                                        {money(analytics.totalPotentialProfit)}
                                    </p>
                                </div>
                            </div>
                        </div>

                        <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                            <p className="text-xs uppercase tracking-[0.18em] text-amber-300">
                                Product Coverage
                            </p>
                            <h2 className="mt-2 text-2xl font-black">
                                Operating Modules
                            </h2>
                            <div className="mt-4 grid grid-cols-1 gap-2">
                                {erpModules.map((module) => (
                                    <div
                                        key={module}
                                        className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.035] px-4 py-3"
                                    >
                                        <span className="text-sm text-neutral-200">{module}</span>
                                        <span className="h-2 w-2 rounded-full bg-emerald-300" />
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="rounded-lg border border-white/10 bg-black/75 p-5 shadow-2xl backdrop-blur-xl">
                            <p className="text-xs uppercase tracking-[0.18em] text-sky-300">
                                Enabled Features
                            </p>
                            <div className="mt-4 flex flex-wrap gap-2">
                                {features.length === 0 && (
                                    <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-neutral-400">
                                        Core business mode
                                    </span>
                                )}
                                {features.map((feature, index) => (
                                    <span
                                        key={`${feature}-${index}`}
                                        className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-200"
                                    >
                                        {feature.replaceAll("_", " ")}
                                    </span>
                                ))}
                            </div>
                        </div>
                    </div>
                </section>
            </div>

            {showFormModal && (
                <ProductFormModal
                    form={form}
                    errorMessage={formError}
                    saving={saving}
                    editMode={Boolean(editProduct)}
                    hasBarcodeScanning={hasBarcodeScanning}
                    hasBatchTracking={hasBatchTracking}
                    hasShippingLabels={hasShippingLabels}
                    hasSerialNumbers={hasSerialNumbers}
                    hasVariants={hasVariants}
                    hasWarrantyTracking={hasWarrantyTracking}
                    onChange={updateForm}
                    onClose={() => {
                        setShowFormModal(false)
                        setEditProduct(null)
                        setForm(emptyForm)
                        setFormError("")
                    }}
                    onSave={saveProduct}
                />
            )}

            {viewProduct && (
                <ProductDetailsModal
                    product={viewProduct}
                    movements={stockMovements}
                    movementLoading={movementLoading}
                    onClose={() => {
                        setViewProduct(null)
                        setStockMovements([])
                    }}
                />
            )}

            {confirmDeleteId && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
                    <div className="w-full max-w-md rounded-lg border border-white/10 bg-[#050606] p-6 shadow-2xl">
                        <h2 className="text-xl font-black text-red-200">Delete Product</h2>
                        <p className="mt-3 text-sm leading-6 text-neutral-400">
                            This product will be moved to trash and removed from active stock
                            workflows.
                        </p>
                        <div className="mt-6 flex justify-end gap-3">
                            <button
                                onClick={() => setConfirmDeleteId(null)}
                                className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-sm"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmDelete}
                                className="rounded-lg bg-red-500 px-4 py-2 text-sm font-bold text-white hover:bg-red-400"
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

function ProductFormModal({
    form,
    errorMessage,
    saving,
    editMode,
    hasBarcodeScanning,
    hasBatchTracking,
    hasShippingLabels,
    hasSerialNumbers,
    hasVariants,
    hasWarrantyTracking,
    onChange,
    onClose,
    onSave,
}: {
    form: ProductForm
    errorMessage: string
    saving: boolean
    editMode: boolean
    hasBarcodeScanning: boolean
    hasBatchTracking: boolean
    hasShippingLabels: boolean
    hasSerialNumbers: boolean
    hasVariants: boolean
    hasWarrantyTracking: boolean
    onChange: <K extends keyof ProductForm>(field: K, value: ProductForm[K]) => void
    onClose: () => void
    onSave: () => void
}) {
    const inputClass =
        "w-full rounded-lg border border-white/10 bg-black px-4 py-3 text-sm outline-none transition-all focus:border-sky-300"
    const selectClass =
        "w-full appearance-none rounded-lg border border-white/10 bg-black py-3 pl-4 pr-14 text-sm outline-none transition-all focus:border-sky-300"

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-2 backdrop-blur-sm sm:p-4">
            <div className="relative max-h-[calc(100dvh-16px)] w-full max-w-6xl overflow-y-auto overscroll-contain rounded-lg border border-white/10 bg-[#050606] shadow-2xl inventory-sheen sm:max-h-[calc(100vh-32px)]">
                <div className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-white/10 bg-[#050606]/95 p-4 backdrop-blur-xl sm:p-5">
                    <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-sky-300">
                            Product Details
                        </p>
                        <h2 className="mt-2 text-xl font-black sm:text-2xl">
                            {editMode ? "Edit Product" : "Add Product"}
                        </h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg border border-white/10 bg-white/[0.06] px-5 py-3 text-sm font-bold text-neutral-100 transition-all hover:border-sky-300/40 hover:bg-white/[0.1]"
                    >
                        Back
                    </button>
                </div>

                {errorMessage && (
                    <div className="relative z-10 mx-5 mt-5 rounded-lg border border-red-400/40 bg-red-500/10 p-4 text-sm font-semibold text-red-100">
                        {errorMessage}
                    </div>
                )}

                <div className="relative z-10 grid gap-5 p-4 sm:p-5 lg:grid-cols-3">
                    <section className="space-y-3">
                        <h3 className="text-sm font-bold uppercase tracking-[0.16em] text-neutral-400">
                            Identity
                        </h3>
                        <input className={inputClass} placeholder="Product name" value={form.name} onChange={(event) => onChange("name", event.target.value)} />
                        <textarea className={`${inputClass} min-h-28`} placeholder="Description" value={form.description} onChange={(event) => onChange("description", event.target.value)} />
                        <input className={inputClass} placeholder="Manufacturer / Brand" value={form.manufacturer} onChange={(event) => onChange("manufacturer", event.target.value)} />
                        <input className={inputClass} placeholder="Category" value={form.category} onChange={(event) => onChange("category", event.target.value)} />
                        {hasVariants && (
                            <div className="rounded-lg border border-sky-400/20 bg-sky-400/10 p-3 text-xs text-sky-100">
                                Variant-ready: create separate SKUs for each size, color, or package variant.
                            </div>
                        )}
                    </section>

                    <section className="space-y-3">
                        <h3 className="text-sm font-bold uppercase tracking-[0.16em] text-neutral-400">
                            SKU and Supply
                        </h3>
                        <input className={inputClass} placeholder="SKU" value={form.sku} onChange={(event) => onChange("sku", event.target.value)} />
                        {hasBarcodeScanning && (
                            <input className={inputClass} placeholder="Barcode" value={form.barcode} onChange={(event) => onChange("barcode", event.target.value)} />
                        )}
                        <input className={inputClass} placeholder="Supplier" value={form.supplier} onChange={(event) => onChange("supplier", event.target.value)} />
                        <input className={inputClass} placeholder="Warehouse / Store" value={form.warehouse} onChange={(event) => onChange("warehouse", event.target.value)} />
                        <div className="relative">
                            <select className={selectClass} value={form.unit} onChange={(event) => onChange("unit", event.target.value)}>
                                <option value="pcs">Pieces</option>
                                <option value="box">Box</option>
                                <option value="kg">Kilogram</option>
                                <option value="litre">Litre</option>
                                <option value="meter">Meter</option>
                                <option value="service">Service</option>
                            </select>
                            <span className="pointer-events-none absolute right-5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rotate-45 border-b-2 border-r-2 border-white" />
                        </div>
                        {hasSerialNumbers && (
                            <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-3 text-xs text-emerald-100">
                                Serial number workflows are enabled for this business.
                            </div>
                        )}
                        {hasWarrantyTracking && (
                            <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-3 text-xs text-emerald-100">
                                Warranty tracking workflows are enabled for this business.
                            </div>
                        )}
                        {hasShippingLabels && (
                            <div className="rounded-lg border border-sky-400/20 bg-sky-400/10 p-3 text-xs text-sky-100">
                                Shipping-label workflow is available from billing and order modules.
                            </div>
                        )}
                    </section>

                    <section className="space-y-3">
                        <h3 className="text-sm font-bold uppercase tracking-[0.16em] text-neutral-400">
                            Pricing and Inventory
                        </h3>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <input className={inputClass} type="number" placeholder="Stock" value={form.stock} onChange={(event) => onChange("stock", event.target.value)} />
                            <input className={inputClass} type="number" placeholder="Min stock" value={form.minStock} onChange={(event) => onChange("minStock", event.target.value)} />
                            <input className={inputClass} type="number" placeholder="Purchase rate" value={form.purchaseRate} onChange={(event) => onChange("purchaseRate", event.target.value)} />
                            <input className={inputClass} type="number" placeholder="Sale rate" value={form.saleRate} onChange={(event) => onChange("saleRate", event.target.value)} />
                            <input className={inputClass} type="number" placeholder="MRP" value={form.mrp} onChange={(event) => onChange("mrp", event.target.value)} />
                            <input className={inputClass} type="number" placeholder="GST %" value={form.gst} onChange={(event) => onChange("gst", event.target.value)} />
                        </div>
                        <input className={inputClass} type="number" placeholder="Fallback price" value={form.price} onChange={(event) => onChange("price", event.target.value)} />
                        {hasBatchTracking && (
                            <input className={inputClass} placeholder="Batch number" value={form.batchNo} onChange={(event) => onChange("batchNo", event.target.value)} />
                        )}
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <label className="text-xs text-neutral-400">
                                Expiry date
                                <input
                                    className={`${inputClass} mt-1`}
                                    type="date"
                                    value={form.expiry}
                                    onChange={(event) => onChange("expiry", event.target.value)}
                                />
                            </label>
                            <label className="text-xs text-neutral-400">
                                Purchase date
                                <input
                                    className={`${inputClass} mt-1`}
                                    type="date"
                                    value={form.purchaseDate}
                                    onChange={(event) => onChange("purchaseDate", event.target.value)}
                                />
                            </label>
                        </div>
                    </section>
                </div>

                <div className="relative z-10 mx-4 rounded-lg border border-emerald-400/20 bg-emerald-400/10 p-4 sm:mx-5">
                    <p className="text-sm font-semibold text-emerald-100">
                        Product safety
                    </p>
                    <p className="mt-1 text-xs leading-6 text-neutral-300">
                        Saving updates the product record, billing-ready price data, stock
                        threshold, GST fields, and stock movement audit history when quantity
                        changes.
                    </p>
                </div>

                <div className="sticky bottom-0 z-30 mt-5 border-t border-white/10 bg-[#050606]/95 p-4 backdrop-blur-xl sm:p-5">
                    <button
                        disabled={saving}
                        onClick={onSave}
                        className="w-full rounded-lg bg-gradient-to-r from-sky-300 to-emerald-300 px-5 py-4 font-black text-black transition-all hover:shadow-lg hover:shadow-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {saving ? "Saving..." : editMode ? "Save Product Changes" : "Create Product"}
                    </button>
                </div>
            </div>
        </div>
    )
}

function ProductDetailsModal({
    product,
    movements,
    movementLoading,
    onClose,
}: {
    product: ProductRow
    movements: StockMovement[]
    movementLoading: boolean
    onClose: () => void
}) {
    const sale = Number(product.sale_rate || product.price || 0)
    const purchase = Number(product.purchase_rate || 0)
    const stock = Number(product.stock || 0)
    const lowStock = stock <= Number(product.min_stock ?? 5)
    const expired = isExpired(product)

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
            <div className="max-h-[calc(100vh-32px)] w-full max-w-6xl overflow-y-auto overscroll-contain rounded-lg border border-white/10 bg-[#050606] shadow-2xl">
                <div className="sticky top-0 z-30 flex items-start justify-between gap-4 border-b border-white/10 bg-[#050606]/95 p-5 backdrop-blur-xl">
                    <div>
                        <p className="text-xs uppercase tracking-[0.18em] text-sky-300">
                            Product Detail
                        </p>
                        <h2 className="mt-2 text-3xl font-black">{product.name}</h2>
                        <p className="mt-1 text-sm text-neutral-500">
                            SKU {product.sku || "N/A"} | {product.category || "General"}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-lg border border-white/10 bg-white/[0.06] px-5 py-3 text-sm font-bold text-neutral-100 transition-all hover:border-sky-300/40 hover:bg-white/[0.1]"
                    >
                        Back
                    </button>
                </div>

                <div className="grid gap-4 p-5 md:grid-cols-4">
                    {[
                        ["Stock Value", money(sale * stock), "text-emerald-200"],
                        ["Potential Profit", money((sale - purchase) * stock), "text-sky-200"],
                        ["Stock Health", lowStock ? "Low Stock" : "Healthy", lowStock ? "text-red-200" : "text-emerald-200"],
                        ["Expiry Status", expired ? "Expired" : "Active", expired ? "text-red-200" : "text-neutral-100"],
                    ].map(([label, value, color]) => (
                        <div key={label} className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                            <p className="text-xs uppercase tracking-[0.14em] text-neutral-500">
                                {label}
                            </p>
                            <p className={`mt-2 text-xl font-black ${color}`}>{value}</p>
                        </div>
                    ))}
                </div>

                <div className="grid gap-4 px-5 pb-5 md:grid-cols-3">
                    {[
                        ["Manufacturer", product.manufacturer || "-"],
                        ["Supplier", product.supplier || "-"],
                        ["Warehouse", product.warehouse || "Main Warehouse"],
                        ["Barcode", product.barcode || "-"],
                        ["Batch", product.batch_no || "-"],
                        ["Unit", product.unit || "pcs"],
                        ["Purchase Rate", money(purchase)],
                        ["Sale Rate", money(sale)],
                        ["GST", `${product.gst ?? 0}%`],
                        ["MRP", product.mrp == null ? "-" : money(product.mrp)],
                        ["Purchase Date", formatDate(product.purchase_date)],
                        ["Expiry Date", formatDate(product.expiry_date)],
                    ].map(([label, value]) => (
                        <div key={label} className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                            <p className="text-xs text-neutral-500">{label}</p>
                            <p className="mt-2 font-semibold text-neutral-100">{value}</p>
                        </div>
                    ))}
                </div>

                <div className="mx-5 mb-5 rounded-lg border border-white/10 bg-black/60">
                    <div className="border-b border-white/10 px-4 py-4">
                        <h3 className="text-xl font-black">Stock Movement Audit</h3>
                        <p className="mt-1 text-sm text-neutral-500">
                            Quantity changes written from product master and inventory operations.
                        </p>
                    </div>
                    {movementLoading ? (
                        <div className="flex justify-center py-12">
                            <div className="h-8 w-8 rounded-full border-2 border-neutral-700 border-t-white animate-spin" />
                        </div>
                    ) : movements.length === 0 ? (
                        <p className="p-8 text-center text-neutral-500">
                            No movement history found for this product.
                        </p>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[760px] text-sm">
                                <thead className="bg-white/[0.04] text-left text-xs uppercase tracking-[0.14em] text-neutral-500">
                                    <tr>
                                        <th className="px-4 py-3">Type</th>
                                        <th className="px-4 py-3">Quantity</th>
                                        <th className="px-4 py-3">Previous</th>
                                        <th className="px-4 py-3">New</th>
                                        <th className="px-4 py-3">Reason</th>
                                        <th className="px-4 py-3">Date</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5">
                                    {movements.map((movement) => {
                                        const qty = Number(movement.quantity || 0)

                                        return (
                                            <tr key={movement.id} className="hover:bg-white/[0.03]">
                                                <td className="px-4 py-4 capitalize">
                                                    {movement.type?.replaceAll("_", " ") || "Movement"}
                                                </td>
                                                <td className={qty >= 0 ? "px-4 py-4 font-semibold text-emerald-200" : "px-4 py-4 font-semibold text-red-200"}>
                                                    {qty > 0 ? `+${qty}` : qty}
                                                </td>
                                                <td className="px-4 py-4 text-neutral-300">{movement.previous_stock ?? "-"}</td>
                                                <td className="px-4 py-4 text-neutral-100">{movement.new_stock ?? "-"}</td>
                                                <td className="max-w-[260px] truncate px-4 py-4 text-neutral-400">
                                                    {movement.reason || movement.reference_no || "-"}
                                                </td>
                                                <td className="whitespace-nowrap px-4 py-4 text-neutral-500">
                                                    {movement.created_at ? new Date(movement.created_at).toLocaleString() : "-"}
                                                </td>
                                            </tr>
                                        )
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
