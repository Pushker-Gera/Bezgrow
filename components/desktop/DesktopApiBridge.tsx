"use client"

import { useEffect } from "react"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"

const REMOTE_SETUP_PATHS = [
  "/api/auth/",
  "/api/desktop-auth/",
  "/api/license/verify",
  "/api/workspace/create-business",
]

function isExplicitSetupPath(apiPath: string) {
  return REMOTE_SETUP_PATHS.some((path) => apiPath === path || apiPath.startsWith(path))
}

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

        if (!isExplicitSetupPath(apiPath)) {
          throw new Error(`Desktop API route ${apiPath} is not implemented in the local SQLite repository.`)
        }

        if (!navigator.onLine) {
          throw new TypeError("Internet required for this action.")
        }

        const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
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
