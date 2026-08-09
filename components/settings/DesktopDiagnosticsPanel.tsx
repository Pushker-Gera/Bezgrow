"use client"

import { useState } from "react"
import packageJson from "@/package.json"
import { saveDesktopBytes } from "@/lib/desktop-file-export"
import { desktopArchitecture } from "@/lib/desktop/tauri"
import { localLicenseSnapshot } from "@/lib/offline/local/license"
import { getLocalDatabaseService } from "@/lib/offline/local/service"

const buildCommit = process.env.NEXT_PUBLIC_BEZGROW_BUILD_COMMIT || "unavailable"
const buildTimestamp = process.env.NEXT_PUBLIC_BEZGROW_BUILD_TIMESTAMP || "unavailable"
const buildVersion = process.env.NEXT_PUBLIC_BEZGROW_BUILD_VERSION || packageJson.version
const buildChannel = process.env.NEXT_PUBLIC_BEZGROW_BUILD_CHANNEL || "development"
const shortBuildCommit = /^[a-f0-9]{7,40}$/i.test(buildCommit) ? buildCommit.slice(0, 7) : buildCommit

function localServerSummary() {
  if (typeof window === "undefined") return null

  const port = Number(window.location.port)
  return {
    origin: window.location.origin,
    host: window.location.hostname,
    port: Number.isFinite(port) ? port : null,
    secure: window.location.protocol === "https:",
  }
}

async function buildSafeDiagnostics() {
  const [database, license] = await Promise.all([
    getLocalDatabaseService().diagnostics(),
    localLicenseSnapshot().catch(() => null),
  ])
  const integrityStage = database.startupStages.find((stage) => stage.stage === "integrity_check")

  return {
    privacy:
      "This export contains technical metadata only. It excludes passwords, tokens, license keys, customer records, invoices, products, and business data.",
    capturedAt: new Date().toISOString(),
    application: {
      name: "Bezgrow",
      version: buildVersion,
      gitCommit: buildCommit,
      buildTimestamp,
      architecture: desktopArchitecture(),
      releaseChannel: buildChannel,
    },
    operatingSystem: {
      platform: typeof navigator === "undefined" ? "" : navigator.platform,
      userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      language: typeof navigator === "undefined" ? "" : navigator.language,
    },
    bundledServer: localServerSummary(),
    database: {
      runtimeMode: database.runtimeMode,
      migrationVersion: database.migrationVersion,
      startupStatus: database.startupStatus,
      integrityStatus: integrityStage?.status || "not-recorded",
      lastFailedStage: database.lastFailedStage,
      lastInitializationError: database.lastInitializationError,
      startupAttempts: database.startupAttempts,
      desktop: database.desktopDiagnostics,
      migrationBackup: database.migrationBackup,
      startupStages: database.startupStages,
      recentOperationErrors: database.recentOperationErrors,
    },
    license: license
      ? {
          status: license.status,
          allowed: license.allowed,
          reason: license.reason,
          expiresAt: license.license?.expiry_date || null,
          graceDays: license.license?.grace_period_days || 0,
        }
      : {
          status: "unavailable",
          allowed: false,
          reason: "License state could not be read.",
          expiresAt: null,
          graceDays: 0,
        },
    updater: {
      currentVersion: buildVersion,
      online: typeof navigator === "undefined" ? false : navigator.onLine,
      installationMode: "verified-manual-installer",
    },
  }
}

export default function DesktopDiagnosticsPanel() {
  const [status, setStatus] = useState("")
  const [busy, setBusy] = useState(false)

  async function exportDiagnostics() {
    setBusy(true)
    setStatus("Preparing sanitized diagnostics…")
    try {
      const payload = await buildSafeDiagnostics()
      const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2))
      const saved = await saveDesktopBytes(
        `bezgrow-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
        bytes,
        "json"
      )
      setStatus(saved ? `Diagnostics saved to ${saved.path}.` : "Diagnostic export cancelled.")
    } catch {
      setStatus("Diagnostics could not be exported. Restart Bezgrow and try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-[36px] border border-white/10 bg-white/[0.035] p-7 backdrop-blur-2xl">
      <h2 className="text-3xl font-black">Desktop Diagnostics</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-neutral-500">
        Save a technical report for support. It never includes passwords, tokens, license keys,
        customers, products, invoices, or other business records.
      </p>
      <div className="mt-5 grid gap-3 text-sm sm:grid-cols-3" aria-label="Application build identity">
        <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-neutral-500">Application</p>
          <p className="mt-2 font-black text-white">Bezgrow {buildVersion}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-neutral-500">Build</p>
          <code className="mt-2 block font-black text-cyan-100">{shortBuildCommit}</code>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-neutral-500">Built</p>
          <p className="mt-2 font-semibold text-white">{buildTimestamp}</p>
        </div>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void exportDiagnostics()}
        className="mt-6 h-12 rounded-2xl bg-white px-6 text-sm font-black text-black disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? "Preparing…" : "Export Diagnostics"}
      </button>
      {status && <p className="mt-4 text-sm font-semibold text-cyan-100">{status}</p>}
    </section>
  )
}
