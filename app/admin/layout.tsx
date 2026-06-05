"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import type { ReactNode } from "react"
import { useEffect, useState } from "react"
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

export default function AdminLayout({ children }: { children: ReactNode }) {
    const router = useRouter()
    const pathname = usePathname()
    const [adminEmail, setAdminEmail] = useState("")
    const [mobileNavOpen, setMobileNavOpen] = useState(false)

    useEffect(() => {
        queueMicrotask(async () => {
            try {
                const {
                    data: { session },
                } = await supabase.auth.getSession()

                const response = await fetch("/api/workspace/bootstrap", {
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

    async function handleLogout() {
        await supabase.auth.signOut()
        router.replace("/login")
    }

    return (
        <div className="responsive-shell flex h-dvh max-h-dvh overflow-hidden bg-black text-white">
            <aside className="hidden w-[292px] shrink-0 border-r border-white/10 bg-[#060909] p-5 lg:flex lg:flex-col">
                <div className="inventory-sheen rounded-[30px] border border-white/10 bg-white/[0.035] p-5">
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
                                prefetch={false}
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
                <header className="z-30 shrink-0 border-b border-white/10 bg-black/80 px-3 py-3 backdrop-blur-xl sm:px-5 sm:py-4 lg:px-8">
                    <div className="flex items-start gap-3">
                        <button
                            onClick={() => setMobileNavOpen((value) => !value)}
                            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-lg font-black lg:hidden"
                            aria-label="Open admin navigation"
                        >
                            {mobileNavOpen ? "X" : "≡"}
                        </button>
                        <div className="min-w-0 flex-1">
                            <h1 className="truncate text-lg font-black sm:text-2xl">Platform Administration</h1>
                            <p className="mt-1 line-clamp-2 text-sm text-neutral-500 sm:line-clamp-none">
                                Users, organizations, analytics, compliance, and global operating health.
                            </p>
                        </div>
                    </div>
                    {mobileNavOpen && (
                        <nav className="mt-3 flex gap-2 overflow-x-auto rounded-2xl border border-white/10 bg-[#060909] p-2 sm:grid sm:grid-cols-3 sm:p-3 lg:hidden">
                            {navItems.map(([name, href]) => {
                                const active = pathname === href
                                return (
                                    <Link
                                        key={href}
                                        href={href}
                                        prefetch={false}
                                        onClick={() => setMobileNavOpen(false)}
                                        className={`flex min-h-11 min-w-[132px] items-center justify-center rounded-xl border px-3 text-center text-xs font-bold sm:min-w-0 ${active ? "border-cyan-300/40 bg-cyan-300/10 text-cyan-100" : "border-white/10 bg-white/[0.03] text-white/65"}`}
                                    >
                                        {name}
                                    </Link>
                                )
                            })}
                        </nav>
                    )}
                </header>
                <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-black p-3 pb-6 sm:p-5 lg:p-8">
                    {children}
                </main>
            </div>
        </div>
    )
}
