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

export default function BackupsPage() {
  const [status, setStatus] = useState("")
  const filters = useMemo(() => ({ status }), [status])
  const list = useAdminList<Record<string, unknown>>("/api/admin/backups", filters)
  const exportParams = new URLSearchParams({ format: "csv", search: list.search, status })

  return (
    <div className="space-y-6">
      <AdminPageHeader
        eyebrow="Opt-in cloud services"
        title="Backups"
        description="Backup metadata appears only for a separate service explicitly enabled by the customer. The desktop ERP remains fully functional when it is disabled."
      />
      <AdminNotice>{String(list.metadata.privacyNotice || "No hidden uploads: local invoices, products, customers, and credentials stay on the customer device by default.")}</AdminNotice>
      <AdminListControls
        search={list.search}
        onSearch={list.setSearch}
        exportHref={`/api/admin/backups?${exportParams}`}
        filters={
          <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-11 rounded-2xl border border-white/10 bg-black px-4 text-sm">
            <option value="">Enabled and disabled</option>
            <option value="enabled">Cloud backup enabled</option>
            <option value="disabled">Cloud backup disabled</option>
          </select>
        }
      />
      <AdminTable
        loading={list.loading}
        error={list.error}
        empty="No customer-enabled cloud backup metadata has been reported."
        rows={list.data}
        columns={[
          {
            key: "business",
            label: "Business",
            render: (row) => {
              const business = (row.business || {}) as Record<string, unknown>
              return <div><p className="font-black text-white">{displayValue(business.business_name, "Workspace metadata unavailable")}</p><code className="mt-1 block text-[11px] text-neutral-500">{displayValue(business.workspace_id, "Workspace not linked")}</code></div>
            },
          },
          {
            key: "cloud_backup_enabled",
            label: "Cloud backup",
            render: (row) => <StatusPill value={row.cloud_backup_enabled ? "enabled" : "disabled"} />,
          },
          {
            key: "results",
            label: "Backup result",
            render: (row) => <div><p>Last successful: {formatAdminDate(row.last_successful_backup_at)}</p><p className="mt-1 text-xs text-neutral-500">Last failed: {formatAdminDate(row.last_failed_backup_at)}</p><p className="mt-1 text-xs text-red-200">{displayValue(row.last_failure_code, "")}</p></div>,
          },
          {
            key: "backup_size",
            label: "Protection",
            render: (row) => <div><p>{row.backup_size === null || row.backup_size === undefined ? "Backup size not reported" : `${Number(row.backup_size).toLocaleString()} bytes`}</p><p className="mt-1 text-xs text-neutral-500">Encryption: {displayValue(row.encryption_status, "Not reported")}</p><p className="mt-1 text-xs text-neutral-600">Retention: {displayValue(row.retention_policy, "Not configured")}</p></div>,
          },
          {
            key: "sync_conflict_count",
            label: "Restore",
            render: (row) => <div><p>{displayValue(row.restore_request_status, "No request")}</p><p className="mt-1 text-xs text-neutral-500">Customer-controlled</p></div>,
          },
        ]}
      />
      <AdminPagination page={list.page} total={list.total} onPage={list.setPage} />
    </div>
  )
}
