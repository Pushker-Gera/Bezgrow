"use client"

import { useState } from "react"
import packageJson from "@/package.json"
import { saveDesktopBytes } from "@/lib/desktop-file-export"
import { desktopArchitecture } from "@/lib/desktop/tauri"
import { getAppLockDiagnostics } from "@/lib/app-lock/client"
import {
  getOrCreateDeviceId,
  localLicenseAppLockDiagnostics,
  localLicenseSnapshot,
} from "@/lib/offline/local/license"
import { getLocalDatabaseService } from "@/lib/offline/local/service"

const buildCommit = process.env.NEXT_PUBLIC_BEZGROW_BUILD_COMMIT || "unavailable"
const buildTimestamp = process.env.NEXT_PUBLIC_BEZGROW_BUILD_TIMESTAMP || "unavailable"
const buildVersion = process.env.NEXT_PUBLIC_BEZGROW_BUILD_VERSION || packageJson.version
const buildPlatform = process.env.NEXT_PUBLIC_BEZGROW_BUILD_PLATFORM || "unavailable"
const embeddedArchitecture = process.env.NEXT_PUBLIC_BEZGROW_BUILD_ARCHITECTURE || ""
const buildChannel = process.env.NEXT_PUBLIC_BEZGROW_BUILD_CHANNEL || "development"
const shortBuildCommit = /^[a-f0-9]{7,40}$/i.test(buildCommit) ? buildCommit.slice(0, 7) : buildCommit
const displayBuildPlatform = buildPlatform === "macos" ? "macOS" : buildPlatform === "windows" ? "Windows" : buildPlatform
const safeBuildId = [buildVersion, shortBuildCommit, buildPlatform, embeddedArchitecture || "runtime", buildChannel]
  .join("-")
  .replace(/[^A-Za-z0-9._-]/g, "_")
const displayBuildTimestamp = Number.isNaN(Date.parse(buildTimestamp))
  ? buildTimestamp
  : `${new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone: "Asia/Kolkata",
    }).format(new Date(buildTimestamp))} IST`

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
  const [database, license, deviceId, appLock, licenceAppLock] = await Promise.all([
    getLocalDatabaseService().diagnostics(),
    localLicenseSnapshot().catch(() => null),
    getOrCreateDeviceId().catch(() => "unavailable"),
    getAppLockDiagnostics({ unlocked: true }).catch(() => ({
      state: "unavailable",
      localCredentialExists: false,
      lastCredentialInstallAt: null,
      resetAuthorizationPresent: false,
      resetAuthorizationExpiryStatus: "unknown",
      secureStorageBackend: "unavailable",
    })),
    localLicenseAppLockDiagnostics().catch(() => ({
      provisioningStatus: "unavailable",
      resetAuthorizationPresent: false,
      resetAuthorizationExpiryStatus: "unknown",
    })),
  ])
  const integrityStage = database.startupStages.find((stage) => stage.stage === "integrity_check")

  return {
    privacy:
      "This export contains technical metadata only. It excludes passwords, password verifiers, tokens, licence keys, signing secrets, customer records, invoices, products, and business data.",
    capturedAt: new Date().toISOString(),
    application: {
      name: "Bezgrow",
      version: buildVersion,
      gitCommit: buildCommit,
      buildTimestamp,
      platform: buildPlatform,
      architecture: embeddedArchitecture || desktopArchitecture(),
      releaseChannel: buildChannel,
    },
    operatingSystem: {
      platform: typeof navigator === "undefined" ? "" : navigator.platform,
      userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
      language: typeof navigator === "undefined" ? "" : navigator.language,
    },
    device: {
      deviceId,
    },
    appLock: {
      state: license && !license.allowed ? "NO_VALID_LICENCE" : appLock.state,
      localCredentialExists: appLock.localCredentialExists,
      licenceProvisioningStatus: licenceAppLock.provisioningStatus,
      lastCredentialInstallAt: appLock.lastCredentialInstallAt,
      resetAuthorizationPresent:
        appLock.resetAuthorizationPresent || licenceAppLock.resetAuthorizationPresent,
      resetAuthorizationExpiryStatus:
        licenceAppLock.resetAuthorizationPresent
          ? licenceAppLock.resetAuthorizationExpiryStatus
          : appLock.resetAuthorizationExpiryStatus,
      secureStorageBackend: appLock.secureStorageBackend,
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

  async function copyBuildIdentity() {
    const safeIdentity = [
      `Bezgrow ERP`,
      `Version: ${buildVersion}`,
      `Build SHA: ${buildCommit}`,
      `Build date: ${buildTimestamp}`,
      `Platform: ${displayBuildPlatform} ${embeddedArchitecture || desktopArchitecture()}`,
      `Channel: ${buildChannel}`,
      `Installation identity: ${safeBuildId}`,
    ].join("\n")
    try {
      await navigator.clipboard.writeText(safeIdentity)
      setStatus("Safe build diagnostics copied.")
    } catch {
      setStatus("Copy was blocked by the operating system. Use Export Safe Diagnostics instead.")
    }
  }

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
      <h2 className="text-3xl font-black">About / Version</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-neutral-500">
        Identify the exact desktop build or save a technical report for support. These diagnostics never include passwords, tokens, licence keys,
        customers, products, invoices, or other business records.
      </p>
      <div className="mt-5 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3" aria-label="Application build identity">
        <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-neutral-500">Application</p>
          <p className="mt-2 font-black text-white">Bezgrow {buildVersion}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-neutral-500">Commit</p>
          <code className="mt-2 block font-black text-cyan-100">{shortBuildCommit}</code>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-neutral-500">Built</p>
          <p className="mt-2 font-semibold text-white">{displayBuildTimestamp}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-neutral-500">Platform</p>
          <p className="mt-2 font-semibold text-white">{displayBuildPlatform} {embeddedArchitecture || desktopArchitecture()}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-neutral-500">Update channel</p>
          <p className="mt-2 font-semibold text-white">{buildChannel}</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/35 p-4">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-neutral-500">Installation identity</p>
          <code className="mt-2 block break-all text-xs font-black text-cyan-100">{safeBuildId}</code>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void copyBuildIdentity()}
          className="h-12 rounded-2xl border border-white/15 bg-white/[0.06] px-6 text-sm font-black text-white"
        >
          Copy Build ID
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void exportDiagnostics()}
          className="h-12 rounded-2xl bg-white px-6 text-sm font-black text-black disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? "Preparing…" : "Export Safe Diagnostics"}
        </button>
      </div>
      {status && <p className="mt-4 text-sm font-semibold text-cyan-100">{status}</p>}
    </section>
  )
}
