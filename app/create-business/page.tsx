"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase"
import {
    businessTypeFeatures,
    categoryFeatures,
} from "@/lib/business-features"

export default function CreateBusiness() {

    const router = useRouter()

    const [name, setName] = useState("")
    const [industry, setIndustry] = useState("")
    const [currency, setCurrency] = useState("INR")
    const [businessType, setBusinessType] =
        useState("retail")

    const [businessCategory, setBusinessCategory] =
        useState("general")
    const [loading, setLoading] = useState(false)
    const [errorMessage, setErrorMessage] = useState("")
    const [successMessage, setSuccessMessage] = useState("")

    useEffect(() => {

        async function checkProfile() {

            const { data: userData } = await supabase.auth.getUser()

            const user = userData.user

            if (!user) {
                router.push("/login")
                return
            }

            const { data: profile, error: profileError } = await supabase
                .from("profiles")
                .select("*")
                .eq("id", user.id)
                .single()

            if (profile?.role === "admin") {
                router.push("/admin")
                return
            }

            if (profileError || !profile?.approved) {
                router.push("/pending-approval")
                return
            }

            if (profile?.business_created) {
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

        // create organization
        const { data: org, error: orgError } = await supabase
            .from("organizations")
            .insert({
                name: name.trim(),
                industry: industry.trim(),
                currency: currency,
                business_type: businessType,
                business_category: businessCategory,
                owner_id: user.id
            })
            .select()
            .single()

        if (orgError || !org) {
            console.error("Organization creation failed:", orgError)
            setErrorMessage("Failed to create business")
            setLoading(false)
            return
        }

        const typeFeatures =
            businessTypeFeatures[businessType] || []

        const industryFeatures =
            categoryFeatures[businessCategory] || []

        const allFeatures = [
            ...new Set([
                ...typeFeatures,
                ...industryFeatures,
            ]),
        ]

        if (allFeatures.length > 0) {

            const featureRows = allFeatures.map(
                (feature) => ({
                    organization_id: org.id,
                    feature_key: feature,
                    is_enabled: true,
                })
            )

            const { error: featureError } =
                await supabase
                    .from("organization_features")
                    .insert(featureRows)

            if (featureError) {
                console.error(
                    "Feature initialization failed:",
                    featureError
                )
            }
        }

        // add user as organization owner
        const { error: memberError } = await supabase
            .from("organization_members")
            .insert({
                user_id: user.id,
                organization_id: org.id,
                role: "owner"
            })

        if (memberError) {
            console.error("Failed to add organization member:", memberError)
            setErrorMessage("Failed to configure organization")
            setLoading(false)
            return
        }

        // update or repair user profile after a successful payment/admin approval path
        const { error: profileError } = await supabase
            .from("profiles")
            .upsert({
                id: user.id,
                email: user.email || "",
                approved: true,
                business_created: true,
                role: "user"
            })

        if (profileError) {
            console.error("Profile update failed:", profileError)
            setErrorMessage("Failed to complete setup")
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

        <div className="inventory-grid-bg min-h-screen overflow-y-auto px-5 py-8 text-white">

            <div className="mx-auto w-full max-w-2xl rounded-[28px] border border-white/10 bg-neutral-950/85 p-6 shadow-[0_28px_120px_rgba(0,0,0,0.45)] backdrop-blur-xl sm:p-10">

                <h1 className="text-3xl font-bold mb-2">
                    Create Your Business
                </h1>

                <p className="text-gray-400 text-sm mb-6">
                    Set up your intelligent ERP workspace with dynamic inventory, billing, warehouse, and industry-specific workflows.
                </p>

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
                        className="w-full p-3 rounded bg-gray-800 border border-gray-700"
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
                        className="w-full p-3 rounded bg-gray-800 border border-gray-700"
                    />

                </div>

                <div className="mb-6">

                    <label className="block text-sm text-gray-400 mb-2">
                        Default Currency
                    </label>

                    <select
                        value={currency}
                        onChange={(e) => setCurrency(e.target.value)}
                        className="w-full p-3 rounded bg-gray-800 border border-gray-700"
                    >
                        <option value="INR">Indian Rupee (INR)</option>
                        <option value="USD">US Dollar (USD)</option>
                        <option value="EUR">Euro (EUR)</option>
                        <option value="GBP">British Pound (GBP)</option>
                    </select>

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
                        className="w-full p-3 rounded bg-gray-800 border border-gray-700"
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
                        className="w-full p-3 rounded bg-gray-800 border border-gray-700"
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

                <div className="mb-6 rounded-xl border border-gray-700 bg-gray-800 p-4">

                    <h3 className="text-sm font-semibold text-white mb-3">
                        ERP Features Preview
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
                                className="px-3 py-1 rounded-full bg-black border border-gray-600 text-xs text-green-400"
                            >
                                {feature.replaceAll("_", " ")}
                            </div>
                        ))}

                    </div>

                </div>

                <button
                    onClick={createBusiness}
                    disabled={loading}
                    className="w-full bg-white text-black p-3 rounded-lg font-semibold hover:bg-gray-200 transition disabled:opacity-50"
                >
                    {loading ? "Creating Business..." : "Create Business"}
                </button>

            </div>

        </div>

    )
}
