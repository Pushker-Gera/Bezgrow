"use client"

import type { FormEvent } from "react"
import { useCallback, useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"

type BootstrapResponse = {
    success?: boolean
    error?: string
    profile?: {
        role?: string | null
        approved?: boolean
        is_suspended?: boolean
        business_created?: boolean
    }
    organization?: { id?: string | null } | null
    permissions?: {
        admin?: boolean
    }
}

export default function LoginPage() {

    const [email, setEmail] = useState("")
    const [password, setPassword] = useState("")

    const [loading, setLoading] = useState(false)
    const [googleLoading, setGoogleLoading] = useState(false)
    const [errorMessage, setErrorMessage] = useState("")
    const [successMessage, setSuccessMessage] = useState("")
    const [resetLoading, setResetLoading] = useState(false)

    const getSafeNextPath = useCallback((fallback: string) => {
        if (typeof window === "undefined") {
            return fallback
        }

        const requested = new URLSearchParams(window.location.search).get("next")
        if (!requested || !requested.startsWith("/") || requested.startsWith("//")) {
            return fallback
        }

        return requested
    }, [])

    function showAuthError(message: string) {
        if (message.toLowerCase().includes("invalid api key")) {
            setErrorMessage("Supabase API key is invalid on this deployment. Update NEXT_PUBLIC_SUPABASE_ANON_KEY in Vercel and redeploy.")
            return
        }

        setErrorMessage(message)
    }

    const getSiteUrl = useCallback(() => {
        return (window.location.origin || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "")
    }, [])

    const redirectToCallback = useCallback((accessToken: string, refreshToken: string, nextPath = getSafeNextPath("/dashboard")) => {
        const params = new URLSearchParams({
            access_token: accessToken,
            refresh_token: refreshToken,
            next: nextPath,
        })
        window.location.assign(`${getSiteUrl()}/auth/callback?${params.toString()}`)
    }, [getSafeNextPath, getSiteUrl])

    useEffect(() => {

        async function checkUser() {
            const urlError = new URLSearchParams(window.location.search).get("error")
            if (urlError === "profile_missing") {
                setErrorMessage("Your login succeeded, but no profile was found for this account. Contact support to repair the admin profile.")
            } else if (urlError === "account_suspended") {
                setErrorMessage("This account is suspended.")
            }

            const bootstrapResponse = await fetch("/api/workspace/bootstrap", { cache: "no-store" })
            if (bootstrapResponse.ok) {
                const payload = (await bootstrapResponse.json()) as BootstrapResponse
                if (payload.success) {
                    if (payload.permissions?.admin || payload.profile?.role === "admin") {
                        window.location.replace("/admin")
                        return
                    }
                    if (!payload.profile?.approved) {
                        window.location.replace("/pending-approval")
                        return
                    }
                    const hasBusiness = Boolean(payload.profile.business_created || payload.organization?.id)
                    window.location.replace(hasBusiness ? "/dashboard" : "/create-business")
                    return
                }
            }

            const {
                data: { session },
                error,
            } = await supabase.auth.getSession()

            if (error) {
                showAuthError(error.message)
                return
            }

            if (session?.access_token && session.refresh_token) {
                redirectToCallback(session.access_token, session.refresh_token)
            }

        }

        checkUser()

    }, [redirectToCallback])

    async function login(event?: FormEvent<HTMLFormElement>) {
        event?.preventDefault()

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
                else if (error.message.toLowerCase().includes("invalid api key")) {
                    showAuthError(error.message)
                }
                else if (error.message.includes("Email not confirmed")) {
                    setErrorMessage("Please verify your email before logging in")
                }
                else {
                    showAuthError(error.message)
                }

                setLoading(false)
                return
            }

            setSuccessMessage("Login successful")

            if (data.session?.access_token && data.session.refresh_token) {
                redirectToCallback(data.session.access_token, data.session.refresh_token)
            }

        } catch {

            setErrorMessage("Something went wrong")

        } finally {

            setLoading(false)

        }

    }

    async function loginWithGoogle() {

        try {
            setGoogleLoading(true)
            setErrorMessage("")
            setSuccessMessage("")

            const { data, error } = await supabase.auth.signInWithOAuth({
                provider: "google",
                options: {
                    redirectTo: `${getSiteUrl()}/auth/callback?next=${encodeURIComponent(getSafeNextPath("/dashboard"))}`,
                    skipBrowserRedirect: true,
                }
            })

            if (error) {
                showAuthError(error.message)
                setGoogleLoading(false)
                return
            }

            if (data.url) {
                window.location.assign(data.url)
                return
            }

        } catch {

            setErrorMessage("Google login failed")
            setGoogleLoading(false)

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
                redirectTo: `${getSiteUrl()}/reset-password`
            })

            if (error) {
                showAuthError(error.message)
                setResetLoading(false)
                return
            }

            setSuccessMessage("Password reset link sent to your email")

    } catch {

            setErrorMessage("Failed to send reset email")

        } finally {

            setResetLoading(false)
        }
    }

    return (
        <div className="inventory-grid-bg flex min-h-dvh items-center justify-center px-3 py-5 text-white sm:px-5 sm:py-8">

            <form onSubmit={login} className="w-full max-w-md rounded-[22px] border border-white/10 bg-neutral-950/85 p-5 shadow-[0_28px_120px_rgba(0,0,0,0.45)] backdrop-blur-xl sm:rounded-[28px] sm:p-8">

                <h1 className="mb-2 text-2xl font-bold sm:text-3xl">
                    Welcome Back
                </h1>

                <p className="mb-5 text-sm leading-6 text-gray-400 sm:mb-6">
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
                    className="mb-4 min-h-12 w-full rounded-lg border border-gray-700 bg-black p-3 outline-none focus:border-cyan-300"
                    onChange={(e) => setEmail(e.target.value)}
                />

                <input
                    type="password"
                    placeholder="Password"
                    value={password}
                    className="mb-4 min-h-12 w-full rounded-lg border border-gray-700 bg-black p-3 outline-none focus:border-cyan-300"
                    onChange={(e) => setPassword(e.target.value)}
                />

                <div className="mb-6 flex flex-col gap-3 text-sm min-[380px]:flex-row min-[380px]:items-center min-[380px]:justify-between">

                    <span className="text-gray-400">You stay signed in until logout</span>

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
                    type="submit"
                    disabled={loading}
                    className="min-h-12 w-full rounded-lg bg-white py-3 font-semibold text-black disabled:opacity-50"
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
                    type="button"
                    onClick={loginWithGoogle}
                    disabled={googleLoading}
                    className="min-h-12 w-full rounded-lg bg-red-500 py-3 font-semibold text-white transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {googleLoading ? "Opening Google..." : "Continue with Google"}
                </button>

                <p className="text-center text-gray-500 text-sm mt-6">
                    Secure business access powered by Supabase authentication.
                </p>

            </form>

        </div>
    )
}
