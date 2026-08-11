"use client"

import { useEffect, useState } from "react"
import {
  AdminNotice,
  AdminPageHeader,
  AdminExportLink,
  StatusPill,
  displayValue,
  formatAdminDate,
  useAdminOnline,
} from "@/components/admin/ControlPlaneUi"
import { secureAdminFetch } from "@/lib/platform-admin/client"

type DashboardPayload = {
  ok?: boolean
  success?: boolean
  error?: string
  requestId?: string
  rangeDays?: number
  loadTimeMs?: number
  sections?: Record<
    "licenses" | "devices" | "businesses" | "customers" | "releases" | "backups" | "support" | "audit" | "analytics",
    {
      status?: "ok" | "not_configured" | "never_reported" | "error"
      message?: string
      notes?: string
    }
  >
  summary?: {
    licenses?: Record<string, number>
    devices?: Record<string, number>
    customers?: number
    businesses?: number
    backup?: Record<string, number>
    supportAttention?: number
    latestMacRelease?: Record<string, unknown> | null
    latestWindowsRelease?: Record<string, unknown> | null
    recentAdminActions?: Array<Record<string, unknown>>
    recentActivationFailures?: Array<Record<string, unknown>>
    recentSecurityEvents?: Array<Record<string, unknown>>
    supportCases?: Array<Record<string, unknown>>
  }
  revenue?: {
    licenseValueLabel?: string
    subscriptionRevenueLabel?: string
  }
  dataBoundaries?: Record<string, string>
}

