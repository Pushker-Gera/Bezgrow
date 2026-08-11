"use client"

import type { FormEvent } from "react"
import { useEffect, useState } from "react"
import {
  AdminNotice,
  AdminPageHeader,
  AdminExportLink,
  adminMutation,
  useAdminOnline,
} from "@/components/admin/ControlPlaneUi"
import { secureAdminFetch } from "@/lib/platform-admin/client"

type Settings = {
  platform_name: string
  support_email: string
  default_license_duration_days: number
  default_grace_days: number
  default_allowed_features: string[]
  license_plans: unknown[]
  update_channels: string[]
  minimum_supported_version: string | null
  backup_policies: Record<string, unknown>
  diagnostic_upload_enabled: boolean
  diagnostic_retention_days: number
  maintenance_message: string | null
  customer_download_urls: Record<string, string>
  mac_release_status: "not_configured" | "internal_testing" | "ready" | "paused"
  windows_release_status: "not_configured" | "internal_testing" | "ready" | "paused"
}

const defaults: Settings = {
  platform_name: "Bezgrow",
  support_email: "support@bezgrow.com",
  default_license_duration_days: 365,
  default_grace_days: 7,
  default_allowed_features: ["billing", "customers", "inventory", "products", "reports"],
  license_plans: [],
  update_channels: ["stable"],
  minimum_supported_version: null,
  backup_policies: {},
  diagnostic_upload_enabled: true,
  diagnostic_retention_days: 30,
  maintenance_message: null,
  customer_download_urls: {},
  mac_release_status: "not_configured",
  windows_release_status: "not_configured",
}

