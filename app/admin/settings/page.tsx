"use client"

import { useEffect, useMemo, useState } from "react"
import { supabase } from "@/lib/supabase"

type PlatformSettings = {
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
  profiles?: Array<{ approved: boolean | null }>
  usersCount?: number
  logs?: LogRow[]
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

function ToggleCard({
  title,
  description,
  enabled,
  onClick,
}: {
  title: string
  description: string
  enabled: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-3xl border p-5 text-left transition-all duration-300 ${enabled ? "border-cyan-400/30 bg-cyan-500/10" : "border-white/10 bg-black/35"}`}
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
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")

  async function fetchSettings() {
    const settingsResult = await supabase.from("platform_settings").select("*").maybeSingle()
    const {
      data: { session },
    } = await supabase.auth.getSession()

    if (!session?.access_token) {
      setNotice("Admin session not found. Please log in again.")
      return
    }

    const metricsResponse = await fetch("/api/admin/metrics", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
    const metrics = (await metricsResponse.json()) as AdminMetricsResponse

    if (!metrics.success) {
      setNotice(metrics.error || "Admin settings metrics failed to load.")
    }

    const pendingProfiles = (metrics.profiles || []).filter((profile) => profile.approved === false)

    if (settingsResult.data) {
      setSettings({
        ...defaultSettings,
        ...(settingsResult.data as Partial<PlatformSettings>),
      })
    }

    setOrganizationsCount(metrics.organizations?.length || 0)
    setUsersCount(metrics.usersCount || metrics.profiles?.length || 0)
    setPendingCount(pendingProfiles.length)
    setLogs(metrics.logs || [])
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
      ["Manual approval control", !settings.auto_approvals],
      ["No pending approvals", pendingCount === 0],
      ["Live customer workspaces", organizationsCount > 0],
    ],
    [organizationsCount, pendingCount, settings]
  )

  const launchScore = Math.round((launchChecks.filter(([, ready]) => ready).length / launchChecks.length) * 100)

  function updateSetting<K extends keyof PlatformSettings>(field: K, value: PlatformSettings[K]) {
    setSettings((current) => ({ ...current, [field]: value }))
  }

  async function saveSettings() {
    setSaving(true)
    setNotice("")

    const { error } = await supabase.from("platform_settings").upsert(settings)
    if (error) {
      setNotice(error.message)
      setSaving(false)
      return
    }

    await writeSystemLog("SETTINGS_UPDATED", "Platform settings updated from admin control center.", false)
    setNotice("Platform settings saved successfully.")
    setSaving(false)
    await fetchSettings()
  }

  async function writeSystemLog(action: string, description: string, showNotice = true) {
    const { error } = await supabase.from("admin_logs").insert({ action, description })
    if (showNotice) setNotice(error ? error.message : description)
    if (!error) await fetchSettings()
  }

  return (
    <div className="space-y-8 text-white">
      <section className="inventory-sheen rounded-[40px] border border-white/10 bg-white/[0.035] p-8 shadow-[0_0_90px_rgba(0,0,0,0.5)]">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="mb-4 text-xs font-bold uppercase tracking-[0.24em] text-cyan-200">Platform Configuration</p>
            <h1 className="max-w-5xl text-4xl font-black leading-tight md:text-6xl">Global SaaS settings, launch controls, and audit operations.</h1>
            <p className="mt-5 max-w-3xl text-neutral-400">Control platform identity, approval behavior, customer notifications, billing, inventory, maintenance mode, and admin audit actions.</p>
          </div>
          <button onClick={saveSettings} disabled={saving} className="h-14 rounded-2xl bg-white px-7 font-black text-black disabled:opacity-50">
            {saving ? "Saving..." : "Save Settings"}
          </button>
        </div>
      </section>

      {notice && <div className="rounded-3xl border border-cyan-400/25 bg-cyan-500/10 px-6 py-4 text-sm text-cyan-100">{notice}</div>}

      <section className="grid grid-cols-1 gap-5 md:grid-cols-2 2xl:grid-cols-4">
        {[
          ["Organizations", organizationsCount, "text-white", "Customer workspaces"],
          ["Users", usersCount, "text-cyan-200", "Registered profiles"],
          ["Pending", pendingCount, "text-amber-200", "Approval queue"],
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
              onClick={() => updateSetting("maintenance_mode", !settings.maintenance_mode)}
            />
            <ToggleCard
              title="Email Notifications"
              description="Send approval, billing, and operational notifications from the platform."
              enabled={settings.email_notifications}
              onClick={() => updateSetting("email_notifications", !settings.email_notifications)}
            />
            <ToggleCard
              title="Auto Approvals"
              description="Automatically approve verified businesses without manual admin review."
              enabled={settings.auto_approvals}
              onClick={() => updateSetting("auto_approvals", !settings.auto_approvals)}
            />
            <ToggleCard
              title="Inventory Tracking"
              description="Enable product stock intelligence, low-stock alerts, and inventory modules."
              enabled={settings.inventory_tracking}
              onClick={() => updateSetting("inventory_tracking", !settings.inventory_tracking)}
            />
            <ToggleCard
              title="Billing Automation"
              description="Enable invoices, payment status control, print routes, and billing automation."
              enabled={settings.billing_automation}
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
              <button onClick={() => void writeSystemLog("CACHE_CLEAR", "Platform cache clear requested by admin.")} className="h-12 rounded-2xl border border-white/10 text-sm font-bold">Log Cache Clear</button>
              <button onClick={() => void writeSystemLog("BACKUP_REQUESTED", "Secure platform backup requested by admin.")} className="h-12 rounded-2xl border border-white/10 text-sm font-bold">Log Backup</button>
              <button onClick={() => void writeSystemLog("SERVICE_CHECK", "Platform service check requested by admin.")} className="h-12 rounded-2xl border border-white/10 text-sm font-bold">Log Service Check</button>
              <button onClick={() => void writeSystemLog("SECURITY_REVIEW", "Security and RLS review requested before global launch.")} className="h-12 rounded-2xl border border-white/10 text-sm font-bold">Log Security Review</button>
            </div>
          </div>
        </div>
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
