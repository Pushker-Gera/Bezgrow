"use client"

import { useEffect } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { invokeTauri, isDesktopRuntime } from "@/lib/desktop/tauri"
import { getLocalDatabaseService } from "@/lib/offline/local/service"

export default function DesktopDatabaseBootstrap() {
  useEffect(() => {
    let disposed = false
    let closing = false
    let removeCloseListener: (() => void) | undefined

    void isDesktopRuntime()
      .then(async (desktopRuntime) => {
        if (!desktopRuntime) return
        const databaseManager = getLocalDatabaseService()
        void databaseManager.ensureReady().catch((error) => {
          console.error("[desktop-database] startup failed", error)
        })
        const unlisten = await getCurrentWindow().onCloseRequested(async (event) => {
          event.preventDefault()
          if (closing) return
          closing = true
          try {
            await databaseManager.closeForAppShutdown()
          } catch (error) {
            console.error("[desktop-database] shutdown checkpoint failed", error)
          } finally {
            await invokeTauri("desktop_exit").catch((error) => {
              console.error("[desktop-database] native shutdown failed", error)
            })
          }
        })
        if (disposed) {
          unlisten()
        } else {
          removeCloseListener = unlisten
        }
      })
      .catch((error) => console.error("[desktop-database] startup handler could not start", error))

    return () => {
      disposed = true
      removeCloseListener?.()
    }
  }, [])

  return null
}
