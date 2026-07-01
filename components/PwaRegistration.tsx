"use client"

import { useEffect } from "react"

import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"

const CACHE_PREFIX = "bezgrow-pwa-"

async function clearRegisteredServiceWorkers() {
  const registrations = await navigator.serviceWorker.getRegistrations()
  await Promise.all(registrations.map((registration) => registration.unregister()))

  if ("caches" in window) {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX)).map((key) => caches.delete(key)))
  }
}

export default function PwaRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return

    let cancelled = false
    let removeLoadListener: (() => void) | undefined

    void isTauriRuntimeAsync().then((desktopRuntime) => {
      if (cancelled) return

      if (process.env.NODE_ENV !== "production" || desktopRuntime) {
        void clearRegisteredServiceWorkers().catch((error) => {
          console.warn("Bezgrow service worker cleanup failed:", error)
        })
        return
      }

      const isSupportedOrigin =
        window.location.protocol === "https:" ||
        window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1"

      if (!isSupportedOrigin) return

      const register = () => {
        navigator.serviceWorker
          .register("/sw.js")
          .then((registration) => {
            window.dispatchEvent(new CustomEvent("bezgrow:pwa-registered", { detail: registration }))
          })
          .catch((error) => {
            console.warn("Bezgrow service worker registration failed:", error)
          })
      }

      if (document.readyState === "complete") {
        register()
        return
      }

      window.addEventListener("load", register, { once: true })
      removeLoadListener = () => window.removeEventListener("load", register)
    })

    return () => {
      cancelled = true
      removeLoadListener?.()
    }
  }, [])

  return null
}
