"use client"

import { useEffect } from "react"

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[dashboard] recoverable page error", {
      message: error.message,
      digest: error.digest || null,
    })
  }, [error])

  return (
    <main className="flex min-h-full items-center justify-center bg-black px-5 py-10 text-white">
      <section className="w-full max-w-xl rounded-3xl border border-red-400/25 bg-red-500/[0.06] p-7 text-center">
        <p className="text-xs font-black uppercase tracking-[0.2em] text-red-200">Page recovery</p>
        <h1 className="mt-4 text-3xl font-black">This page could not be displayed.</h1>
        <p className="mt-4 text-sm leading-6 text-neutral-300">
          Your SQLite business data was not erased. Retry the page; if the problem continues, open Settings → Desktop Diagnostics and export the startup log.
        </p>
        <button type="button" onClick={reset} className="mt-6 min-h-12 rounded-2xl bg-white px-6 text-sm font-black text-black">
          Retry page
        </button>
      </section>
    </main>
  )
}
