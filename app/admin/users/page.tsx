"use client"

import { useEffect, useMemo, useState } from "react"
import { useDebounce } from "use-debounce"
import { supabase } from "@/lib/supabase"

type ProfileRow = {
  id: string
  email: string | null
  full_name?: string | null
  role: string | null
  approved: boolean | null
  business_created: boolean | null
  organization_id: string | null
  created_at?: string | null
}

type OrganizationRow = {
  id: string
  name: string | null
}

type UserView = ProfileRow & {
  business: string
  status: "Approved" | "Pending" | "Suspended"
}

type AdminMetricsResponse = {
  success: boolean
  error?: string
  profiles?: ProfileRow[]
  organizations?: OrganizationRow[]
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-"
  return new Date(value).toLocaleDateString()
}

export default function AdminUsersPage() {
  const [profiles, setProfiles] = useState<ProfileRow[]>([])
  const [organizations, setOrganizations] = useState<OrganizationRow[]>([])
  const [search, setSearch] = useState("")
  const [debouncedSearch] = useDebounce(search, 300)
  const [statusFilter, setStatusFilter] = useState("all")
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState("")

  async function fetchUsers() {
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
      setNotice(payload.error || "Admin users failed to load.")
      setLoading(false)
      return
    }

    setProfiles(payload.profiles || [])
    setOrganizations(payload.organizations || [])
    setLoading(false)
  }

  useEffect(() => {
    queueMicrotask(() => {
      void fetchUsers()
    })
  }, [])

  const orgMap = useMemo(() => new Map(organizations.map((org) => [org.id, org.name || "No Organization"])), [organizations])

  const users = useMemo<UserView[]>(() => {
    return profiles.map((profile) => {
      const status = profile.approved
        ? profile.business_created === false
          ? "Suspended"
          : "Approved"
        : "Pending"

      return {
        ...profile,
        business: profile.organization_id ? orgMap.get(profile.organization_id) || "No Organization" : "No Organization",
        status,
      }
    })
  }, [orgMap, profiles])

  const filteredUsers = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase()
    return users.filter((user) => {
      const text = [user.full_name, user.email, user.business, user.role].join(" ").toLowerCase()
      const matchesSearch = !term || text.includes(term)
      const matchesStatus = statusFilter === "all" || user.status.toLowerCase() === statusFilter
      return matchesSearch && matchesStatus
    })
  }, [debouncedSearch, statusFilter, users])

  async function updateUser(user: UserView, action: "approve" | "suspend" | "activate") {
    const payload =
      action === "approve" || action === "activate"
        ? { approved: true, business_created: true }
        : { business_created: false }

    const { error } = await supabase.from("profiles").update(payload).eq("id", user.id)
    if (error) {
      setNotice(error.message)
      return
    }

    setNotice(`${user.email || "User"} updated successfully.`)
    await fetchUsers()
  }

  const stats = {
    total: users.length,
    approved: users.filter((user) => user.status === "Approved").length,
    pending: users.filter((user) => user.status === "Pending").length,
    suspended: users.filter((user) => user.status === "Suspended").length,
  }

  return (
    <div className="space-y-8 text-white">
      <section className="inventory-sheen rounded-[40px] border border-white/10 bg-white/[0.035] p-8 shadow-[0_0_90px_rgba(0,0,0,0.5)]">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="mb-4 text-xs font-bold uppercase tracking-[0.24em] text-cyan-200">User Governance</p>
            <h1 className="max-w-5xl text-4xl font-black leading-tight md:text-6xl">Users, approvals, roles, and access control.</h1>
            <p className="mt-5 max-w-3xl text-neutral-400">Operate a scalable SaaS user layer with real profiles, organization mapping, status control, and approval workflows.</p>
          </div>
          <button onClick={() => void fetchUsers()} className="h-14 rounded-2xl bg-white px-7 font-black text-black">Refresh Users</button>
        </div>
      </section>

      {notice && <div className="rounded-3xl border border-cyan-400/25 bg-cyan-500/10 px-6 py-4 text-sm text-cyan-100">{notice}</div>}

      <section className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-4">
        {[
          ["Total Users", stats.total, "text-white"],
          ["Approved", stats.approved, "text-emerald-200"],
          ["Pending", stats.pending, "text-amber-200"],
          ["Suspended", stats.suspended, "text-red-200"],
        ].map(([label, value, color]) => (
          <div key={label} className="rounded-[32px] border border-white/10 bg-gradient-to-br from-zinc-950 via-black to-zinc-950 p-7">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">{label}</p>
            <p className={`mt-5 text-4xl font-black ${color}`}>{value}</p>
          </div>
        ))}
      </section>

      <section className="rounded-[36px] border border-white/10 bg-white/[0.035] p-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr,220px]">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search user, email, role, organization..." className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none" />
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-14 rounded-2xl border border-white/10 bg-black/50 px-5 outline-none">
            <option value="all">All status</option>
            <option value="approved">Approved</option>
            <option value="pending">Pending</option>
            <option value="suspended">Suspended</option>
          </select>
        </div>
      </section>

      <section className="overflow-hidden rounded-[36px] border border-white/10 bg-gradient-to-br from-zinc-950/95 to-black">
        <div className="border-b border-white/10 p-6">
          <h2 className="text-3xl font-black">User Register</h2>
          <p className="mt-2 text-sm text-neutral-500">{filteredUsers.length} users visible.</p>
        </div>
        {loading ? (
          <div className="p-12 text-center text-neutral-500">Loading users...</div>
        ) : (
          <div className="divide-y divide-white/5">
            {filteredUsers.map((user) => (
              <div key={user.id} className="grid gap-4 px-6 py-5 xl:grid-cols-[1fr,180px,160px,240px] xl:items-center">
                <div>
                  <p className="text-xl font-bold">{user.full_name || user.email?.split("@")[0] || "Unnamed User"}</p>
                  <p className="mt-1 text-sm text-neutral-400">{user.email || "No email"}</p>
                  <p className="mt-1 text-xs text-neutral-500">{user.business}</p>
                </div>
                <p className="text-sm capitalize text-neutral-400">{user.role || "user"}</p>
                <p className="text-sm text-neutral-500">{formatDate(user.created_at)}</p>
                <div className="flex flex-wrap gap-2 xl:justify-end">
                  <button onClick={() => void updateUser(user, "approve")} className="rounded-xl bg-white px-4 py-2 text-sm font-black text-black">Approve</button>
                  <button onClick={() => void updateUser(user, user.status === "Suspended" ? "activate" : "suspend")} className="rounded-xl border border-white/10 px-4 py-2 text-sm font-bold text-white">
                    {user.status === "Suspended" ? "Activate" : "Suspend"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
