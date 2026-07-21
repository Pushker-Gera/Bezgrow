"use client"

import { useEffect } from "react"
import { supabase } from "@/lib/supabase"
import { installDesktopSessionPersistence, restoreDesktopSession } from "@/lib/desktop/session"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"

export default function DesktopAuthBridge() {
  useEffect(() => {
    let dispose: () => void = () => undefined
    let cancelled = false

    queueMicrotask(async () => {
      const desktopRuntime = await isTauriRuntimeAsync().catch(() => false)
      if (!desktopRuntime) return

      const result = await restoreDesktopSession(supabase)
      if (!cancelled) {
        window.dispatchEvent(
          new CustomEvent("bezgrow:desktop-auth-restored", {
            detail: result,
          })
        )
      }

      if (!cancelled) {
        dispose = installDesktopSessionPersistence(supabase)
      }
    })

    return () => {
      cancelled = true
      dispose()
    }
  }, [])

  return null
}
