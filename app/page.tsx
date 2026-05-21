"use client"

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

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#020403] text-white">
      <section className="relative flex min-h-screen flex-col overflow-hidden">
        <div className="inventory-grid-bg absolute inset-0 opacity-55" />
        <div className="landing-aurora absolute left-1/2 top-24 h-[420px] w-[820px] -translate-x-1/2 rounded-full bg-cyan-300/10 blur-[90px]" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-200/70 to-transparent" />

        <nav className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-5 lg:px-8">
          <button onClick={() => router.push("/")} className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-200 to-blue-400 text-lg font-black text-black shadow-[0_0_34px_rgba(34,211,238,0.3)]">B</span>
            <span className="text-left">
              <span className="block text-lg font-black">Bezgrow</span>
              <span className="block text-xs uppercase tracking-[0.18em] text-white/45">Business Cloud</span>
            </span>
          </button>
          <div className="hidden rounded-full border border-white/10 bg-white/[0.035] px-4 py-2 text-sm font-bold text-white/50 md:flex md:gap-5">
            <span>Product</span>
            <span>Inventory</span>
            <span>Billing</span>
            <span>Admin</span>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => router.push("/login")} className="h-11 rounded-2xl border border-white/10 bg-white/[0.035] px-5 text-sm font-bold text-white/75 hover:border-cyan-300/40">
              Login
            </button>
            <button onClick={() => router.push("/signup")} className="h-11 rounded-2xl bg-white px-5 text-sm font-black text-black hover:bg-cyan-100">
              Start
            </button>
          </div>
        </nav>

        <div className="relative z-10 mx-auto flex w-full max-w-7xl flex-1 flex-col items-center justify-center px-5 pb-12 pt-8 text-center lg:px-8">
          <div className="landing-fade-up flex max-w-5xl flex-col items-center">
            <p className="inline-flex rounded-full border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-xs font-black uppercase tracking-[0.22em] text-cyan-100">
              Built for modern retail, wholesale, and service businesses
            </p>
            <h1 className="mt-6 max-w-5xl text-center text-5xl font-black leading-[0.95] tracking-tight sm:text-6xl lg:text-7xl">
              Run your entire business from one beautiful workspace.
            </h1>
            <p className="mx-auto mt-6 max-w-3xl text-center text-base leading-8 text-white/62 sm:text-lg">
              Inventory, billing, customers, orders, analytics, and admin control designed for fast teams that want professional software from day one.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <button onClick={() => router.push("/signup")} className="h-14 rounded-2xl bg-cyan-300 px-8 font-black text-black shadow-[0_0_44px_rgba(34,211,238,0.25)] transition hover:-translate-y-0.5 hover:bg-cyan-200">
                Create Workspace
              </button>
              <button onClick={() => router.push("/login")} className="h-14 rounded-2xl border border-white/12 bg-white/[0.04] px-8 font-bold text-white/85 transition hover:-translate-y-0.5 hover:border-white/30">
                Login
              </button>
            </div>
          </div>

          <div className="landing-fade-up mt-10 grid w-full max-w-5xl gap-4 md:grid-cols-4">
            {capabilityGroups.map(([title, copy], index) => (
              <article
                key={title}
                className="landing-feature-card rounded-[24px] border border-white/10 bg-white/[0.045] p-5 text-left shadow-[0_20px_70px_rgba(0,0,0,0.35)] backdrop-blur-xl"
                style={{ animationDelay: `${index * 90}ms` }}
              >
                <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-300/12 text-sm font-black text-cyan-100">
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
