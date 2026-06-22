"use client"

import { useCallback, useEffect, useState } from "react"
import { exportOfflineBackup, pendingOfflineCount } from "@/lib/offline/db"
import { syncOfflineQueue } from "@/lib/offline/sync"

export default function OfflineStatusBar() {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine))
  const [pending, setPending] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState("")

  const refreshCount = useCallback(async () => {
    setPending(await pendingOfflineCount())
  }, [])

  const runSync = useCallback(async () => {
    if (syncing) return
    setSyncing(true)
    setMessage("Sync starting...")

    try {
      const result = await syncOfflineQueue((progress) => {
        setMessage(progress.message)
      })
      await refreshCount()
      setMessage(result.unresolved ? "Some offline changes need review." : "Offline changes synced.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sync failed.")
    } finally {
      setSyncing(false)
    }
  }, [refreshCount, syncing])

  async function exportBackup() {
    const backup = await exportOfflineBackup()
    if (!backup) return
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `bezgrow-offline-backup-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  useEffect(() => {
    const handleOnline = () => {
      setOnline(true)
      void refreshCount()
      void runSync()
    }
    const handleOffline = () => {
      setOnline(false)
      setMessage("Offline mode active. New work will be saved locally.")
    }
    const handleActionsChanged = () => {
      void refreshCount()
    }

    setOnline(navigator.onLine)
    void refreshCount()
    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)
    window.addEventListener("bezgrow:offline-actions-changed", handleActionsChanged)

    return () => {
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
      window.removeEventListener("bezgrow:offline-actions-changed", handleActionsChanged)
    }
  }, [refreshCount, runSync])

  if (online && pending === 0 && !message) return null

  return (
    <div className={`border-b px-3 py-2 text-sm ${online ? "border-amber-400/20 bg-amber-500/10 text-amber-100" : "border-cyan-400/20 bg-cyan-500/10 text-cyan-100"}`}>
      <div className="mx-auto flex max-w-[1800px] flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="font-semibold">
          {online ? "Online" : "Offline"} {pending > 0 ? `- ${pending} pending sync` : ""}
          {message ? <span className="ml-2 font-normal opacity-80">{message}</span> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={runSync}
            disabled={!online || syncing || pending === 0}
            className="rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-black disabled:cursor-not-allowed disabled:opacity-50"
          >
            {syncing ? "Syncing..." : "Sync Now"}
          </button>
          <button
            type="button"
            onClick={exportBackup}
            className="rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-black"
          >
            Export Local Backup
          </button>
        </div>
      </div>
    </div>
  )
}
