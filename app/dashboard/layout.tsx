"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import type { ReactNode } from "react"
import { useEffect, useMemo, useState } from "react"
import { BezgrowLogoMark } from "@/components/brand/BezgrowLogoMark"
import OfflineStatusBar from "@/components/offline/OfflineStatusBar"
import { clearDesktopSession } from "@/lib/desktop/session"
import { clearOfflineData } from "@/lib/offline/db"
import { prepareOfflineWorkspace } from "@/lib/offline/bootstrap"
import { supabase } from "@/lib/supabase"
import { clearWorkspaceBootstrapCache, getWorkspaceBootstrap } from "@/lib/workspaceBootstrapClient"

const navItems = [
    ["Dashboard", "/dashboard"],
    ["Products", "/dashboard/products"],
    ["Customers", "/dashboard/customers"],
    ["Invoices", "/dashboard/invoices"],
    ["Orders", "/dashboard/orders"],
    ["Billing", "/dashboard/billing"],
    ["Inventory", "/dashboard/inventory"],
    ["Analytics", "/dashboard/charts"],
    ["Settings", "/dashboard/settings"],
]

export default function DashboardLayout({ children }: { children: ReactNode }) {
    const router = useRouter()
    const pathname = usePathname()
    const [businessName, setBusinessName] = useState("My Business")
    const [ownerEmail, setOwnerEmail] = useState("")
    const [mobileNavOpen, setMobileNavOpen] = useState(false)
    const [offlinePrepMessage, setOfflinePrepMessage] = useState("")

    useEffect(() => {
        queueMicrotask(async () => {
            try {
                const payload = await getWorkspaceBootstrap()

                if (!payload?.success) {
                    router.replace("/login")
                    return
                }

                if (payload.organization?.name) setBusinessName(payload.organization.name)

                setOwnerEmail(payload.user?.email || "owner@bezgrow.com")

                if (payload.profile?.role === "admin") router.replace("/admin")

                void prepareOfflineWorkspace(payload, {
                    onProgress: (progress) => {
                        setOfflinePrepMessage(progress.message)
                        if (progress.completed >= progress.total) {
                            globalThis.setTimeout(() => setOfflinePrepMessage(""), 4000)
                        }
                    },
                }).catch((error) => {
                    if (typeof navigator !== "undefined" && navigator.onLine) {
                        setOfflinePrepMessage(error instanceof Error ? error.message : "Offline workspace preparation failed.")
                        globalThis.setTimeout(() => setOfflinePrepMessage(""), 6000)
                    }
                })
            } catch (error) {
                console.error("Dashboard access error:", error)
            }
        })
    }, [router])

    useEffect(() => {
        const prefetchDashboardRoutes = () => {
            navItems.forEach(([, href]) => router.prefetch(href))
        }

        if ("requestIdleCallback" in window) {
            const idleId = window.requestIdleCallback(prefetchDashboardRoutes, { timeout: 2500 })
            return () => window.cancelIdleCallback(idleId)
        }

        const timeout = globalThis.setTimeout(prefetchDashboardRoutes, 600)
        return () => globalThis.clearTimeout(timeout)
    }, [router])

    const workspaceInitial = useMemo(() => businessName.charAt(0).toUpperCase() || "?", [businessName])

    async function handleLogout() {
        clearWorkspaceBootstrapCache()
        await clearDesktopSession()
        await clearOfflineData()
        await supabase.auth.signOut()
        router.replace("/login")
    }

    return (
        <div className="responsive-shell flex h-dvh max-h-dvh overflow-hidden bg-black text-white">
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
                    <button onClick={handleLogout} className="mt-4 h-11 w-full rounded-2xl bg-red-500/15 text-sm font-bold text-red-200 hover:bg-red-500/25">
                        Logout
                    </button>
                </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <header className="z-30 shrink-0 border-b border-white/10 bg-black/80 px-3 py-3 backdrop-blur-xl sm:px-5 sm:py-4 lg:px-8">
                    <div className="flex items-center justify-between gap-3">
                        <button
                            onClick={() => setMobileNavOpen((value) => !value)}
                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-lg font-black lg:hidden"
                            aria-label="Open navigation"
                        >
                            {mobileNavOpen ? "X" : "≡"}
                        </button>
                        <div className="min-w-0 flex-1">
                            <h1 className="truncate text-lg font-black sm:text-2xl">Global ERP Workspace</h1>
                            <p className="mt-1 truncate text-sm text-neutral-500">
                                Inventory, billing, retail POS, analytics, and launch operations.
                            </p>
                        </div>
                        <Link href="/profile" className="flex h-11 shrink-0 items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-2 hover:border-cyan-400/30 sm:h-12 sm:gap-3 sm:px-3">
                            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-400 text-sm font-black text-black">
                                {workspaceInitial}
                            </span>
                            <span className="hidden max-w-[180px] truncate text-sm font-bold lg:block">{businessName}</span>
                        </Link>
                    </div>
                    {mobileNavOpen && (
                        <nav className="mt-3 flex gap-2 overflow-x-auto rounded-2xl border border-white/10 bg-[#060909] p-2 sm:grid sm:grid-cols-3 sm:p-3 lg:hidden">
                            {navItems.map(([name, href]) => {
                                const active = pathname === href
                                return (
                                    <Link
                                        key={href}
                                        href={href}
                                        onMouseEnter={() => router.prefetch(href)}
                                        onFocus={() => router.prefetch(href)}
                                        onClick={() => setMobileNavOpen(false)}
                                        className={`flex min-h-11 min-w-[120px] items-center justify-center rounded-xl border px-3 text-center text-xs font-bold sm:min-w-0 ${active ? "border-cyan-300/40 bg-cyan-300/10 text-cyan-100" : "border-white/10 bg-white/[0.03] text-white/65"}`}
                                    >
                                        {name}
                                    </Link>
                                )
                            })}
                        </nav>
                    )}
                </header>

                <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-black pb-4">
                    <OfflineStatusBar />
                    {offlinePrepMessage && (
                        <div className="border-b border-emerald-400/20 bg-emerald-500/10 px-3 py-2 text-sm font-semibold text-emerald-100">
                            <div className="mx-auto max-w-[1800px]">{offlinePrepMessage}</div>
                        </div>
                    )}
                    {children}
                </main>
            </div>
        </div>
    )
}
