"use client"

import type { Session, SupabaseClient } from "@supabase/supabase-js"
import { invokeTauri, isTauriRuntimeAsync } from "@/lib/desktop/tauri"

const SESSION_SECRET_KEY = "supabase-session"
const SESSION_FALLBACK_KEY = "bezgrow:desktop-session-fallback"
const SESSION_STORAGE_KEYS_KEY = "bezgrow:desktop-session-storage-keys"
export const DESKTOP_AUTH_MARKER_COOKIE = "bezgrow_desktop_auth"

type StoredSession = Pick<
  Session,
  "access_token" | "refresh_token" | "expires_at" | "expires_in" | "token_type" | "user"
>

function storageAvailable() {
  return typeof window !== "undefined"
}

function serializeSession(session: Session) {
  const stored: StoredSession = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    expires_in: session.expires_in,
    token_type: session.token_type,
    user: session.user,
  }

  return JSON.stringify(stored)
}

function parseSession(value: string | null) {
  if (!value) return null

  try {
    const parsed = JSON.parse(value) as StoredSession
    if (!parsed.access_token || !parsed.refresh_token) return null
    return parsed
  } catch {
    return null
  }
}

async function readDesktopSecret(key: string) {
  if (!(await isTauriRuntimeAsync())) return null

  try {
    return await invokeTauri<string | null>("read_secret", { key })
  } catch {
    return null
  }
}

async function writeDesktopSecret(key: string, value: string) {
  if (!(await isTauriRuntimeAsync())) return false

  try {
    await invokeTauri<void>("store_secret", { key, value })
    return true
  } catch {
    return false
  }
}

async function deleteDesktopSecret(key: string) {
  if (!(await isTauriRuntimeAsync())) return

  try {
    await invokeTauri<void>("delete_secret", { key })
  } catch {
    // Best effort. Logout also clears browser storage.
  }
}

function readTrackedStorageKeys() {
  if (!storageAvailable()) return []

  try {
    const keys = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEYS_KEY) || "[]")
    return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string" && key.length > 0) : []
  } catch {
    localStorage.removeItem(SESSION_STORAGE_KEYS_KEY)
    return []
  }
}

function trackStorageKey(key: string) {
  if (!storageAvailable()) return
  const keys = new Set(readTrackedStorageKeys())
  keys.add(key)
  localStorage.setItem(SESSION_STORAGE_KEYS_KEY, JSON.stringify(Array.from(keys)))
}

function untrackStorageKey(key: string) {
  if (!storageAvailable()) return
  const keys = readTrackedStorageKeys().filter((trackedKey) => trackedKey !== key)
  if (keys.length) {
    localStorage.setItem(SESSION_STORAGE_KEYS_KEY, JSON.stringify(keys))
  } else {
    localStorage.removeItem(SESSION_STORAGE_KEYS_KEY)
  }
}

export function setDesktopAuthMarker() {
  if (!storageAvailable()) return
  document.cookie = `${DESKTOP_AUTH_MARKER_COOKIE}=1; Max-Age=${60 * 60 * 24 * 180}; Path=/; SameSite=Lax`
}

export function clearDesktopAuthMarker() {
  if (!storageAvailable()) return
  document.cookie = `${DESKTOP_AUTH_MARKER_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`
}

export async function persistDesktopSession(session: Session | null) {
  if (!storageAvailable()) return

  if (!session?.access_token || !session.refresh_token) {
    await clearDesktopSession()
    return
  }

  const serialized = serializeSession(session)
  const storedSecurely = await writeDesktopSecret(SESSION_SECRET_KEY, serialized)

  if (!storedSecurely) {
    localStorage.setItem(SESSION_FALLBACK_KEY, serialized)
  } else {
    localStorage.removeItem(SESSION_FALLBACK_KEY)
  }
  setDesktopAuthMarker()
}

export async function readCachedDesktopSession() {
  if (!storageAvailable()) return null

  const secret = await readDesktopSecret(SESSION_SECRET_KEY)
  const session = parseSession(secret)
  if (session) return session

  return parseSession(localStorage.getItem(SESSION_FALLBACK_KEY))
}

export async function hasCachedDesktopSession() {
  return Boolean(await readCachedDesktopSession())
}

export async function restoreDesktopSession(supabase: SupabaseClient) {
  const cached = await readCachedDesktopSession()
  if (!cached) return { restored: false, offlineOnly: false }

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return { restored: false, offlineOnly: true, session: cached }
  }

  const { error } = await supabase.auth.setSession({
    access_token: cached.access_token,
    refresh_token: cached.refresh_token,
  })

  if (error) {
    const message = error.message.toLowerCase()
    const isInvalidRefreshToken =
      message.includes("invalid refresh token") ||
      message.includes("refresh token not found") ||
      message.includes("already used")

    if (isInvalidRefreshToken) {
      await clearDesktopSession()
      return { restored: false, offlineOnly: false, error }
    }

    return { restored: false, offlineOnly: true, session: cached, error }
  }

  return { restored: true, offlineOnly: false, session: cached }
}

export async function clearDesktopSession() {
  if (!storageAvailable()) return

  const trackedKeys = readTrackedStorageKeys()
  await Promise.all(trackedKeys.map((key) => deleteDesktopSecret(key)))
  trackedKeys.forEach((key) => localStorage.removeItem(key))
  localStorage.removeItem(SESSION_STORAGE_KEYS_KEY)
  localStorage.removeItem(SESSION_FALLBACK_KEY)
  clearDesktopAuthMarker()
  await deleteDesktopSecret(SESSION_SECRET_KEY)
}

export function installDesktopSessionPersistence(supabase: SupabaseClient) {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      void clearDesktopSession()
      return
    }

    if (session) {
      void persistDesktopSession(session)
    }
  })

  return () => subscription.unsubscribe()
}

export const desktopSupabaseStorage = {
  async getItem(key: string) {
    if (!(await isTauriRuntimeAsync())) {
      return storageAvailable() ? localStorage.getItem(key) : null
    }

    const secret = await readDesktopSecret(key)
    if (secret !== null) return secret
    return storageAvailable() ? localStorage.getItem(key) : null
  },
  async setItem(key: string, value: string) {
    if (!(await isTauriRuntimeAsync())) {
      if (storageAvailable()) localStorage.setItem(key, value)
      return
    }

    trackStorageKey(key)
    const storedSecurely = await writeDesktopSecret(key, value)
    if (!storedSecurely && storageAvailable()) localStorage.setItem(key, value)
  },
  async removeItem(key: string) {
    if (storageAvailable()) localStorage.removeItem(key)
    await deleteDesktopSecret(key)
    untrackStorageKey(key)
  },
}
