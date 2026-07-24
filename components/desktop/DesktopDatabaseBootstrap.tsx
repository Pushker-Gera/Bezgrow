"use client"

import { useEffect } from "react"
import { isDesktopRuntime } from "@/lib/desktop/tauri"
import { getLocalDatabaseService } from "@/lib/offline/local/service"

export default function DesktopDatabaseBootstrap() {
  useEffect(() => {
    void isDesktopRuntime()
      .then(async (desktopRuntime) => {
        if (!desktopRuntime) return
        const databaseManager = getLocalDatabaseService()
        void databaseManager.ensureReady().catch((error) => {
          console.error("[desktop-database] startup failed", error)
        })
      })
      .catch((error) => console.error("[desktop-database] startup handler could not start", error))
  }, [])

  return null
}
