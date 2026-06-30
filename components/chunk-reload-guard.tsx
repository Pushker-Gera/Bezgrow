"use client"

import { useEffect } from "react"
import { isTauriRuntime } from "@/lib/desktop/tauri"

function isChunkLoadError(reason: unknown) {
  if (!reason) return false
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason
        : String(reason)

  return (
    message.includes("ChunkLoadError") ||
    message.includes("Loading chunk") ||
    message.includes("/_next/static/chunks/")
  )
}

export default function ChunkReloadGuard() {
  useEffect(() => {
    if (isTauriRuntime()) return

    const reloadOnce = () => {
      const key = "bezgrow:chunk-reload"
      if (sessionStorage.getItem(key) === "1") return
      sessionStorage.setItem(key, "1")
      window.location.reload()
    }

    const clearReloadFlag = () => {
      sessionStorage.removeItem("bezgrow:chunk-reload")
    }

    const onError = (event: ErrorEvent) => {
      if (isChunkLoadError(event.error) || isChunkLoadError(event.message)) {
        reloadOnce()
      }
    }

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (isChunkLoadError(event.reason)) {
        reloadOnce()
      }
    }

    clearReloadFlag()
    window.addEventListener("error", onError)
    window.addEventListener("unhandledrejection", onUnhandledRejection)

    return () => {
      window.removeEventListener("error", onError)
      window.removeEventListener("unhandledrejection", onUnhandledRejection)
    }
  }, [])

  return null
}
