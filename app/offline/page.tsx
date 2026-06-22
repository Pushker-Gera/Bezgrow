import Link from "next/link"

export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-black px-5 text-white">
      <section className="w-full max-w-xl rounded-[32px] border border-cyan-400/20 bg-cyan-500/10 p-8 text-center shadow-2xl">
        <p className="text-xs font-black uppercase tracking-[0.24em] text-cyan-200">Offline Mode</p>
        <h1 className="mt-4 text-4xl font-black">Bezgrow is available offline.</h1>
        <p className="mt-4 text-neutral-300">
          You can open cached workspace pages and continue supported offline work. Internet is required for new login, approval refresh, and server sync.
        </p>
        <div className="mt-7 grid gap-3 sm:grid-cols-2">
          <Link href="/dashboard" className="rounded-2xl bg-white px-5 py-3 font-black text-black">
            Open Dashboard
          </Link>
          <Link href="/dashboard/invoices/create" className="rounded-2xl border border-white/15 bg-white/10 px-5 py-3 font-black">
            Create Offline Invoice
          </Link>
        </div>
      </section>
    </main>
  )
}
