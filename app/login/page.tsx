"use client"

import type { FormEvent } from "react"
import { useCallback, useEffect, useState } from "react"
import type { Session } from "@supabase/supabase-js"
import { BezgrowLogoMark } from "@/components/brand/BezgrowLogoMark"
import { completeDesktopAuthCallback } from "@/lib/desktop/auth-callback"
import { hasCachedDesktopSession, persistDesktopSession } from "@/lib/desktop/session"
import { isTauriRuntimeAsync, openExternalUrl } from "@/lib/desktop/tauri"
import { getCachedWorkspaceBootstrap } from "@/lib/offline/db"
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
        canAccessDashboard?: boolean
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

    const redirectToCallback = useCallback(async (accessToken: string, refreshToken: string, nextPath = getSafeNextPath("/dashboard")) => {
        if (await isTauriRuntimeAsync()) {
            const redirectPath = await completeDesktopAuthCallback(accessToken, refreshToken, nextPath)
            window.location.replace(redirectPath)
            return
        }

        const params = new URLSearchParams({
            access_token: accessToken,
            refresh_token: refreshToken,
            next: nextPath,
        })
        window.location.assign(`${getSiteUrl()}/auth/callback?${params.toString()}`)
    }, [getSafeNextPath, getSiteUrl])

    function createDesktopOAuthState() {
        const bytes = new Uint8Array(32)
        crypto.getRandomValues(bytes)
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
    }

    function getOAuthCallbackUrl(desktopOAuthState?: string) {
        const callbackUrl = new URL("/auth/callback", getSiteUrl())
        callbackUrl.searchParams.set("next", getSafeNextPath("/dashboard"))
        if (desktopOAuthState) {
            callbackUrl.searchParams.set("desktop_oauth_state", desktopOAuthState)
        }
        return callbackUrl.toString()
    }

    async function waitForDesktopGoogleSignIn(state: string) {
        const deadline = Date.now() + 5 * 60 * 1000

        while (Date.now() < deadline) {
            await new Promise((resolve) => globalThis.setTimeout(resolve, 1200))

            const response = await fetch(`/api/desktop-auth/exchange?state=${encodeURIComponent(state)}`, {
                credentials: "include",
                cache: "no-store",
            })
            const payload = (await response.json().catch(() => ({}))) as {
                ready?: boolean
                error?: string
                session?: Session
                redirectTo?: string
            }

            if (!response.ok) {
                throw new Error(payload.error || "Google login failed.")
            }

            if (!payload.ready) continue

            const session = payload.session
            if (!session?.access_token || !session.refresh_token) {
                throw new Error("Google login did not return a valid session.")
            }

            const { data, error } = await supabase.auth.setSession({
                access_token: session.access_token,
                refresh_token: session.refresh_token,
            })

            if (error) throw error
            if (data.session) await persistDesktopSession(data.session)

            const redirectPath = await completeDesktopAuthCallback(session.access_token, session.refresh_token, getSafeNextPath("/dashboard"))
            window.location.replace(redirectPath)
            return
        }

        throw new Error("Google login timed out. Please try again.")
    }

    useEffect(() => {

        async function checkUser() {
            const urlError = new URLSearchParams(window.location.search).get("error")
            if (urlError === "profile_missing") {
                setErrorMessage("Your login succeeded, but no profile was found for this account. Contact support to repair the admin profile.")
            } else if (urlError === "account_suspended") {
                setErrorMessage("This account is suspended.")
            }

            if (!navigator.onLine) {
                const [hasSession, cachedWorkspace] = await Promise.all([
                    hasCachedDesktopSession(),
                    Promise.resolve(getCachedWorkspaceBootstrap()),
                ])

                if (hasSession && cachedWorkspace?.success && cachedWorkspace.permissions?.canAccessDashboard) {
                    window.location.replace("/dashboard")
                    return
                }

                setErrorMessage("Internet required for first login. Reconnect once, then Bezgrow can open offline.")
                return
            }

            const bootstrapResponse = await fetch("/api/workspace/bootstrap", {
                cache: "no-store",
                credentials: "include",
            })
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
                await redirectToCallback(session.access_token, session.refresh_token)
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
                await persistDesktopSession(data.session)
                await redirectToCallback(data.session.access_token, data.session.refresh_token)
            }

        } catch (error) {

            setErrorMessage(error instanceof Error ? error.message : "Something went wrong")

        } finally {

            setLoading(false)

        }

    }

    async function loginWithGoogle() {

        try {
            if (!navigator.onLine) {
                setErrorMessage("Internet required for this action.")
                return
            }

            setGoogleLoading(true)
            setErrorMessage("")
            setSuccessMessage("")

            const desktopRuntime = await isTauriRuntimeAsync()
            const desktopOAuthState = desktopRuntime ? createDesktopOAuthState() : undefined
            const { data, error } = await supabase.auth.signInWithOAuth({
                provider: "google",
                options: {
                    redirectTo: getOAuthCallbackUrl(desktopOAuthState),
                    skipBrowserRedirect: true,
                }
            })

            if (error) {
                showAuthError(error.message)
                setGoogleLoading(false)
                return
            }

            if (data.url) {
                if (desktopOAuthState) {
                    const openedExternally = await openExternalUrl(data.url)
                    if (!openedExternally) {
                        throw new Error("Unable to open Google sign-in in your browser.")
                    }
                    setSuccessMessage("Complete Google sign-in in your browser. Bezgrow will continue automatically.")
                    void waitForDesktopGoogleSignIn(desktopOAuthState).catch((error) => {
                        showAuthError(error instanceof Error ? error.message : "Google login failed")
                        setGoogleLoading(false)
                    })
                    return
                }

                window.location.assign(data.url)
                return
            }

        } catch (error) {

            setErrorMessage(error instanceof Error ? error.message : "Google login failed")
            setGoogleLoading(false)

        }

    }

    async function forgotPassword() {

        try {
            if (!navigator.onLine) {
                setErrorMessage("Internet required for this action.")
                return
            }

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
        <div className="inventory-grid-bg flex min-h-dvh w-full overflow-x-hidden items-center justify-center px-3 py-5 text-white sm:px-5 sm:py-8">

            <form onSubmit={login} className="w-full min-w-0 max-w-[calc(100vw-1.5rem)] rounded-[22px] border border-white/10 bg-neutral-950/85 p-5 shadow-[0_28px_120px_rgba(0,0,0,0.45)] backdrop-blur-xl sm:max-w-md sm:rounded-[28px] sm:p-8">

                <div className="mb-5 flex min-w-0 items-center gap-3">
                    <BezgrowLogoMark className="h-10 w-10" size={40} priority />
                    <span className="min-w-0 text-base font-black">Bezgrow</span>
                </div>

                <h1 className="mb-2 break-words text-2xl font-bold sm:text-3xl">
                    Welcome Back
                </h1>

                <p className="mb-5 break-words text-sm leading-6 text-gray-400 sm:mb-6">
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

                <div className="mb-6 flex flex-col gap-3 text-sm min-[440px]:flex-row min-[440px]:items-center min-[440px]:justify-between">

                    <span className="text-gray-400">You stay signed in until logout</span>

                    <button
                        type="button"
                        onClick={forgotPassword}
                        disabled={resetLoading}
                        className="self-start text-blue-400 hover:text-blue-300 disabled:opacity-50 min-[440px]:self-auto"
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

                <p className="mt-6 break-words text-center text-sm text-gray-500">
                    Secure business access powered by Supabase authentication.
                </p>

            </form>

        </div>
    )
}
