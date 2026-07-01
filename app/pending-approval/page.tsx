"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { supabase } from "@/lib/supabase"

export default function PendingApprovalPage() {
  const router = useRouter()
  const [approved, setApproved] = useState(false)
  const redirectingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    let redirectTimer: ReturnType<typeof setTimeout> | undefined

    async function checkApproval() {
      if (redirectingRef.current) return

      const { data: userData } = await supabase.auth.getUser()
      const user = userData.user

      if (!user) {
        const hasPendingSubmission = window.sessionStorage.getItem("bezgrow_pending_signup") === "1"
        if (!hasPendingSubmission) {
          router.replace("/login")
        }
        return
      }

      const {
        data: { session },
      } = await supabase.auth.getSession()

      const bootstrapPath = "/api/workspace/bootstrap"
      const desktopRuntime = await isTauriRuntimeAsync()
      const response = await fetch(desktopRuntime ? `/api/desktop-proxy?path=${encodeURIComponent(bootstrapPath)}` : bootstrapPath, {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
        cache: "no-store",
      })

      if (response.status === 401) {
        router.replace("/login")
        return
      }

      const payload = (await response.json().catch(() => null)) as {
        success?: boolean
        profile?: {
          approved?: boolean
          business_created?: boolean
          is_suspended?: boolean
        }
        organization?: { id?: string | null } | null
      } | null

      if (!payload?.success) return

      if (payload.profile?.is_suspended) {
        router.replace("/login?error=account_suspended")
        return
      }

      if (payload.profile?.approved) {
        redirectingRef.current = true
        window.sessionStorage.removeItem("bezgrow_pending_signup")
        setApproved(true)

        redirectTimer = setTimeout(() => {
          if (cancelled) return
          const hasBusiness = Boolean(payload.profile?.business_created || payload.organization?.id)
          router.replace(hasBusiness ? "/dashboard" : "/create-business")
        }, 1400)
      }
    }

    const interval = setInterval(() => {
      void checkApproval()
    }, 3000)

    void checkApproval()

    return () => {
      cancelled = true
      clearInterval(interval)
      if (redirectTimer) clearTimeout(redirectTimer)
    }
  }, [router])

  if (approved) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-black px-3 text-white sm:px-5">
        <div className="max-w-xl rounded-[22px] border border-emerald-300/20 bg-emerald-300/10 p-5 text-center sm:rounded-[28px] sm:p-10">
          <h1 className="text-3xl font-black text-emerald-200 sm:text-4xl">Access Approved</h1>
          <p className="mt-4 text-base leading-7 text-white/65 sm:text-lg">Redirecting to create your business workspace...</p>
        </div>
      </div>
    )
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.16),transparent_34%),#020403] px-3 py-5 text-white sm:px-5">
      <section className="w-full max-w-3xl rounded-[22px] border border-white/10 bg-white/[0.04] p-5 text-center shadow-2xl sm:rounded-[30px] sm:p-7 md:p-10">
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-200 sm:text-xs sm:tracking-[0.28em]">Approval Review</p>
        <h1 className="mt-4 text-3xl font-black sm:text-4xl md:text-5xl">Approval Pending</h1>
        <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-white/60 sm:text-lg sm:leading-8">
          Your business request is in review. You will be redirected automatically after an admin approves your access.
        </p>

        <div className="mt-6 rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-4 sm:mt-8 sm:rounded-3xl sm:p-6">
          <p className="text-sm font-bold text-cyan-100">Status checks run automatically every few seconds.</p>
          <p className="mt-2 text-sm text-white/50">Keep this page open or log in again later after admin approval.</p>
        </div>
      </section>
    </main>
  )
}
