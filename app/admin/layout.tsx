"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { BezgrowLogoMark } from "@/components/brand/BezgrowLogoMark"
import DesktopBackButton from "@/components/desktop/DesktopBackButton"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { supabase } from "@/lib/supabase"

type BootstrapResponse = {
    success?: boolean
    error?: string
    user?: {
        email?: string | null
    }
    profile?: {
        role?: string | null
    }
    permissions?: {
        admin?: boolean
    }
}

const navItems = [
    ["Dashboard", "/admin"],
    ["User Approvals", "/admin/users"],
    ["Businesses", "/admin/businesses"],
    ["Analytics", "/admin/analytics"],
    ["Settings", "/admin/settings"],
]

const mobilePrimaryNav = [
    ["Admin", "/admin"],
    ["Users", "/admin/users"],
    ["Businesses", "/admin/businesses"],
    ["Analytics", "/admin/analytics"],
]

const mobileMoreNav = [
    ["Settings", "/admin/settings"],
    ["Workspace", "/dashboard"],
]

export default function AdminLayout({ children }: { children: ReactNode }) {
    const router = useRouter()
    const pathname = usePathname()
    const [adminEmail, setAdminEmail] = useState("")
    const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
    const [tabletNavOpen, setTabletNavOpen] = useState(false)
    const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine))

    useEffect(() => {
        queueMicrotask(async () => {
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession()

                const bootstrapPath = "/api/workspace/bootstrap"
                const desktopRuntime = await isTauriRuntimeAsync()
                const response = await fetch(desktopRuntime ? `/api/desktop-proxy?path=${encodeURIComponent(bootstrapPath)}` : bootstrapPath, {
                    headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
                    cache: "no-store",
                })
                const payload = (await response.json()) as BootstrapResponse

                setAdminEmail(payload.user?.email || "")

                if (!payload.success || (!payload.permissions?.admin && payload.profile?.role !== "admin")) {
                    router.replace(response.status === 401 ? "/login" : "/dashboard")
                }
            } catch (error) {
                console.error("Admin auth error:", error)
            }
        })
    }, [router])

    useEffect(() => {
        const handleOnline = () => setOnline(true)
        const handleOffline = () => setOnline(false)

        window.addEventListener("online", handleOnline)
        window.addEventListener("offline", handleOffline)

        return () => {
            window.removeEventListener("online", handleOnline)
            window.removeEventListener("offline", handleOffline)
        }
    }, [])

    async function handleLogout() {
        await supabase.auth.signOut()
        router.replace("/login")
    }

    const adminInitial = (adminEmail.charAt(0) || "A").toUpperCase()
    const isActivePath = (href: string) => pathname === href || (href !== "/admin" && pathname.startsWith(`${href}/`))
    const isMoreActive = mobileMoreNav.some(([, href]) => isActivePath(href))

    return (
        <div className="responsive-shell flex h-dvh max-h-dvh overflow-hidden bg-black text-white">
            <aside className="hidden w-[292px] shrink-0 border-r border-white/10 bg-[#060909] p-5 lg:flex lg:flex-col">
                <div className="inventory-sheen rounded-[30px] border border-white/10 bg-white/[0.035] p-5">
                    <BezgrowLogoMark className="mb-3 h-12 w-12" size={48} />
                    <p className="text-xs font-bold uppercase tracking-[0.22em] text-cyan-200">Platform Admin</p>
                    <h1 className="mt-3 text-3xl font-black">Bezgrow</h1>
                    <p className="mt-2 text-sm text-neutral-500">Global SaaS control plane</p>
                </div>

                <nav className="mt-6 flex-1 space-y-2 overflow-y-auto pr-1">
                    {navItems.map(([name, href]) => {
                        const active = pathname === href
                        return (
                            <Link
                                key={href}
                                href={href}
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
                    <p className="text-xs uppercase tracking-[0.18em] text-neutral-500">Admin</p>
                    <p className="mt-2 truncate text-sm font-bold text-white">{adminEmail}</p>
                    <button onClick={handleLogout} className="mt-4 h-11 w-full rounded-2xl bg-white text-sm font-black text-black hover:bg-cyan-100">
                        Logout
                    </button>
                </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <header className="z-30 hidden shrink-0 border-b border-white/10 bg-black/80 px-3 py-3 backdrop-blur-xl sm:px-5 sm:py-4 lg:block lg:px-8">
                    <div className="flex items-start gap-3">
                        <DesktopBackButton fallback="/admin" />
                        <div className="min-w-0 flex-1">
                            <h1 className="truncate text-lg font-black sm:text-2xl">Platform Administration</h1>
                            <p className="mt-1 line-clamp-2 text-sm text-neutral-500 sm:line-clamp-none">
                                Users, organizations, analytics, compliance, and global operating health.
                            </p>
                        </div>
                    </div>
                </header>

                <header className="z-30 hidden shrink-0 border-b border-white/10 bg-black/80 px-5 py-4 backdrop-blur-xl md:block lg:hidden">
                    <div className="flex items-start gap-3">
                        <button
                            onClick={() => setTabletNavOpen((value) => !value)}
                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-lg font-black"
                            aria-label="Open admin navigation"
                        >
                            {tabletNavOpen ? "X" : "≡"}
                        </button>
                        <DesktopBackButton fallback="/admin" />
                        <div className="min-w-0 flex-1">
                            <h1 className="truncate text-2xl font-black">Platform Administration</h1>
                            <p className="mt-1 line-clamp-2 text-sm text-neutral-500">
                                Users, organizations, analytics, compliance, and global operating health.
                            </p>
                        </div>
                    </div>
                    {tabletNavOpen && (
                        <nav className="mt-3 grid grid-cols-3 gap-2 rounded-2xl border border-white/10 bg-[#060909] p-3">
                            {navItems.map(([name, href]) => {
                                const active = isActivePath(href)
                                return (
                                    <Link
                                        key={href}
                                        href={href}
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
                            <DesktopBackButton fallback="/admin" />
                            <BezgrowLogoMark className="h-10 w-10 shrink-0" size={40} />
                            <div className="min-w-0">
                                <p className="truncate text-sm font-black text-white">Platform Admin</p>
                                <div className="mt-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.12em] text-neutral-500">
                                    <span className={`h-2 w-2 rounded-full ${online ? "bg-emerald-300" : "bg-amber-300"}`} />
                                    <span>{online ? "Online" : "Offline"}</span>
                                </div>
                            </div>
                        </div>
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-cyan-300 text-sm font-black text-black">
                            {adminInitial}
                        </div>
                    </div>
                </header>

                <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-black p-3 pb-28 sm:p-5 md:pb-6 lg:p-8 lg:pb-8">
                    {children}
                </main>

                <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-[#050707]/95 px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-2 shadow-[0_-18px_60px_rgba(0,0,0,0.35)] backdrop-blur-xl md:hidden">
                    {mobileMoreOpen && (
                        <div className="absolute inset-x-3 bottom-[calc(100%+0.5rem)] overflow-hidden rounded-lg border border-white/10 bg-[#080b0b] shadow-2xl">
                            <div className="grid grid-cols-2 gap-2 p-2">
                                {mobileMoreNav.map(([name, href]) => (
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
