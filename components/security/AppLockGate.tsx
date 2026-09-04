"use client"

import type { FormEvent, ReactNode } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { BezgrowLogoMark } from "@/components/brand/BezgrowLogoMark"
import PlatformAdminLauncher from "@/components/desktop/PlatformAdminLauncher"
import {
  APP_LOCK_CREDENTIAL_CHANGED_EVENT,
  APP_LOCK_EVENT,
  APP_LOCK_PROVISIONING_STATUS_EVENT,
  getAppLockStatus,
  readAutoLockDelay,
  type AppLockProvisioningStatus,
  verifyAppPassword,
} from "@/lib/app-lock/client"
import {
  APP_LOCK_STATES,
  appLockStateFrom,
  transitionAppLockState,
  type AppLockState,
} from "@/lib/app-lock/state"
import {
  activateOfflineLicense,
  localLicenseSnapshot,
  reconcileLocalAppLockCredential,
  revalidateLocalLicenseWithControlPlane,
} from "@/lib/offline/local/license"

const THROTTLE_KEY = "bezgrow:app-lock-throttle-v1"

type GateState = AppLockState | "CHECKING" | "FAILED"
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
  const [gate, setGate] = useState<GateState>("CHECKING")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [provisioningStatus, setProvisioningStatus] = useState("Checking for app-access credential…")
  const [blockedUntil, setBlockedUntil] = useState(0)
  const [now, setNow] = useState(Date.now())
  const passwordRef = useRef<HTMLInputElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const refreshRunningRef = useRef(false)
  const lastAutomaticRefreshRef = useRef(0)
  const mountedRef = useRef(false)
  const credentialRevisionRef = useRef(0)

  const loadCredentialState = useCallback(async () => {
    const revision = credentialRevisionRef.current
    try {
      const [status, snapshot] = await Promise.all([getAppLockStatus(), localLicenseSnapshot()])
      if (!mountedRef.current || revision !== credentialRevisionRef.current) return
      const next = appLockStateFrom({ licenceValid: snapshot.allowed, credentialExists: status.enabled })
      setBlockedUntil(readThrottle().blockedUntil)
      setGate(next)
      if (!snapshot.allowed) setProvisioningStatus(snapshot.reason || "The local licence is not valid.")
      return next
    } catch (cause) {
      if (!mountedRef.current || revision !== credentialRevisionRef.current) return
      setError(cause instanceof Error ? cause.message : "App Lock could not be initialized.")
      setGate("FAILED")
    }
  }, [])

  const refreshAppLock = useCallback(async (manual = false) => {
    if (!mountedRef.current || refreshRunningRef.current) return
    const current = Date.now()
    if (!manual && current - lastAutomaticRefreshRef.current < 3_000) return
    lastAutomaticRefreshRef.current = current

    refreshRunningRef.current = true
    setRefreshing(true)
    setError("")
    setProvisioningStatus("Checking for app-access credential…")
    try {
      let localReconciliationError = ""
      try {
        await reconcileLocalAppLockCredential()
      } catch (cause) {
        localReconciliationError = cause instanceof Error ? cause.message : "The signed local credential could not be installed."
      }
      let checkStatus = "offline"
      if (navigator.onLine) {
        // Existing credentials must also receive resets on return from Admin.
        // Network failure never prevents verification with a valid local one.
        try {
          const result = await revalidateLocalLicenseWithControlPlane()
          checkStatus = result.check.status
          localReconciliationError = ""
        } catch (cause) {
          checkStatus = "network_error"
          localReconciliationError = cause instanceof Error ? cause.message : "The licence refresh could not be completed."
        }
        await reconcileLocalAppLockCredential().catch((cause) => {
          localReconciliationError = cause instanceof Error ? cause.message : localReconciliationError
        })
      }

      const [status, snapshot] = await Promise.all([getAppLockStatus(), localLicenseSnapshot()])
      if (!mountedRef.current) return
      if (!snapshot.allowed) {
        setGate(APP_LOCK_STATES.noValidLicence)
        setProvisioningStatus(snapshot.reason || "The local licence is not valid.")
        return
      }
      if (status.enabled) {
        setProvisioningStatus("App Lock ready.")
        // An unchanged credential does not interrupt an unlocked workspace.
        // Credential installation emits its own event which always locks it.
        setGate((state) => state === APP_LOCK_STATES.unlocked ? state : APP_LOCK_STATES.locked)
        return
      }

      setGate(APP_LOCK_STATES.provisioningRequired)
      setProvisioningStatus(
        localReconciliationError
          || (checkStatus === "offline"
          ? "Connect to the internet to receive a new administrator-authorized credential."
          : checkStatus === "network_error"
          ? "The control plane could not be reached. Check the connection and try again."
          : checkStatus === "rejected"
            ? "The licence refresh was not accepted. Import the latest signed licence or contact support."
            : "No app-access credential is available yet. Ask the administrator to authorize a reset, then refresh again."),
      )
    } catch (cause) {
      if (!mountedRef.current) return
      const message = cause instanceof Error ? cause.message : "App Lock refresh failed."
      setError(message)
      setProvisioningStatus(message)
      // An unreadable secure store is different from a genuinely missing
      // credential; do not silently turn it into a provisioning request.
      setGate("FAILED")
    } finally {
      refreshRunningRef.current = false
      if (mountedRef.current) setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void loadCredentialState()
    return () => { mountedRef.current = false }
  }, [loadCredentialState])

  useEffect(() => {
    if (gate !== APP_LOCK_STATES.locked) return
    passwordRef.current?.focus()
  }, [gate])

  useEffect(() => {
    const credentialChanged = () => {
      credentialRevisionRef.current += 1
      localStorage.removeItem(THROTTLE_KEY)
      setBlockedUntil(0)
      setPassword("")
      setError("")
      setGate((state) => state === "CHECKING" || state === "FAILED"
        ? "CHECKING"
        : transitionAppLockState(state, "CREDENTIAL_INSTALLED"))
      void loadCredentialState()
    }
    const provisioningChanged = (event: Event) => {
      const status = (event as CustomEvent<AppLockProvisioningStatus>).detail
      if (status === "credential-received") setProvisioningStatus("Credential received.")
      if (status === "installing") setProvisioningStatus("Installing secure credential…")
      if (status === "ready") setProvisioningStatus("App Lock ready.")
    }
    window.addEventListener(APP_LOCK_CREDENTIAL_CHANGED_EVENT, credentialChanged)
    window.addEventListener(APP_LOCK_PROVISIONING_STATUS_EVENT, provisioningChanged)
    return () => {
      window.removeEventListener(APP_LOCK_CREDENTIAL_CHANGED_EVENT, credentialChanged)
      window.removeEventListener(APP_LOCK_PROVISIONING_STATUS_EVENT, provisioningChanged)
    }
  }, [loadCredentialState])

  const canRefresh = gate !== "CHECKING" && gate !== "FAILED"
  useEffect(() => {
    if (!canRefresh) return
    const refreshWhenAvailable = () => {
      if (document.visibilityState !== "hidden") void refreshAppLock(false)
    }
    void refreshAppLock(false)
    window.addEventListener("online", refreshWhenAvailable)
    window.addEventListener("focus", refreshWhenAvailable)
    document.addEventListener("visibilitychange", refreshWhenAvailable)
    return () => {
      window.removeEventListener("online", refreshWhenAvailable)
      window.removeEventListener("focus", refreshWhenAvailable)
      document.removeEventListener("visibilitychange", refreshWhenAvailable)
    }
  }, [canRefresh, refreshAppLock])

  useEffect(() => {
    if (gate !== APP_LOCK_STATES.provisioningRequired) return
    const refreshWhenAvailable = () => {
      if (document.visibilityState !== "hidden") void refreshAppLock(false)
    }
    const timer = globalThis.setInterval(refreshWhenAvailable, 30_000)
    return () => globalThis.clearInterval(timer)
  }, [gate, refreshAppLock])

  useEffect(() => {
    if (blockedUntil <= Date.now()) return
    const timer = globalThis.setInterval(() => setNow(Date.now()), 500)
    return () => globalThis.clearInterval(timer)
  }, [blockedUntil])

  useEffect(() => {
    if (gate !== APP_LOCK_STATES.unlocked) return
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
      setGate((state) => state === "CHECKING" || state === "FAILED"
        ? state
        : transitionAppLockState(state, "LOCK_REQUESTED"))
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
    if (gate !== APP_LOCK_STATES.locked || submitting) return
    const revision = credentialRevisionRef.current
    const current = Date.now()
    if (blockedUntil > current) return
    if (!password) {
      setError("Enter the app-access password.")
      return
    }
    setSubmitting(true)
    setError("")
    try {
      const accepted = await verifyAppPassword(password)
      if (!mountedRef.current || revision !== credentialRevisionRef.current) return
      if (accepted) {
        localStorage.removeItem(THROTTLE_KEY)
        setPassword("")
        setBlockedUntil(0)
        setGate((state) => state === "CHECKING" || state === "FAILED"
          ? state
          : transitionAppLockState(state, "PASSWORD_ACCEPTED"))
        return
      }
      const previous = readThrottle()
      const attempts = previous.attempts + 1
      const nextBlockedUntil = Date.now() + throttleDelay(attempts)
      localStorage.setItem(THROTTLE_KEY, JSON.stringify({ attempts, blockedUntil: nextBlockedUntil }))
      setBlockedUntil(nextBlockedUntil)
      setNow(Date.now())
      setPassword("")
      setGate((state) => state === "CHECKING" || state === "FAILED"
        ? state
        : transitionAppLockState(state, "PASSWORD_REJECTED"))
      setError("Incorrect password.")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The password could not be verified.")
    } finally {
      setSubmitting(false)
    }
  }

  async function importLicence(file: File | null) {
    if (!file || refreshRunningRef.current) return
    refreshRunningRef.current = true
    setRefreshing(true)
    setError("")
    setProvisioningStatus("Verifying the signed licence…")
    try {
      const text = await file.text()
      let input: unknown = text
      try {
        input = JSON.parse(text)
      } catch {
        // Plain signed licence keys are accepted directly.
      }
      await activateOfflineLicense(input)
      const status = await getAppLockStatus()
      if (!status.enabled) throw new Error("The imported licence does not contain an app-access credential.")
      setProvisioningStatus("App Lock ready.")
      setGate(APP_LOCK_STATES.locked)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The licence could not be imported."
      setError(message)
      setProvisioningStatus(message)
    } finally {
      refreshRunningRef.current = false
      setRefreshing(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  if (gate === APP_LOCK_STATES.unlocked) return children

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

        {gate === "CHECKING" ? (
          <div className="py-16 text-center text-sm font-semibold text-neutral-400">Securing this workspace…</div>
        ) : gate === APP_LOCK_STATES.provisioningRequired ? (
          <div className="mt-8">
            <h1 className="text-2xl font-black">App Lock setup required</h1>
            <p className="mt-4 text-sm leading-6 text-neutral-400">
              This device has not yet received its app-access password credential.
            </p>
            <div role="status" className="mt-5 rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.06] px-4 py-3 text-sm leading-6 text-cyan-100">
              {provisioningStatus}
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                disabled={refreshing}
                onClick={() => void refreshAppLock(true)}
                className="min-h-12 rounded-2xl bg-cyan-300 px-4 text-sm font-black text-black disabled:cursor-wait disabled:opacity-50"
              >
                {refreshing ? "Refreshing…" : "Refresh App Lock"}
              </button>
              <button
                type="button"
                disabled={refreshing}
                onClick={() => fileInputRef.current?.click()}
                className="min-h-12 rounded-2xl border border-white/15 bg-white/[0.06] px-4 text-sm font-black disabled:cursor-wait disabled:opacity-50"
              >
                Import / Refresh Licence
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json,.lic,.txt"
                className="hidden"
                onChange={(event) => void importLicence(event.target.files?.[0] || null)}
              />
            </div>
            {error && <p role="alert" className="mt-3 text-sm leading-5 text-red-200">{error}</p>}
          </div>
        ) : gate === APP_LOCK_STATES.noValidLicence ? (
          <div className="mt-8">
            <h1 className="text-2xl font-black">Licence refresh required</h1>
            <p className="mt-4 text-sm leading-6 text-neutral-400">{provisioningStatus}</p>
            <button
              type="button"
              disabled={refreshing}
              onClick={() => fileInputRef.current?.click()}
              className="mt-5 min-h-12 w-full rounded-2xl bg-white px-4 text-sm font-black text-black disabled:opacity-50"
            >
              Import / Refresh Licence
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json,.lic,.txt"
              className="hidden"
              onChange={(event) => void importLicence(event.target.files?.[0] || null)}
            />
          </div>
        ) : gate === "FAILED" ? (
          <div className="mt-8">
            <h1 className="text-2xl font-black">App Lock unavailable</h1>
            <p className="mt-4 text-sm leading-6 text-red-200">{error}</p>
            <button type="button" onClick={() => void loadCredentialState()} className="mt-5 min-h-12 w-full rounded-2xl bg-white px-4 text-sm font-black text-black">
              Retry App Lock
            </button>
          </div>
        ) : (
          <form onSubmit={unlock} className="mt-8">
            <p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-200">Workspace locked</p>
            <h1 className="mt-3 text-3xl font-black">Enter App Password</h1>
            <p className="mt-3 text-sm leading-6 text-neutral-400">Unlock this device to open the local ERP workspace.</p>
            <label className="mt-7 block text-sm font-bold" htmlFor="app-lock-password">App Password</label>
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
            <p className="mt-3 text-xs text-neutral-500">Forgot password? Contact your administrator.</p>
            <button
              type="submit"
              disabled={submitting || remainingSeconds > 0}
              className="mt-6 h-14 w-full rounded-2xl bg-cyan-300 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Unlocking…" : "Unlock Bezgrow"}
            </button>
          </form>
        )}
        <PlatformAdminLauncher className="mt-5" />
      </section>
    </main>
  )
}