export default function PlatformSettingsPage() {
  const { online } = useAdminOnline()
  const [settings, setSettings] = useState<Settings>(defaults)
  const [licensePlans, setLicensePlans] = useState("[]")
  const [backupPolicies, setBackupPolicies] = useState("{}")
  const [downloadUrls, setDownloadUrls] = useState("{}")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    queueMicrotask(() => setLoading(true))
    secureAdminFetch("/api/admin/settings", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string; settings?: Partial<Settings> | null }
        if (!response.ok || !payload.success) throw new Error(payload.error || "Platform settings failed to load.")
        const next = { ...defaults, ...(payload.settings || {}) }
        setSettings(next)
        setLicensePlans(JSON.stringify(next.license_plans || [], null, 2))
        setBackupPolicies(JSON.stringify(next.backup_policies || {}, null, 2))
        setDownloadUrls(JSON.stringify(next.customer_download_urls || {}, null, 2))
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : "Platform settings failed to load.")
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [online])

  async function save(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setNotice("")
    setError("")
    try {
      const plans = JSON.parse(licensePlans) as unknown
      const policies = JSON.parse(backupPolicies) as unknown
      const urls = JSON.parse(downloadUrls) as unknown
      const payload = await adminMutation<{ settings?: Settings }>("/api/admin/settings", "PATCH", {
        ...settings,
        license_plans: plans,
        backup_policies: policies,
        customer_download_urls: urls,
      })
      if (payload.settings) setSettings(payload.settings)
      setNotice("Platform settings saved and audited.")
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Platform settings could not be saved.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader
        eyebrow="Control-plane defaults"
        title="Platform settings"
        description="Licensing defaults, update channels, release visibility, optional backup and diagnostic policies, support details, and customer download locations."
        action={<AdminExportLink href="/api/admin/settings?format=csv" />}
      />
      <AdminNotice>
        Settings for centrally hosted customer invoices, stock, or retail customers are intentionally absent. Server secrets and private signing keys are never displayed or returned.
      </AdminNotice>
      {notice && <AdminNotice tone="success">{notice}</AdminNotice>}
      {error && <AdminNotice tone="danger">{error}</AdminNotice>}

      {loading ? (
        <div className="h-96 animate-pulse rounded-[28px] bg-white/[0.04]" />
      ) : (
        <form onSubmit={save} className="space-y-5">
          <SettingsSection title="Platform identity and defaults">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Platform name" value={settings.platform_name} onChange={(value) => setSettings((current) => ({ ...current, platform_name: value }))} />
              <TextField label="Support email" type="email" value={settings.support_email} onChange={(value) => setSettings((current) => ({ ...current, support_email: value }))} />
              <NumberField label="Default license duration (days)" value={settings.default_license_duration_days} onChange={(value) => setSettings((current) => ({ ...current, default_license_duration_days: value }))} />
              <NumberField label="Default grace days" value={settings.default_grace_days} onChange={(value) => setSettings((current) => ({ ...current, default_grace_days: value }))} />
              <TextField label="Minimum supported version" required={false} value={settings.minimum_supported_version || ""} onChange={(value) => setSettings((current) => ({ ...current, minimum_supported_version: value || null }))} />
              <TextField label="Update channels (comma separated)" value={settings.update_channels.join(", ")} onChange={(value) => setSettings((current) => ({ ...current, update_channels: value.split(",").map((item) => item.trim()).filter(Boolean) }))} />
              <TextField label="Default allowed features (comma separated)" value={settings.default_allowed_features.join(", ")} onChange={(value) => setSettings((current) => ({ ...current, default_allowed_features: value.split(",").map((item) => item.trim()).filter(Boolean) }))} />
            </div>
          </SettingsSection>

          <SettingsSection title="License plans">
            <JsonField label="Plan definitions" value={licensePlans} onChange={setLicensePlans} />
          </SettingsSection>

          <SettingsSection title="Releases and downloads">
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField label="Mac release status" value={settings.mac_release_status} onChange={(value) => setSettings((current) => ({ ...current, mac_release_status: value as Settings["mac_release_status"] }))} />
              <SelectField label="Windows release status" value={settings.windows_release_status} onChange={(value) => setSettings((current) => ({ ...current, windows_release_status: value as Settings["windows_release_status"] }))} />
            </div>
            <div className="mt-4">
              <JsonField label="Customer download URLs" value={downloadUrls} onChange={setDownloadUrls} />
            </div>
          </SettingsSection>

          <SettingsSection title="Optional backup and diagnostics">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex min-h-12 items-center gap-3 rounded-2xl border border-white/10 bg-black/20 px-4 text-sm font-bold">
                <input type="checkbox" checked={settings.diagnostic_upload_enabled} onChange={(event) => setSettings((current) => ({ ...current, diagnostic_upload_enabled: event.target.checked }))} />
                Allow voluntary diagnostic uploads
              </label>
              <NumberField label="Diagnostic retention days" value={settings.diagnostic_retention_days} onChange={(value) => setSettings((current) => ({ ...current, diagnostic_retention_days: value }))} />
            </div>
            <div className="mt-4">
              <JsonField label="Backup policies" value={backupPolicies} onChange={setBackupPolicies} />
            </div>
          </SettingsSection>

          <SettingsSection title="Maintenance">
            <label className="block text-sm font-bold text-neutral-300">
              Maintenance message
              <textarea value={settings.maintenance_message || ""} onChange={(event) => setSettings((current) => ({ ...current, maintenance_message: event.target.value || null }))} className="mt-2 min-h-24 w-full rounded-xl border border-white/10 bg-black/50 p-3 outline-none focus:border-cyan-400/40" />
            </label>
          </SettingsSection>

          <button type="submit" disabled={saving} className="h-12 rounded-2xl bg-cyan-300 px-6 text-sm font-black text-black disabled:opacity-40">
            {saving ? "Saving…" : "Save platform settings"}
          </button>
        </form>
      )}
    </div>
  )
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-[28px] border border-white/10 bg-white/[0.03] p-6"><h3 className="mb-5 text-lg font-black">{title}</h3>{children}</section>
}

function TextField({ label, value, onChange, type = "text", required = true }: { label: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean }) {
  return <label className="text-sm font-bold text-neutral-300">{label}<input type={type} required={required} value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black/50 px-3 outline-none focus:border-cyan-400/40" /></label>
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label className="text-sm font-bold text-neutral-300">{label}<input type="number" min="0" required value={value} onChange={(event) => onChange(Number(event.target.value))} className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black/50 px-3 outline-none focus:border-cyan-400/40" /></label>
}

function SelectField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="text-sm font-bold text-neutral-300">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black px-3">{["not_configured", "internal_testing", "ready", "paused"].map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}</select></label>
}

function JsonField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="block text-sm font-bold text-neutral-300">{label}<textarea spellCheck={false} value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 min-h-36 w-full rounded-xl border border-white/10 bg-black/50 p-3 font-mono text-xs outline-none focus:border-cyan-400/40" /></label>
}
