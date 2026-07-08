"use client"

import { useEffect, useMemo, useState } from "react"
import { supabase } from "@/lib/supabase"

type PlatformSettings = {
  id?: string
  platform_name: string
  support_email: string
  maintenance_mode: boolean
  email_notifications: boolean
  auto_approvals: boolean
  inventory_tracking: boolean
  billing_automation: boolean
}

type LogRow = {
  id: string
  action: string | null
  description: string | null
  created_at: string | null
}

type AdminMetricsResponse = {
  success: boolean
  error?: string
  organizations?: unknown[]
  profiles?: Array<{ approved: boolean | null; is_suspended?: boolean | null }>
  usersCount?: number
  logs?: LogRow[]
}

type AdminSettingsResponse = {
  success: boolean
  error?: string
  message?: string
  settings?: Partial<PlatformSettings> | null
}

type LicenseSigningStatus = {
  configured: boolean
  privateKeyConfigured: boolean
  publicKeyConfigured: boolean
  production: boolean
  privateKeyEnv: string
  publicKeyEnv: string
  algorithm: string
  keyId: string | null
  keyStorePath: string
  integrity: "ok" | "missing" | "corrupted" | "unavailable"
  issue?: "configured" | "missing" | "invalid_format" | "mismatched_pair"
  canRegenerate: boolean
  message: string
  setupInstructions: string[]
  source?: string
  warning?: string
}

type AdminLicenseResponse = {
  success: boolean
  error?: string
  license_key?: string
  license_file?: Record<string, unknown>
  licenseSigning?: LicenseSigningStatus
}

type AdminLicenseStatusResponse = {
  success: boolean
  error?: string
  licenseSigning?: LicenseSigningStatus
  regenerated?: boolean
}

type LicenseForm = {
  customer_name: string
  customer_email: string
  business_name: string
  device_id: string
  plan_name: string
  expiry_date: string
  grace_period_days: number
  allowed_features: string[]
  notes: string
}

const defaultSettings: PlatformSettings = {
  platform_name: "Bezgrow ERP",
  support_email: "support@bezgrow.com",
  maintenance_mode: false,
  email_notifications: true,
  auto_approvals: false,
  inventory_tracking: true,
  billing_automation: true,
}

const defaultLicenseForm: LicenseForm = {
  customer_name: "",
  customer_email: "",
  business_name: "",
  device_id: "",
  plan_name: "Offline ERP",
  expiry_date: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  grace_period_days: 7,
  allowed_features: ["billing", "inventory", "customers", "orders", "reports", "backup"],
  notes: "",
}

const licenseFeatures = [
  "billing",
  "inventory",
  "customers",
  "orders",
  "purchase",
  "payments",
  "reports",
  "backup",
  "print",
  "settings",
]

const defaultLicenseSigningStatus: LicenseSigningStatus = {
  configured: false,
  privateKeyConfigured: false,
  publicKeyConfigured: false,
  production: false,
  privateKeyEnv: "BEZGROW_LICENSE_PRIVATE_KEY",
  publicKeyEnv: "NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY",
  algorithm: "ed25519",
  keyId: null,
  keyStorePath: "",
  integrity: "missing",
  issue: "missing",
  canRegenerate: false,
  message: "License signing keys are not configured.",
  setupInstructions: [
    "Run npm run generate-license-keys.",
    "Set BEZGROW_LICENSE_PRIVATE_KEY to the printed raw base64url private key in the server environment.",
    "Set NEXT_PUBLIC_BEZGROW_LICENSE_PUBLIC_KEY to the printed raw base64url public key in the app/client environment and rebuild the desktop/web app.",
    "Do not use PEM blocks, quotes, or generated key files.",
  ],
}

function licenseSigningHeadline(status: LicenseSigningStatus) {
  if (status.configured || status.issue === "configured") return "Licensing configured"
  if (status.issue === "invalid_format") return "License key format invalid"
  if (status.issue === "mismatched_pair") return "License keys mismatched"
  if (status.issue === "missing" || status.integrity === "missing") return "License keys missing"
  return "License keys invalid"
}

