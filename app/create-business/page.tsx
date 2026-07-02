"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { businessTypeFeatures, categoryFeatures } from "@/lib/business-features"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { supabase } from "@/lib/supabase"

const featureLabels: Record<string, string> = {
    pos_billing: "Counter billing",
    quick_checkout: "Fast checkout",
    gst_b2b: "GST bills",
    batch_tracking: "Batch tracking",
    expiry_tracking: "Expiry alerts",
    barcode_scanning: "Barcode scanning",
    thermal_printing: "Thermal receipts",
    purchase_orders: "Purchase orders",
    warehouse_transfers: "Stock transfers",
    bulk_inventory: "Bulk stock",
    shipping_labels: "Shipping labels",
    awb_tracking: "Courier tracking",
    parcel_qr: "Parcel QR",
    bulk_pricing: "Wholesale pricing",
    size_variants: "Size variants",
    color_variants: "Color variants",
    serial_numbers: "Serial numbers",
    warranty_tracking: "Warranty tracking",
    prescription_required: "Prescription control",
    prescription_upload: "Prescription upload",
    kot_printing: "Kitchen tickets",
    table_management: "Table billing",
    raw_materials: "Raw material stock",
    recipe_tracking: "Recipe stock",
    production_batches: "Production batches",
    quotation_system: "Quotations",
    service_invoices: "Service bills",
    weight_inventory: "Weight-based stock",
    weight_tracking: "Weight tracking",
    purity_tracking: "Purity tracking",
}

function friendlyFeatureLabel(feature: string) {
    return featureLabels[feature] || feature.replaceAll("_", " ")
}

