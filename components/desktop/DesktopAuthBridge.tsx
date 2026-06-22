"use client"

import { useEffect } from "react"
import { supabase } from "@/lib/supabase"
import { installDesktopSessionPersistence, restoreDesktopSession } from "@/lib/desktop/session"

export default function DesktopAuthBridge() {
  useEffect(() => {
    let dispose: () => void = () => undefined
    let cancelled = false

    queueMicrotask(async () => {
      const result = await restoreDesktopSession(supabase)
      if (!cancelled) {
        window.dispatchEvent(
          new CustomEvent("bezgrow:desktop-auth-restored", {
            detail: result,
          })
        )
      }
    })

    dispose = installDesktopSessionPersistence(supabase)

    return () => {
      cancelled = true
      dispose()
    }
  }, [])

  return null
}
