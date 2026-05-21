"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase"

export default function PendingApprovalPage() {
  const router = useRouter()
  const [approved, setApproved] = useState(false)

  useEffect(() => {
    async function checkApproval() {
      const { data: userData } = await supabase.auth.getUser()
      const user = userData.user

      if (!user) {
        router.replace("/login")
        return
      }

      const { data, error } = await supabase
        .from("pending_users")
        .select("*")
        .eq("email", user.email)
        .maybeSingle()

      if (error) {
        console.error(error)
        return
      }

      if (!data || data.status === "approved") {
        setApproved(true)
        setTimeout(() => {
          router.push("/create-business")
        }, 1400)
      }
    }

    const interval = setInterval(() => {
      void checkApproval()
    }, 3000)

    void checkApproval()

    return () => clearInterval(interval)
  }, [router])

  if (approved) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black px-5 text-white">
        <div className="max-w-xl rounded-[28px] border border-emerald-300/20 bg-emerald-300/10 p-10 text-center">
          <h1 className="text-4xl font-black text-emerald-200">Access Approved</h1>
          <p className="mt-4 text-lg text-white/65">Redirecting to create your business workspace...</p>
        </div>
      </div>
    )
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.16),transparent_34%),#020403] px-5 text-white">
      <section className="w-full max-w-3xl rounded-[30px] border border-white/10 bg-white/[0.04] p-7 text-center shadow-2xl md:p-10">
        <p className="text-xs font-black uppercase tracking-[0.28em] text-cyan-200">Approval Review</p>
        <h1 className="mt-4 text-4xl font-black md:text-5xl">Approval Pending</h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg leading-8 text-white/60">
          Your business request is in review. You will be redirected automatically after an admin approves your access.
        </p>

        <div className="mt-8 rounded-3xl border border-cyan-300/20 bg-cyan-300/10 p-6">
          <p className="text-sm font-bold text-cyan-100">Status checks run automatically every few seconds.</p>
          <p className="mt-2 text-sm text-white/50">Keep this page open or log in again later after admin approval.</p>
        </div>
      </section>
    </main>
  )
}
