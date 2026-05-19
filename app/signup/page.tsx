"use client"

import { useState } from "react"
import { supabase } from "@/lib/supabase"
import { useRouter } from "next/navigation"

export default function SignupPage() {

    const router = useRouter()

    const [fullName, setFullName] = useState("")
    const [businessName, setBusinessName] = useState("")
    const [phone, setPhone] = useState("")
    const [email, setEmail] = useState("")
    const [password, setPassword] = useState("")
    const [loading, setLoading] = useState(false)
    const [statusMessage, setStatusMessage] = useState("")
    const [errorMessage, setErrorMessage] = useState("")

    async function signup() {

        try {

            setLoading(true)
            setStatusMessage("")
            setErrorMessage("")

            if (!fullName || !businessName || !phone || !email || !password) {
                setErrorMessage("Please fill all fields")
                setLoading(false)
                return
            }

            const { data: authData, error: authError } = await supabase.auth.signUp({
                email,
                password,
            })

            if (authError) {
                setErrorMessage(authError.message)
                setLoading(false)
                return
            }

            const userId = authData.user?.id

            if (!userId) {
                setErrorMessage("User account was not created")
                setLoading(false)
                return
            }

            const { error: pendingError } = await supabase
                .from("pending_users")
                .upsert([
                    {
                        id: userId,
                        full_name: fullName,
                        business_name: businessName,
                        phone,
                        email,
                        status: "pending"
                    }
                ])

            if (pendingError) {
                setErrorMessage(pendingError.message)
                setLoading(false)
                return
            }

            setStatusMessage("Application submitted successfully. Choose payment activation or wait for admin approval.")

            setTimeout(() => {
                router.push("/payment")
            }, 1500)

        } catch (err) {

            console.error(err)
            setErrorMessage("Something went wrong")

        } finally {

            setLoading(false)

        }

    }

    return (
        <div className="inventory-grid-bg flex min-h-screen items-center justify-center px-5 py-8 text-white">

            <div className="w-full max-w-md rounded-[28px] border border-white/10 bg-neutral-950/85 p-6 shadow-[0_28px_120px_rgba(0,0,0,0.45)] backdrop-blur-xl sm:p-8">

                <h1 className="text-3xl font-bold mb-2">Apply for Access</h1>

                <p className="text-gray-400 text-sm mb-6">
                    Create your business account and submit your application for approval.
                </p>

                {statusMessage && (
                    <div className="bg-green-900 border border-green-600 text-green-300 p-3 rounded mb-4 text-sm">
                        {statusMessage}
                    </div>
                )}

                {errorMessage && (
                    <div className="bg-red-950/70 border border-red-500/60 text-red-200 p-3 rounded mb-4 text-sm">
                        {errorMessage}
                    </div>
                )}

                <input
                    type="text"
                    placeholder="Full Name"
                    value={fullName}
                    className="w-full p-3 mb-4 bg-black border border-gray-700 rounded-lg outline-none"
                    onChange={(e) => setFullName(e.target.value)}
                />

                <input
                    type="text"
                    placeholder="Business Name"
                    value={businessName}
                    className="w-full p-3 mb-4 bg-black border border-gray-700 rounded-lg outline-none"
                    onChange={(e) => setBusinessName(e.target.value)}
                />

                <input
                    type="tel"
                    placeholder="Phone Number"
                    value={phone}
                    className="w-full p-3 mb-4 bg-black border border-gray-700 rounded-lg outline-none"
                    onChange={(e) => setPhone(e.target.value)}
                />

                <input
                    type="email"
                    placeholder="Business Email"
                    value={email}
                    className="w-full p-3 mb-4 bg-black border border-gray-700 rounded-lg outline-none"
                    onChange={(e) => setEmail(e.target.value)}
                />

                <input
                    type="password"
                    placeholder="Create Password"
                    value={password}
                    className="w-full p-3 mb-6 bg-black border border-gray-700 rounded-lg outline-none"
                    onChange={(e) => setPassword(e.target.value)}
                />

                <button
                    onClick={signup}
                    disabled={loading}
                    className="w-full bg-white text-black py-3 rounded-lg font-semibold disabled:opacity-50"
                >
                    {loading ? "Submitting Application..." : "Request Access / Pay to Activate"}
                </button>

                <p className="mt-4 text-center text-sm text-gray-500">
                    Monthly plan Rs 250. Yearly plan Rs 2000. Admin approval is still available after signup.
                </p>

            </div>

        </div>
    )
}
