"use client"

import type { FormEvent, ReactNode } from "react"
import { useEffect, useRef, useState } from "react"
import { BezgrowLogoMark } from "@/components/brand/BezgrowLogoMark"
import {
  APP_LOCK_CREDENTIAL_CHANGED_EVENT,
  APP_LOCK_EVENT,
  getAppLockStatus,
  readAutoLockDelay,
  verifyAppPassword,
} from "@/lib/app-lock/client"

const THROTTLE_KEY = "bezgrow:app-lock-throttle-v1"

type GateState = "checking" | "missing" | "locked" | "unlocked" | "failed"
type ThrottleState = { attempts: number; blockedUntil: number }

function readThrottle(): ThrottleState {
  try {
    const parsed = JSON.parse(localStorage.getItem(THROTTLE_KEY) || "{}") as Partial<ThrottleState>
    return {
      attempts: Number.isFinite(parsed.attempts) ? Math.max(0, Number(parsed.attempts)) : 0,
      blockedUntil: Number.isFinite(parsed.blockedUntil) ? Math.max(0, Number(parsed.blockedUntil)) : 0,
    }
  } catch {
    return { attempts: 0, blockedUntil: 0 }
  }
}

function throttleDelay(attempts: number) {
  if (attempts < 5) return 1_000
  return Math.min(300_000, 30_000 * 2 ** Math.min(4, attempts - 5))
}

