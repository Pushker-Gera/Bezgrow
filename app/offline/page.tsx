"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import LocalDatabaseRecovery from "@/components/offline/LocalDatabaseRecovery"
import PlatformAdminLauncher from "@/components/desktop/PlatformAdminLauncher"
import { markDesktopSessionActive } from "@/lib/desktop/session"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { activateOfflineLicense, localLicenseSnapshot, restoreLicensedWorkspaceContext } from "@/lib/offline/local/license"
import { getLocalDatabaseService } from "@/lib/offline/local/service"
import type { LicensePolicyResult } from "@/lib/license/policy"

type LicenseSnapshot = LicensePolicyResult & {
  device_id: string
}

function safeNextPath(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/dashboard"
  return value
}

export default function OfflinePage() {
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [deviceId, setDeviceId] = useState("")
  const [licenseKey, setLicenseKey] = useState("")
  const [status, setStatus] = useState<LicenseSnapshot | null>(null)
  const [notice, setNotice] = useState("")
  const [activating, setActivating] = useState(false)
  const [nextPath, setNextPath] = useState("/dashboard")
  const [checkingLocalDatabase, setCheckingLocalDatabase] = useState(true)
  const [localDatabaseError, setLocalDatabaseError] = useState("")
  const [desktopRuntime, setDesktopRuntime] = useState<boolean | null>(null)
  const [postLogout, setPostLogout] = useState(false)
  const [useAnotherLicense, setUseAnotherLicense] = useState(false)
  const [continuing, setContinuing] = useState(false)

  async function refreshStatus() {
    const snapshot = await localLicenseSnapshot()
    setDeviceId(snapshot.device_id)
    setStatus(snapshot)
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const requestedNextPath = safeNextPath(params.get("next"))
    const openedAfterLogout = params.get("reason") === "logged_out"
    setNextPath(requestedNextPath)
    setPostLogout(openedAfterLogout)

    queueMicrotask(async () => {
      try {
        const desktopRuntime = await isTauriRuntimeAsync().catch(() => false)
        setDesktopRuntime(desktopRuntime)
        if (desktopRuntime) {
          try {
            await getLocalDatabaseService().integrityReport()
          } catch (error) {
            setLocalDatabaseError(error instanceof Error ? error.message : "Bezgrow local database could not start.")
            return
          }
          const restoredWorkspace = openedAfterLogout ? null : await restoreLicensedWorkspaceContext().catch(() => null)
          const organizationId = restoredWorkspace?.organization?.id || restoredWorkspace?.membership?.organization_id || undefined
          const snapshot = await localLicenseSnapshot(organizationId).catch(() => null)
          if (snapshot) {
            setDeviceId(snapshot.device_id)
            setStatus(snapshot)
          }
          if (!openedAfterLogout && snapshot?.allowed && requestedNextPath.startsWith("/dashboard")) {
            router.replace(requestedNextPath)
            return
          }
        }
      } finally {
        setCheckingLocalDatabase(false)
      }
    })
    const storedMessage = sessionStorage.getItem("bezgrow:license-message")
    if (storedMessage) {
      setNotice(storedMessage)
      sessionStorage.removeItem("bezgrow:license-message")
    } else if (openedAfterLogout) {
      setNotice("You are signed out. Your local data, Device ID, and signed licence remain on this device.")
    } else if (params.get("reason") === "license_required") {
      setNotice("Please activate Bezgrow using your license key.")
    }
  }, [router])

  async function copyDeviceId() {
    if (!deviceId) return
    await navigator.clipboard.writeText(deviceId)
    setNotice("Device ID copied.")
  }

  async function activate(input: unknown) {
    setActivating(true)
    setNotice("")
    try {
      const result = await activateOfflineLicense(input)
      setLicenseKey("")
      setNotice(`License activated for ${result.license.business_name}.`)
      await refreshStatus()
      router.replace(nextPath)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "License could not be activated.")
    } finally {
      setActivating(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  async function importFile(file: File | null) {
    if (!file) return
    const text = await file.text()
    try {
      await activate(JSON.parse(text))
    } catch {
      await activate(text)
    }
  }

  async function continueWithStoredLicense() {
    if (!valid || continuing) return
    setContinuing(true)
    setNotice("")
    try {
      const workspace = await restoreLicensedWorkspaceContext()
      if (!workspace?.success) throw new Error("The licensed local workspace could not be restored.")
      markDesktopSessionActive()
      router.replace(nextPath)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The local workspace could not be opened.")
    } finally {
      setContinuing(false)
    }
  }

  const valid = status?.allowed
  const expiryText = status?.expiresAt ? new Date(status.expiresAt).toLocaleDateString() : "Not activated"
  const statusText = valid
    ? status?.reason?.toLowerCase().includes("grace")
      ? "Trial Active"
      : "Licence Active"
    : status?.status === "expired"
      ? "Licence Expired"
      : status?.status === "missing"
        ? "Activation Required"
        : "Update Licence Required"
  const heading = valid
    ? postLogout ? "Licence ready on this device." : "This device is licensed."
    : status?.status === "expired" ? "Update Bezgrow licence." : "Bezgrow licence activation."

  if (checkingLocalDatabase) return <LocalDatabaseRecovery checking />
  if (localDatabaseError) return <LocalDatabaseRecovery errorMessage={localDatabaseError} />
  if (desktopRuntime === false) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-black px-5 text-white">
        <section className="max-w-xl rounded-[32px] border border-cyan-400/20 bg-cyan-500/10 p-8 text-center">
          <p className="text-xs font-black uppercase tracking-[0.2em] text-cyan-200">Desktop activation</p>
          <h1 className="mt-4 text-3xl font-black">Activate Bezgrow in the desktop app.</h1>
          <p className="mt-4 leading-7 text-neutral-300">
            A browser cannot read or create the desktop SQLite workspace. License activation and ERP records remain on the customer&apos;s device.
          </p>
          <Link href="/download" className="mt-6 inline-flex min-h-12 items-center rounded-2xl bg-white px-6 font-black text-black">
            Download Bezgrow Desktop
          </Link>
        </section>
      </main>
    )
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-black px-5 py-8 text-white">
      <section className="w-full max-w-2xl rounded-[32px] border border-cyan-400/20 bg-cyan-500/10 p-8 text-center shadow-2xl">
        <p className="text-xs font-black uppercase tracking-[0.24em] text-cyan-200">Desktop Licence</p>
        <h1 className="mt-4 text-4xl font-black">{heading}</h1>
        <p className="mt-4 text-neutral-300">
          {valid
            ? "This signed licence is stored locally and can be verified without an internet connection."
            : "Send this Device ID to the admin, then paste the licence key or import the licence file received from admin."}
        </p>
        <div className="mt-7 rounded-3xl border border-white/10 bg-black/35 p-5 text-left">
          <p className="text-xs font-black uppercase tracking-[0.18em] text-neutral-500">Device ID</p>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row">
            <code className="min-h-12 flex-1 break-all rounded-2xl border border-white/10 bg-black/50 px-4 py-3 text-sm text-cyan-100">
              {deviceId || "Generating..."}
            </code>
            <button type="button" onClick={copyDeviceId} className="h-12 rounded-2xl bg-white px-5 text-sm font-black text-black">
              Copy
            </button>
          </div>
        </div>

        <div className="mt-5 rounded-3xl border border-white/10 bg-black/35 p-5 text-left">
          <p className="text-xs font-black uppercase tracking-[0.18em] text-neutral-500">Licence Status</p>
          <p className={`mt-3 text-lg font-black ${valid ? "text-emerald-200" : "text-amber-200"}`}>
            {statusText}
          </p>
          {!valid && <p className="mt-2 text-sm text-neutral-400">{status?.reason || "Please activate Bezgrow using your license key."}</p>}
          <p className="mt-2 text-sm text-neutral-400">Expiry: {expiryText}</p>
        </div>

        {(!valid || useAnotherLicense) && <div className="mt-5 text-left">
          <label>
            <span className="mb-2 block text-xs font-black uppercase tracking-[0.18em] text-neutral-500">Licence Key</span>
            <textarea
              value={licenseKey}
              onChange={(event) => setLicenseKey(event.target.value)}
              rows={5}
              placeholder="Paste admin-issued licence key"
              className="w-full resize-none rounded-3xl border border-white/10 bg-black/50 px-5 py-4 text-sm outline-none"
            />
          </label>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <button type="button" disabled={activating || !licenseKey.trim()} onClick={() => void activate(licenseKey)} className="h-12 rounded-2xl bg-white px-5 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-50">
              {activating ? "Activating..." : "Activate Licence"}
            </button>
            <button type="button" disabled={activating} onClick={() => fileInputRef.current?.click()} className="h-12 rounded-2xl border border-white/15 bg-white/10 px-5 text-sm font-black disabled:cursor-not-allowed disabled:opacity-50">
              Import Licence File
            </button>
            <input ref={fileInputRef} type="file" accept="application/json,.json,.lic,.txt" className="hidden" onChange={(event) => void importFile(event.target.files?.[0] || null)} />
          </div>
        </div>}

        {notice && <div className="mt-5 rounded-2xl border border-cyan-400/25 bg-cyan-500/10 px-5 py-3 text-sm text-cyan-100">{notice}</div>}

        {valid && (
          <div className="mt-7 grid gap-3 sm:grid-cols-2">
            <button type="button" onClick={() => void continueWithStoredLicense()} disabled={continuing} className="rounded-2xl bg-white px-5 py-3 font-black text-black disabled:opacity-50">
              {continuing ? "Opening..." : "Continue / Open Dashboard"}
            </button>
            <button type="button" onClick={() => setUseAnotherLicense((value) => !value)} className="rounded-2xl border border-white/15 bg-white/10 px-5 py-3 font-black">
              {useAnotherLicense ? "Keep Current Licence" : "Use Another Licence"}
            </button>
          </div>
        )}
        <PlatformAdminLauncher className="mt-5" />
      </section>
    </main>
  )
}
