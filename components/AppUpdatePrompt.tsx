"use client"

import { useEffect, useRef, useState } from "react"
import { compareVersions, fetchDesktopReleaseManifest, installerHrefForCurrentPlatform } from "@/lib/app-updates"
import { isTauriRuntimeAsync, openExternalUrl } from "@/lib/desktop/tauri"
import packageJson from "@/package.json"

type UpdatePrompt =
  | {
      kind: "web"
      worker: ServiceWorker
      version?: string
      href?: never
    }
  | {
      kind: "desktop"
      worker?: never
      version: string
      href: string
    }

function dismissedKey(prompt: UpdatePrompt) {
  return `bezgrow:update-dismissed:${prompt.kind}:${prompt.version || "pwa"}`
}

export default function AppUpdatePrompt() {
  const [prompt, setPrompt] = useState<UpdatePrompt | null>(null)
  const shouldReloadOnControllerChange = useRef(false)

  useEffect(() => {
    let cancelled = false
    let cleanupWebListeners: (() => void) | undefined

    function maybeShow(nextPrompt: UpdatePrompt) {
      if (cancelled) return
      if (sessionStorage.getItem(dismissedKey(nextPrompt)) === "1") return
      setPrompt(nextPrompt)
    }

    async function checkForUpdates() {
      const desktopRuntime = await isTauriRuntimeAsync()

      if (desktopRuntime) {
        const manifest = await fetchDesktopReleaseManifest()
        const latestVersion = manifest?.version || ""
        const href = installerHrefForCurrentPlatform(manifest)

        if (latestVersion && href && compareVersions(latestVersion, packageJson.version) > 0) {
          maybeShow({ kind: "desktop", version: latestVersion, href })
        }

        return
      }

      if (!("serviceWorker" in navigator)) return

      const handleControllerChange = () => {
        if (!shouldReloadOnControllerChange.current) return
        window.location.reload()
      }
      const watchedRegistrations = new WeakSet<ServiceWorkerRegistration>()

      function setupRegistration(registration: ServiceWorkerRegistration) {
        if (watchedRegistrations.has(registration)) return
        watchedRegistrations.add(registration)

        if (registration.waiting && navigator.serviceWorker.controller) {
          maybeShow({ kind: "web", worker: registration.waiting })
        }

        registration.addEventListener("updatefound", () => {
          const worker = registration.installing
          if (!worker) return

          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              maybeShow({ kind: "web", worker })
            }
          })
        })

        void registration.update().catch(() => undefined)
      }

      const handleRegistered = (event: Event) => {
        const registration = (event as CustomEvent<ServiceWorkerRegistration>).detail
        if (registration) setupRegistration(registration)
      }

      navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange)
      window.addEventListener("bezgrow:pwa-registered", handleRegistered)
      cleanupWebListeners = () => {
        navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange)
        window.removeEventListener("bezgrow:pwa-registered", handleRegistered)
      }

      const registration = await navigator.serviceWorker.getRegistration()
      if (registration) setupRegistration(registration)
    }

    void checkForUpdates()

    return () => {
      cancelled = true
      cleanupWebListeners?.()
    }
  }, [])

  if (!prompt) return null

  const message = prompt.kind === "desktop" ? `Version ${prompt.version} is ready to install.` : "A newer Bezgrow app version is ready."

  async function updateNow() {
    if (!prompt) return

    if (prompt.kind === "web") {
      shouldReloadOnControllerChange.current = true
      prompt.worker.postMessage({ type: "SKIP_WAITING" })
      window.setTimeout(() => window.location.reload(), 900)
      return
    }

    const href = prompt.href.startsWith("/") ? `${window.location.origin}${prompt.href}` : prompt.href
    await openExternalUrl(href)
  }

  function dismiss() {
    if (!prompt) return
    sessionStorage.setItem(dismissedKey(prompt), "1")
    setPrompt(null)
  }

  return (
    <div className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-[70] mx-auto max-w-md rounded-lg border border-cyan-300/25 bg-[#071010]/95 p-4 text-white shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur-xl md:bottom-5">
      <div className="flex items-start gap-3">
        <div className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-cyan-300" />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-black">Update available</h2>
          <p className="mt-1 text-sm leading-6 text-neutral-300">{message}</p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button onClick={() => void updateNow()} className="min-h-11 rounded-lg bg-cyan-300 px-4 text-sm font-black text-black">
              Update now
            </button>
            <button onClick={dismiss} className="min-h-11 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-bold text-white">
              Later
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
