"use client"

import { useEffect } from "react"
import { isDesktopRuntime } from "@/lib/desktop/tauri"
import { getLocalDatabaseService } from "@/lib/offline/local/service"

export default function DesktopDatabaseBootstrap() {
  useEffect(() => {
    let disposed = false

    void isDesktopRuntime()
      .then(async (desktopRuntime) => {
        if (!desktopRuntime) return
        const databaseManager = getLocalDatabaseService()
        void databaseManager.ensureReady().catch((error) => {
          console.error("[desktop-database] startup failed", error)
        })
        if (disposed) return
      })
      .catch((error) => console.error("[desktop-database] startup handler could not start", error))

    return () => {
      disposed = true
    }
  }, [])

  return null
}
