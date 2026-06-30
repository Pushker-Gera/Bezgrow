"use client"

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

export function offlineFallbackMessage(offlineMessage: string, errorMessage = "Connection failed. Saved offline instead.") {
  if (typeof navigator !== "undefined" && !navigator.onLine) return offlineMessage
  return errorMessage
}