function ToggleCard({
  title,
  description,
  enabled,
  disabled = false,
  onClick,
}: {
  title: string
  description: string
  enabled: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-3xl border p-5 text-left transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-50 ${enabled ? "border-cyan-400/30 bg-cyan-500/10" : "border-white/10 bg-black/35"}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-lg font-black">{title}</p>
          <p className="mt-2 text-sm leading-6 text-neutral-500">{description}</p>
        </div>
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${enabled ? "bg-cyan-400 text-black" : "bg-white/10 text-white"}`}>
          {enabled ? "On" : "Off"}
        </span>
      </div>
    </button>
  )
}

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<PlatformSettings>(defaultSettings)
  const [organizationsCount, setOrganizationsCount] = useState(0)
  const [usersCount, setUsersCount] = useState(0)
  const [pendingCount, setPendingCount] = useState(0)
  const [logs, setLogs] = useState<LogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")
  const [licenseForm, setLicenseForm] = useState<LicenseForm>(defaultLicenseForm)
  const [generatingLicense, setGeneratingLicense] = useState(false)
  const [generatedLicenseKey, setGeneratedLicenseKey] = useState("")
  const [generatedLicenseFile, setGeneratedLicenseFile] = useState<Record<string, unknown> | null>(null)
  const [licenseSigning, setLicenseSigning] = useState<LicenseSigningStatus>(defaultLicenseSigningStatus)

  async function fetchSettings() {
    setLoading(true)
    setNotice("")

    try {
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession()

      if (sessionError) {
        setNotice("Admin session could not be checked. Retrying with secure cookies.")
      }

      const [settingsResponse, metricsResponse, licenseStatusResponse] = await Promise.all([
        fetch("/api/admin/settings", {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
          cache: "no-store",
        }),
        fetch("/api/admin/metrics", {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
          cache: "no-store",
        }),
        fetch("/api/admin/license/generate", {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
          cache: "no-store",
        }),
      ])

      const settingsPayload = (await settingsResponse.json()) as AdminSettingsResponse
      const metrics = (await metricsResponse.json()) as AdminMetricsResponse
      const licenseStatus = (await licenseStatusResponse.json()) as AdminLicenseStatusResponse

      if (!settingsResponse.ok || !settingsPayload.success) {
        setNotice(settingsPayload.error || "Platform settings failed to load.")
      }

      if (!metricsResponse.ok || !metrics.success) {
        setNotice(metrics.error || "Admin settings metrics failed to load.")
      }

      if (licenseStatusResponse.ok && licenseStatus.success && licenseStatus.licenseSigning) {
        setLicenseSigning(licenseStatus.licenseSigning)
      } else {
        setLicenseSigning({
          ...defaultLicenseSigningStatus,
          message: licenseStatus.error || "License signing status could not be checked.",
        })
      }

      const pendingProfiles = (metrics.profiles || []).filter((profile) => profile.approved === false && !profile.is_suspended)

      if (settingsPayload.settings) {
        setSettings({
          ...defaultSettings,
          ...settingsPayload.settings,
        })
      }

      setOrganizationsCount(metrics.organizations?.length || 0)
      setUsersCount(metrics.usersCount || metrics.profiles?.length || 0)
      setPendingCount(pendingProfiles.length)
      setLogs(metrics.logs || [])
    } catch {
      setNotice("Admin settings could not connect. Please refresh or try again later.")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    queueMicrotask(() => {
      void fetchSettings()
    })
  }, [])

  const launchChecks = useMemo(
    () => [
      ["Platform identity", Boolean(settings.platform_name && settings.support_email)],
      ["Billing automation", settings.billing_automation],
      ["Inventory tracking", settings.inventory_tracking],
      ["Notification channel", settings.email_notifications],
      ["License signing configured", licenseSigning.configured],
      ["Legacy access queue clear", pendingCount === 0],
      ["Live customer workspaces", organizationsCount > 0],
    ],
    [licenseSigning.configured, organizationsCount, pendingCount, settings]
  )

  const launchScore = Math.round((launchChecks.filter(([, ready]) => ready).length / launchChecks.length) * 100)

  function updateSetting<K extends keyof PlatformSettings>(field: K, value: PlatformSettings[K]) {
    setSettings((current) => ({ ...current, [field]: value }))
  }

  async function saveSettings() {
    setSaving(true)
    setNotice("")

    try {
      const supportEmail = settings.support_email.trim().toLowerCase()
      const platformName = settings.platform_name.trim()

      if (!platformName) {
        setNotice("Platform name is required.")
        return
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) {
        setNotice("Enter a valid support email address.")
        return
      }

      const payload = {
        ...settings,
        platform_name: platformName,
        support_email: supportEmail,
      }

      const {
        data: { session },
      } = await supabase.auth.getSession()

      const response = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify(payload),
      })
      const result = (await response.json()) as AdminSettingsResponse

      if (!response.ok || !result.success) {
        setNotice(result.error || "Platform settings could not be saved.")
        return
      }

      setNotice("Platform settings saved successfully.")
      await fetchSettings()
    } catch {
      setNotice("Settings could not be saved. Please try again.")
    } finally {
      setSaving(false)
    }
  }

  async function writeSystemLog(action: string, description: string, showNotice = true) {
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const response = await fetch("/api/admin/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ action, description }),
      })
      const result = (await response.json()) as AdminSettingsResponse

      if (showNotice) setNotice(response.ok && result.success ? description : result.error || "System action could not be recorded.")
      if (response.ok && result.success) await fetchSettings()
    } catch {
      if (showNotice) setNotice("System action could not be recorded.")
    }
  }

  function updateLicenseForm<K extends keyof LicenseForm>(field: K, value: LicenseForm[K]) {
    setLicenseForm((current) => ({ ...current, [field]: value }))
  }

  function toggleLicenseFeature(feature: string) {
    setLicenseForm((current) => ({
      ...current,
      allowed_features: current.allowed_features.includes(feature)
        ? current.allowed_features.filter((item) => item !== feature)
        : [...current.allowed_features, feature].sort(),
    }))
  }

  async function generateLicense() {
    setGeneratingLicense(true)
    setNotice("")
    setGeneratedLicenseKey("")
    setGeneratedLicenseFile(null)

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()
      const response = await fetch("/api/admin/license/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify(licenseForm),
      })
      const result = (await response.json()) as AdminLicenseResponse
      if (!response.ok || !result.success || !result.license_key) {
        if (result.licenseSigning) setLicenseSigning(result.licenseSigning)
        setNotice(result.error || "License could not be generated.")
        return
      }
      setGeneratedLicenseKey(result.license_key)
      setGeneratedLicenseFile(result.license_file || null)
      setNotice("Offline license generated successfully.")
      await fetchSettings()
    } catch {
      setNotice("License could not be generated.")
    } finally {
      setGeneratingLicense(false)
    }
  }

  async function copyGeneratedLicense() {
    if (!generatedLicenseKey) return
    await navigator.clipboard.writeText(generatedLicenseKey)
    setNotice("License key copied.")
  }

  function downloadGeneratedLicense() {
    if (!generatedLicenseFile) return
    const blob = new Blob([JSON.stringify(generatedLicenseFile, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `bezgrow-license-${licenseForm.business_name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "offline"}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-8 text-white">
      <section className="inventory-sheen rounded-[40px] border border-white/10 bg-white/[0.035] p-8 shadow-[0_0_90px_rgba(0,0,0,0.5)]">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="mb-4 text-xs font-bold uppercase tracking-[0.24em] text-cyan-200">Platform Configuration</p>
            <h1 className="max-w-5xl text-4xl font-black leading-tight md:text-6xl">Global SaaS settings, launch controls, and audit operations.</h1>
            <p className="mt-5 max-w-3xl text-neutral-400">Control platform identity, license issuance, customer notifications, billing, inventory, maintenance mode, and admin audit actions.</p>
          </div>
          <button type="button" onClick={saveSettings} disabled={saving || loading} className="h-14 rounded-2xl bg-white px-7 font-black text-black disabled:cursor-not-allowed disabled:opacity-50">
            {saving ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </section>

      {notice && <div className="rounded-3xl border border-cyan-400/25 bg-cyan-500/10 px-6 py-4 text-sm text-cyan-100">{notice}</div>}

      {loading && (
        <div className="rounded-3xl border border-white/10 bg-white/[0.035] px-6 py-4 text-sm font-semibold text-neutral-300">
          Loading secure platform settings...
        </div>
      )}

      <section className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-4">
        {[
          ["Organizations", organizationsCount, "text-white", "Customer workspaces"],
          ["Users", usersCount, "text-cyan-200", "Registered profiles"],
          ["Legacy Queue", pendingCount, "text-amber-200", "Old access requests"],
          ["Launch Score", `${launchScore}%`, launchScore >= 85 ? "text-emerald-200" : "text-amber-200", "Admin readiness"],
        ].map(([label, value, color, helper]) => (
          <div key={label} className="rounded-[32px] border border-white/10 bg-gradient-to-br from-zinc-950 via-black to-zinc-950 p-7">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">{label}</p>
            <p className={`mt-5 text-4xl font-black ${color}`}>{value}</p>
            <p className="mt-3 text-sm text-neutral-500">{helper}</p>
          </div>
        ))}
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr,440px]">
        <div className="rounded-[36px] border border-white/10 bg-white/[0.035] p-7">
          <h2 className="text-3xl font-black">General Settings</h2>
          <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
            <label>
              <span className="mb-2 block text-xs font-black uppercase tracking-[0.18em] text-neutral-500">Platform Name</span>
              <input value={settings.platform_name} onChange={(event) => updateSetting("platform_name", event.target.value)} placeholder="Platform name" className="h-14 w-full rounded-2xl border border-white/10 bg-black/50 px-5 outline-none" />
            </label>
            <label>
              <span className="mb-2 block text-xs font-black uppercase tracking-[0.18em] text-neutral-500">Support Email</span>
              <input type="email" value={settings.support_email} onChange={(event) => updateSetting("support_email", event.target.value)} placeholder="Support email" className="h-14 w-full rounded-2xl border border-white/10 bg-black/50 px-5 outline-none" />
            </label>
          </div>

          <div className="mt-7 grid grid-cols-1 gap-4 md:grid-cols-2">
            <ToggleCard
              title="Maintenance Mode"
              description="Pause customer operations during planned platform maintenance."
              enabled={settings.maintenance_mode}
              disabled={saving || loading}
              onClick={() => updateSetting("maintenance_mode", !settings.maintenance_mode)}
            />
            <ToggleCard
              title="Email Notifications"
              description="Send license, billing, and operational notifications from the platform."
              enabled={settings.email_notifications}
              disabled={saving || loading}
              onClick={() => updateSetting("email_notifications", !settings.email_notifications)}
            />
            <ToggleCard
              title="Legacy Auto Access"
              description="Kept for older cloud accounts only. Offline desktop access uses admin-issued licenses."
              enabled={settings.auto_approvals}
              disabled={saving || loading}
              onClick={() => updateSetting("auto_approvals", !settings.auto_approvals)}
            />
            <ToggleCard
              title="Inventory Tracking"
              description="Enable product stock intelligence, low-stock alerts, and inventory modules."
              enabled={settings.inventory_tracking}
              disabled={saving || loading}
              onClick={() => updateSetting("inventory_tracking", !settings.inventory_tracking)}
            />
            <ToggleCard
              title="Billing Automation"
              description="Enable invoices, payment status control, print routes, and billing automation."
              enabled={settings.billing_automation}
              disabled={saving || loading}
              onClick={() => updateSetting("billing_automation", !settings.billing_automation)}
            />
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-[36px] border border-cyan-400/20 bg-cyan-500/10 p-7">
            <h2 className="text-3xl font-black">Launch Readiness</h2>
            <p className="mt-2 text-sm text-neutral-400">Checks for operating globally before customer launch.</p>
            <div className="mt-6 space-y-3">
              {launchChecks.map(([label, ready]) => (
                <div key={String(label)} className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/35 px-4 py-3">
                  <span className="text-sm text-neutral-300">{label}</span>
                  <span className={`rounded-full px-3 py-1 text-xs font-black ${ready ? "bg-emerald-400 text-black" : "bg-amber-400 text-black"}`}>
                    {ready ? "Ready" : "Needs Work"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[36px] border border-white/10 bg-white/[0.035] p-7">
            <h2 className="text-3xl font-black">System Actions</h2>
            <div className="mt-6 grid gap-3">
              <button type="button" disabled={loading || saving} onClick={() => void writeSystemLog("CACHE_CLEAR", "Platform cache clear requested by admin.")} className="h-12 rounded-2xl border border-white/10 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50">Log Cache Clear</button>
              <button type="button" disabled={loading || saving} onClick={() => void writeSystemLog("BACKUP_REQUESTED", "Secure platform backup requested by admin.")} className="h-12 rounded-2xl border border-white/10 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50">Log Backup</button>
              <button type="button" disabled={loading || saving} onClick={() => void writeSystemLog("SERVICE_CHECK", "Platform service check requested by admin.")} className="h-12 rounded-2xl border border-white/10 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50">Log Service Check</button>
              <button type="button" disabled={loading || saving} onClick={() => void writeSystemLog("SECURITY_REVIEW", "Security and RLS review requested before global launch.")} className="h-12 rounded-2xl border border-white/10 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50">Log Security Review</button>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-[36px] border border-white/10 bg-white/[0.035] p-7">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h2 className="text-3xl font-black">Offline License Generator</h2>
            <p className="mt-2 max-w-3xl text-sm text-neutral-400">Create admin-issued licenses for customer devices. The customer activates by pasting the key or importing the file on the offline screen.</p>
          </div>
          <button type="button" disabled={generatingLicense || loading || !licenseSigning.configured} onClick={() => void generateLicense()} className="h-12 rounded-2xl bg-white px-6 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-50">
            {generatingLicense ? "Generating..." : "Generate License"}
          </button>
        </div>

        <div className={`mt-6 rounded-3xl border p-5 ${licenseSigning.configured ? "border-emerald-400/25 bg-emerald-500/10" : "border-red-400/25 bg-red-500/10"}`}>
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <p className={`text-lg font-black ${licenseSigning.configured ? "text-emerald-100" : "text-red-100"}`}>
                {licenseSigningHeadline(licenseSigning)}
              </p>
              <p className="mt-2 text-sm leading-6 text-neutral-300">{licenseSigning.message}</p>
              {licenseSigning.warning && <p className="mt-2 text-sm leading-6 text-amber-200">{licenseSigning.warning}</p>}
              <p className="mt-2 text-xs leading-5 text-neutral-500">
                Algorithm: {licenseSigning.algorithm.toUpperCase()} · Key ID: {licenseSigning.keyId || "pending"} · Integrity: {licenseSigning.integrity}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className={`w-fit rounded-full px-3 py-1 text-xs font-black ${licenseSigning.privateKeyConfigured ? "bg-emerald-400 text-black" : "bg-amber-400 text-black"}`}>
                {licenseSigning.privateKeyConfigured ? "Private key ready" : "Private key missing"}
              </span>
              <span className={`w-fit rounded-full px-3 py-1 text-xs font-black ${licenseSigning.publicKeyConfigured ? "bg-emerald-400 text-black" : "bg-amber-400 text-black"}`}>
                {licenseSigning.publicKeyConfigured ? "Public key ready" : "Public key pending"}
              </span>
            </div>
          </div>
          {!licenseSigning.configured && (
            <div className="mt-4 rounded-2xl border border-white/10 bg-black/35 p-4">
              <p className="text-xs font-black uppercase tracking-[0.18em] text-neutral-500">Setup</p>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-neutral-300">
                {licenseSigning.setupInstructions.map((instruction) => (
                  <li key={instruction}>{instruction}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <label>
            <span className="mb-2 block text-xs font-black uppercase tracking-[0.18em] text-neutral-500">Customer Name</span>
            <input value={licenseForm.customer_name} onChange={(event) => updateLicenseForm("customer_name", event.target.value)} className="h-14 w-full rounded-2xl border border-white/10 bg-black/50 px-5 outline-none" />
          </label>
          <label>
            <span className="mb-2 block text-xs font-black uppercase tracking-[0.18em] text-neutral-500">Customer Email</span>
            <input type="email" value={licenseForm.customer_email} onChange={(event) => updateLicenseForm("customer_email", event.target.value.trim())} className="h-14 w-full rounded-2xl border border-white/10 bg-black/50 px-5 outline-none" />
          </label>
          <label>
            <span className="mb-2 block text-xs font-black uppercase tracking-[0.18em] text-neutral-500">Business Name</span>
            <input value={licenseForm.business_name} onChange={(event) => updateLicenseForm("business_name", event.target.value)} className="h-14 w-full rounded-2xl border border-white/10 bg-black/50 px-5 outline-none" />
          </label>
          <label>
            <span className="mb-2 block text-xs font-black uppercase tracking-[0.18em] text-neutral-500">Device ID</span>
            <input value={licenseForm.device_id} onChange={(event) => updateLicenseForm("device_id", event.target.value.trim())} className="h-14 w-full rounded-2xl border border-white/10 bg-black/50 px-5 outline-none" />
          </label>
          <label>
            <span className="mb-2 block text-xs font-black uppercase tracking-[0.18em] text-neutral-500">Plan Name</span>
            <input value={licenseForm.plan_name} onChange={(event) => updateLicenseForm("plan_name", event.target.value)} className="h-14 w-full rounded-2xl border border-white/10 bg-black/50 px-5 outline-none" />
          </label>
          <label>
            <span className="mb-2 block text-xs font-black uppercase tracking-[0.18em] text-neutral-500">Expiry Date</span>
            <input type="date" value={licenseForm.expiry_date} onChange={(event) => updateLicenseForm("expiry_date", event.target.value)} className="h-14 w-full rounded-2xl border border-white/10 bg-black/50 px-5 outline-none" />
          </label>
          <label>
            <span className="mb-2 block text-xs font-black uppercase tracking-[0.18em] text-neutral-500">Grace Days</span>
            <input type="number" min={0} max={365} value={licenseForm.grace_period_days} onChange={(event) => updateLicenseForm("grace_period_days", Number(event.target.value || 0))} className="h-14 w-full rounded-2xl border border-white/10 bg-black/50 px-5 outline-none" />
          </label>
        </div>

        <div className="mt-6">
          <p className="mb-3 text-xs font-black uppercase tracking-[0.18em] text-neutral-500">Allowed Features</p>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {licenseFeatures.map((feature) => {
              const selected = licenseForm.allowed_features.includes(feature)
              return (
                <button
                  key={feature}
                  type="button"
                  onClick={() => toggleLicenseFeature(feature)}
                  className={`h-11 rounded-2xl border text-sm font-bold ${selected ? "border-cyan-400/30 bg-cyan-500/10 text-cyan-100" : "border-white/10 bg-black/35 text-neutral-400"}`}
                >
                  {feature}
                </button>
              )
            })}
          </div>
        </div>

        <label className="mt-6 block">
          <span className="mb-2 block text-xs font-black uppercase tracking-[0.18em] text-neutral-500">Notes</span>
          <textarea value={licenseForm.notes} onChange={(event) => updateLicenseForm("notes", event.target.value)} rows={3} className="w-full resize-none rounded-3xl border border-white/10 bg-black/50 px-5 py-4 text-sm outline-none" />
        </label>

        {generatedLicenseKey && (
          <div className="mt-6 rounded-3xl border border-cyan-400/20 bg-cyan-500/10 p-5">
            <p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-200">Generated License</p>
            <textarea readOnly value={generatedLicenseKey} rows={5} className="mt-3 w-full resize-none rounded-2xl border border-white/10 bg-black/50 px-4 py-3 text-xs text-cyan-100 outline-none" />
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <button type="button" onClick={() => void copyGeneratedLicense()} className="h-12 rounded-2xl bg-white px-5 text-sm font-black text-black">Copy Key</button>
              <button type="button" onClick={downloadGeneratedLicense} className="h-12 rounded-2xl border border-white/15 bg-white/10 px-5 text-sm font-black">Download File</button>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-[36px] border border-white/10 bg-gradient-to-br from-zinc-950/95 to-black p-7">
        <h2 className="text-3xl font-black">Admin Audit Trail</h2>
        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {logs.length ? (
            logs.map((log) => (
              <div key={log.id} className="rounded-3xl border border-white/10 bg-black/35 p-5">
                <p className="font-bold">{log.action || "Admin Action"}</p>
                <p className="mt-2 text-sm text-neutral-500">{log.description || "Activity recorded."}</p>
                <p className="mt-3 text-xs text-neutral-600">{log.created_at ? new Date(log.created_at).toLocaleString() : ""}</p>
              </div>
            ))
          ) : (
            <div className="text-neutral-500">No admin logs yet.</div>
          )}
        </div>
      </section>
    </div>
  )
}
