"use client"

import type { Session, SupabaseClient } from "@supabase/supabase-js"
import { invokeTauri, isTauriRuntime } from "@/lib/desktop/tauri"

const SESSION_SECRET_KEY = "supabase-session"
const SESSION_FALLBACK_KEY = "bezgrow:desktop-session-fallback"

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
  if (!isTauriRuntime()) return null

  try {
    return await invokeTauri<string | null>("read_secret", { key })
  } catch {
    return null
  }
}

async function writeDesktopSecret(key: string, value: string) {
  if (!isTauriRuntime()) return false

  try {
    await invokeTauri<void>("store_secret", { key, value })
    return true
  } catch {
    return false
  }
}

async function deleteDesktopSecret(key: string) {
  if (!isTauriRuntime()) return

  try {
    await invokeTauri<void>("delete_secret", { key })
  } catch {
    // Best effort. Logout also clears browser storage.
  }
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
    await clearDesktopSession()
    return { restored: false, offlineOnly: false, error }
  }

  return { restored: true, offlineOnly: false, session: cached }
}

export async function clearDesktopSession() {
  if (!storageAvailable()) return

  localStorage.removeItem(SESSION_FALLBACK_KEY)
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
    if (!isTauriRuntime()) {
      return storageAvailable() ? localStorage.getItem(key) : null
    }

    const secret = await readDesktopSecret(key)
    if (secret !== null) return secret
    return storageAvailable() ? localStorage.getItem(key) : null
  },
  async setItem(key: string, value: string) {
    if (!isTauriRuntime()) {
      if (storageAvailable()) localStorage.setItem(key, value)
      return
    }

    const storedSecurely = await writeDesktopSecret(key, value)
    if (!storedSecurely && storageAvailable()) localStorage.setItem(key, value)
  },
  async removeItem(key: string) {
    if (storageAvailable()) localStorage.removeItem(key)
    await deleteDesktopSecret(key)
  },
}
