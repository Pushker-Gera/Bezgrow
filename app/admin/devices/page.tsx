"use client"

import { useMemo, useState } from "react"
import {
  AdminListControls,
  AdminNotice,
  AdminPageHeader,
  AdminPagination,
  AdminTable,
  StatusPill,
  adminMutation,
  displayValue,
  formatAdminDate,
  useAdminList,
} from "@/components/admin/ControlPlaneUi"

export default function DevicesPage() {
  const [status, setStatus] = useState("")
  const [platform, setPlatform] = useState("")
  const [notice, setNotice] = useState("")
  const [actionError, setActionError] = useState("")
  const filters = useMemo(() => ({ status, platform }), [platform, status])
  const list = useAdminList<Record<string, unknown>>("/api/admin/devices", filters)

  async function action(row: Record<string, unknown>, actionName: string) {
    setNotice("")
    setActionError("")
    let body: Record<string, unknown> = { id: row.id, action: actionName }
    if (actionName === "mark_replaced") {
      const replacement = window.prompt("Replacement Device ID")
      if (!replacement) return
      const reason = window.prompt("Replacement reason")
      if (!reason) return
      body = { ...body, replacement_device_id: replacement, reason }
    }
    if (actionName === "revoke" && !window.confirm(`Revoke device ${row.device_id}? Local ERP data will not be deleted.`)) return

    try {
      await adminMutation("/api/admin/devices", "PATCH", body)
      setNotice(
        actionName === "request_diagnostics"
          ? "A new voluntary diagnostic package was requested."
          : actionName === "reset_online_session"
            ? "Online session reset. Local ERP data was not changed."
            : "Device status updated. Local ERP data was not changed."
      )
      list.reload()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Device action failed.")
    }
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader
        eyebrow="Reported devices"
        title="Devices"
        description="Registered desktop devices and their last authenticated reports. Offline devices are not monitored in real time, and administrators can never remotely delete customer ERP data."
      />
      <AdminNotice>{String(list.metadata.monitoringNotice || "Use Last reported rather than Live unless a recent authenticated heartbeat exists.")}</AdminNotice>
      {notice && <AdminNotice tone="success">{notice}</AdminNotice>}
      {actionError && <AdminNotice tone="danger">{actionError}</AdminNotice>}
      <AdminListControls
        search={list.search}
        onSearch={list.setSearch}
        filters={
          <>
            <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-11 rounded-2xl border border-white/10 bg-black px-4 text-sm">
              <option value="">All states</option>
              {["registered", "active", "revoked", "replaced"].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select value={platform} onChange={(event) => setPlatform(event.target.value)} className="h-11 rounded-2xl border border-white/10 bg-black px-4 text-sm">
              <option value="">All platforms</option>
              <option value="macos">macOS</option>
              <option value="windows">Windows</option>
            </select>
          </>
        }
      />
      <AdminTable
        loading={list.loading}
        error={list.error}
        empty="No devices have been registered with the platform."
        rows={list.data}
        columns={[
          {
            key: "device_id",
            label: "Device ID",
            render: (row) => (
              <div>
                <code className="text-xs text-cyan-100">{displayValue(row.device_id)}</code>
                <button type="button" onClick={() => void navigator.clipboard.writeText(String(row.device_id))} className="mt-2 block text-xs font-bold text-neutral-500 hover:text-white">Copy Device ID</button>
              </div>
            ),
          },
          {
            key: "customer",
            label: "Customer / Business",
            render: (row) => {
              const customer = (row.customer || {}) as Record<string, unknown>
              const business = (row.business || {}) as Record<string, unknown>
              return <div><p className="font-bold text-white">{displayValue(customer.name, "Unlinked customer")}</p><p className="mt-1 text-xs text-neutral-500">{displayValue(business.business_name, "Unlinked workspace")}</p></div>
            },
          },
          {
            key: "platform",
            label: "System",
            render: (row) => <div><p>{displayValue(row.platform)} · {displayValue(row.architecture, "Architecture not reported")}</p><p className="mt-1 text-xs text-neutral-500">{displayValue(row.operating_system, "OS not reported")} · v{displayValue(row.app_version, "Not reported")}</p></div>,
          },
          {
            key: "license",
            label: "License",
            render: (row) => {
              const license = (row.license || {}) as Record<string, unknown>
              return <div><p className="text-xs">{displayValue(row.license_id, "No license")}</p><div className="mt-2"><StatusPill value={license.effective_status || "not licensed"} /></div></div>
            },
          },
          {
            key: "reported",
            label: "Reported activity",
            render: (row) => <div><p>{row.last_reported_at ? formatAdminDate(row.last_reported_at) : "Last reported: Never"}</p><p className="mt-1 text-xs text-neutral-500">Update check: {formatAdminDate(row.last_update_check_at)}</p><p className="mt-1 text-xs text-neutral-600">Channel: {displayValue(row.release_channel)}</p></div>,
          },
          { key: "device_status", label: "State", render: (row) => <StatusPill value={row.device_status} /> },
          {
            key: "actions",
            label: "Actions",
            render: (row) => (
              <div className="flex min-w-[250px] flex-wrap gap-2">
                <a href={`/admin/licenses?device=${encodeURIComponent(String(row.device_id))}`} className="rounded-lg border border-cyan-400/25 px-2.5 py-1.5 text-xs font-bold text-cyan-100">Issue / renew</a>
                <button type="button" onClick={() => void action(row, "request_diagnostics")} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold">Request diagnostics</button>
                <button type="button" onClick={() => void action(row, "reset_online_session")} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold">Reset online session</button>
                <button type="button" onClick={() => void action(row, "mark_replaced")} className="rounded-lg border border-amber-400/20 px-2.5 py-1.5 text-xs font-bold text-amber-100">Mark replaced</button>
                <button type="button" onClick={() => void action(row, "revoke")} className="rounded-lg border border-red-400/20 px-2.5 py-1.5 text-xs font-bold text-red-200">Revoke</button>
              </div>
            ),
          },
        ]}
      />
      <AdminPagination page={list.page} total={list.total} onPage={list.setPage} />
    </div>
  )
}
