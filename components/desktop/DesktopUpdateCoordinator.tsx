"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater"
import { getVersion } from "@tauri-apps/api/app"
import {
  fetchDesktopReleaseManifest,
  formatUpdateSize,
  isDesktopUpdateAvailable,
  latestVersionForCurrentPlatform,
  normalizeReleaseNotes,
  reportDesktopUpdateResult,
  releaseForCurrentPlatform,
  type DesktopReleaseManifest,
} from "@/lib/app-updates"
import { invokeTauri, isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import {
  UPDATE_CHECK_EVENT,
  UPDATE_INSTALL_EVENT,
  autoUpdateDue,
  clearPendingUpdateRestart,
  clearUpdateDecision,
  markUpdatePendingRestart,
  pendingUpdateHasLaunched,
  readPendingUpdateRestart,
  readUpdateDecision,
  remindLater,
  scheduleUpdate,
  writeUpdateDecision,
  type UpdateDecision,
} from "@/lib/desktop/update-state"
import packageJson from "@/package.json"

type InstallState = "idle" | "checking" | "preparing" | "downloading" | "installing" | "restarting" | "failed"

const RECENT_EDIT_WINDOW_MS = 2 * 60 * 1000
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const STARTUP_CHECK_DELAY_MS = 5_000

function updateIsUnsafe(lastEditAt: number) {
  const path = window.location.pathname.toLowerCase()
  const sensitiveRoute = /\/(new|edit|create|pos|billing|print|backup|restore|import|export)(\/|$)/.test(path)
  const activeElement = document.activeElement
  const editing =
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLTextAreaElement ||
    activeElement instanceof HTMLSelectElement ||
    Boolean(activeElement?.getAttribute("contenteditable"))
  const busy = Boolean(document.querySelector('[aria-busy="true"], [data-unsaved="true"], [data-critical-operation="true"]'))
  return sensitiveRoute || editing || busy || Date.now() - lastEditAt < RECENT_EDIT_WINDOW_MS
}

function platformLabel() {
  const architecture = typeof window !== "undefined" && (window as Window & { __BEZGROW_ARCH__?: string }).__BEZGROW_ARCH__ === "arm64" ? "arm64" : "x64"
  return /windows/i.test(navigator.userAgent) ? `Windows ${architecture}` : `macOS ${architecture}`
}

export default function DesktopUpdateCoordinator() {
  const [manifest, setManifest] = useState<DesktopReleaseManifest | null>(null)
  const [currentVersion, setCurrentVersion] = useState(packageJson.version)
  const [decision, setDecision] = useState<UpdateDecision | null>(null)
  const [installState, setInstallState] = useState<InstallState>("idle")
  const [message, setMessage] = useState("")
  const [progress, setProgress] = useState(0)
  const [scheduleHours, setScheduleHours] = useState("12")
  const lastEditAt = useRef(0)
  const checking = useRef(false)
  const installing = useRef(false)
  const lastCheckedAt = useRef(0)

  const latestVersion = latestVersionForCurrentPlatform(manifest)
  const release = releaseForCurrentPlatform(manifest)
  const notes = useMemo(() => normalizeReleaseNotes(manifest), [manifest])
  const available = Boolean(latestVersion && isDesktopUpdateAvailable(manifest, currentVersion))
  const visible = Boolean(available && decision && Date.now() >= decision.nextPromptAt)

  const checkForUpdate = useCallback(async () => {
    if (checking.current || !navigator.onLine || !(await isTauriRuntimeAsync())) return
    checking.current = true
    setInstallState((state) => (state === "idle" ? "checking" : state))
    try {
      const installedVersion = await getVersion().catch(() => packageJson.version)
      setCurrentVersion(installedVersion)
      const pendingRestart = readPendingUpdateRestart()
      if (pendingRestart && pendingUpdateHasLaunched(pendingRestart, installedVersion)) {
        const reported = await reportDesktopUpdateResult(installedVersion, "success")
        if (reported) clearPendingUpdateRestart()
      }
      const nextManifest = await fetchDesktopReleaseManifest(undefined, installedVersion)
      lastCheckedAt.current = Date.now()
      if (nextManifest && isDesktopUpdateAvailable(nextManifest, installedVersion)) {
        const version = latestVersionForCurrentPlatform(nextManifest)
        const nextDecision = readUpdateDecision(version)
        writeUpdateDecision(nextDecision)
        setDecision(nextDecision)
        setManifest(nextManifest)
        void reportDesktopUpdateResult(installedVersion, "update_available")
      } else {
        clearUpdateDecision()
        setDecision(null)
        setManifest(null)
        void reportDesktopUpdateResult(installedVersion, "no_update")
      }
    } catch {
      // Offline billing remains available when the update service cannot be reached.
    } finally {
      checking.current = false
      setInstallState((state) => (state === "checking" ? "idle" : state))
    }
  }, [])

  const installUpdate = useCallback(async (automatic = false) => {
    if (installing.current || !navigator.onLine) {
      if (!navigator.onLine) setMessage("The update is waiting for an internet connection.")
      return
    }
    if (updateIsUnsafe(lastEditAt.current)) {
      setMessage("The update is waiting for unsaved work or the current billing operation to finish.")
      return
    }

    installing.current = true
    let prepared = false
    let updater: Awaited<ReturnType<typeof check>> = null
    try {
      setInstallState("preparing")
      setMessage("Checking SQLite integrity and creating a pre-update backup…")
      await invokeTauri("desktop_prepare_update", { unsavedWork: false })
      prepared = true

      setInstallState("checking")
      updater = await check({ timeout: 20_000 })
      if (!updater) throw new Error("No signed compatible update is available for this device.")
      if (latestVersion && updater.version !== latestVersion) {
        throw new Error(`The signed updater returned ${updater.version}, but release metadata advertises ${latestVersion}.`)
      }

      let downloaded = 0
      let total = release?.updaterSize || release?.size || 0
      const onDownload = (event: DownloadEvent) => {
        if (event.event === "Started") total = event.data.contentLength || total
        if (event.event === "Progress") downloaded += event.data.chunkLength
        if (event.event === "Started" || event.event === "Progress") {
          setInstallState("downloading")
          setProgress(total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0)
          setMessage(total > 0 ? `Downloading verified update… ${Math.min(100, Math.round((downloaded / total) * 100))}%` : "Downloading verified update…")
        }
        if (event.event === "Finished") {
          setInstallState("installing")
          setMessage("Signature verified. Installing the update…")
        }
      }
      await updater.downloadAndInstall(onDownload, { timeout: 10 * 60_000 })
      markUpdatePendingRestart(updater.version, currentVersion)
      setInstallState("restarting")
      setMessage("Update installed. Bezgrow will restart in 5 seconds; your local data and license remain in place.")
      await new Promise((resolve) => globalThis.setTimeout(resolve, 5_000))
      await invokeTauri("desktop_restart_after_update")
    } catch (error) {
      if (prepared) await invokeTauri("desktop_cancel_update_preparation").catch(() => undefined)
      const errorMessage = error instanceof Error ? error.message : "The update could not be installed."
      setInstallState("failed")
      if (!/waiting|unsaved|operation in progress/i.test(errorMessage)) {
        void reportDesktopUpdateResult(currentVersion, "failed")
      }
      setMessage(automatic && /waiting|unsaved|operation in progress/i.test(errorMessage) ? "The automatic update was deferred safely." : errorMessage)
    } finally {
      await updater?.close().catch(() => undefined)
      installing.current = false
    }
  }, [currentVersion, latestVersion, release?.size, release?.updaterSize])

  useEffect(() => {
    let cleanup: (() => void) | undefined
    let cancelled = false
    void isTauriRuntimeAsync().then((desktop) => {
      if (cancelled) return
      if (!desktop) return
      const recordEdit = () => { lastEditAt.current = Date.now() }
      const handleCheck = () => { void checkForUpdate() }
      const handleInstall = () => { void installUpdate(false) }
      const handleOnline = () => { void checkForUpdate() }
      const handleVisibility = () => {
        if (document.visibilityState === "visible" && Date.now() - lastCheckedAt.current >= UPDATE_CHECK_INTERVAL_MS) void checkForUpdate()
      }
      const startupTimer = globalThis.setTimeout(handleCheck, STARTUP_CHECK_DELAY_MS)
      const periodicTimer = globalThis.setInterval(handleCheck, UPDATE_CHECK_INTERVAL_MS)
      window.addEventListener("input", recordEdit, true)
      window.addEventListener("change", recordEdit, true)
      window.addEventListener("online", handleOnline)
      document.addEventListener("visibilitychange", handleVisibility)
      window.addEventListener(UPDATE_CHECK_EVENT, handleCheck)
      window.addEventListener(UPDATE_INSTALL_EVENT, handleInstall)
      cleanup = () => {
        window.removeEventListener("input", recordEdit, true)
        window.removeEventListener("change", recordEdit, true)
        window.removeEventListener("online", handleOnline)
        document.removeEventListener("visibilitychange", handleVisibility)
        window.removeEventListener(UPDATE_CHECK_EVENT, handleCheck)
        window.removeEventListener(UPDATE_INSTALL_EVENT, handleInstall)
        globalThis.clearTimeout(startupTimer)
        globalThis.clearInterval(periodicTimer)
      }
    })
    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [checkForUpdate, installUpdate])

  useEffect(() => {
    if (!available || !decision || !navigator.onLine || !autoUpdateDue(decision)) return
    if (decision.lastAttemptAt && Date.now() - decision.lastAttemptAt < 60 * 60 * 1000) return
    const nextDecision = { ...decision, lastAttemptAt: Date.now() }
    writeUpdateDecision(nextDecision)
    setDecision(nextDecision)
    const timer = globalThis.setTimeout(() => void installUpdate(true), 15_000)
    return () => globalThis.clearTimeout(timer)
  }, [available, decision, installUpdate])

  if (!visible || !manifest || !decision) return null

  const size = formatUpdateSize(release?.updaterSize || release?.size)
  const busy = !["idle", "failed"].includes(installState)

  return (
    <aside className="fixed inset-x-3 bottom-3 z-[1000] mx-auto max-w-3xl rounded-2xl border border-cyan-300/30 bg-neutral-950/95 p-4 text-white shadow-2xl backdrop-blur-xl" role="status" aria-live="polite">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-cyan-200">Signed Bezgrow update available</p>
          <h2 className="mt-1 text-lg font-black">Version {latestVersion}</h2>
          <p className="mt-1 text-sm text-neutral-300">
            Current {currentVersion} · {platformLabel()}{size ? ` · ${size}` : ""} · Restart required
          </p>
          <p className="mt-1 text-xs text-neutral-400">The update downloads only while online and installs only after database checks, a backup, and an idle-work check.</p>
          {notes.length > 0 && <ul className="mt-2 max-h-24 space-y-1 overflow-auto text-sm text-neutral-200">{notes.map((note) => <li key={note}>• {note}</li>)}</ul>}
          {message && <p className={`mt-2 text-sm font-semibold ${installState === "failed" ? "text-red-200" : "text-cyan-100"}`}>{message}</p>}
          {installState === "downloading" && <progress className="mt-2 h-2 w-full" max={100} value={progress} aria-label="Update download progress" />}
        </div>
        <div className="grid shrink-0 grid-cols-2 gap-2 sm:w-72">
          <button type="button" disabled={busy} onClick={() => void installUpdate(false)} className="min-h-11 rounded-lg bg-cyan-300 px-3 text-sm font-black text-black disabled:opacity-50">Update now</button>
          <button type="button" disabled={busy} onClick={() => { const next = remindLater(latestVersion); setDecision(next); setMessage("We’ll remind you again in 6 hours.") }} className="min-h-11 rounded-lg border border-white/15 px-3 text-sm font-bold disabled:opacity-50">Remind me later</button>
          <select aria-label="Schedule update" disabled={busy} value={scheduleHours} onChange={(event) => setScheduleHours(event.target.value)} className="min-h-11 rounded-lg border border-white/15 bg-neutral-900 px-2 text-sm">
            <option value="2">In 2 hours</option><option value="12">In 12 hours</option><option value="24">Tomorrow</option><option value="48">In 48 hours</option>
          </select>
          <button type="button" disabled={busy} onClick={() => { const when = Date.now() + Number(scheduleHours) * 60 * 60 * 1000; const next = scheduleUpdate(latestVersion, when); setDecision(next); setMessage(`Scheduled for ${new Date(when).toLocaleString()}.`) }} className="min-h-11 rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-3 text-sm font-bold disabled:opacity-50">Schedule for later</button>
        </div>
      </div>
    </aside>
  )
}
