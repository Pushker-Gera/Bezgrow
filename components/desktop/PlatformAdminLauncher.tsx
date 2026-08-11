"use client"

import { useEffect, useState } from "react"
import { isTauriRuntimeAsync, openPlatformAdmin } from "@/lib/desktop/tauri"
import { getExplicitControlPlaneActionAuth } from "@/lib/offline/local/license"
import { authorizeThisPlatformAdminDevice } from "@/lib/platform-admin/client"

export default function PlatformAdminLauncher({ className = "" }: { className?: string }) {
  const [desktop, setDesktop] = useState(false)
  const [authorized, setAuthorized] = useState(false)
  const [opening, setOpening] = useState(false)
  const [notice, setNotice] = useState("")

  useEffect(() => {
    let active = true
    void isTauriRuntimeAsync().then(async (value) => {
      if (!active) return
      setDesktop(value)
      if (!value || !navigator.onLine) return
      const auth = await getExplicitControlPlaneActionAuth().catch(() => null)
      if (!active || !auth) return
      const allowed = await authorizeThisPlatformAdminDevice(auth).catch(() => false)
      if (active) setAuthorized(allowed)
    })
    return () => {
      active = false
    }
  }, [])

  if (!desktop || !authorized) return null

  async function launch() {
    if (!navigator.onLine) {
      setNotice("Internet connection required for Platform Administration")
      return
    }

    setOpening(true)
    setNotice("")
    try {
      const auth = await getExplicitControlPlaneActionAuth()
      await authorizeThisPlatformAdminDevice(auth)
      await openPlatformAdmin()
      setNotice("Platform Administration opened securely inside Bezgrow.")
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
