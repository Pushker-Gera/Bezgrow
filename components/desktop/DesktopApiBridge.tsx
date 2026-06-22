"use client"

import { useEffect } from "react"
import { isTauriRuntime } from "@/lib/desktop/tauri"
import { supabase } from "@/lib/supabase"

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
    if (!isTauriRuntime()) return

    const originalFetch = window.fetch.bind(window)

    window.fetch = async (input, init) => {
      const apiPath = apiPathFrom(input)
      if (!apiPath) return originalFetch(input, init)

      if (!navigator.onLine) {
        throw new TypeError("Internet required for this action.")
      }

      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
      if (!headers.has("authorization")) {
        const {
          data: { session },
        } = await supabase.auth.getSession()

        if (session?.access_token) {
          headers.set("authorization", `Bearer ${session.access_token}`)
        }
      }

      const proxyUrl = `/api/desktop-proxy?path=${encodeURIComponent(apiPath)}`
      return originalFetch(proxyUrl, {
        ...init,
        headers,
        cache: "no-store",
      })
    }

    return () => {
      window.fetch = originalFetch
    }
  }, [])

  return null
}
