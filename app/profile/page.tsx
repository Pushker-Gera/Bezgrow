"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { supabase } from "@/lib/supabase"
import { useRouter } from "next/navigation"
import type { User } from "@supabase/supabase-js"

type OrganizationProfile = {
  id: string
  business_name?: string | null
  business_type?: string | null
  business_category?: string | null
}

export default function ProfilePage() {

  const router = useRouter()

  const [user, setUser] = useState<User | null>(null)
  const [organization, setOrganization] = useState<OrganizationProfile | null>(null)
  const [loading, setLoading] = useState(true)

  const checkUser = useCallback(async () => {
    const { data } = await supabase.auth.getUser()

    if (!data.user) {
      router.push("/login")
      return
    }

    setUser(data.user)

    const { data: membership } = await supabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", data.user.id)
      .single()

    if (membership?.organization_id) {
      const { data: org } = await supabase
        .from("organizations")
        .select("*")
        .eq("id", membership.organization_id)
        .single()

      setOrganization(org)
    }

    setLoading(false)
  }, [router])

  useEffect(() => {
    queueMicrotask(() => {
      void checkUser()
    })
  }, [checkUser])

  async function logout() {
    await supabase.auth.signOut()
    router.push("/login")
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="animate-pulse text-xl font-semibold">
          Loading ERP Profile...
        </div>
      </div>
    )
  }

  return (
    <div className="w-full min-h-screen bg-black text-white relative overflow-x-hidden">

      <div className="fixed inset-0 overflow-hidden pointer-events-none -z-10">

        <div className="absolute top-[-120px] left-[-120px] w-[420px] h-[420px] bg-cyan-500/10 blur-[140px] rounded-full"></div>

        <div className="absolute bottom-[-160px] right-[-120px] w-[460px] h-[460px] bg-blue-500/10 blur-[160px] rounded-full"></div>

        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),transparent_35%)]"></div>

      </div>

      <div className="relative z-10 h-screen w-full flex items-center justify-center px-6 py-6 overflow-hidden">

        <div className="w-full max-w-[1500px] h-full grid grid-cols-12 gap-6">

          <div className="col-span-3 rounded-[36px] border border-white/10 bg-gradient-to-b from-zinc-900 to-black backdrop-blur-2xl p-7 flex flex-col justify-between shadow-[0_0_60px_rgba(0,0,0,0.55)] overflow-hidden relative">

            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.12),transparent_35%)]"></div>

            <div className="relative z-10">

              <div className="flex items-center gap-4 mb-10">

                <div className="w-20 h-20 rounded-[28px] bg-gradient-to-br from-cyan-400 via-blue-500 to-blue-700 flex items-center justify-center text-4xl font-black shadow-[0_0_50px_rgba(34,211,238,0.3)]">
                  {organization?.business_name?.charAt(0) || "B"}
                </div>

                <div>
                  <h2 className="text-2xl font-black leading-tight">
                    {organization?.business_name || "Bezgrow ERP"}
                  </h2>

                  <p className="text-sm text-neutral-400 mt-2">
                    Enterprise Workspace
                  </p>
                </div>

              </div>

              <div className="space-y-4">

                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                  <p className="text-xs uppercase tracking-[0.18em] text-neutral-500 mb-2">
                    Business Owner
                  </p>

                  <p className="text-base font-semibold break-all text-white">
                    {user?.email}
                  </p>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                  <p className="text-xs uppercase tracking-[0.18em] text-neutral-500 mb-2">
                    Organization Type
                  </p>

                  <p className="text-lg font-semibold text-white">
                    {organization?.business_type || "Enterprise Business"}
                  </p>
                </div>

                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                  <p className="text-xs uppercase tracking-[0.18em] text-neutral-500 mb-2">
                    Industry
                  </p>

                  <p className="text-lg font-semibold text-white">
                    {organization?.business_category || "Global Retail"}
                  </p>
                </div>

              </div>

            </div>

            <button
              onClick={logout}
              className="relative z-10 w-full py-4 rounded-2xl bg-gradient-to-r from-red-600 to-red-500 hover:from-red-500 hover:to-red-400 transition-all duration-300 font-bold text-base shadow-[0_0_40px_rgba(239,68,68,0.3)] hover:scale-[1.02]"
            >
              Logout Workspace
            </button>

          </div>

          <div className="col-span-6 rounded-[40px] border border-white/10 bg-gradient-to-br from-zinc-900/95 via-black to-zinc-950 backdrop-blur-2xl p-8 shadow-[0_0_80px_rgba(0,0,0,0.65)] relative overflow-hidden flex flex-col justify-between">

            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.12),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.08),transparent_35%)]"></div>

            <div className="relative z-10">

              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-cyan-500/20 bg-cyan-500/10 text-cyan-300 text-xs tracking-[0.2em] uppercase mb-6">
                Global ERP Infrastructure
              </div>

              <h1 className="text-6xl font-black tracking-tight leading-none bg-gradient-to-r from-white via-cyan-100 to-blue-300 bg-clip-text text-transparent">
                Business Profile
              </h1>

              <p className="text-lg text-neutral-400 leading-8 mt-6 max-w-3xl">
                Centralized enterprise identity management for your global inventory,
                billing, fulfillment and warehouse operations.
              </p>

            </div>

            <div className="relative z-10 grid grid-cols-2 gap-5 mt-10">

              <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 hover:border-cyan-400/30 transition-all duration-300 hover:-translate-y-1">
                <p className="text-xs uppercase tracking-[0.18em] text-neutral-500 mb-3">
                  ERP Status
                </p>

                <h3 className="text-4xl font-black text-green-300">
                  Live
                </h3>
              </div>

              <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 hover:border-cyan-400/30 transition-all duration-300 hover:-translate-y-1">
                <p className="text-xs uppercase tracking-[0.18em] text-neutral-500 mb-3">
                  Cloud Sync
                </p>

                <h3 className="text-4xl font-black text-cyan-300">
                  Active
                </h3>
              </div>

              <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 hover:border-cyan-400/30 transition-all duration-300 hover:-translate-y-1">
                <p className="text-xs uppercase tracking-[0.18em] text-neutral-500 mb-3">
                  Workspace ID
                </p>

                <h3 className="text-sm font-semibold break-all text-white leading-7">
                  {organization?.id || user?.id}
                </h3>
              </div>

              <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-cyan-500/10 to-blue-500/10 p-6 hover:border-cyan-400/30 transition-all duration-300 hover:-translate-y-1">
                <p className="text-xs uppercase tracking-[0.18em] text-neutral-400 mb-3">
                  Infrastructure
                </p>

                <h3 className="text-4xl font-black text-white">
                  Global
                </h3>
              </div>

            </div>

          </div>

          <div className="col-span-3 flex flex-col gap-6">

            <div className="flex-1 rounded-[36px] border border-white/10 bg-gradient-to-b from-zinc-900 to-black backdrop-blur-2xl p-7 shadow-[0_0_60px_rgba(0,0,0,0.45)]">

              <div className="flex items-center justify-between mb-8">

                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-neutral-500 mb-2">
                    Operations
                  </p>

                  <h3 className="text-3xl font-black">
                    Quick Actions
                  </h3>
                </div>

                <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-300 text-xl">
                  ⚡
                </div>

              </div>

              <div className="space-y-4">

                <Link
                  href="/dashboard/products"
                  className="group flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-5 hover:bg-cyan-500/[0.05] hover:border-cyan-500/30 transition-all duration-300 hover:-translate-y-1"
                >
                  <div>
                    <p className="font-semibold text-white text-lg">
                      Products
                    </p>

                    <p className="text-sm text-neutral-500 mt-1">
                      Manage inventory catalog
                    </p>
                  </div>

                  <span className="text-cyan-300 text-xl group-hover:translate-x-1 transition-all">
                    →
                  </span>
                </Link>

                <Link
                  href="/dashboard/orders"
                  className="group flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-5 hover:bg-cyan-500/[0.05] hover:border-cyan-500/30 transition-all duration-300 hover:-translate-y-1"
                >
                  <div>
                    <p className="font-semibold text-white text-lg">
                      Orders
                    </p>

                    <p className="text-sm text-neutral-500 mt-1">
                      Enterprise fulfillment flow
                    </p>
                  </div>

                  <span className="text-cyan-300 text-xl group-hover:translate-x-1 transition-all">
                    →
                  </span>
                </Link>

                <Link
                  href="/dashboard/invoices"
                  className="group flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-5 hover:bg-cyan-500/[0.05] hover:border-cyan-500/30 transition-all duration-300 hover:-translate-y-1"
                >
                  <div>
                    <p className="font-semibold text-white text-lg">
                      Invoices
                    </p>

                    <p className="text-sm text-neutral-500 mt-1">
                      Billing and taxation engine
                    </p>
                  </div>

                  <span className="text-cyan-300 text-xl group-hover:translate-x-1 transition-all">
                    →
                  </span>
                </Link>

                <Link
                  href="/dashboard"
                  className="group flex items-center justify-between rounded-2xl border border-cyan-500/20 bg-cyan-500/10 px-5 py-5 hover:bg-cyan-500/20 transition-all duration-300 hover:-translate-y-1"
                >
                  <div>
                    <p className="font-semibold text-cyan-100 text-lg">
                      Main Dashboard
                    </p>

                    <p className="text-sm text-cyan-300/70 mt-1">
                      Return to ERP operations
                    </p>
                  </div>

                  <span className="text-cyan-200 text-xl group-hover:translate-x-1 transition-all">
                    ↗
                  </span>
                </Link>

              </div>

            </div>

          </div>

        </div>

      </div>
    </div>
  )
}
