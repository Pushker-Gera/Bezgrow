"use client"

import { useEffect, useState } from "react"
import {
  absoluteInstallerUrl,
  appUpdateStatusLabel,
  fetchDesktopReleaseManifest,
  formatUpdateSize,
  installerHrefForCurrentPlatform,
  isDesktopUpdateAvailable,
  isOnline,
  latestVersionForCurrentPlatform,
  releaseForCurrentPlatform,
  type AppUpdateStatus,
  type DesktopReleaseManifest,
} from "@/lib/app-updates"
import { isTauriRuntimeAsync, openExternalUrl } from "@/lib/desktop/tauri"
import packageJson from "@/package.json"

function dismissedKey(version: string) {
  return `bezgrow:desktop-update-later:${version}`
}

function isDismissed(version: string) {
  if (typeof window === "undefined") return false
  return localStorage.getItem(dismissedKey(version)) === "1"
}

export default function AppUpdateBanner() {
  const [manifest, setManifest] = useState<DesktopReleaseManifest | null>(null)
  const [status, setStatus] = useState<AppUpdateStatus>("idle")
  const [hidden, setHidden] = useState(false)
  const currentVersion = packageJson.version
  const latestVersion = latestVersionForCurrentPlatform(manifest)
  const release = releaseForCurrentPlatform(manifest)
  const updateAvailable = isDesktopUpdateAvailable(manifest, currentVersion)
  const installerHref = installerHrefForCurrentPlatform(manifest)
  const releaseSize = formatUpdateSize(release?.size)

  useEffect(() => {
    let cancelled = false
    let cancelScheduledCheck: (() => void) | undefined

    async function runCheck() {
      if (cancelled || !isOnline()) return
      const desktopRuntime = await isTauriRuntimeAsync()
      if (cancelled || !desktopRuntime) return

      const controller = new AbortController()
      const timeoutId = globalThis.setTimeout(() => controller.abort(), 10000)
      setStatus("checking")

      try {
        const nextManifest = await fetchDesktopReleaseManifest(controller.signal)
        const nextLatestVersion = latestVersionForCurrentPlatform(nextManifest)
        if (!nextManifest || !isDesktopUpdateAvailable(nextManifest, currentVersion) || isDismissed(nextLatestVersion)) {
          if (!cancelled) {
            setStatus("success")
            setHidden(true)
          }
          return
        }

        if (!cancelled) {
          setManifest(nextManifest)
          setStatus("available")
          setHidden(false)
        }
      } catch {
        if (!cancelled) {
          setStatus(isOnline() ? "failed" : "offline")
          setHidden(true)
        }
      } finally {
        globalThis.clearTimeout(timeoutId)
      }
    }

    const scheduleCheck = () => {
      if (!isOnline()) return
      if ("requestIdleCallback" in window) {
        const idleId = window.requestIdleCallback(() => void runCheck(), { timeout: 8000 })
        cancelScheduledCheck = () => window.cancelIdleCallback(idleId)
        return
      }

      const timeoutId = globalThis.setTimeout(() => void runCheck(), 4000)
      cancelScheduledCheck = () => globalThis.clearTimeout(timeoutId)
    }

    scheduleCheck()
    window.addEventListener("online", scheduleCheck)

    return () => {
      cancelled = true
      cancelScheduledCheck?.()
      window.removeEventListener("online", scheduleCheck)
    }
  }, [currentVersion])

  async function updateNow() {
    setStatus("downloading")
    try {
      await openExternalUrl(absoluteInstallerUrl(installerHref))
      setStatus("ready")
    } catch {
      setStatus("failed")
    }
  }

  function later() {
    if (latestVersion) localStorage.setItem(dismissedKey(latestVersion), "1")
    setHidden(true)
  }

  if (hidden || !updateAvailable || !latestVersion) return null

  return (
    <section className="rounded-[28px] border border-cyan-300/25 bg-cyan-300/10 p-5 shadow-[0_20px_70px_rgba(0,0,0,0.28)]">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-200">{appUpdateStatusLabel[status]}</p>
          <h2 className="mt-2 text-2xl font-black">New Bezgrow update available</h2>
          <p className="mt-2 text-sm leading-6 text-neutral-300">
            Current version {currentVersion} · Latest version {latestVersion}{releaseSize ? ` · ${releaseSize}` : ""}
          </p>
          {status === "ready" && (
            <p className="mt-2 text-sm font-semibold text-emerald-200">Installer opened. Your local SQLite data and license remain on this device.</p>
          )}
          {status === "failed" && <p className="mt-2 text-sm font-semibold text-red-200">Update failed, try again.</p>}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:min-w-72">
          <button
            type="button"
            onClick={() => void updateNow()}
            disabled={status === "downloading"}
            className="min-h-12 rounded-2xl bg-cyan-300 px-5 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "downloading" ? "Opening..." : "Update Now"}
          </button>
          <button type="button" onClick={later} className="min-h-12 rounded-2xl border border-white/10 bg-white/[0.05] px-5 text-sm font-black text-white">
            Later
          </button>
        </div>
      </div>
    </section>
  )
}
