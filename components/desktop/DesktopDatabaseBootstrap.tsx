"use client"

import { useEffect } from "react"
import { isDesktopRuntime } from "@/lib/desktop/tauri"
import { getLocalDatabaseService } from "@/lib/offline/local/service"

export default function DesktopDatabaseBootstrap() {
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let closing = false

    void isDesktopRuntime()
      .then(async (desktopRuntime) => {
        if (!desktopRuntime) return
        const databaseManager = getLocalDatabaseService()
        void databaseManager.ensureReady().catch((error) => {
          console.error("[desktop-database] startup failed", error)
        })

        const { getCurrentWindow } = await import("@tauri-apps/api/window")
        const appWindow = getCurrentWindow()
        unlisten = await appWindow.onCloseRequested(async (event) => {
          if (closing) return
          event.preventDefault()
          closing = true
          await databaseManager.closeForAppShutdown().catch((error) => {
            console.error("[desktop-database] shutdown flush failed", error)
          })
          await appWindow.destroy()
        })
      })
      .catch((error) => {
        console.error("[desktop-database] close handler could not start", error)
      })

    return () => unlisten?.()
  }, [])

  return null
}
