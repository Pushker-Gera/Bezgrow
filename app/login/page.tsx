"use client"

import { useState, useEffect } from "react"
import { supabase } from "@/lib/supabase"
import { useRouter } from "next/navigation"

export default function LoginPage() {

    const router = useRouter()

    const [email, setEmail] = useState("")
    const [password, setPassword] = useState("")
    const [rememberMe, setRememberMe] = useState(false)

    const [loading, setLoading] = useState(false)
    const [errorMessage, setErrorMessage] = useState("")
    const [successMessage, setSuccessMessage] = useState("")
    const [resetLoading, setResetLoading] = useState(false)

    useEffect(() => {

        async function checkUser() {

            const {
                data: { session }
            } = await supabase.auth.getSession()

            if (session?.user) {

                const { data: profile } = await supabase
                    .from("profiles")
                    .select("*")
                    .eq("id", session.user.id)
                    .single()

                if (profile?.role === "admin") {
                    router.push("/admin")
                }
                else if (!profile?.approved) {
                    router.push("/pending-approval")
                }
                else if (!profile?.business_created) {
                    router.push("/create-business")
                }
                else {
                    router.push("/dashboard")
                }
            }

        }

        checkUser()

    }, [router])

    async function login() {

        try {

            setLoading(true)
            setErrorMessage("")
            setSuccessMessage("")

            if (!email.trim() || !password.trim()) {
                setErrorMessage("Please enter email and password")
                setLoading(false)
                return
            }

            const {
                data,
                error
            } = await supabase.auth.signInWithPassword({
                email,
                password
            })

            if (error) {

                if (error.message.includes("Invalid login credentials")) {
                    setErrorMessage("Incorrect email or password")
                }
                else if (error.message.includes("Email not confirmed")) {
                    setErrorMessage("Please verify your email before logging in")
                }
                else {
                    setErrorMessage(error.message)
                }

                setLoading(false)
                return
            }

            setSuccessMessage("Login successful")

            const { data: profile } = await supabase
                .from("profiles")
                .select("*")
                .eq("id", data.user.id)
                .single()

            if (profile?.role === "admin") {
                router.push("/admin")
            }
            else if (!profile?.approved) {
                router.push("/pending-approval")
            }
            else if (!profile?.business_created) {
                router.push("/create-business")
            }
            else {
                router.push("/dashboard")
            }

        } catch (err) {

            console.error(err)

            setErrorMessage("Something went wrong")

        } finally {

            setLoading(false)

        }

    }

    async function loginWithGoogle() {

        try {

            const { error } = await supabase.auth.signInWithOAuth({
                provider: "google",
                options: {
                    redirectTo: `${window.location.origin}/login`
                }
            })

            if (error) {
                setErrorMessage(error.message)
            }

        } catch (err) {

            console.error(err)

            setErrorMessage("Google login failed")

        }

    }

    async function forgotPassword() {

        try {

            setErrorMessage("")
            setSuccessMessage("")

            if (!email.trim()) {
                setErrorMessage("Please enter your email first")
                return
            }

            setResetLoading(true)

            const { error } = await supabase.auth.resetPasswordForEmail(email, {
                redirectTo: `${window.location.origin}/reset-password`
            })

            if (error) {
                setErrorMessage(error.message)
                setResetLoading(false)
                return
            }

            setSuccessMessage("Password reset link sent to your email")

        } catch (err) {

            console.error(err)
            setErrorMessage("Failed to send reset email")

        } finally {

            setResetLoading(false)
        }
    }

    return (
        <div className="inventory-grid-bg flex min-h-screen items-center justify-center px-5 py-8 text-white">

            <div className="w-full max-w-md rounded-[28px] border border-white/10 bg-neutral-950/85 p-6 shadow-[0_28px_120px_rgba(0,0,0,0.45)] backdrop-blur-xl sm:p-8">

                <h1 className="text-3xl font-bold mb-2">
                    Welcome Back
                </h1>

                <p className="text-gray-400 text-sm mb-6">
                    Login to manage your inventory, billing, customers, and business operations.
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

                <input
                    type="email"
                    placeholder="Enter your business email"
                    value={email}
                    className="w-full p-3 mb-4 bg-black border border-gray-700 rounded-lg outline-none focus:border-cyan-300"
                    onChange={(e) => setEmail(e.target.value)}
                />

                <input
                    type="password"
                    placeholder="Password"
                    value={password}
                    className="w-full p-3 mb-4 bg-black border border-gray-700 rounded-lg outline-none focus:border-cyan-300"
                    onChange={(e) => setPassword(e.target.value)}
                />

                <div className="flex items-center justify-between mb-6 text-sm">

                    <label className="flex items-center gap-2 text-gray-400 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={rememberMe}
                            onChange={(e) => setRememberMe(e.target.checked)}
                        />
                        Remember me
                    </label>

                    <button
                        type="button"
                        onClick={forgotPassword}
                        disabled={resetLoading}
                        className="text-blue-400 hover:text-blue-300 disabled:opacity-50"
                    >
                        {resetLoading ? "Sending..." : "Forgot password?"}
                    </button>

                </div>

                <button
                    onClick={login}
                    disabled={loading}
                    className="w-full bg-white text-black py-3 rounded-lg font-semibold disabled:opacity-50"
                >
                    {loading ? "Logging in..." : "Login"}
                </button>

                <div className="flex items-center my-4">

                    <div className="flex-1 h-[1px] bg-gray-700"></div>

                    <span className="px-3 text-gray-400 text-sm">
                        OR
                    </span>

                    <div className="flex-1 h-[1px] bg-gray-700"></div>

                </div>

                <button
                    onClick={loginWithGoogle}
                    className="w-full bg-red-500 hover:bg-red-600 text-white py-3 rounded-lg font-semibold transition"
                >
                    Continue with Google
                </button>

                <p className="text-center text-gray-500 text-sm mt-6">
                    Secure business access powered by Supabase authentication.
                </p>

            </div>

        </div>
    )
}
