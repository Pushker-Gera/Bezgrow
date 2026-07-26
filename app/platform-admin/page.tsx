"use client"

import Link from "next/link"
import PlatformAdminLauncher from "@/components/desktop/PlatformAdminLauncher"

export default function PlatformAdminDesktopEntryPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-black px-5 py-10 text-white">
      <section className="w-full max-w-xl rounded-[32px] border border-cyan-400/20 bg-cyan-500/[0.08] p-8 text-center shadow-2xl">
        <p className="text-xs font-black uppercase tracking-[0.22em] text-cyan-200">Online-only control plane</p>
        <h1 className="mt-4 text-3xl font-black">Platform Administration</h1>
        <p className="mt-4 text-sm leading-6 text-neutral-300">
          Open the secure hosted admin application. A valid Supabase session and an admin or platform_admin server-side role are required.
        </p>
        <PlatformAdminLauncher className="mt-7" />
        <Link href="/dashboard" className="mt-3 flex h-11 items-center justify-center rounded-2xl border border-white/10 text-sm font-black text-neutral-300">
          Return to local ERP
        </Link>
      </section>
    </main>
  )
}