export function AppLockGate({ businessName, children }: { businessName: string; children: ReactNode }) {
  const [gate, setGate] = useState<GateState>("checking")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [blockedUntil, setBlockedUntil] = useState(0)
  const [now, setNow] = useState(Date.now())
  const passwordRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void getAppLockStatus()
      .then((status) => {
        if (cancelled) return
        const throttle = readThrottle()
        setBlockedUntil(throttle.blockedUntil)
        setGate(status.enabled ? "locked" : "missing")
      })
      .catch((cause) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : "App Lock could not be initialized.")
        setGate("failed")
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (gate !== "locked") return
    passwordRef.current?.focus()
  }, [gate])

  useEffect(() => {
    const credentialChanged = () => {
      localStorage.removeItem(THROTTLE_KEY)
      setBlockedUntil(0)
      setPassword("")
      setError("")
      void getAppLockStatus()
        .then((status) => setGate(status.enabled ? "locked" : "missing"))
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : "App Lock could not reload the device credential.")
          setGate("failed")
        })
    }
    window.addEventListener(APP_LOCK_CREDENTIAL_CHANGED_EVENT, credentialChanged)
    return () => window.removeEventListener(APP_LOCK_CREDENTIAL_CHANGED_EVENT, credentialChanged)
  }, [])

  useEffect(() => {
    if (blockedUntil <= Date.now()) return
    const timer = globalThis.setInterval(() => setNow(Date.now()), 500)
    return () => globalThis.clearInterval(timer)
  }, [blockedUntil])

  useEffect(() => {
    if (gate !== "unlocked") return
    let backgroundedAt = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastTick = Date.now()
    const delay = readAutoLockDelay()

    const clearTimer = () => {
      if (timer) globalThis.clearTimeout(timer)
      timer = null
    }
    const lock = () => {
      clearTimer()
      setPassword("")
      setError("")
      setGate("locked")
    }
    const beginGrace = () => {
      if (!backgroundedAt) backgroundedAt = Date.now()
      clearTimer()
      if (delay === 0) lock()
      else timer = globalThis.setTimeout(lock, delay)
    }
    const resume = () => {
      if (backgroundedAt && Date.now() - backgroundedAt >= delay) lock()
      else {
        backgroundedAt = 0
        clearTimer()
      }
    }
    const visibilityChanged = () => document.visibilityState === "hidden" ? beginGrace() : resume()
    const sleepCheck = () => {
      const current = Date.now()
      const elapsed = current - lastTick
      lastTick = current
      if (elapsed >= Math.max(5_000, delay)) lock()
    }

    const interval = globalThis.setInterval(sleepCheck, 1_000)
    window.addEventListener("blur", beginGrace)
    window.addEventListener("focus", resume)
    window.addEventListener(APP_LOCK_EVENT, lock)
    document.addEventListener("visibilitychange", visibilityChanged)
    return () => {
      clearTimer()
      globalThis.clearInterval(interval)
      window.removeEventListener("blur", beginGrace)
      window.removeEventListener("focus", resume)
      window.removeEventListener(APP_LOCK_EVENT, lock)
      document.removeEventListener("visibilitychange", visibilityChanged)
    }
  }, [gate])

  async function unlock(event: FormEvent) {
    event.preventDefault()
    const current = Date.now()
    if (blockedUntil > current) return
    if (!password) {
      setError("Enter the app-access password.")
      return
    }
    setSubmitting(true)
    setError("")
    try {
      if (await verifyAppPassword(password)) {
        localStorage.removeItem(THROTTLE_KEY)
        setPassword("")
        setBlockedUntil(0)
        setGate("unlocked")
        return
      }
      const previous = readThrottle()
      const attempts = previous.attempts + 1
      const nextBlockedUntil = Date.now() + throttleDelay(attempts)
      localStorage.setItem(THROTTLE_KEY, JSON.stringify({ attempts, blockedUntil: nextBlockedUntil }))
      setBlockedUntil(nextBlockedUntil)
      setNow(Date.now())
      setPassword("")
      setError(attempts >= 5
        ? "Incorrect password. Too many attempts; unlock is temporarily paused."
        : "Incorrect app-access password. Try again.")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The password could not be verified.")
    } finally {
      setSubmitting(false)
    }
  }

  if (gate === "unlocked") return children

  const remainingSeconds = Math.max(0, Math.ceil((blockedUntil - now) / 1_000))
  return (
    <main className="fixed inset-0 z-[1000] flex min-h-dvh items-center justify-center overflow-auto bg-[#020404] px-5 py-8 text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.12),transparent_38%)]" />
      <section className="relative w-full max-w-md rounded-[32px] border border-white/10 bg-[#080b0b] p-7 shadow-[0_32px_120px_rgba(0,0,0,0.8)] sm:p-9">
        <div className="flex items-center gap-4">
          <BezgrowLogoMark className="h-14 w-14 shrink-0" size={56} />
          <div className="min-w-0">
            <p className="text-xl font-black">Bezgrow</p>
            <p className="truncate text-sm text-neutral-400">{businessName}</p>
          </div>
        </div>

        {gate === "checking" ? (
          <div className="py-16 text-center text-sm font-semibold text-neutral-400">Securing this workspace…</div>
        ) : gate === "missing" ? (
          <div className="mt-8">
            <h1 className="text-2xl font-black">App Lock needs provisioning</h1>
            <p className="mt-4 text-sm leading-6 text-neutral-400">
              This licence does not have a device app-access credential. Ask your platform administrator to authorize an App Password reset, then reconnect this device so the signed credential can be installed.
            </p>
          </div>
        ) : gate === "failed" ? (
          <div className="mt-8">
            <h1 className="text-2xl font-black">App Lock unavailable</h1>
            <p className="mt-4 text-sm leading-6 text-red-200">{error}</p>
          </div>
        ) : (
          <form onSubmit={unlock} className="mt-8">
            <p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-200">Workspace locked</p>
            <h1 className="mt-3 text-3xl font-black">Welcome back</h1>
            <p className="mt-3 text-sm leading-6 text-neutral-400">Enter the app-access password for this device. Your ERP data stays local.</p>
            <label className="mt-7 block text-sm font-bold" htmlFor="app-lock-password">App-access password</label>
            <div className="mt-2 flex overflow-hidden rounded-2xl border border-white/10 bg-black focus-within:border-cyan-300/50">
              <input
                ref={passwordRef}
                id="app-lock-password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                disabled={submitting || remainingSeconds > 0}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => setCapsLock(event.getModifierState("CapsLock"))}
                onKeyUp={(event) => setCapsLock(event.getModifierState("CapsLock"))}
                className="h-14 min-w-0 flex-1 bg-transparent px-4 outline-none disabled:opacity-50"
              />
              <button type="button" onClick={() => setShowPassword((value) => !value)} className="min-h-11 px-4 text-xs font-black text-cyan-200">
                {showPassword ? "Hide" : "Show"}
              </button>
            </div>
            {capsLock && <p className="mt-2 text-xs font-semibold text-amber-200">Caps Lock is on.</p>}
            {error && <p role="alert" className="mt-3 text-sm leading-5 text-red-200">{error}</p>}
            {remainingSeconds > 0 && <p className="mt-2 text-xs text-neutral-400">Try again in {remainingSeconds} second{remainingSeconds === 1 ? "" : "s"}.</p>}
            <button
              type="submit"
              disabled={submitting || remainingSeconds > 0}
              className="mt-6 h-14 w-full rounded-2xl bg-cyan-300 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Unlocking…" : "Unlock Bezgrow"}
            </button>
          </form>
        )}
      </section>
    </main>
  )
}
