"use client"

import { useEffect, useState } from "react"
import { isTauriRuntimeAsync, openPlatformAdmin } from "@/lib/desktop/tauri"

export default function PlatformAdminLauncher({ className = "" }: { className?: string }) {
  const [desktop, setDesktop] = useState(false)
  const [opening, setOpening] = useState(false)
  const [notice, setNotice] = useState("")

  useEffect(() => {
    let active = true
    void isTauriRuntimeAsync().then((value) => {
      if (active) setDesktop(value)
    })
    return () => {
      active = false
    }
  }, [])

  if (!desktop) return null

  async function launch() {
    if (!navigator.onLine) {
      setNotice("Internet connection required for Platform Administration")
      return
    }

    setOpening(true)
    setNotice("")
    try {
      const configured = (process.env.NEXT_PUBLIC_ADMIN_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || "https://www.bezgrow.com").replace(/\/$/, "")
      const target = new URL("/login", configured)
      target.searchParams.set("next", "/admin?desktop=1")
      target.searchParams.set("platform_admin", "1")
      target.searchParams.set("desktop", "1")
      await openPlatformAdmin(target.toString())
      setNotice("Platform Administration opened in a secure online window.")
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Platform Administration could not be opened.")
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => void launch()}
        disabled={opening}
        className="h-11 w-full rounded-2xl border border-cyan-300/25 bg-cyan-300/10 px-4 text-sm font-black text-cyan-100 disabled:opacity-50"
      >
        {opening ? "Connecting…" : "Platform Admin Login"}
      </button>
      {notice && <p className="mt-2 text-xs leading-5 text-neutral-400">{notice}</p>}
    </div>
  )
}
