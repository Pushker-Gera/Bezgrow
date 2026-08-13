"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import type { ReactNode } from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { BezgrowLogoMark } from "@/components/brand/BezgrowLogoMark"
import { FormKeyboardNavigation } from "@/components/forms/FormKeyboardNavigation"
import DesktopBackButton from "@/components/desktop/DesktopBackButton"
import PlatformAdminLauncher from "@/components/desktop/PlatformAdminLauncher"
import LocalDatabaseRecovery from "@/components/offline/LocalDatabaseRecovery"
import { clearDesktopSession } from "@/lib/desktop/session"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { getLocalDatabaseService } from "@/lib/offline/local/service"
import { localLicenseSnapshot, restoreLicensedWorkspaceContext } from "@/lib/offline/local/license"
import { clearWorkspaceBootstrapCache } from "@/lib/workspaceBootstrapClient"

const navItems = [
    ["Dashboard", "/dashboard"],
    ["Products", "/dashboard/products"],
    ["Customers", "/dashboard/customers"],
    ["Invoices", "/dashboard/invoices"],
    ["Billing", "/dashboard/billing"],
    ["Stock", "/dashboard/inventory"],
    ["Reports", "/dashboard/charts"],
    ["Settings", "/dashboard/settings"],
]

const mobilePrimaryNav = [
    ["Dashboard", "/dashboard"],
    ["Products", "/dashboard/products"],
    ["Customers", "/dashboard/customers"],
    ["Invoices", "/dashboard/invoices"],
]

const mobileMoreNav = [
    ["Reports", "/dashboard/charts"],
    ["Billing", "/dashboard/billing"],
    ["Stock", "/dashboard/inventory"],
    ["Settings", "/dashboard/settings"],
]

const priorityPrefetchRoutes = [
    "/dashboard/invoices/create",
    "/dashboard/products",
    "/dashboard/customers",
]

