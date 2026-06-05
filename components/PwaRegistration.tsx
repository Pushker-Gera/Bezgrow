"use client"

import { useEffect } from "react"

export default function PwaRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return

    const isSupportedOrigin =
      window.location.protocol === "https:" ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1"

    if (!isSupportedOrigin) return

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch((error) => {
        console.warn("Bezgrow service worker registration failed:", error)
      })
    }

    if (document.readyState === "complete") {
      register()
      return
    }

    window.addEventListener("load", register, { once: true })
    return () => window.removeEventListener("load", register)
  }, [])

  return null
}
