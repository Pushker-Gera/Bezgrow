"use client"

import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { localApiFetch } from "@/lib/offline/local/api"
import type { SupabaseClient } from "@supabase/supabase-js"

type CachedToken = {
  token: string
  expiresAt: number
}

let cachedToken: CachedToken | null = null
let tokenRequest: Promise<string | null> | null = null
let authListenerInstalled = false
let browserSupabase: SupabaseClient | null = null

async function getBrowserSupabase() {
  if (browserSupabase) return browserSupabase
  browserSupabase = (await import("@/lib/supabase")).supabase
  return browserSupabase
}

function tokenExpiryMs(expiresAt?: number) {
  return expiresAt ? expiresAt * 1000 : Date.now() + 5 * 60 * 1000
}

function rememberToken(token: string | undefined, expiresAt?: number) {
  cachedToken = token ? { token, expiresAt: tokenExpiryMs(expiresAt) } : null
}

async function installAuthListener() {
  if (authListenerInstalled || typeof window === "undefined") return
  authListenerInstalled = true
  const supabase = await getBrowserSupabase()

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
  if (await isTauriRuntimeAsync()) return null
  await installAuthListener()

  if (!forceFresh && cachedToken && cachedToken.expiresAt - Date.now() > 60_000) {
    return cachedToken.token
  }

  if (!forceFresh && tokenRequest) return tokenRequest

  const supabase = await getBrowserSupabase()
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

function withSelectedFinancialYear(input: RequestInfo | URL, init: RequestInit) {
  if (typeof window === "undefined") return { input, init }
  const selected = localStorage.getItem("bezgrow:selected-financial-year") || ""
  if (!selected) return { input, init }
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  const url = new URL(raw, window.location.origin)
  if (!url.searchParams.has("financial_year_id")) url.searchParams.set("financial_year_id", selected)
  const nextInput = raw.startsWith("http://") || raw.startsWith("https://") ? url.toString() : `${url.pathname}${url.search}${url.hash}`
  if (typeof init.body !== "string") return { input: nextInput, init }
  try {
    const body = JSON.parse(init.body) as Record<string, unknown>
    if (!body.financial_year_id) body.financial_year_id = selected
    return { input: nextInput, init: { ...init, body: JSON.stringify(body) } }
  } catch {
    return { input: nextInput, init }
  }
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const contextual = withSelectedFinancialYear(input, init)
  const localResult = await localApiFetch(contextual.input, contextual.init)
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

  if (await isTauriRuntimeAsync()) {
    throw new Error("This desktop operation is not implemented in the local SQLite repository.")
  }

  return fetch(input, {
    ...init,
    headers: await authHeaders(init.headers),
  })
}
