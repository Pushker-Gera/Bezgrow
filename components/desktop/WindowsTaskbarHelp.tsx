"use client"

import { useEffect, useState } from "react"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"

const STORAGE_KEY = "bezgrow.windows-taskbar-help-dismissed"

export default function WindowsTaskbarHelp() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let active = true
    queueMicrotask(async () => {
      const windows = /windows/i.test(navigator.userAgent) || /win/i.test(navigator.platform)
      if (!windows || window.localStorage.getItem(STORAGE_KEY) === "1") return
      if (await isTauriRuntimeAsync().catch(() => false)) {
        if (active) setVisible(true)
      }
    })
    return () => {
      active = false
    }
  }, [])

  if (!visible) return null
  return (
    <aside className="fixed bottom-4 right-4 z-[95] max-w-sm rounded-2xl border border-cyan-300/25 bg-neutral-950/95 p-4 text-sm text-neutral-200 shadow-2xl backdrop-blur-xl" role="status">
      <p className="font-black text-cyan-100">Keep Bezgrow handy</p>
      <p className="mt-1 leading-6">To keep Bezgrow on the taskbar, right-click the Bezgrow icon while it is open and choose Pin to taskbar.</p>
      <button
        type="button"
        onClick={() => {
          window.localStorage.setItem(STORAGE_KEY, "1")
          setVisible(false)
        }}
        className="mt-3 rounded-xl border border-white/10 px-3 py-2 text-xs font-black text-white"
      >
        Got it
      </button>
    </aside>
  )
}
