"use client"

import Link from "next/link"
import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { BezgrowLogoMark } from "@/components/brand/BezgrowLogoMark"
import PlatformAdminLauncher from "@/components/desktop/PlatformAdminLauncher"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { resolveStartupRedirect } from "@/lib/auth/startup-redirect"

/** Account creation belongs to the resumable business-onboarding transaction. */
export default function SignupPage() {
  const router = useRouter()

  useEffect(() => {
    let active = true
    void (async () => {
      const desktop = await isTauriRuntimeAsync().catch(() => false)
      if (!active) return
      if (!desktop) {
        router.replace("/download?erp=desktop_local_only")
        return
      }
      const existing = await resolveStartupRedirect("/dashboard").catch(() => null)
      if (!active) return
      router.replace(existing || "/create-business")
    })()
    return () => { active = false }
  }, [router])

  return <main className="flex min-h-dvh items-center justify-center bg-[#020505] px-5 text-white"><section className="w-full max-w-md rounded-[30px] border border-white/10 bg-white/[0.04] p-8 text-center"><BezgrowLogoMark className="mx-auto h-14 w-14" size={56} priority /><h1 className="mt-5 text-3xl font-black">Opening business setup</h1><p className="mt-3 text-sm leading-6 text-neutral-400">Your Bezgrow account, local business, and 30-day trial are created together so an interrupted setup can resume safely.</p><Link href="/create-business" className="mt-7 flex min-h-12 items-center justify-center rounded-2xl bg-cyan-300 px-5 font-black text-black">Continue</Link><PlatformAdminLauncher className="mt-3" /></section></main>
}
