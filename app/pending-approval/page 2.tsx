"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

export default function PendingApprovalPage() {
  const router = useRouter()

  useEffect(() => {
    router.replace("/offline?reason=license_required&next=/dashboard")
  }, [router])

  return (
    <main className="flex min-h-dvh items-center justify-center bg-black px-3 text-white sm:px-5">
      <section className="w-full max-w-xl rounded-[22px] border border-cyan-300/20 bg-cyan-300/10 p-5 text-center sm:rounded-[28px] sm:p-8">
        <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-200">License Activation</p>
        <h1 className="mt-4 text-3xl font-black">Opening license activation.</h1>
        <p className="mt-3 text-sm leading-6 text-white/60">Please activate Bezgrow using your license key.</p>
      </section>
    </main>
  )
}
