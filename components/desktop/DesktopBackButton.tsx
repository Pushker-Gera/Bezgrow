"use client"

import { useEffect, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"

type DesktopBackButtonProps = {
  fallback?: string
  className?: string
}

export default function DesktopBackButton({ fallback = "/dashboard", className = "" }: DesktopBackButtonProps) {
  const router = useRouter()
  const pathname = usePathname()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let active = true

    void isTauriRuntimeAsync().then((desktopRuntime) => {
      if (!active) return
      setVisible(desktopRuntime && pathname !== fallback)
    })

    return () => {
      active = false
    }
  }, [fallback, pathname])

  if (!visible) return null

  function goBack() {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back()
      return
    }

    router.replace(fallback)
  }

  return (
    <button
      type="button"
      onClick={goBack}
      aria-label="Go back"
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-cyan-100 transition hover:border-cyan-300/40 hover:bg-cyan-300/10 ${className}`}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 18l-6-6 6-6" />
      </svg>
    </button>
  )
}
