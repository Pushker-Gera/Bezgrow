"use client"

import { useMemo, useState } from "react"
import {
  AdminListControls,
  AdminNotice,
  AdminPageHeader,
  AdminPagination,
  AdminTable,
  StatusPill,
  displayValue,
  formatAdminDate,
  useAdminList,
} from "@/components/admin/ControlPlaneUi"

export default function BusinessesPage() {
  const [licenseStatus, setLicenseStatus] = useState("")
  const [cloud, setCloud] = useState("")
  const [platform, setPlatform] = useState("")
  const [channel, setChannel] = useState("")
  const [version, setVersion] = useState("")
  const filters = useMemo(
    () => ({ license_status: licenseStatus, cloud, platform, channel, version }),
    [channel, cloud, licenseStatus, platform, version]
  )
  const list = useAdminList<Record<string, unknown>>("/api/admin/businesses", filters)
  const exportParams = new URLSearchParams({
    format: "csv",
    search: list.search,
    platform,
    license_status: licenseStatus,
    cloud,
    channel,
    version,
  })

  return (
    <div className="space-y-6">
      <AdminPageHeader
        eyebrow="Platform-control metadata"
        title="Businesses"
        description="Customer ERP data is stored locally on the customer’s device and is not available to Bezgrow administrators."
      />

      <section className="grid gap-3 sm:grid-cols-3">
        {[
          ["Subscription Revenue", "Payment system not connected"],
          ["Active Licenses", "See authoritative license status"],
          ["Licenses or Devices Requiring Attention", "Filter expired or suspended records"],
        ].map(([label, value]) => (
          <article key={label} className="rounded-[24px] border border-white/10 bg-white/[0.03] p-5">
            <p className="text-xs font-black uppercase tracking-[0.12em] text-neutral-500">{label}</p>
            <p className="mt-3 text-lg font-black">{value}</p>
          </article>
        ))}
      </section>

      <AdminNotice tone="warning">
        Local records are shown as “Local-only” or “Not available to platform”—never as fabricated zeroes.
      </AdminNotice>

      <AdminListControls
        search={list.search}
        onSearch={list.setSearch}
        exportHref={`/api/admin/businesses?${exportParams}`}
        filters={
          <>
            <select value={licenseStatus} onChange={(event) => setLicenseStatus(event.target.value)} className="h-11 rounded-2xl border border-white/10 bg-black px-3 text-sm">
              <option value="">All license states</option>
              <option value="active">Active license</option>
              <option value="expired">Expired</option>
              <option value="suspended">Suspended</option>
            </select>
            <select value={cloud} onChange={(event) => setCloud(event.target.value)} className="h-11 rounded-2xl border border-white/10 bg-black px-3 text-sm">
              <option value="">All cloud modes</option>
              <option value="local_only">Local-only</option>
              <option value="cloud_backup">Cloud backup enabled</option>
            </select>
            <select value={platform} onChange={(event) => setPlatform(event.target.value)} className="h-11 rounded-2xl border border-white/10 bg-black px-3 text-sm">
              <option value="">Mac & Windows</option>
              <option value="macos">Mac</option>
              <option value="windows">Windows</option>
            </select>
            <input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="App version" className="h-11 w-28 rounded-2xl border border-white/10 bg-black px-3 text-sm" />
            <input value={channel} onChange={(event) => setChannel(event.target.value)} placeholder="Channel" className="h-11 w-28 rounded-2xl border border-white/10 bg-black px-3 text-sm" />
          </>
        }
      />

      <AdminTable
        loading={list.loading}
        error={list.error}
        empty="No registered platform-control metadata matches these filters."
        rows={list.data}
        columns={[
          {
            key: "business_name",
            label: "Business",
            render: (row) => {
              const customer = (row.customer || {}) as Record<string, unknown>
              return <div><p className="font-black text-white">{displayValue(row.business_name)}</p><p className="mt-1 text-xs text-neutral-500">{displayValue(customer.name, "Owner not linked")}</p><code className="mt-1 block text-[11px] text-neutral-600">{displayValue(row.workspace_id)}</code></div>
            },
          },
          {
            key: "license",
            label: "License / Device",
            render: (row) => {
              const license = (row.license || {}) as Record<string, unknown>
              const device = (row.device || {}) as Record<string, unknown>
              return <div><StatusPill value={license.effective_status || "not licensed"} /><p className="mt-2 text-xs">{displayValue(license.id, "No license")}</p><p className="mt-1 text-xs text-neutral-500">{displayValue(device.device_id, "No device")}</p></div>
            },
          },
          {
            key: "platform",
            label: "App",
            render: (row) => <div><p>{displayValue(row.platform, "Not reported")} · v{displayValue(row.app_version, "Not reported")}</p><p className="mt-1 text-xs text-neutral-500">Channel: {displayValue(row.update_channel)}</p><p className="mt-1 text-xs text-neutral-600">Plan: {displayValue(row.plan_name)}</p></div>,
          },
          {
            key: "cloud_mode",
            label: "Data availability",
            render: (row) => <div><StatusPill value={row.cloud_mode} /><p className="mt-2 text-xs font-bold">{displayValue(row.local_data_state, "Local-only")}</p><p className="mt-1 text-xs text-neutral-500">Not available to platform</p></div>,
          },
          {
            key: "backup",
            label: "Optional services",
            render: (row) => <div><p>{row.cloud_backup_enabled ? "Customer-enabled backup" : "Backup disabled"}</p><p className="mt-1 text-xs text-neutral-500">Last backup: {formatAdminDate(row.last_backup_at)}</p><p className="mt-1 text-xs text-neutral-500">Customer-controlled</p></div>,
          },
          {
            key: "created_at",
            label: "Registered",
            render: (row) => <div><StatusPill value={row.status} /><p className="mt-2 text-xs text-neutral-500">{formatAdminDate(row.created_at)}</p></div>,
          },
        ]}
      />
      <AdminPagination page={list.page} total={list.total} onPage={list.setPage} />
    </div>
  )
}
