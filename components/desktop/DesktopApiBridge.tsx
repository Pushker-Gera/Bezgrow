"use client"

import { useEffect } from "react"
import { getCachedAccessToken } from "@/lib/api/client-fetch"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"

function apiPathFrom(input: RequestInfo | URL) {
  const rawUrl = typeof input === "string" || input instanceof URL ? input.toString() : input.url
  const currentOrigin = window.location.origin
  const url = new URL(rawUrl, currentOrigin)

  if (url.origin !== currentOrigin || !url.pathname.startsWith("/api/") || url.pathname === "/api/desktop-proxy") {
    return null
  }

  return `${url.pathname}${url.search}`
}

export default function DesktopApiBridge() {
  useEffect(() => {
    let cancelled = false
    const originalFetch = window.fetch.bind(window)

    void isTauriRuntimeAsync().then((desktopRuntime) => {
      if (cancelled || !desktopRuntime) return

      window.fetch = async (input, init) => {
        const apiPath = apiPathFrom(input)
        if (!apiPath) return originalFetch(input, init)

        const { localApiFetch } = await import("@/lib/offline/local/api")
        const localResult = await localApiFetch(input, init)
        if (localResult.handled && localResult.response) return localResult.response

        if (!navigator.onLine) {
          throw new TypeError("Internet required for this action.")
        }

        const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
        if (!headers.has("authorization")) {
          const token = await getCachedAccessToken()
          if (token) headers.set("authorization", `Bearer ${token}`)
        }

        const proxyUrl = `/api/desktop-proxy?path=${encodeURIComponent(apiPath)}`
        return originalFetch(proxyUrl, {
          ...init,
          headers,
          cache: "no-store",
        })
      }
    })

    return () => {
      cancelled = true
      window.fetch = originalFetch
    }
  }, [])

  return null
}
