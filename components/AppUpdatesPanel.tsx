"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  absoluteInstallerUrl,
  appUpdateStatusLabel,
  fetchDesktopReleaseManifest,
  formatUpdateSize,
  installerHrefForCurrentPlatform,
  isDesktopUpdateAvailable,
  isOnline,
  latestVersionForCurrentPlatform,
  normalizeReleaseNotes,
  releaseForCurrentPlatform,
  type AppUpdateStatus,
  type DesktopReleaseManifest,
} from "@/lib/app-updates"
import { isTauriRuntimeAsync, openExternalUrl } from "@/lib/desktop/tauri"
import packageJson from "@/package.json"

function statusColor(status: AppUpdateStatus) {
  if (status === "available") return "text-cyan-200"
  if (status === "failed") return "text-red-200"
  if (status === "offline") return "text-amber-200"
  if (status === "ready" || status === "success") return "text-emerald-200"
  return "text-white"
}

export default function AppUpdatesPanel() {
  const [manifest, setManifest] = useState<DesktopReleaseManifest | null>(null)
  const [status, setStatus] = useState<AppUpdateStatus>("idle")
  const [desktopRuntime, setDesktopRuntime] = useState(false)
  const [message, setMessage] = useState("")
  const [postponedVersion, setPostponedVersion] = useState("")

  const currentVersion = packageJson.version
  const latestVersion = latestVersionForCurrentPlatform(manifest) || currentVersion
  const platformRelease = releaseForCurrentPlatform(manifest)
  const releaseNotes = useMemo(() => normalizeReleaseNotes(manifest), [manifest])
  const updateAvailable = isDesktopUpdateAvailable(manifest, currentVersion)
  const installerHref = installerHrefForCurrentPlatform(manifest)
  const updatePostponed = Boolean(updateAvailable && postponedVersion === latestVersion)
  const releaseSize = formatUpdateSize(platformRelease?.size)

  const checkUpdates = useCallback(async () => {
    if (!isOnline()) {
      setStatus("offline")
      setMessage("Offline. Bezgrow will keep working normally and update checks will resume when internet is available.")
      return
    }

    const controller = new AbortController()
    const timeoutId = globalThis.setTimeout(() => controller.abort(), 10000)

    setStatus("checking")
    setMessage("")

    try {
      const runtime = await isTauriRuntimeAsync()
      const nextManifest = await fetchDesktopReleaseManifest(controller.signal)

      setDesktopRuntime(runtime)
      setManifest(nextManifest)

      if (!nextManifest?.version) {
        setStatus("failed")
        setMessage("Release metadata is not published yet.")
        return
      }

      if (isDesktopUpdateAvailable(nextManifest, currentVersion)) {
        setStatus("available")
        setMessage(`Version ${latestVersionForCurrentPlatform(nextManifest)} is available.`)
        return
      }

      setStatus("success")
      setMessage("You are running the latest published version.")
    } catch {
      setStatus(isOnline() ? "failed" : "offline")
      setMessage(isOnline() ? "Update failed, try again." : "Offline. Bezgrow will keep working normally.")
    } finally {
      globalThis.clearTimeout(timeoutId)
    }
  }, [currentVersion])

  useEffect(() => {
    let cancelled = false

    const runCheck = () => {
      if (cancelled || !isOnline()) return
      void checkUpdates()
    }

    queueMicrotask(() => {
      runCheck()
    })

    window.addEventListener("online", runCheck)
    return () => {
      cancelled = true
      window.removeEventListener("online", runCheck)
    }
  }, [checkUpdates])

  async function updateNow() {
    setStatus("downloading")
    setMessage("Opening the latest Bezgrow installer.")

    try {
      await openExternalUrl(absoluteInstallerUrl(installerHref))
      setStatus("ready")
      setMessage("Ready to install. Finish the installer when it opens; your local SQLite data and license stay on this device.")
    } catch {
      setStatus("failed")
      setMessage("Update failed, try again.")
    }
  }

  function postponeUpdate() {
    setPostponedVersion(latestVersion)
    setMessage("Update postponed. You can install it later from this page.")
  }

  return (
    <div className="rounded-lg border border-cyan-400/20 bg-cyan-500/[0.06] p-5 backdrop-blur-2xl sm:rounded-[36px] sm:p-7">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-2xl font-black sm:text-3xl">App Updates</h2>
          <p className="mt-2 text-sm leading-6 text-neutral-500">
            Current version, latest desktop release, manual update check, and release notes.
          </p>
        </div>
        <span className="w-fit rounded-full border border-cyan-400/20 bg-cyan-500/10 px-4 py-2 text-xs font-black uppercase tracking-[0.16em] text-cyan-100">
          {desktopRuntime ? "Desktop" : "Web / PWA"}
        </span>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-white/10 bg-black/35 p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-neutral-500">Current</p>
          <p className="mt-2 text-xl font-black text-white">{currentVersion}</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-black/35 p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-neutral-500">Latest</p>
          <p className="mt-2 text-xl font-black text-cyan-200">{latestVersion}</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-black/35 p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-neutral-500">Status</p>
          <p className={`mt-2 text-xl font-black ${statusColor(status)}`}>{appUpdateStatusLabel[status]}</p>
        </div>
      </div>

      {updateAvailable && !updatePostponed && (
        <div className="mt-5 rounded-lg border border-cyan-300/25 bg-cyan-300/10 p-4">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-lg font-black text-cyan-100">New Bezgrow update available</h3>
              <p className="mt-1 text-sm leading-6 text-neutral-300">
                Current version {currentVersion} · Latest version {latestVersion}{releaseSize ? ` · ${releaseSize}` : ""}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:min-w-64">
              <button type="button" onClick={() => void updateNow()} className="min-h-11 rounded-lg bg-cyan-300 px-4 text-sm font-black text-black">
                Update Now
              </button>
              <button type="button" onClick={postponeUpdate} className="min-h-11 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-bold text-white">
                Later
              </button>
            </div>
          </div>
        </div>
      )}

      {message && (
        <div className="mt-4 rounded-lg border border-white/10 bg-black/35 px-4 py-3 text-sm font-semibold text-neutral-200">
          {message}
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => void checkUpdates()}
          disabled={status === "checking" || status === "downloading"}
          className="min-h-12 rounded-lg border border-white/10 bg-white/[0.05] px-5 text-sm font-black text-white disabled:opacity-50"
        >
          {status === "checking" ? "Checking..." : "Check for updates"}
        </button>
        <button
          type="button"
          onClick={() => void updateNow()}
          disabled={!updateAvailable || status === "downloading"}
          className="min-h-12 rounded-lg bg-cyan-300 px-5 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-40"
        >
          {status === "downloading" ? "Opening..." : "Update Now"}
        </button>
      </div>

      <div className="mt-5 rounded-lg border border-white/10 bg-black/30 p-4">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-neutral-500">Release Notes</p>
        {releaseNotes.length > 0 ? (
          <ul className="mt-3 space-y-2 text-sm leading-6 text-neutral-300">
            {releaseNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm leading-6 text-neutral-400">
            Release notes appear here when the desktop release manifest includes them.
          </p>
        )}
      </div>
    </div>
  )
}
