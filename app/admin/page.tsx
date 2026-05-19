"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase"

type PendingUser = {
    id: string
    email: string | null
    full_name?: string | null
    business_name: string | null
    created_at?: string | null
}

type AdminMetricsResponse = {
    success: boolean
    error?: string
    organizations?: unknown[]
    profiles?: Array<{ approved: boolean | null; business_created: boolean | null }>
    pendingUsers?: PendingUser[]
    usersCount?: number
}

function formatDate(value: string | null | undefined) {
    if (!value) return "New request"
    return new Date(value).toLocaleDateString()
}

export default function AdminPage() {
    const router = useRouter()

    const [users, setUsers] = useState<PendingUser[]>([])
    const [totalUsers, setTotalUsers] = useState(0)
    const [totalBusinesses, setTotalBusinesses] = useState(0)
    const [pendingCount, setPendingCount] = useState(0)
    const [approvedUsers, setApprovedUsers] = useState(0)
    const [loading, setLoading] = useState(true)
    const [notice, setNotice] = useState("")

    const loadUsers = useCallback(async () => {
        setLoading(true)

        const {
            data: { session },
        } = await supabase.auth.getSession()

        if (!session?.access_token) {
            setNotice("Admin session not found. Please log in again.")
            setLoading(false)
            return
        }

        const response = await fetch("/api/admin/metrics", {
            headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const payload = (await response.json()) as AdminMetricsResponse

        if (!payload.success) {
            setNotice(payload.error || "Admin metrics failed to load.")
            setLoading(false)
            return
        }

        const profileRows = payload.profiles || []
        const pendingRows = payload.pendingUsers || []

        setUsers(pendingRows)
        setPendingCount(pendingRows.length)
        setTotalUsers(payload.usersCount || profileRows.length)
        setApprovedUsers(profileRows.filter((profile) => profile.approved !== false && profile.business_created !== false).length)
        setTotalBusinesses(payload.organizations?.length || 0)
        setLoading(false)
    }, [])

    const checkAdmin = useCallback(async () => {
        const {
            data: { user },
        } = await supabase.auth.getUser()

        if (!user) {
            router.push("/login")
            return
        }

        const { data: profile } = await supabase
            .from("profiles")
            .select("role")
            .eq("id", user.id)
            .maybeSingle()

        if (!profile || profile.role !== "admin") {
            router.push("/dashboard")
            return
        }

        await loadUsers()
    }, [loadUsers, router])

    useEffect(() => {
        queueMicrotask(() => {
            void checkAdmin()
        })
    }, [checkAdmin])

    const approvalHealth = useMemo(() => {
        if (totalUsers === 0) return 100
        return Math.round((approvedUsers / totalUsers) * 100)
    }, [approvedUsers, totalUsers])

    async function approveUser(user: PendingUser) {
        const { error: profileError } = await supabase
            .from("profiles")
            .upsert([
                {
                    id: user.id,
                    email: user.email,
                    approved: true,
                    business_created: false,
                    role: "user",
                },
            ])

        if (profileError) {
            setNotice(profileError.message)
            return
        }

        const { error: deleteError } = await supabase
            .from("pending_users")
            .delete()
            .eq("id", user.id)

        if (deleteError) {
            setNotice(deleteError.message)
            return
        }

        setNotice(`${user.email || "User"} approved successfully.`)
        await loadUsers()
    }

    return (
        <div className="space-y-8 text-white">
            <section className="inventory-sheen relative overflow-hidden rounded-[40px] border border-white/10 bg-white/[0.035] p-8 shadow-[0_0_90px_rgba(0,0,0,0.5)] backdrop-blur-2xl">
                <div className="relative z-10 flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
                    <div>
                        <div className="mb-5 inline-flex rounded-full border border-cyan-400/20 bg-cyan-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200">
                            Platform Command Center
                        </div>
                        <h1 className="max-w-5xl text-4xl font-black leading-tight tracking-tight md:text-6xl">
                            Admin operations for approvals, organizations, and SaaS growth.
                        </h1>
                        <p className="mt-5 max-w-3xl text-base leading-8 text-neutral-400">
                            Monitor platform health, approve businesses, track workspace growth,
                            and keep the ERP launch pipeline clean.
                        </p>
                    </div>
                    <div className="rounded-[32px] border border-emerald-400/20 bg-emerald-500/10 p-6">
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-200">
                            Approval Health
                        </p>
                        <p className="mt-3 text-5xl font-black text-emerald-200">{approvalHealth}%</p>
                    </div>
                </div>
            </section>

            {notice && (
                <div className="rounded-3xl border border-cyan-400/25 bg-cyan-500/10 px-6 py-4 text-sm text-cyan-100">
                    {notice}
                </div>
            )}

            <section className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-4">
                {[
                    ["Total Users", totalUsers, "text-white", "Registered profiles"],
                    ["Approved Users", approvedUsers, "text-emerald-200", "Active platform access"],
                    ["Pending Approvals", pendingCount, "text-amber-200", "Requires admin action"],
                    ["Organizations", totalBusinesses, "text-cyan-200", "Business workspaces"],
                ].map(([label, value, color, helper]) => (
                    <div key={label} className="rounded-[32px] border border-white/10 bg-gradient-to-br from-zinc-950 via-black to-zinc-950 p-7">
                        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">{label}</p>
                        <p className={`mt-5 text-4xl font-black tracking-tight ${color}`}>{value}</p>
                        <p className="mt-4 text-sm text-neutral-500">{helper}</p>
                    </div>
                ))}
            </section>

            <section className="overflow-hidden rounded-[36px] border border-white/10 bg-gradient-to-br from-zinc-950/95 to-black shadow-[0_0_80px_rgba(0,0,0,0.4)]">
                <div className="flex flex-col gap-3 border-b border-white/10 p-6 md:flex-row md:items-center md:justify-between">
                    <div>
                        <h2 className="text-3xl font-black">Pending User Approvals</h2>
                        <p className="mt-2 text-sm text-neutral-500">Review and approve business owners before workspace creation.</p>
                    </div>
                    <button onClick={() => void loadUsers()} className="h-12 rounded-2xl border border-white/10 px-5 text-sm font-bold text-white hover:border-cyan-400/30">
                        Refresh
                    </button>
                </div>

                {loading ? (
                    <div className="p-12 text-center text-neutral-500">Loading platform data...</div>
                ) : users.length === 0 ? (
                    <div className="p-12 text-center">
                        <h3 className="text-2xl font-black">No Pending Users</h3>
                        <p className="mt-3 text-neutral-500">All signup requests have been approved.</p>
                    </div>
                ) : (
                    <div className="divide-y divide-white/5">
                        {users.map((user) => (
                            <div key={user.id} className="grid gap-5 px-6 py-5 md:grid-cols-[1fr,180px,140px] md:items-center">
                                <div>
                                    <p className="text-xl font-bold text-white">{user.full_name || "New Business Owner"}</p>
                                    <p className="mt-1 text-sm text-neutral-400">{user.email || "No email"}</p>
                                    <p className="mt-1 text-xs text-neutral-500">{user.business_name || "Business name pending"}</p>
                                </div>
                                <p className="text-sm text-neutral-500">{formatDate(user.created_at)}</p>
                                <button
                                    onClick={() => void approveUser(user)}
                                    className="h-12 rounded-2xl bg-white px-5 font-black text-black hover:bg-cyan-100"
                                >
                                    Approve
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </div>
    )
}
