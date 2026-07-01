"use client"

import { useEffect, useMemo, useState } from "react"
import { compareVersions, fetchDesktopReleaseManifest, installerHrefForCurrentPlatform, normalizeReleaseNotes, type DesktopReleaseManifest } from "@/lib/app-updates"
import { isTauriRuntimeAsync, openExternalUrl } from "@/lib/desktop/tauri"
import packageJson from "@/package.json"

function statusText(manifest: DesktopReleaseManifest | null, updateAvailable: boolean, checked: boolean) {
  if (!checked) return "Ready to check"
  if (!manifest?.version) return "No release manifest found"
  if (updateAvailable) return "Update available"
  return "Up to date"
}

export default function AppUpdatesPanel() {
  const [manifest, setManifest] = useState<DesktopReleaseManifest | null>(null)
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState(false)
  const [desktopRuntime, setDesktopRuntime] = useState(false)
  const [message, setMessage] = useState("")

  const latestVersion = manifest?.version || packageJson.version
  const releaseNotes = useMemo(() => normalizeReleaseNotes(manifest), [manifest])
  const updateAvailable = compareVersions(latestVersion, packageJson.version) > 0
  const installerHref = installerHrefForCurrentPlatform(manifest)

  async function checkUpdates() {
    setChecking(true)
    setMessage("")

    const runtime = await isTauriRuntimeAsync()
    const nextManifest = await fetchDesktopReleaseManifest()

    setDesktopRuntime(runtime)
    setManifest(nextManifest)
    setChecked(true)
    setChecking(false)

    if (!nextManifest?.version) {
      setMessage("Release metadata is not published yet.")
      return
    }

    setMessage(
      compareVersions(nextManifest.version, packageJson.version) > 0
        ? `Version ${nextManifest.version} is available.`
        : "You are running the latest published version."
    )
  }

  useEffect(() => {
    queueMicrotask(() => {
      void checkUpdates()
    })
  }, [])

  async function updateNow() {
    const href = installerHref || "/download"
    const target = href.startsWith("/") ? `${window.location.origin}${href}` : href
    await openExternalUrl(target)
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
          <p className="mt-2 text-xl font-black text-white">{packageJson.version}</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-black/35 p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-neutral-500">Latest</p>
          <p className="mt-2 text-xl font-black text-cyan-200">{latestVersion}</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-black/35 p-4">
          <p className="text-xs uppercase tracking-[0.14em] text-neutral-500">Status</p>
          <p className="mt-2 text-xl font-black text-emerald-200">{statusText(manifest, updateAvailable, checked)}</p>
        </div>
      </div>

      {message && (
        <div className="mt-4 rounded-lg border border-white/10 bg-black/35 px-4 py-3 text-sm font-semibold text-neutral-200">
          {message}
        </div>
      )}

      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => void checkUpdates()}
          disabled={checking}
          className="min-h-12 rounded-lg border border-white/10 bg-white/[0.05] px-5 text-sm font-black text-white disabled:opacity-50"
        >
          {checking ? "Checking..." : "Check updates"}
        </button>
        <button
          type="button"
          onClick={() => void updateNow()}
          disabled={!updateAvailable}
          className="min-h-12 rounded-lg bg-cyan-300 px-5 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-40"
        >
          Update now
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
