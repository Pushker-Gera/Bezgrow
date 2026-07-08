"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useDebounce } from "use-debounce"
import { supabase } from "@/lib/supabase"

type ProfileRow = {
  id: string
  email: string | null
  full_name?: string | null
  role: string | null
  approved: boolean | null
  business_created: boolean | null
  is_suspended?: boolean | null
  organization_id: string | null
  created_at?: string | null
}

type OrganizationRow = {
  id: string
  name: string | null
}

type MembershipRow = {
  user_id: string
  organization_id: string
  role: string | null
}

type UserView = ProfileRow & {
  business: string
  status: "Active" | "Pending" | "Suspended"
}

type AdminMetricsResponse = {
  success: boolean
  error?: string
  profiles?: ProfileRow[]
  organizations?: OrganizationRow[]
  stats?: {
    total: number
    approved: number
    pending: number
    suspended: number
  }
}

function calculateStats(profileRows: ProfileRow[]) {
  return {
    total: profileRows.length,
    approved: profileRows.filter((profile) => profile.approved === true && !profile.is_suspended).length,
    pending: profileRows.filter((profile) => profile.approved !== true && !profile.is_suspended).length,
    suspended: profileRows.filter((profile) => profile.is_suspended).length,
  }
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-"
  return new Date(value).toLocaleDateString()
}

export default function AdminUsersPage() {
  const [profiles, setProfiles] = useState<ProfileRow[]>([])
  const [organizations, setOrganizations] = useState<OrganizationRow[]>([])
  const [serverStats, setServerStats] = useState({
    total: 0,
    approved: 0,
    pending: 0,
    suspended: 0,
  })
  const [search, setSearch] = useState("")
  const [debouncedSearch] = useDebounce(search, 300)
  const [statusFilter, setStatusFilter] = useState("all")
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [notice, setNotice] = useState("")

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    setNotice("")

    const {
      data: { session },
    } = await supabase.auth.getSession()

    let nextProfiles: ProfileRow[] = []
    let nextOrganizations: OrganizationRow[] = []
    let nextStats = calculateStats([])
    let apiError = ""

    try {
      const response = await fetch("/api/admin/users?limit=100", {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
        cache: "no-store",
      })
      const payload = (await response.json()) as AdminMetricsResponse

      if (payload.success) {
        nextProfiles = payload.profiles || []
        nextOrganizations = payload.organizations || []
        nextStats = payload.stats || calculateStats(nextProfiles)
      } else {
        apiError = payload.error || "Admin users failed to load."
      }
    } catch {
      apiError = "Admin users failed to load."
    }

    if (nextStats.total === 0) {
      const { data: profileRows, error: profileError } = await supabase
        .from("profiles")
        .select("id,email,full_name,role,approved,business_created,is_suspended,created_at")
        .order("created_at", { ascending: false })

      if (!profileError && profileRows?.length) {
        const ids = profileRows.map((profile) => profile.id)
        const memberMap = new Map<string, MembershipRow>()

        const { data: memberships } = await supabase
          .from("organization_members")
          .select("user_id,organization_id,role")
          .in("user_id", ids)

        ;((memberships || []) as MembershipRow[]).forEach((membership) => {
          if (!memberMap.has(membership.user_id) || membership.role === "owner") {
            memberMap.set(membership.user_id, membership)
          }
        })

        const organizationIds = Array.from(new Set(Array.from(memberMap.values()).map((membership) => membership.organization_id)))
        const { data: organizationRows } = organizationIds.length
          ? await supabase.from("organizations").select("id,name").in("id", organizationIds)
          : { data: [] }

        nextProfiles = (profileRows as ProfileRow[]).map((profile) => ({
          ...profile,
          organization_id: memberMap.get(profile.id)?.organization_id ?? null,
        }))
        nextOrganizations = (organizationRows || []) as OrganizationRow[]
        nextStats = calculateStats(nextProfiles)
        apiError = ""
      } else if (apiError || profileError) {
        setNotice(apiError || profileError?.message || "Admin users failed to load.")
      }
    }

    setProfiles(nextProfiles)
    setOrganizations(nextOrganizations)
    setServerStats(nextStats)
    setLoading(false)
  }, [])

  useEffect(() => {
    queueMicrotask(() => {
      void fetchUsers()
    })
  }, [fetchUsers])

  const orgMap = useMemo(() => new Map(organizations.map((org) => [org.id, org.name || "No Organization"])), [organizations])

  const users = useMemo<UserView[]>(() => {
    return profiles.map((profile) => {
      const status = profile.is_suspended ? "Suspended" : profile.approved ? "Active" : "Pending"

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
    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (action === "suspend" && !window.confirm(`Suspend ${user.email || "this user"}?`)) {
      return
    }

    setActionLoading(`${action}:${user.id}`)
    const response = await fetch(`/api/admin/users/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({ userId: user.id }),
    })
    const payload = (await response.json()) as { success: boolean; error?: string; message?: string }
    setActionLoading(null)

    if (!payload.success) {
      setNotice(payload.error || "Unable to update user.")
      return
    }

    setNotice(payload.message || `${user.email || "User"} updated successfully.`)
    await fetchUsers()
  }

  const stats = serverStats

  return (
    <div className="space-y-8 text-white">
      <section className="inventory-sheen rounded-[40px] border border-white/10 bg-white/[0.035] p-8 shadow-[0_0_90px_rgba(0,0,0,0.5)]">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="mb-4 text-xs font-bold uppercase tracking-[0.24em] text-cyan-200">User Governance</p>
            <h1 className="max-w-5xl text-4xl font-black leading-tight md:text-6xl">Users, roles, and access control.</h1>
            <p className="mt-5 max-w-3xl text-neutral-400">Operate a scalable SaaS user layer with real profiles, organization mapping, status control, and license-based desktop access.</p>
          </div>
          <button onClick={() => void fetchUsers()} className="h-14 rounded-2xl bg-white px-7 font-black text-black">Refresh Users</button>
        </div>
      </section>

      {notice && <div className="rounded-3xl border border-cyan-400/25 bg-cyan-500/10 px-6 py-4 text-sm text-cyan-100">{notice}</div>}

      <section className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-4">
        {[
          ["Total Users", stats.total, "text-white"],
          ["Active", stats.approved, "text-emerald-200"],
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
            <option value="active">Active</option>
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
                  <button
                    disabled={actionLoading === `approve:${user.id}`}
                    onClick={() => void updateUser(user, "approve")}
                    className="rounded-xl bg-white px-4 py-2 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {actionLoading === `approve:${user.id}` ? "Activating..." : "Mark Active"}
                  </button>
                  <button
                    disabled={actionLoading === `${user.status === "Suspended" ? "activate" : "suspend"}:${user.id}`}
                    onClick={() => void updateUser(user, user.status === "Suspended" ? "activate" : "suspend")}
                    className="rounded-xl border border-white/10 px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {actionLoading === `activate:${user.id}` || actionLoading === `suspend:${user.id}`
                      ? "Working..."
                      : user.status === "Suspended"
                        ? "Activate"
                        : "Suspend"}
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
