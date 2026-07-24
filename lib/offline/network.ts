"use client"

import { isDesktopRuntime } from "@/lib/desktop/tauri"

export function shouldSaveOffline(error?: unknown) {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true

  const message = error instanceof Error ? error.message.toLowerCase() : String(error || "").toLowerCase()
  return [
    "failed to fetch",
    "internet required",
    "networkerror",
    "network error",
    "load failed",
    "could not connect",
  ].some((needle) => message.includes(needle))
}

export async function shouldUseWebOfflineFallback(error?: unknown) {
  if (!shouldSaveOffline(error)) return false

  // Packaged Tauri always owns its data through the local SQLite adapter.
  // Falling through to the legacy browser cache would split a mutation across
  // two authorities and can make a partial write look successful.
  return !(await isDesktopRuntime().catch(() => false))
}

export function offlineFallbackMessage(offlineMessage: string, errorMessage = "Connection failed. Saved offline instead.") {
  if (typeof navigator !== "undefined" && !navigator.onLine) return offlineMessage
  return errorMessage
}
