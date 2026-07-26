"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import { AdminOnlineProvider } from "@/components/admin/ControlPlaneUi"
import { BezgrowLogoMark } from "@/components/brand/BezgrowLogoMark"
import { supabase } from "@/lib/supabase"

type AdminSession = {
  success?: boolean
  error?: string
  admin?: {
    email?: string | null
    role?: string | null
  }
}

const navItems = [
  ["Dashboard", "/admin"],
  ["Licenses", "/admin/licenses"],
  ["Devices", "/admin/devices"],
  ["Customers", "/admin/customers"],
  ["Businesses", "/admin/businesses"],
  ["Releases & Updates", "/admin/releases"],
  ["Backups & Sync", "/admin/backups"],
  ["Support & Diagnostics", "/admin/support"],
  ["Security & Audit Logs", "/admin/security"],
  ["Analytics", "/admin/analytics"],
  ["Platform Settings", "/admin/settings"],
] as const

const mobilePrimary = navItems.slice(0, 3)
const mobileMore = navItems.slice(3)

export default function AdminLayout({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [adminEmail, setAdminEmail] = useState("")
  const [adminRole, setAdminRole] = useState("")
  const [online, setOnline] = useState(true)
  const [checking, setChecking] = useState(true)
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
  const [desktopAdminWindow, setDesktopAdminWindow] = useState(false)

  useEffect(() => {
    const initialOnline = typeof navigator === "undefined" ? true : navigator.onLine
    queueMicrotask(() => setOnline(initialOnline))
    const handleOnline = () => setOnline(true)
    const handleOffline = () => setOnline(false)
    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)
    return () => {
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("desktop") === "1") {
      sessionStorage.setItem("bezgrow:platform-admin-window", "1")
    }
    queueMicrotask(() => setDesktopAdminWindow(sessionStorage.getItem("bezgrow:platform-admin-window") === "1"))
  }, [])

  useEffect(() => {
    if (!online) {
      queueMicrotask(() => setChecking(false))
      return
    }
    const controller = new AbortController()
    queueMicrotask(() => setChecking(true))
    fetch("/api/admin/session", {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as AdminSession
        if (!response.ok || !payload.success) {
          const query = new URLSearchParams({
            next: `${pathname}${window.location.search}`,
            platform_admin: "1",
          })
          if (response.status === 403) query.set("error", "admin_required")
          router.replace(`/login?${query}`)
          return
        }
        setAdminEmail(payload.admin?.email || "")
        setAdminRole(payload.admin?.role || "")
      })
      .catch((error) => {
        if (controller.signal.aborted) return
        console.warn("Admin session validation failed:", error)
        setOnline(false)
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false)
      })
    return () => controller.abort()
  }, [online, pathname, router])

  function isActive(href: string) {
    return pathname === href || (href !== "/admin" && pathname.startsWith(`${href}/`))
  }

  async function handleLogout() {
    await supabase.auth.signOut()
    router.replace("/login?next=/admin&platform_admin=1")
  }

  function returnToErp() {
    sessionStorage.removeItem("bezgrow:platform-admin-window")
    window.close()
  }

  const initials = (adminEmail.charAt(0) || "A").toUpperCase()

  return (
    <AdminOnlineProvider online={online}>
      <div className="responsive-shell flex h-dvh max-h-dvh overflow-hidden bg-black text-white">
        <aside className="hidden w-[292px] shrink-0 border-r border-white/10 bg-[#060909] p-5 lg:flex lg:flex-col">
          <div className="inventory-sheen rounded-[30px] border border-white/10 bg-white/[0.035] p-5">
            <BezgrowLogoMark className="mb-3 h-12 w-12" size={48} />
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-cyan-200">Platform Admin</p>
            <h1 className="mt-3 text-3xl font-black">Bezgrow</h1>
            <p className="mt-2 text-sm text-neutral-500">Online control plane</p>
          </div>

          <nav className="mt-5 flex-1 space-y-1 overflow-y-auto pr-1">
            {navItems.map(([name, href]) => (
              <Link
                key={href}
                href={href}
                className={`flex min-h-10 items-center rounded-xl border px-3 text-[13px] font-bold transition ${
                  isActive(href)
                    ? "border-cyan-400/30 bg-cyan-500/10 text-cyan-100"
                    : "border-transparent text-neutral-400 hover:border-white/10 hover:bg-white/[0.04] hover:text-white"
                }`}
              >
                {name}
              </Link>
            ))}
          </nav>

          <div className="mt-4 rounded-[22px] border border-white/10 bg-white/[0.035] p-4">
            <p className="truncate text-sm font-bold">{adminEmail || "Platform administrator"}</p>
            <p className="mt-1 text-[11px] uppercase tracking-[0.12em] text-neutral-500">
              {adminRole.replaceAll("_", " ") || "Validating role"}
            </p>
            {desktopAdminWindow && (
              <button
                type="button"
                onClick={returnToErp}
                className="mt-3 h-10 w-full rounded-xl bg-cyan-300 text-xs font-black text-black"
              >
                Return to local ERP
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="mt-2 h-10 w-full rounded-xl border border-white/10 text-xs font-black text-neutral-300"
            >
              Admin logout
            </button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="z-30 shrink-0 border-b border-white/10 bg-black/90 px-4 py-3 backdrop-blur-xl sm:px-6 lg:px-8">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <BezgrowLogoMark className="h-10 w-10 shrink-0 lg:hidden" size={40} />
                <div className="min-w-0">
                  <h1 className="truncate text-lg font-black sm:text-2xl">Platform Administration</h1>
                  <p className="mt-1 flex items-center gap-2 text-xs text-neutral-500">
                    <span className={`h-2 w-2 rounded-full ${online ? "bg-emerald-300" : "bg-red-300"}`} />
                    {online ? "Connected to the Bezgrow control plane" : "Internet connection required"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {desktopAdminWindow && (
                  <button
                    type="button"
                    onClick={returnToErp}
                    className="hidden h-10 rounded-xl border border-cyan-300/25 px-4 text-xs font-black text-cyan-100 sm:block lg:hidden"
                  >
                    Return to ERP
                  </button>
                )}
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-300 text-sm font-black text-black">
                  {initials}
                </div>
              </div>
            </div>
          </header>

          <main className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-black p-4 pb-28 sm:p-6 md:pb-8 lg:p-8">
            {checking && online ? (
              <div className="grid gap-4">
                <div className="h-28 animate-pulse rounded-[28px] bg-white/[0.05]" />
                <div className="h-64 animate-pulse rounded-[28px] bg-white/[0.035]" />
              </div>
            ) : (
              children
            )}
            {!online && (
              <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/85 p-5 backdrop-blur-md">
                <section className="max-w-lg rounded-[30px] border border-amber-400/25 bg-amber-500/10 p-7 text-center shadow-2xl">
                  <p className="text-xs font-black uppercase tracking-[0.2em] text-amber-200">Platform administration paused</p>
                  <h2 className="mt-4 text-2xl font-black">Internet connection required for Platform Administration</h2>
                  <p className="mt-3 text-sm leading-6 text-neutral-300">
                    Admin reads and mutations are stopped. Your customer ERP workspace and local SQLite data are unchanged.
                  </p>
                  {desktopAdminWindow && (
                    <button type="button" onClick={returnToErp} className="mt-6 h-12 rounded-2xl bg-white px-6 text-sm font-black text-black">
                      Return to local ERP
                    </button>
                  )}
                </section>
              </div>
            )}
          </main>

          <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-[#050707]/95 px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-2 backdrop-blur-xl lg:hidden">
            {mobileMoreOpen && (
              <div className="absolute inset-x-3 bottom-[calc(100%+0.5rem)] max-h-[55dvh] overflow-y-auto rounded-2xl border border-white/10 bg-[#080b0b] p-2 shadow-2xl">
                <div className="grid grid-cols-2 gap-2">
                  {mobileMore.map(([name, href]) => (
                    <Link
                      key={href}
                      href={href}
                      onClick={() => setMobileMoreOpen(false)}
                      className={`flex min-h-12 items-center rounded-xl border px-3 text-xs font-bold ${
                        isActive(href) ? "border-cyan-300/35 bg-cyan-300/10 text-cyan-100" : "border-white/10 text-neutral-300"
                      }`}
                    >
                      {name}
                    </Link>
                  ))}
                </div>
              </div>
            )}
            <div className="grid grid-cols-4 gap-1">
              {mobilePrimary.map(([name, href]) => (
                <Link
                  key={href}
                  href={href}
                  className={`flex min-h-[58px] items-center justify-center rounded-xl px-1 text-[11px] font-black ${
                    isActive(href) ? "bg-cyan-300 text-black" : "text-neutral-400"
                  }`}
                >
                  {name}
                </Link>
              ))}
              <button
                type="button"
                onClick={() => setMobileMoreOpen((value) => !value)}
                className={`min-h-[58px] rounded-xl text-[11px] font-black ${
                  mobileMoreOpen || mobileMore.some(([, href]) => isActive(href))
                    ? "bg-cyan-300 text-black"
                    : "text-neutral-400"
                }`}
              >
                More
              </button>
            </div>
          </nav>
        </div>
      </div>
    </AdminOnlineProvider>
  )
}