export default function AdminDashboardPage() {
  const { online } = useAdminOnline()
  const [payload, setPayload] = useState<DashboardPayload>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [days, setDays] = useState("30")

  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    queueMicrotask(() => {
      setLoading(true)
      setError("")
    })
    secureAdminFetch(`/api/admin/dashboard?days=${days}`, {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const next = (await response.json().catch(() => ({}))) as DashboardPayload
        if (!response.ok || !next.success) throw new Error(next.error || "Dashboard failed to load.")
        setPayload(next)
      })
      .catch((requestError) => {
        if (!controller.signal.aborted) {
          setError(requestError instanceof Error ? requestError.message : "Dashboard failed to load.")
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [days, online])

  const summary = payload.summary || {}
  const licenses = summary.licenses || {}
  const devices = summary.devices || {}
  const sections = payload.sections
  const cards = [
    ["Active Licenses", licenses.active, "licenses"],
    ["Expiring in 7 days", licenses.expiring7, "licenses"],
    ["Expiring in 30 days", licenses.expiring30, "licenses"],
    ["Expiring in 90 days", licenses.expiring90, "licenses"],
    ["Grace Period", licenses.gracePeriod, "licenses"],
    ["Expired Licenses", licenses.expired, "licenses"],
    ["Revoked Licenses", licenses.revoked, "licenses"],
    ["Suspended Licenses", licenses.suspended, "licenses"],
    ["Trial Licenses", licenses.trial, "licenses"],
    ["Registered Devices", devices.total, "devices"],
    ["Activated Today", devices.activatedToday, "devices"],
    ["Active in 30 days", devices.active30Days, "devices"],
    ["Platform Customers", summary.customers, "customers"],
    ["Cloud Workspaces", summary.businesses, "businesses"],
    ["Failed Update Checks", devices.failedUpdateChecks, "devices"],
    ["Support Attention", summary.supportAttention, "support"],
  ] as const
  const sectionErrors = Object.entries(sections || {}).filter(([, section]) => section.status === "error")

  return (
    <div className="space-y-7">
      <AdminPageHeader
        eyebrow="Control plane"
        title="Platform dashboard"
        description="Authoritative licenses, registered devices, releases, optional cloud services, support, and security events. Local customer ERP records are intentionally excluded."
        action={
          <div className="flex gap-2">
            <select
              aria-label="Dashboard date range"
              value={days}
              onChange={(event) => setDays(event.target.value)}
              className="h-12 rounded-2xl border border-white/10 bg-black px-4 text-sm font-bold"
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="365">Last 365 days</option>
            </select>
            <AdminExportLink href={`/api/admin/dashboard?days=${days}&format=csv`} />
          </div>
        }
      />

      {error && <AdminNotice tone="danger">{error}</AdminNotice>}
      {sectionErrors.map(([name, section]) => (
        <AdminNotice key={name} tone="danger">
          {section.message || `${name} metrics could not be loaded.`}
        </AdminNotice>
      ))}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(([label, value, sectionName]) => (
          <article key={label} className="rounded-[24px] border border-white/10 bg-white/[0.035] p-5">
            <p className="text-xs font-black uppercase tracking-[0.12em] text-neutral-500">{label}</p>
            <p className="mt-4 text-3xl font-black text-white">
              {loading
                ? <span className="inline-block h-9 w-16 animate-pulse rounded-lg bg-white/10" />
                : sections?.[sectionName]?.status === "error"
                  ? <span className="text-base text-red-200">Error</span>
                  : Number(value ?? 0).toLocaleString()}
            </p>
          </article>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="rounded-[28px] border border-white/10 bg-white/[0.03] p-6">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-neutral-500">Subscription Revenue</p>
          <p className="mt-4 text-2xl font-black">{payload.revenue?.subscriptionRevenueLabel || "Payment system not connected"}</p>
          <p className="mt-2 text-sm text-neutral-400">License value: {payload.revenue?.licenseValueLabel || "Not configured"}</p>
          <p className="mt-4 text-xs leading-5 text-neutral-500">
            Customer invoices are business data, not Bezgrow platform revenue, and are never used in this metric.
          </p>
        </article>
        <article className="rounded-[28px] border border-white/10 bg-white/[0.03] p-6">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-neutral-500">Optional Cloud Backup</p>
          <p className="mt-4 text-2xl font-black">
            {sections?.backups?.status === "not_configured"
              ? "Not configured"
              : sections?.backups?.status === "error"
                ? "Error"
                : `${Number(summary.backup?.enabled ?? 0).toLocaleString()} enabled`}
          </p>
          <p className="mt-2 text-sm text-neutral-400">
            {sections?.backups?.status === "not_configured"
              ? "No workspace has opted in"
              : sections?.backups?.status === "error"
                ? "Backup metrics could not be loaded"
                : `${Number(summary.backup?.failed ?? 0).toLocaleString()} requiring attention`}
          </p>
          <p className="mt-4 text-xs leading-5 text-neutral-500">Only explicitly enabled backup metadata is counted.</p>
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {[
          ["Latest macOS release", summary.latestMacRelease],
          ["Latest Windows release", summary.latestWindowsRelease],
        ].map(([title, release]) => {
          const row = (release || null) as Record<string, unknown> | null
          return (
            <article key={String(title)} className="rounded-[28px] border border-white/10 bg-white/[0.03] p-6">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-neutral-500">{String(title)}</p>
              {sections?.releases?.status === "error" ? (
                <p className="mt-4 text-lg font-black text-red-200">Release query failed</p>
              ) : row ? (
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <p className="text-2xl font-black">v{displayValue(row.version)}</p>
                  <StatusPill value={row.release_channel} />
                  <StatusPill value={row.release_status} />
                  <span className="text-sm text-neutral-400">{displayValue(row.architecture)}</span>
                </div>
              ) : (
                <p className="mt-4 text-lg font-black text-neutral-300">Not configured</p>
              )}
            </article>
          )
        })}
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <EventList title="Recent admin actions" rows={summary.recentAdminActions || []} />
        <EventList title="Recent activation failures" rows={summary.recentActivationFailures || []} empty="No reported activation failures." />
        <EventList title="Integrity and security events" rows={summary.recentSecurityEvents || []} empty="No recent security events." />
        <EventList title="Support requiring attention" rows={summary.supportCases || []} empty="No support cases require attention." support />
      </section>

      <section className="rounded-[28px] border border-cyan-400/15 bg-cyan-500/[0.06] p-6">
        <p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-200">Data boundaries</p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {Object.entries(payload.dataBoundaries || {}).map(([name, description]) => (
            <div key={name}>
              <p className="text-sm font-black capitalize">{name.replaceAll(/([A-Z])/g, " $1")}</p>
              <p className="mt-2 text-xs leading-5 text-neutral-400">{description}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function EventList({
  title,
  rows,
  empty = "No actions recorded yet.",
  support = false,
}: {
  title: string
  rows: Array<Record<string, unknown>>
  empty?: string
  support?: boolean
}) {
  return (
    <article className="rounded-[28px] border border-white/10 bg-white/[0.03] p-6">
      <h3 className="text-lg font-black">{title}</h3>
      <div className="mt-4 space-y-3">
        {rows.length ? (
          rows.map((row, index) => (
            <div key={String(row.id || index)} className="rounded-2xl border border-white/[0.08] bg-black/25 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-black">
                    {displayValue(support ? row.subject : row.action, support ? "Support case" : "Admin action")}
                  </p>
                  <p className="mt-1 truncate text-xs text-neutral-500">
                    {support
                      ? displayValue(row.case_number, "No case number")
                      : `${displayValue(row.target_type, "platform")} · ${displayValue(row.target_id, "No target")}`}
                  </p>
                </div>
                <StatusPill value={support ? row.priority : row.result} />
              </div>
              <p className="mt-3 text-xs text-neutral-500">{formatAdminDate(row.updated_at || row.created_at)}</p>
            </div>
          ))
        ) : (
          <p className="rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-neutral-500">{empty}</p>
        )}
      </div>
    </article>
  )
}
