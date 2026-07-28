"use client"

import { useState } from "react"
import { saveDesktopBytes } from "@/lib/desktop-file-export"
import { getLocalDatabaseService } from "@/lib/offline/local/service"

type LocalDatabaseRecoveryProps = {
  checking?: boolean
  errorMessage?: string
  onRetry?: () => void
}

type DiagnosticsPayload = {
  capturedAt: string
  page: string
  userAgent: string
  platform: string
  database: Awaited<ReturnType<ReturnType<typeof getLocalDatabaseService>["diagnostics"]>>
}

async function buildDiagnostics(): Promise<DiagnosticsPayload> {
  const database = await getLocalDatabaseService().diagnostics()
  return {
    capturedAt: new Date().toISOString(),
    page: typeof window === "undefined" ? "" : window.location.pathname,
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    platform: typeof navigator === "undefined" ? "" : navigator.platform,
    database,
  }
}

export default function LocalDatabaseRecovery({ checking = false, errorMessage, onRetry }: LocalDatabaseRecoveryProps) {
  const [status, setStatus] = useState("")

  async function copyDiagnostics() {
    try {
      const diagnostics = await buildDiagnostics()
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2))
      setStatus("Diagnostics copied.")
    } catch {
      setStatus("Diagnostics could not be copied. Download them instead.")
    }
  }

  async function exportDiagnostics() {
    try {
      const diagnostics = await buildDiagnostics()
      const bytes = new TextEncoder().encode(JSON.stringify(diagnostics, null, 2))
      const saved = await saveDesktopBytes(
        `bezgrow-local-db-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
        bytes,
        "json"
      )
      setStatus(saved ? `Diagnostics saved to ${saved.path}.` : "Diagnostic export cancelled.")
    } catch {
      setStatus("Diagnostics could not be exported.")
    }
  }

  async function retry() {
    setStatus("Retrying local database…")
    try {
      await getLocalDatabaseService().retryInitialization()
      setStatus("Local database is ready.")
      if (onRetry) onRetry()
      else window.location.reload()
    } catch {
      setStatus("Local database retry failed. Download diagnostics for the exact native error.")
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-black px-5 py-8 text-white">
      <section className="w-full max-w-2xl rounded-lg border border-amber-300/25 bg-[#0d0f0f] p-6 shadow-2xl sm:p-8">
        <p className="text-xs font-black uppercase tracking-[0.18em] text-amber-200">
          {checking ? "Checking Local Database" : "Local Database Needs Attention"}
        </p>
        <h1 className="mt-4 text-3xl font-black sm:text-4xl">
          {checking ? "Starting Bezgrow local storage." : "Bezgrow cannot open its local database."}
        </h1>
        <p className="mt-4 text-sm leading-6 text-neutral-300 sm:text-base">
          {checking
            ? "Bezgrow is verifying the desktop database before opening your workspace."
            : errorMessage ||
              "Restart the desktop app and try again. Export diagnostics before making more changes if the issue continues."}
        </p>
        {!checking && (
          <>
            <div className="mt-6 rounded-lg border border-white/10 bg-black/40 p-4 text-sm text-neutral-300">
              Your dashboard is locked until the desktop database is available, so new invoices, products, and license changes cannot be saved to the wrong place.
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              <button type="button" onClick={() => void retry()} className="h-12 rounded-lg bg-white px-4 text-sm font-black text-black">
                Retry Database
              </button>
              <button type="button" onClick={() => void exportDiagnostics()} className="h-12 rounded-lg border border-white/15 bg-white/10 px-4 text-sm font-black text-white">
                Download Diagnostics
              </button>
              <button type="button" onClick={() => void copyDiagnostics()} className="h-12 rounded-lg border border-white/15 bg-white/10 px-4 text-sm font-black text-white">
                Copy Diagnostics
              </button>
            </div>
          </>
        )}
        {status && <p className="mt-4 text-sm font-semibold text-cyan-100">{status}</p>}
      </section>
    </main>
  )
}
