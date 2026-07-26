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

export default function PlatformCustomersPage() {
  const [status, setStatus] = useState("")
  const [notice, setNotice] = useState("")
  const [actionError, setActionError] = useState("")
  const filters = useMemo(() => ({ status }), [status])
  const list = useAdminList<Record<string, unknown>>("/api/admin/customers", filters)
  const exportParams = new URLSearchParams({ format: "csv", search: list.search, status })

  async function editCustomer(row: Record<string, unknown>) {
    const notes = window.prompt("Internal customer notes", String(row.notes || ""))
    if (notes === null) return
    const nextStatus = window.prompt("Account status: active, suspended, or closed", String(row.account_status || "active"))
    if (!nextStatus) return
    try {
      await adminMutation("/api/admin/customers", "PATCH", {
        id: row.id,
        notes,
        account_status: nextStatus,
      })
      setNotice("Platform customer updated and audited.")
      setActionError("")
      list.reload()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Customer update failed.")
    }
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader
        eyebrow="Commercial relationships"
        title="Platform customers"
        description="People and companies purchasing or using Bezgrow. These records are completely separate from retail customers stored in each local billing database."
      />
      <AdminNotice>{String(list.metadata.dataNotice || "Platform customers never include local ERP retail customer records.")}</AdminNotice>
      {notice && <AdminNotice tone="success">{notice}</AdminNotice>}
      {actionError && <AdminNotice tone="danger">{actionError}</AdminNotice>}
      <AdminListControls
        search={list.search}
        onSearch={list.setSearch}
        exportHref={`/api/admin/customers?${exportParams}`}
        filters={
          <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-11 rounded-2xl border border-white/10 bg-black px-4 text-sm">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="closed">Closed</option>
          </select>
        }
      />
      <AdminTable
        loading={list.loading}
        error={list.error}
        empty="No platform customers have been registered."
        rows={list.data}
        columns={[
          {
            key: "name",
            label: "Customer",
            render: (row) => <div><p className="font-black text-white">{displayValue(row.name)}</p><p className="mt-1 text-xs text-neutral-500">{displayValue(row.email)}</p><p className="mt-1 text-xs text-neutral-600">{displayValue(row.phone, "Phone not configured")}</p></div>,
          },
          {
            key: "company",
            label: "Company",
            render: (row) => <div><p>{displayValue(row.company, "Not configured")}</p><p className="mt-1 text-xs text-neutral-500">{displayValue(row.country, "Country not configured")}</p></div>,
          },
          {
            key: "counts",
            label: "Platform footprint",
            render: (row) => <div className="space-y-1 text-xs"><p>{Number(row.license_count || 0)} licenses</p><p>{Number(row.device_count || 0)} devices</p><p>{Number(row.business_count || 0)} cloud-registered workspaces</p></div>,
          },
          {
            key: "activity",
            label: "Activity",
            render: (row) => <div><p>Created {formatAdminDate(row.created_at)}</p><p className="mt-1 text-xs text-neutral-500">Last platform activity: {formatAdminDate(row.last_platform_activity_at)}</p></div>,
          },
          {
            key: "status",
            label: "Status",
            render: (row) => <div className="space-y-2"><StatusPill value={row.account_status} /><div><StatusPill value={Number(row.open_support_count || 0) ? "support attention" : row.support_status} /></div></div>,
          },
          {
            key: "actions",
            label: "Actions",
            render: (row) => <button type="button" onClick={() => void editCustomer(row)} className="rounded-xl border border-white/10 px-3 py-2 text-xs font-black hover:border-cyan-300/30">Edit notes / status</button>,
          },
        ]}
      />
      <AdminPagination page={list.page} total={list.total} onPage={list.setPage} />
    </div>
  )
}
