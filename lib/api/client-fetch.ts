"use client"

import { supabase } from "@/lib/supabase"
import { localApiFetch } from "@/lib/offline/local/api"

type CachedToken = {
  token: string
  expiresAt: number
}

let cachedToken: CachedToken | null = null
let tokenRequest: Promise<string | null> | null = null
let authListenerInstalled = false

function tokenExpiryMs(expiresAt?: number) {
  return expiresAt ? expiresAt * 1000 : Date.now() + 5 * 60 * 1000
}

function rememberToken(token: string | undefined, expiresAt?: number) {
  cachedToken = token ? { token, expiresAt: tokenExpiryMs(expiresAt) } : null
}

function installAuthListener() {
  if (authListenerInstalled || typeof window === "undefined") return
  authListenerInstalled = true

  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      cachedToken = null
      tokenRequest = null
      return
    }

    rememberToken(session?.access_token, session?.expires_at)
  })
}

export async function getCachedAccessToken(forceFresh = false) {
  installAuthListener()

  if (!forceFresh && cachedToken && cachedToken.expiresAt - Date.now() > 60_000) {
    return cachedToken.token
  }

  if (!forceFresh && tokenRequest) return tokenRequest

  tokenRequest = supabase.auth
    .getSession()
    .then(({ data }) => {
      rememberToken(data.session?.access_token, data.session?.expires_at)
      return data.session?.access_token || null
    })
    .finally(() => {
      tokenRequest = null
    })

  return tokenRequest
}

export async function authHeaders(headersInit?: HeadersInit) {
  const headers = new Headers(headersInit)

  if (!headers.has("authorization")) {
    const token = await getCachedAccessToken()
    if (token) headers.set("authorization", `Bearer ${token}`)
  }

  return headers
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const localResult = await localApiFetch(input, init)
  if (localResult.handled && localResult.response) {
    if (localResult.response.status === 403 && typeof window !== "undefined") {
      const payload = (await localResult.response.clone().json().catch(() => null)) as { error?: string } | null
      if (payload?.error && /activation required|license|another device|reactivation/i.test(payload.error)) {
        sessionStorage.setItem("bezgrow:license-message", payload.error)
        const next = `${window.location.pathname}${window.location.search}${window.location.hash}`
        window.location.assign(`/offline?reason=license_required&next=${encodeURIComponent(next)}`)
      }
    }
    return localResult.response
  }

  return fetch(input, {
    ...init,
    headers: await authHeaders(init.headers),
  })
}
