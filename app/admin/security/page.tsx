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

export default function SecurityPage() {
  const [status, setStatus] = useState("")
  const filters = useMemo(() => ({ status }), [status])
  const list = useAdminList<Record<string, unknown>>("/api/admin/audit-logs", filters)
  const exportParams = new URLSearchParams({ format: "csv", search: list.search, status })

  return (
    <div className="space-y-6">
      <AdminPageHeader
        eyebrow="Append-only history"
        title="Security and audit logs"
        description="Search and export administrator actions with actor, target, request, client, before/after values, timestamp, and result. Normal admin APIs cannot edit or delete these records."
      />
      <AdminNotice tone="warning">Audit history is append-only. No edit or delete action is exposed through this control plane.</AdminNotice>
      <AdminListControls
        search={list.search}
        onSearch={list.setSearch}
        exportHref={`/api/admin/audit-logs?${exportParams}`}
        filters={
          <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-11 rounded-2xl border border-white/10 bg-black px-4 text-sm">
            <option value="">Success and failure</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
          </select>
        }
      />
      <AdminTable
        loading={list.loading}
        error={list.error}
        empty="No admin audit records match this search."
        rows={list.data}
        columns={[
          {
            key: "action",
            label: "Action",
            render: (row) => <div><p className="font-black text-white">{displayValue(row.action)}</p><p className="mt-1 text-xs text-neutral-500">{displayValue(row.target_type, "platform")} · {displayValue(row.target_id, "No target")}</p></div>,
          },
          {
            key: "admin_email",
            label: "Administrator",
            render: (row) => <div><p>{displayValue(row.admin_email, "Unknown")}</p><code className="mt-1 block text-[11px] text-neutral-600">{displayValue(row.admin_user_id, "No user ID")}</code></div>,
          },
          {
            key: "created_at",
            label: "Request",
            render: (row) => <div><p>{formatAdminDate(row.created_at)}</p><code className="mt-1 block text-[11px] text-neutral-500">{displayValue(row.request_id)}</code><p className="mt-1 text-xs text-neutral-600">{displayValue(row.ip_address, "IP unavailable")}</p></div>,
          },
          {
            key: "values",
            label: "Change",
            render: (row) => <details className="max-w-[280px]"><summary className="cursor-pointer text-xs font-bold text-cyan-100">Previous / new values</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-black/40 p-2 text-[10px] text-neutral-400">{JSON.stringify({ previous: row.previous_values ?? null, next: row.new_values ?? null }, null, 2)}</pre></details>,
          },
          {
            key: "user_agent",
            label: "Client",
            render: (row) => <p className="max-w-[220px] break-words text-xs text-neutral-500">{displayValue(row.user_agent, "User agent unavailable")}</p>,
          },
          { key: "result", label: "Result", render: (row) => <StatusPill value={row.result} /> },
        ]}
      />
      <AdminPagination page={list.page} total={list.total} onPage={list.setPage} />
    </div>
  )
}
