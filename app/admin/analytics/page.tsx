"use client"

import { useEffect, useState } from "react"
import { AdminNotice, AdminPageHeader, useAdminOnline } from "@/components/admin/ControlPlaneUi"

type Point = { label: string; value: number }
type AnalyticsPayload = {
  success?: boolean
  error?: string
  rangeDays?: number
  licenseGrowth?: Point[]
  activationsByDay?: Point[]
  activationsByPlatform?: Point[]
  devicePlatforms?: Point[]
  licenseRenewals?: Point[]
  licenseOutcomes?: Point[]
  versionAdoption?: Point[]
  updateOutcomes?: Point[]
  backupUsage?: { enabled: number; disabled: number }
  supportVolume?: Point[]
  dataNotice?: string
}

export default function AnalyticsPage() {
  const { online } = useAdminOnline()
  const [days, setDays] = useState("30")
  const [payload, setPayload] = useState<AnalyticsPayload>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    queueMicrotask(() => {
      setLoading(true)
      setError("")
    })
    fetch(`/api/admin/analytics?days=${days}`, { cache: "no-store", credentials: "include", signal: controller.signal })
      .then(async (response) => {
        const result = (await response.json().catch(() => ({}))) as AnalyticsPayload
        if (!response.ok || !result.success) throw new Error(result.error || "Analytics failed to load.")
        setPayload(result)
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) setError(requestError instanceof Error ? requestError.message : "Analytics failed to load.")
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [days, online])

  const charts: Array<[string, Point[] | undefined, string]> = [
    ["License growth", payload.licenseGrowth, "New licenses by day"],
    ["Activations by day", payload.activationsByDay, "Authenticated device activations"],
    ["Activations by platform", payload.activationsByPlatform, "macOS versus Windows activations"],
    ["Mac vs Windows devices", payload.devicePlatforms, "Registered device platform"],
    ["License renewals", payload.licenseRenewals, "Renewals and extensions"],
    ["License outcomes", payload.licenseOutcomes, "Current recorded status"],
    ["App-version adoption", payload.versionAdoption, "Last reported desktop version"],
    ["Update success / failure", payload.updateOutcomes, "Reported update-check results"],
    ["Support case volume", payload.supportVolume, "New support cases by day"],
  ]

  return (
    <div className="space-y-6">
      <AdminPageHeader
        eyebrow="Real platform signals"
        title="Analytics"
        description="License growth, activations, devices, releases, optional backup use, and support. Local customer sales, inventory value, and invoices are excluded."
        action={
          <select value={days} onChange={(event) => setDays(event.target.value)} className="h-12 rounded-2xl border border-white/10 bg-black px-4 text-sm font-bold">
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last 365 days</option>
          </select>
        }
      />
      <AdminNotice>{payload.dataNotice || "Only authoritative platform data is included."}</AdminNotice>
      {error && <AdminNotice tone="danger">{error}</AdminNotice>}

      <section className="grid gap-4 xl:grid-cols-2">
        {charts.map(([title, points, description]) => (
          <article key={title} className="rounded-[28px] border border-white/10 bg-white/[0.03] p-6">
            <h3 className="text-lg font-black">{title}</h3>
            <p className="mt-1 text-xs text-neutral-500">{description}</p>
            {loading ? (
              <div className="mt-6 h-44 animate-pulse rounded-2xl bg-white/[0.05]" />
            ) : (
              <MiniBarChart points={points || []} />
            )}
          </article>
        ))}
        <article className="rounded-[28px] border border-white/10 bg-white/[0.03] p-6">
          <h3 className="text-lg font-black">Optional backup usage</h3>
          <p className="mt-1 text-xs text-neutral-500">Explicit customer enablement only</p>
          <div className="mt-6 grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.06] p-5">
              <p className="text-3xl font-black">{Number(payload.backupUsage?.enabled || 0).toLocaleString()}</p>
              <p className="mt-2 text-xs text-neutral-400">Enabled</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/25 p-5">
              <p className="text-3xl font-black">{Number(payload.backupUsage?.disabled || 0).toLocaleString()}</p>
              <p className="mt-2 text-xs text-neutral-400">Disabled</p>
            </div>
          </div>
        </article>
      </section>
    </div>
  )
}

function MiniBarChart({ points }: { points: Point[] }) {
  if (!points.length) {
    return <div className="mt-6 flex h-44 items-center justify-center rounded-2xl border border-dashed border-white/10 text-sm text-neutral-500">No reported data in this range.</div>
  }
  const visible = points.slice(-18)
  const max = Math.max(...visible.map((point) => point.value), 1)
  return (
    <div className="mt-6 flex h-44 items-end gap-2 overflow-x-auto rounded-2xl border border-white/[0.07] bg-black/20 px-4 pt-5">
      {visible.map((point) => (
        <div key={point.label} className="group flex h-full min-w-8 flex-1 flex-col items-center justify-end">
          <span className="mb-2 text-[10px] font-black text-cyan-100 opacity-0 transition group-hover:opacity-100">{point.value}</span>
          <div className="w-full rounded-t-lg bg-cyan-300/70" style={{ height: `${Math.max(4, (point.value / max) * 105)}px` }} />
          <span className="mt-2 max-w-16 truncate text-[9px] text-neutral-600">{point.label}</span>
        </div>
      ))}
    </div>
  )
}