export default function CreateBusiness() {

    const router = useRouter()

    const [name, setName] = useState("")
    const [industry, setIndustry] = useState("")
    const [currency, setCurrency] = useState("INR")
    const [gstNumber, setGstNumber] = useState("")
    const [phone, setPhone] = useState("")
    const [email, setEmail] = useState("")
    const [fssai, setFssai] = useState("")
    const [website, setWebsite] = useState("")
    const [address, setAddress] = useState("")
    const [branchName, setBranchName] = useState("Main Branch")
    const [businessType, setBusinessType] =
        useState("retail")

    const [businessCategory, setBusinessCategory] =
        useState("general")
    const [loading, setLoading] = useState(false)
    const [errorMessage, setErrorMessage] = useState("")
    const [successMessage, setSuccessMessage] = useState("")

    useEffect(() => {

        async function checkProfile() {
            const {
                data: { session },
            } = await supabase.auth.getSession()

            const bootstrapPath = "/api/workspace/bootstrap"
            const desktopRuntime = await isTauriRuntimeAsync()
            const response = await fetch(desktopRuntime ? `/api/desktop-proxy?path=${encodeURIComponent(bootstrapPath)}` : bootstrapPath, {
                headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
                cache: "no-store",
            })

            if (response.status === 401) {
                router.push("/login")
                return
            }

            const payload = (await response.json()) as {
                success?: boolean
                profile?: { role?: string | null; approved?: boolean; business_created?: boolean }
                organization?: { id?: string | null } | null
                permissions?: { admin?: boolean }
            }

            if (payload.permissions?.admin || payload.profile?.role === "admin") {
                router.push("/admin")
                return
            }

            if (!payload.success || !payload.profile?.approved) {
                router.push("/pending-approval")
                return
            }

            if (payload.profile.business_created || payload.organization?.id) {
                router.push("/dashboard")
                return
            }

        }

        checkProfile()

    }, [router])

    async function createBusiness() {

        setLoading(true)
        setErrorMessage("")
        setSuccessMessage("")

        if (!name.trim()) {
            setErrorMessage("Business name is required")
            setLoading(false)
            return
        }

        const { data: userData } = await supabase.auth.getUser()

        const user = userData.user

        if (!user) {
            setErrorMessage("You must be logged in to create a business")
            setLoading(false)
            router.push("/login")
            return
        }

        const {
            data: { session },
        } = await supabase.auth.getSession()

        const response = await fetch("/api/workspace/create-business", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
            },
            body: JSON.stringify({
                name: name.trim(),
                industry: industry.trim(),
                currency,
                gst_number: gstNumber.trim(),
                phone: phone.trim(),
                email: email.trim(),
                fssai: fssai.trim(),
                website: website.trim(),
                address: address.trim(),
                branch_name: branchName.trim() || "Main Branch",
                business_type: businessType,
                business_category: businessCategory,
            }),
        })
        const result = (await response.json()) as { success?: boolean; error?: string }

        if (!response.ok || !result.success) {
            setErrorMessage(result.error || "Failed to create business")
            setLoading(false)
            return
        }

        setSuccessMessage("Business created successfully")
        setLoading(false)

        setTimeout(() => {
            window.location.href = "/dashboard"
        }, 1500)

    }

    return (

        <div className="inventory-grid-bg min-h-dvh overflow-y-auto px-3 py-5 text-white sm:px-5 sm:py-8">

            <div className="mx-auto w-full max-w-2xl rounded-[22px] border border-white/10 bg-neutral-950/85 p-5 shadow-[0_28px_120px_rgba(0,0,0,0.45)] backdrop-blur-xl sm:rounded-[28px] sm:p-10">

                <h1 className="mb-2 text-2xl font-bold sm:text-3xl">
                    Create Your Business
                </h1>

                <p className="mb-5 text-sm leading-6 text-gray-400 sm:mb-6">
                    Set up your business account. After this, Bezgrow will guide you to add products, add customers, and create your first invoice.
                </p>

                <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-4">
                    {["Business", "Products", "Customers", "First bill"].map((step, index) => (
                        <div key={step} className={`rounded-xl border p-3 ${index === 0 ? "border-cyan-400/30 bg-cyan-400/10" : "border-white/10 bg-black/25"}`}>
                            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-500">Step {index + 1}</p>
                            <p className="mt-2 text-sm font-black text-white">{step}</p>
                        </div>
                    ))}
                </div>

                {errorMessage && (
                    <div className="bg-red-900 border border-red-600 text-red-300 p-3 rounded mb-4 text-sm">
                        {errorMessage}
                    </div>
                )}

                {successMessage && (
                    <div className="bg-green-900 border border-green-600 text-green-300 p-3 rounded mb-4 text-sm">
                        {successMessage}
                    </div>
                )}

                <div className="mb-4">

                    <label className="block text-sm text-gray-400 mb-2">
                        Business Name
                    </label>

                    <input
                        placeholder="Enter your business name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="min-h-12 w-full rounded border border-gray-700 bg-gray-800 p-3"
                    />

                </div>

                <div className="mb-4">

                    <label className="block text-sm text-gray-400 mb-2">
                        Industry
                    </label>

                    <input
                        placeholder="Retail, Wholesale, Medical, Electronics, etc."
                        value={industry}
                        onChange={(e) => setIndustry(e.target.value)}
                        className="min-h-12 w-full rounded border border-gray-700 bg-gray-800 p-3"
                    />

                </div>

                <div className="mb-6">

                    <label className="block text-sm text-gray-400 mb-2">
                        Default Currency
                    </label>

                    <select
                        value={currency}
                        onChange={(e) => setCurrency(e.target.value)}
                        className="min-h-12 w-full rounded border border-gray-700 bg-gray-800 p-3"
                    >
                        <option value="INR">Indian Rupee (INR)</option>
                        <option value="USD">US Dollar (USD)</option>
                        <option value="EUR">Euro (EUR)</option>
                        <option value="GBP">British Pound (GBP)</option>
                    </select>

                </div>

                <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <input
                        placeholder="GST number"
                        value={gstNumber}
                        onChange={(e) => setGstNumber(e.target.value)}
                        className="min-h-12 rounded border border-gray-700 bg-gray-800 p-3"
                    />
                    <input
                        placeholder="Business phone"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        className="min-h-12 rounded border border-gray-700 bg-gray-800 p-3"
                    />
                    <input
                        placeholder="Business email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="min-h-12 rounded border border-gray-700 bg-gray-800 p-3"
                    />
                    <input
                        placeholder="FSSAI number"
                        value={fssai}
                        onChange={(e) => setFssai(e.target.value)}
                        className="min-h-12 rounded border border-gray-700 bg-gray-800 p-3"
                    />
                    <input
                        placeholder="Website"
                        value={website}
                        onChange={(e) => setWebsite(e.target.value)}
                        className="min-h-12 rounded border border-gray-700 bg-gray-800 p-3"
                    />
                    <input
                        placeholder="Branch name"
                        value={branchName}
                        onChange={(e) => setBranchName(e.target.value)}
                        className="min-h-12 rounded border border-gray-700 bg-gray-800 p-3"
                    />
                    <textarea
                        placeholder="Business address"
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        className="min-h-24 rounded border border-gray-700 bg-gray-800 p-3 sm:col-span-2"
                    />
                </div>

                <div className="mb-4">

                    <label className="block text-sm text-gray-400 mb-2">
                        Business Type
                    </label>

                    <select
                        value={businessType}
                        onChange={(e) =>
                            setBusinessType(e.target.value)
                        }
                        className="min-h-12 w-full rounded border border-gray-700 bg-gray-800 p-3"
                    >

                        <option value="retail">
                            Retail Store
                        </option>

                        <option value="wholesale">
                            Wholesale
                        </option>

                        <option value="online_store">
                            Online Store
                        </option>

                        <option value="distributor">
                            Distributor
                        </option>

                        <option value="restaurant">
                            Restaurant
                        </option>

                        <option value="pharmacy">
                            Pharmacy
                        </option>

                        <option value="manufacturer">
                            Manufacturer
                        </option>

                        <option value="service_business">
                            Service Business
                        </option>

                    </select>

                </div>

                <div className="mb-6">

                    <label className="block text-sm text-gray-400 mb-2">
                        Business Category
                    </label>

                    <select
                        value={businessCategory}
                        onChange={(e) =>
                            setBusinessCategory(e.target.value)
                        }
                        className="min-h-12 w-full rounded border border-gray-700 bg-gray-800 p-3"
                    >

                        <option value="general">
                            General
                        </option>

                        <option value="medicine">
                            Medicine
                        </option>

                        <option value="cosmetics">
                            Cosmetics
                        </option>

                        <option value="garments">
                            Garments
                        </option>

                        <option value="grocery">
                            Grocery
                        </option>

                        <option value="electronics">
                            Electronics
                        </option>

                        <option value="confectionary">
                            Confectionary
                        </option>

                        <option value="jewellery">
                            Jewellery
                        </option>

                        <option value="furniture">
                            Furniture
                        </option>

                        <option value="automobile">
                            Automobile
                        </option>

                    </select>

                </div>

                <div className="mb-6 rounded-xl border border-gray-700 bg-gray-800 p-3 sm:p-4">

                    <h3 className="text-sm font-semibold text-white mb-3">
                        What Bezgrow Will Set Up
                    </h3>

                    <div className="flex flex-wrap gap-2">

                        {[
                            ...new Set([
                                ...(businessTypeFeatures[
                                    businessType
                                ] || []),
                                ...(categoryFeatures[
                                    businessCategory
                                ] || []),
                            ]),
                        ].map((feature) => (
                            <div
                                key={feature}
                                className="rounded-full border border-gray-600 bg-black px-3 py-1 text-xs text-green-400"
                            >
                                {friendlyFeatureLabel(feature)}
                            </div>
                        ))}

                    </div>

                </div>

                <button
                    onClick={createBusiness}
                    disabled={loading}
                    className="min-h-12 w-full rounded-lg bg-white p-3 font-semibold text-black transition hover:bg-gray-200 disabled:opacity-50"
                >
                    {loading ? "Creating Business..." : "Create Business & Continue"}
                </button>

            </div>

        </div>

    )
}
