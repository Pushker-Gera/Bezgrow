"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

const capabilityGroups = [
  ["Inventory", "Stock, batches, suppliers, warehouses"],
  ["Billing", "GST, no-GST, A4, thermal, collections"],
  ["Retail POS", "Barcode scan, quick sale, customer message"],
  ["Admin", "Approvals, businesses, analytics, launch controls"],
]

const signals = ["Realtime stock", "Smart invoices", "Approval workflow", "Mobile ready", "Global operations", "Thermal POS"]

export default function Home() {
  const router = useRouter()

  useEffect(() => {
    if (window.location.hash.includes("access_token=")) {
      window.location.replace(`/auth/callback?${window.location.hash.slice(1)}`)
    }
  }, [])

  return (
    <main className="min-h-dvh overflow-x-hidden bg-[#020403] text-white">
      <section className="relative flex min-h-dvh flex-col overflow-hidden">
        <div className="inventory-grid-bg absolute inset-0 opacity-55" />
        <div className="landing-aurora absolute left-1/2 top-24 h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-cyan-300/10 blur-[90px]" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-200/70 to-transparent" />

        <nav className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between gap-3 px-3 py-4 sm:px-5 sm:py-5 lg:px-8">
          <button onClick={() => router.push("/")} className="flex min-w-0 items-center gap-2 sm:gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-200 to-blue-400 text-lg font-black text-black shadow-[0_0_34px_rgba(34,211,238,0.3)] sm:h-11 sm:w-11">B</span>
            <span className="text-left">
              <span className="block text-base font-black sm:text-lg">Bezgrow</span>
              <span className="hidden text-xs uppercase tracking-[0.18em] text-white/45 sm:block">Business Cloud</span>
            </span>
          </button>
          <div className="hidden rounded-full border border-white/10 bg-white/[0.035] px-4 py-2 text-sm font-bold text-white/50 md:flex md:gap-5">
            <span>Product</span>
            <span>Inventory</span>
            <span>Billing</span>
            <span>Admin</span>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <button onClick={() => router.push("/login")} className="h-10 rounded-2xl border border-white/10 bg-white/[0.035] px-3 text-sm font-bold text-white/75 hover:border-cyan-300/40 sm:h-11 sm:px-5">
              Login
            </button>
            <button onClick={() => router.push("/signup")} className="h-10 rounded-2xl bg-white px-3 text-sm font-black text-black hover:bg-cyan-100 sm:h-11 sm:px-5">
              Start
            </button>
          </div>
        </nav>

        <div className="relative z-10 mx-auto flex w-full max-w-7xl flex-1 flex-col items-center justify-center px-3 pb-10 pt-6 text-center sm:px-5 sm:pb-12 sm:pt-8 lg:px-8">
          <div className="landing-fade-up flex max-w-5xl flex-col items-center">
            <p className="inline-flex max-w-full rounded-full border border-cyan-300/30 bg-cyan-300/10 px-3 py-2 text-center text-[10px] font-black uppercase tracking-[0.16em] text-cyan-100 sm:px-4 sm:text-xs sm:tracking-[0.22em]">
              Built for modern retail, wholesale, and service businesses
            </p>
            <h1 className="mt-5 max-w-5xl text-center text-4xl font-black leading-[0.98] tracking-tight sm:mt-6 sm:text-6xl lg:text-7xl">
              Run your entire business from one beautiful workspace.
            </h1>
            <p className="mx-auto mt-5 max-w-3xl text-center text-sm leading-7 text-white/62 sm:mt-6 sm:text-lg sm:leading-8">
              Inventory, billing, customers, orders, analytics, and admin control designed for fast teams that want professional software from day one.
            </p>
            <div className="mt-7 flex w-full flex-col gap-3 sm:mt-8 sm:w-auto sm:flex-row">
              <button onClick={() => router.push("/signup")} className="h-12 w-full rounded-2xl bg-cyan-300 px-6 font-black text-black shadow-[0_0_44px_rgba(34,211,238,0.25)] transition hover:-translate-y-0.5 hover:bg-cyan-200 sm:h-14 sm:w-auto sm:px-8">
                Create Workspace
              </button>
              <button onClick={() => router.push("/login")} className="h-12 w-full rounded-2xl border border-white/12 bg-white/[0.04] px-6 font-bold text-white/85 transition hover:-translate-y-0.5 hover:border-white/30 sm:h-14 sm:w-auto sm:px-8">
                Login
              </button>
            </div>
          </div>

          <div className="landing-fade-up mt-8 grid w-full max-w-5xl gap-3 sm:mt-10 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
            {capabilityGroups.map(([title, copy], index) => (
              <article
                key={title}
                className="landing-feature-card rounded-[20px] border border-white/10 bg-white/[0.045] p-4 text-left shadow-[0_20px_70px_rgba(0,0,0,0.35)] backdrop-blur-xl sm:rounded-[24px] sm:p-5"
                style={{ animationDelay: `${index * 90}ms` }}
              >
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-2xl bg-cyan-300/12 text-sm font-black text-cyan-100 sm:mb-5 sm:h-11 sm:w-11">
                  0{index + 1}
                </div>
                <h2 className="text-xl font-black">{title}</h2>
                <p className="mt-3 text-sm leading-6 text-white/52">{copy}</p>
              </article>
            ))}
          </div>
        </div>

        <div className="relative z-10 border-y border-white/10 bg-black/45 py-3">
          <div className="landing-marquee flex gap-3 whitespace-nowrap text-sm font-bold text-white/55">
            {[...signals, ...signals, ...signals].map((signal, index) => (
              <span key={`${signal}-${index}`} className="rounded-full border border-white/10 bg-white/[0.035] px-4 py-2">
                {signal}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="px-5 py-14 lg:px-8">
        <div className="mx-auto grid max-w-6xl gap-4 md:grid-cols-3">
          {[
            ["Sell faster", "Barcode scan, quick invoice, thermal bill, and customer SMS bill handoff."],
            ["Control stock", "Batch, supplier, warehouse, low-stock, expiry, and stock audit trails."],
            ["Scale cleanly", "Admin approvals, business monitoring, and launch controls."],
          ].map(([title, copy]) => (
            <article key={title} className="rounded-[24px] border border-white/10 bg-white/[0.035] p-6 text-center transition hover:-translate-y-1 hover:border-cyan-300/25">
              <h3 className="text-2xl font-black">{title}</h3>
              <p className="mt-3 leading-7 text-white/52">{copy}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  )
}