type DesktopDatabaseState = {
    status: "initializing" | "database-ready" | "license-valid" | "business-ready" | "browser-local-only" | "failed"
    message?: string
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
    const router = useRouter()
    const pathname = usePathname()
    const [businessName, setBusinessName] = useState("My Business")
    const [ownerEmail, setOwnerEmail] = useState("")
    const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
    const [tabletNavOpen, setTabletNavOpen] = useState(false)
    const [online, setOnline] = useState(true)
    const [canShowAdmin, setCanShowAdmin] = useState(false)
    const [desktopDatabase, setDesktopDatabase] = useState<DesktopDatabaseState>({ status: "initializing" })
    const startupStartedRef = useRef(false)
    const initialPathRef = useRef(pathname || "/dashboard")

    useEffect(() => {
        if (startupStartedRef.current) return
        startupStartedRef.current = true
        let cancelled = false

        queueMicrotask(async () => {
            try {
                const desktopRuntime = await isTauriRuntimeAsync().catch(() => false)
                if (desktopRuntime) {
                    try {
                        await getLocalDatabaseService().ensureReady()
                        if (!cancelled) setDesktopDatabase({ status: "database-ready" })
                    } catch (error) {
                        if (!cancelled) {
                            setDesktopDatabase({
                                status: "failed",
                                message: error instanceof Error ? error.message : "Bezgrow local database could not start.",
                            })
                        }
                        return
                    }

                    const restoredWorkspace = await restoreLicensedWorkspaceContext().catch((error) => {
                        console.warn("Desktop license workspace restore warning:", error)
                        return null
                    })
                    const organizationId = restoredWorkspace?.organization?.id || restoredWorkspace?.membership?.organization_id || undefined
                    const license = await localLicenseSnapshot(organizationId).catch((error) => {
                        console.warn("Desktop license validation warning:", error)
                        return null
                    })
                    if (!license?.allowed) {
                        router.replace(`/offline?next=${encodeURIComponent(initialPathRef.current)}`)
                        return
                    }
                    if (!cancelled) setDesktopDatabase({ status: "license-valid" })

                    if (restoredWorkspace?.success) {
                        if (restoredWorkspace.organization?.name) setBusinessName(restoredWorkspace.organization.name)
                        setOwnerEmail(restoredWorkspace.user?.email || "licensed@bezgrow.local")
                        setCanShowAdmin(false)
                        if (!cancelled) setDesktopDatabase({ status: "business-ready" })
                        return
                    }
                    router.replace(`/offline?next=${encodeURIComponent(initialPathRef.current)}`)
                    return
                } else if (!cancelled) {
                    setDesktopDatabase({ status: "browser-local-only" })
                    return
                }
            } catch (error) {
                console.warn("Dashboard access warning:", error)
                if (!cancelled) setDesktopDatabase({ status: "failed", message: "Bezgrow local startup could not be completed." })
            }
        })

        return () => {
            cancelled = true
        }
    }, [router])

    useEffect(() => {
        const handleOnline = () => setOnline(true)
        const handleOffline = () => setOnline(false)

        const initialSync = globalThis.setTimeout(() => {
            setOnline(typeof navigator === "undefined" ? true : navigator.onLine)
        }, 0)
        window.addEventListener("online", handleOnline)
        window.addEventListener("offline", handleOffline)

        return () => {
            globalThis.clearTimeout(initialSync)
            window.removeEventListener("online", handleOnline)
            window.removeEventListener("offline", handleOffline)
        }
    }, [])

    useEffect(() => {
        const prefetchDashboardRoutes = () => {
            priorityPrefetchRoutes.forEach((href, index) => {
                globalThis.setTimeout(() => router.prefetch(href), index * 250)
            })
        }

        if ("requestIdleCallback" in window) {
            const idleId = window.requestIdleCallback(prefetchDashboardRoutes, { timeout: 4000 })
            return () => window.cancelIdleCallback(idleId)
        }

        const timeout = globalThis.setTimeout(prefetchDashboardRoutes, 1500)
        return () => globalThis.clearTimeout(timeout)
    }, [router])

    const workspaceInitial = useMemo(() => businessName.charAt(0).toUpperCase() || "?", [businessName])
    const moreNavItems = canShowAdmin ? [...mobileMoreNav, ["Admin", "/admin"]] : mobileMoreNav
    const isActivePath = (href: string) => pathname === href || (href !== "/dashboard" && pathname.startsWith(`${href}/`))
    const isMoreActive = moreNavItems.some(([, href]) => isActivePath(href))
    const isInvoicePrintWorkspace = /^\/dashboard\/invoices\/[^/]+\/print(?:\/|$)/.test(pathname)

    async function handleLogout() {
        clearWorkspaceBootstrapCache()
        await clearDesktopSession()
        router.replace("/offline?reason=logged_out&next=%2Fdashboard")
    }

    if (desktopDatabase.status === "initializing" || desktopDatabase.status === "database-ready" || desktopDatabase.status === "license-valid") {
        return <LocalDatabaseRecovery checking />
    }

    if (desktopDatabase.status === "failed") {
        return <LocalDatabaseRecovery errorMessage={desktopDatabase.message} />
    }

    if (desktopDatabase.status === "browser-local-only") {
        return (
            <main className="flex min-h-dvh items-center justify-center bg-black px-5 text-white">
                <section className="max-w-xl rounded-[32px] border border-cyan-400/20 bg-cyan-500/10 p-8 text-center">
                    <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-200">Local-only desktop ERP</p>
                    <h1 className="mt-4 text-3xl font-black">Open Bezgrow on this device.</h1>
                    <p className="mt-4 leading-7 text-neutral-300">
                        Customer ERP data is stored in the desktop app&apos;s local SQLite database and is not available to this browser or to Bezgrow administrators.
                    </p>
                    <Link href="/download" className="mt-6 inline-flex min-h-12 items-center rounded-2xl bg-white px-6 font-black text-black">
                        Download Bezgrow Desktop
                    </Link>
                </section>
            </main>
        )
    }

    return (
        <div className="responsive-shell flex h-dvh max-h-dvh overflow-hidden bg-black text-white">
            <FormKeyboardNavigation />
            <aside className="hidden w-[292px] shrink-0 border-r border-white/10 bg-[#060909] p-5 lg:flex lg:flex-col">
                <div className="inventory-sheen rounded-[30px] border border-white/10 bg-white/[0.035] p-5">
                    <div className="flex items-center gap-4">
                        <BezgrowLogoMark className="h-14 w-14" size={56} />
                        <div className="min-w-0">
                            <p className="truncate text-lg font-black">Bezgrow</p>
                            <p className="truncate text-xs uppercase tracking-[0.18em] text-neutral-500">{businessName}</p>
                        </div>
                    </div>
                </div>

                <nav className="mt-6 flex-1 space-y-2 overflow-y-auto pr-1">
                    {navItems.map(([name, href]) => {
                        const active = pathname === href
                        return (
                            <Link
                                key={href}
                                href={href}
                                onMouseEnter={() => router.prefetch(href)}
                                onFocus={() => router.prefetch(href)}
                                className={`flex min-h-12 items-center rounded-2xl border px-4 text-sm font-bold transition-all duration-300 ${active
                                    ? "border-cyan-400/30 bg-cyan-500/10 text-cyan-100 shadow-[0_0_30px_rgba(34,211,238,0.12)]"
                                    : "border-transparent text-neutral-400 hover:border-white/10 hover:bg-white/[0.04] hover:text-white"
                                    }`}
                            >
                                {name}
                            </Link>
                        )
                    })}
                </nav>

                <div className="mt-5 rounded-[26px] border border-white/10 bg-white/[0.035] p-4">
                    <p className="truncate text-sm font-bold text-white">{businessName}</p>
                    <p className="mt-1 truncate text-xs text-neutral-500">{ownerEmail}</p>
                    <PlatformAdminLauncher className="mt-4" />
                    <button onClick={handleLogout} className="mt-4 h-11 w-full rounded-2xl bg-red-500/15 text-sm font-bold text-red-200 hover:bg-red-500/25">
                        Logout
                    </button>
                </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <header className="z-30 hidden shrink-0 border-b border-white/10 bg-black/80 px-3 py-3 backdrop-blur-xl sm:px-5 sm:py-4 lg:block lg:px-8">
                    <div className="flex items-center justify-between gap-3">
                        <DesktopBackButton fallback="/dashboard" />
                        <div className="min-w-0 flex-1">
                            <h1 className="truncate text-lg font-black sm:text-2xl">Business Dashboard</h1>
                            <p className="mt-1 truncate text-sm text-neutral-500">
                                Sales, stock, customers, invoices, and reports.
                            </p>
                        </div>
                        <Link href="/profile" className="flex h-11 shrink-0 items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-2 hover:border-cyan-400/30 sm:h-12 sm:gap-3 sm:px-3">
                            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-400 text-sm font-black text-black">
                                {workspaceInitial}
                            </span>
                            <span className="hidden max-w-[180px] truncate text-sm font-bold lg:block">{businessName}</span>
                        </Link>
                    </div>
                </header>

                <header className="z-30 hidden shrink-0 border-b border-white/10 bg-black/80 px-5 py-4 backdrop-blur-xl md:block lg:hidden">
                    <div className="flex items-center justify-between gap-3">
                        <button
                            onClick={() => setTabletNavOpen((value) => !value)}
                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-lg font-black"
                            aria-label="Open navigation"
                        >
                            {tabletNavOpen ? "X" : "≡"}
                        </button>
                        <DesktopBackButton fallback="/dashboard" />
                        <div className="min-w-0 flex-1">
                            <h1 className="truncate text-2xl font-black">Business Dashboard</h1>
                            <p className="mt-1 truncate text-sm text-neutral-500">
                                Sales, stock, customers, invoices, and reports.
                            </p>
                        </div>
                        <Link href="/profile" className="flex h-12 shrink-0 items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-3 hover:border-cyan-400/30">
                            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-400 text-sm font-black text-black">
                                {workspaceInitial}
                            </span>
                        </Link>
                    </div>
                    {tabletNavOpen && (
                        <nav className="mt-3 grid grid-cols-3 gap-2 rounded-2xl border border-white/10 bg-[#060909] p-3">
                            {navItems.map(([name, href]) => {
                                const active = isActivePath(href)
                                return (
                                    <Link
                                        key={href}
                                        href={href}
                                        onMouseEnter={() => router.prefetch(href)}
                                        onFocus={() => router.prefetch(href)}
                                        onClick={() => setTabletNavOpen(false)}
                                        className={`flex min-h-11 items-center justify-center rounded-xl border px-3 text-center text-xs font-bold ${active ? "border-cyan-300/40 bg-cyan-300/10 text-cyan-100" : "border-white/10 bg-white/[0.03] text-white/65"}`}
                                    >
                                        {name}
                                    </Link>
                                )
                            })}
                        </nav>
                    )}
                </header>

                <header className="z-30 shrink-0 border-b border-white/10 bg-black/90 px-4 py-3 backdrop-blur-xl md:hidden">
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                            <DesktopBackButton fallback="/dashboard" />
                            <BezgrowLogoMark className="h-10 w-10 shrink-0" size={40} />
                            <div className="min-w-0">
                                <p className="truncate text-sm font-black text-white">{businessName}</p>
                                <div className="mt-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.12em] text-neutral-500">
                                    <span className={`h-2 w-2 rounded-full ${online ? "bg-emerald-300" : "bg-amber-300"}`} />
                                    <span>{online ? "Online" : "Offline"}</span>
                                </div>
                            </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            <button
                                type="button"
                                aria-label="Notifications"
                                className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-sm font-black text-cyan-100"
                            >
                                !
                            </button>
                            <Link
                                href="/profile"
                                aria-label="Profile"
                                className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-300 text-sm font-black text-black"
                            >
                                {workspaceInitial}
                            </Link>
                        </div>
                    </div>
                </header>

                <main className={`min-h-0 flex-1 overflow-x-hidden bg-black ${isInvoicePrintWorkspace ? "overflow-hidden p-0" : "overflow-y-auto pb-28 md:pb-4"}`}>
                    {children}
                </main>

                <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-[#050707]/95 px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-2 shadow-[0_-18px_60px_rgba(0,0,0,0.35)] backdrop-blur-xl md:hidden">
                    {mobileMoreOpen && (
                        <div className="absolute inset-x-3 bottom-[calc(100%+0.5rem)] overflow-hidden rounded-lg border border-white/10 bg-[#080b0b] shadow-2xl">
                            <div className="grid grid-cols-2 gap-2 p-2">
                                {moreNavItems.map(([name, href]) => (
                                    <Link
                                        key={href}
                                        href={href}
                                        onClick={() => setMobileMoreOpen(false)}
                                        className={`flex min-h-12 items-center rounded-lg border px-3 text-sm font-bold ${isActivePath(href)
                                            ? "border-cyan-300/35 bg-cyan-300/10 text-cyan-100"
                                            : "border-white/10 bg-white/[0.04] text-neutral-200"
                                            }`}
                                    >
                                        {name}
                                    </Link>
                                ))}
                                <button
                                    type="button"
                                    onClick={() => void handleLogout()}
                                    className="flex min-h-12 items-center rounded-lg border border-red-400/20 bg-red-500/10 px-3 text-left text-sm font-bold text-red-200"
                                >
                                    Logout
                                </button>
                            </div>
                        </div>
                    )}
                    <div className="grid grid-cols-5 gap-1">
                        {mobilePrimaryNav.map(([name, href]) => {
                            const active = isActivePath(href)
                            return (
                                <Link
                                    key={href}
                                    href={href}
                                    onMouseEnter={() => router.prefetch(href)}
                                    onFocus={() => router.prefetch(href)}
                                    className={`flex min-h-[58px] flex-col items-center justify-center rounded-lg px-1 text-[11px] font-black ${active
                                        ? "bg-cyan-300 text-black"
                                        : "text-neutral-400"
                                        }`}
                                >
                                    <span className={`mb-1 h-1.5 w-1.5 rounded-full ${active ? "bg-black" : "bg-neutral-600"}`} />
                                    {name}
                                </Link>
                            )
                        })}
                        <button
                            type="button"
                            onClick={() => setMobileMoreOpen((value) => !value)}
                            className={`flex min-h-[58px] flex-col items-center justify-center rounded-lg px-1 text-[11px] font-black ${mobileMoreOpen || isMoreActive
                                ? "bg-cyan-300 text-black"
                                : "text-neutral-400"
                                }`}
                        >
                            <span className={`mb-1 h-1.5 w-1.5 rounded-full ${mobileMoreOpen || isMoreActive ? "bg-black" : "bg-neutral-600"}`} />
                            More
                        </button>
                    </div>
                </nav>
            </div>
        </div>
    )
}
