"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { BezgrowLogoMark } from "@/components/brand/BezgrowLogoMark"
import { clearDesktopSession } from "@/lib/desktop/session"
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
      .limit(1)
      .maybeSingle()

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
    await clearDesktopSession()
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
    <div className="responsive-shell relative min-h-dvh w-full overflow-x-hidden bg-black text-white">

      <div className="fixed inset-0 overflow-hidden pointer-events-none -z-10">

        <div className="absolute top-[-120px] left-[-120px] w-[420px] h-[420px] bg-cyan-500/10 blur-[140px] rounded-full"></div>

        <div className="absolute bottom-[-160px] right-[-120px] w-[460px] h-[460px] bg-blue-500/10 blur-[160px] rounded-full"></div>

        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),transparent_35%)]"></div>

      </div>

      <div className="relative z-10 min-h-dvh w-full px-3 py-4 sm:px-6 sm:py-5 lg:flex lg:items-center lg:justify-center lg:overflow-hidden">

        <div className="grid w-full max-w-[1500px] grid-cols-1 gap-4 sm:gap-5 lg:min-h-[calc(100dvh-48px)] lg:grid-cols-12 lg:gap-6">

          <div className="relative flex flex-col justify-between overflow-hidden rounded-[22px] border border-white/10 bg-gradient-to-b from-zinc-900 to-black p-4 shadow-[0_0_60px_rgba(0,0,0,0.55)] backdrop-blur-2xl sm:rounded-[28px] sm:p-7 lg:col-span-3">

            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.12),transparent_35%)]"></div>

            <div className="relative z-10">

              <div className="mb-6 flex min-w-0 items-center gap-3 sm:gap-4 lg:mb-10">

                {organization?.business_name ? (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[20px] bg-gradient-to-br from-cyan-400 via-blue-500 to-blue-700 text-2xl font-black shadow-[0_0_50px_rgba(34,211,238,0.3)] sm:h-20 sm:w-20 sm:rounded-[28px] sm:text-4xl">
                    {organization.business_name.charAt(0)}
                  </div>
                ) : (
                  <BezgrowLogoMark className="h-14 w-14 rounded-[20px] sm:h-20 sm:w-20 sm:rounded-[28px]" size={80} />
                )}

                <div className="min-w-0">
                  <h2 className="truncate text-xl font-black leading-tight sm:text-2xl">
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
              className="relative z-10 mt-6 w-full rounded-2xl bg-gradient-to-r from-red-600 to-red-500 py-4 text-base font-bold shadow-[0_0_40px_rgba(239,68,68,0.3)] transition-all duration-300 hover:scale-[1.02] hover:from-red-500 hover:to-red-400 lg:mt-0"
            >
              Logout Workspace
            </button>

          </div>

          <div className="relative flex flex-col justify-between overflow-hidden rounded-[24px] border border-white/10 bg-gradient-to-br from-zinc-900/95 via-black to-zinc-950 p-4 shadow-[0_0_80px_rgba(0,0,0,0.65)] backdrop-blur-2xl sm:rounded-[30px] sm:p-8 lg:col-span-6">

            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.12),transparent_30%),radial-gradient(circle_at_bottom_right,rgba(59,130,246,0.08),transparent_35%)]"></div>

            <div className="relative z-10">

              <div className="mb-5 inline-flex max-w-full items-center gap-2 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-4 py-2 text-[10px] uppercase tracking-[0.16em] text-cyan-300 sm:mb-6 sm:text-xs sm:tracking-[0.2em]">
                Global ERP Infrastructure
              </div>

              <h1 className="bg-gradient-to-r from-white via-cyan-100 to-blue-300 bg-clip-text text-3xl font-black leading-tight tracking-tight text-transparent sm:text-5xl xl:text-6xl xl:leading-none">
                Business Profile
              </h1>

              <p className="mt-4 max-w-3xl text-sm leading-6 text-neutral-400 sm:mt-6 sm:text-lg sm:leading-8">
                Centralized enterprise identity management for your global inventory,
                billing, fulfillment and warehouse operations.
              </p>

            </div>

            <div className="relative z-10 mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:mt-10">

              <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 hover:border-cyan-400/30 transition-all duration-300 hover:-translate-y-1">
                <p className="text-xs uppercase tracking-[0.18em] text-neutral-500 mb-3">
                  ERP Status
                </p>

                <h3 className="text-3xl font-black text-green-300 sm:text-4xl">
                  Live
                </h3>
              </div>

              <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 hover:border-cyan-400/30 transition-all duration-300 hover:-translate-y-1">
                <p className="text-xs uppercase tracking-[0.18em] text-neutral-500 mb-3">
                  Cloud Sync
                </p>

                <h3 className="text-3xl font-black text-cyan-300 sm:text-4xl">
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

                <h3 className="text-3xl font-black text-white sm:text-4xl">
                  Global
                </h3>
              </div>

            </div>

          </div>

          <div className="flex flex-col gap-5 lg:col-span-3 lg:gap-6">

            <div className="flex-1 rounded-[28px] border border-white/10 bg-gradient-to-b from-zinc-900 to-black p-5 shadow-[0_0_60px_rgba(0,0,0,0.45)] backdrop-blur-2xl sm:p-7">

              <div className="mb-6 flex items-center justify-between gap-4 sm:mb-8">

                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-[0.18em] text-neutral-500 mb-2">
                    Operations
                  </p>

                  <h3 className="text-2xl font-black sm:text-3xl">
                    Quick Actions
                  </h3>
                </div>

                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-cyan-500/20 bg-cyan-500/10 text-xl text-cyan-300">
                  ⚡
                </div>

              </div>

              <div className="space-y-4">

                <Link
                  href="/dashboard/products"
                  className="group flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 transition-all duration-300 hover:-translate-y-1 hover:border-cyan-500/30 hover:bg-cyan-500/[0.05] sm:px-5 sm:py-5"
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
                  className="group flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 transition-all duration-300 hover:-translate-y-1 hover:border-cyan-500/30 hover:bg-cyan-500/[0.05] sm:px-5 sm:py-5"
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
                  className="group flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 transition-all duration-300 hover:-translate-y-1 hover:border-cyan-500/30 hover:bg-cyan-500/[0.05] sm:px-5 sm:py-5"
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
                  className="group flex items-center justify-between gap-4 rounded-2xl border border-cyan-500/20 bg-cyan-500/10 px-4 py-4 transition-all duration-300 hover:-translate-y-1 hover:bg-cyan-500/20 sm:px-5 sm:py-5"
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
