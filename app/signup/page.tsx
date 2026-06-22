"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { BezgrowLogoMark } from "@/components/brand/BezgrowLogoMark"

export default function SignupPage() {

    const router = useRouter()

    const [fullName, setFullName] = useState("")
    const [businessName, setBusinessName] = useState("")
    const [phone, setPhone] = useState("")
    const [email, setEmail] = useState("")
    const [password, setPassword] = useState("")
    const [termsAccepted, setTermsAccepted] = useState(false)
    const [loading, setLoading] = useState(false)
    const [statusMessage, setStatusMessage] = useState("")
    const [errorMessage, setErrorMessage] = useState("")

    async function signup() {

        try {

            setLoading(true)
            setStatusMessage("")
            setErrorMessage("")

            const cleanFullName = fullName.trim()
            const cleanBusinessName = businessName.trim()
            const cleanPhone = phone.trim()
            const cleanEmail = email.trim()

            if (!cleanFullName || !cleanBusinessName || !cleanPhone || !cleanEmail || !password) {
                setErrorMessage("Please fill all fields")
                setLoading(false)
                return
            }

            if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
                setErrorMessage("Password must be at least 8 characters and include a letter and number.")
                setLoading(false)
                return
            }

            if (!termsAccepted) {
                setErrorMessage("Please accept the terms and privacy policy.")
                setLoading(false)
                return
            }

            const response = await fetch("/api/auth/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    fullName: cleanFullName,
                    businessName: cleanBusinessName,
                    phone: cleanPhone,
                    email: cleanEmail,
                    password,
                    termsAccepted,
                }),
            })

            const result = await response.json()

            if (!response.ok) {
                setErrorMessage(result.error || result.message || "Application could not be submitted.")
                setLoading(false)
                return
            }

            setStatusMessage("Application submitted successfully. Please wait for admin approval.")

            setTimeout(() => {
                window.sessionStorage.setItem("bezgrow_pending_signup", "1")
                router.push("/pending-approval")
            }, 1500)

        } catch {

            setErrorMessage("Something went wrong")

        } finally {

            setLoading(false)

        }

    }

    return (
        <div className="inventory-grid-bg flex min-h-dvh items-center justify-center px-3 py-5 text-white sm:px-5 sm:py-8">

            <div className="w-full max-w-md rounded-[22px] border border-white/10 bg-neutral-950/85 p-5 shadow-[0_28px_120px_rgba(0,0,0,0.45)] backdrop-blur-xl sm:rounded-[28px] sm:p-8">

                <div className="mb-5 flex items-center gap-3">
                    <BezgrowLogoMark className="h-10 w-10" size={40} priority />
                    <span className="text-base font-black">Bezgrow</span>
                </div>

                <h1 className="mb-2 text-2xl font-bold sm:text-3xl">Apply for Access</h1>

                <p className="mb-5 text-sm leading-6 text-gray-400 sm:mb-6">
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
                    className="mb-4 min-h-12 w-full rounded-lg border border-gray-700 bg-black p-3 outline-none focus:border-cyan-300"
                    onChange={(e) => setFullName(e.target.value)}
                />

                <input
                    type="text"
                    placeholder="Business Name"
                    value={businessName}
                    className="mb-4 min-h-12 w-full rounded-lg border border-gray-700 bg-black p-3 outline-none focus:border-cyan-300"
                    onChange={(e) => setBusinessName(e.target.value)}
                />

                <input
                    type="tel"
                    placeholder="Phone Number"
                    value={phone}
                    className="mb-4 min-h-12 w-full rounded-lg border border-gray-700 bg-black p-3 outline-none focus:border-cyan-300"
                    onChange={(e) => setPhone(e.target.value)}
                />

                <input
                    type="email"
                    placeholder="Business Email"
                    value={email}
                    className="mb-4 min-h-12 w-full rounded-lg border border-gray-700 bg-black p-3 outline-none focus:border-cyan-300"
                    onChange={(e) => setEmail(e.target.value)}
                />

                <input
                    type="password"
                    placeholder="Create Password"
                    value={password}
                    className="mb-2 min-h-12 w-full rounded-lg border border-gray-700 bg-black p-3 outline-none focus:border-cyan-300"
                    onChange={(e) => setPassword(e.target.value)}
                />
                <p className="mb-6 text-xs leading-5 text-gray-500">
                    Use at least 8 characters with one letter and one number.
                </p>

                <label className="mb-6 flex items-start gap-3 text-sm leading-5 text-gray-400">
                    <input
                        type="checkbox"
                        checked={termsAccepted}
                        onChange={(e) => setTermsAccepted(e.target.checked)}
                        className="mt-1"
                    />
                    <span>I agree to the terms, privacy policy, and approval-based access process.</span>
                </label>

                <button
                    onClick={signup}
                    disabled={loading}
                    className="min-h-12 w-full rounded-lg bg-white py-3 font-semibold text-black disabled:opacity-50"
                >
                    {loading ? "Submitting Application..." : "Request Admin Approval"}
                </button>

                <p className="mt-4 text-center text-sm text-gray-500">
                    Your account will open after an admin approves your request.
                </p>

            </div>

        </div>
    )
}
