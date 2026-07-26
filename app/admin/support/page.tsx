"use client"

import type { FormEvent } from "react"
import { useMemo, useState } from "react"
import {
  AdminListControls,
  AdminModal,
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

export default function SupportPage() {
  const [status, setStatus] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState("")
  const [actionError, setActionError] = useState("")
  const [form, setForm] = useState({
    subject: "",
    description: "",
    priority: "normal",
    platform_customer_id: "",
    registered_device_id: "",
    license_id: "",
    private_admin_notes: "",
  })
  const filters = useMemo(() => ({ status }), [status])
  const list = useAdminList<Record<string, unknown>>("/api/admin/support", filters)

  async function createCase(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setActionError("")
    try {
      await adminMutation("/api/admin/support", "POST", {
        ...form,
        platform_customer_id: form.platform_customer_id || null,
        registered_device_id: form.registered_device_id || null,
        license_id: form.license_id || null,
      })
      setCreateOpen(false)
      setNotice("Support case created and audited.")
      setForm({ subject: "", description: "", priority: "normal", platform_customer_id: "", registered_device_id: "", license_id: "", private_admin_notes: "" })
      list.reload()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Support case could not be created.")
    } finally {
      setSaving(false)
    }
  }

  async function action(row: Record<string, unknown>, actionName: string) {
    setNotice("")
    setActionError("")
    const body: Record<string, unknown> = { id: row.id, action: actionName }
    if (actionName === "add_notes") {
      const notes = window.prompt("Private admin notes", String(row.private_admin_notes || ""))
      if (!notes) return
      body.private_admin_notes = notes
    }
    try {
      await adminMutation("/api/admin/support", "PATCH", body)
      setNotice(actionName === "request_diagnostics" ? "New diagnostic package requested." : "Support case updated and audited.")
      list.reload()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Support action failed.")
    }
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader
        eyebrow="Consent-based assistance"
        title="Support and diagnostics"
        description="Manage support cases and voluntarily uploaded, sanitized diagnostics. Sensitive business records, passwords, tokens, and signing keys are excluded by contract."
        action={<button type="button" onClick={() => setCreateOpen(true)} className="h-12 rounded-2xl bg-cyan-300 px-5 text-sm font-black text-black">Create support case</button>}
      />
      <AdminNotice>{String(list.metadata.diagnosticPrivacy || "Diagnostics are voluntary, sanitized, and limited to technical metadata.")}</AdminNotice>
      {notice && <AdminNotice tone="success">{notice}</AdminNotice>}
      {actionError && <AdminNotice tone="danger">{actionError}</AdminNotice>}
      <AdminListControls
        search={list.search}
        onSearch={list.setSearch}
        filters={
          <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-11 rounded-2xl border border-white/10 bg-black px-4 text-sm">
            <option value="">All cases</option>
            {["open", "in_progress", "waiting_customer", "resolved"].map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
          </select>
        }
      />
      <AdminTable
        loading={list.loading}
        error={list.error}
        empty="No support cases have been created."
        rows={list.data}
        columns={[
          {
            key: "case_number",
            label: "Case",
            render: (row) => <div><p className="font-black text-white">{displayValue(row.case_number)}</p><p className="mt-1 max-w-[260px] font-bold">{displayValue(row.subject)}</p><p className="mt-1 text-xs text-neutral-500">{formatAdminDate(row.created_at)}</p></div>,
          },
          {
            key: "links",
            label: "Linked records",
            render: (row) => <div className="space-y-1 text-xs"><p>Customer: {displayValue(row.platform_customer_id, "Not linked")}</p><p>Device: {displayValue(row.registered_device_id, "Not linked")}</p><p>License: {displayValue(row.license_id, "Not linked")}</p></div>,
          },
          {
            key: "diagnostics",
            label: "Diagnostics",
            render: (row) => {
              const diagnostics = Array.isArray(row.diagnostic_uploads) ? row.diagnostic_uploads : []
              const latest = (diagnostics[0] || null) as Record<string, unknown> | null
              return latest ? <div><StatusPill value="available" /><p className="mt-2 text-xs">App {displayValue(latest.app_version, "version not reported")} · {displayValue(latest.operating_system, "OS not reported")}</p><p className="mt-1 text-xs text-neutral-500">DB integrity: {displayValue(latest.database_integrity_result, "Not reported")}</p><p className="mt-1 text-xs text-neutral-500">License: {displayValue(latest.license_status, "Not reported")}</p></div> : <span className="text-neutral-500">Not uploaded</span>
            },
          },
          {
            key: "status",
            label: "Status",
            render: (row) => <div className="space-y-2"><StatusPill value={row.status} /><div><StatusPill value={row.priority} /></div></div>,
          },
          {
            key: "actions",
            label: "Actions",
            render: (row) => (
              <div className="flex min-w-[230px] flex-wrap gap-2">
                {row.status !== "resolved" && <button type="button" onClick={() => void action(row, "mark_in_progress")} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold">In progress</button>}
                <button type="button" onClick={() => void action(row, "add_notes")} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold">Private notes</button>
                <button type="button" onClick={() => void action(row, "request_diagnostics")} className="rounded-lg border border-cyan-400/25 px-2.5 py-1.5 text-xs font-bold text-cyan-100">Request diagnostics</button>
                {row.status !== "resolved" && <button type="button" onClick={() => void action(row, "resolve")} className="rounded-lg border border-emerald-400/25 px-2.5 py-1.5 text-xs font-bold text-emerald-100">Resolve</button>}
              </div>
            ),
          },
        ]}
      />
      <AdminPagination page={list.page} total={list.total} onPage={list.setPage} />

      <AdminModal open={createOpen} title="Create support case" onClose={() => setCreateOpen(false)}>
        <form onSubmit={createCase} className="space-y-4">
          {[
            ["subject", "Subject", true],
            ["platform_customer_id", "Platform customer ID", false],
            ["registered_device_id", "Registered device record ID", false],
            ["license_id", "License ID", false],
          ].map(([key, label, required]) => (
            <label key={String(key)} className="block text-sm font-bold text-neutral-300">
              {String(label)}
              <input required={Boolean(required)} value={form[key as keyof typeof form]} onChange={(event) => setForm((current) => ({ ...current, [String(key)]: event.target.value }))} className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black/50 px-3 outline-none focus:border-cyan-400/40" />
            </label>
          ))}
          <label className="block text-sm font-bold text-neutral-300">
            Priority
            <select value={form.priority} onChange={(event) => setForm((current) => ({ ...current, priority: event.target.value }))} className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black px-3">
              {["low", "normal", "high", "urgent"].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="block text-sm font-bold text-neutral-300">
            Description
            <textarea value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} className="mt-2 min-h-28 w-full rounded-xl border border-white/10 bg-black/50 p-3 outline-none focus:border-cyan-400/40" />
          </label>
          <label className="block text-sm font-bold text-neutral-300">
            Private admin notes
            <textarea value={form.private_admin_notes} onChange={(event) => setForm((current) => ({ ...current, private_admin_notes: event.target.value }))} className="mt-2 min-h-20 w-full rounded-xl border border-white/10 bg-black/50 p-3 outline-none focus:border-cyan-400/40" />
          </label>
          {actionError && <AdminNotice tone="danger">{actionError}</AdminNotice>}
          <button type="submit" disabled={saving} className="h-12 w-full rounded-2xl bg-cyan-300 text-sm font-black text-black disabled:opacity-40">
            {saving ? "Creating case…" : "Create support case"}
          </button>
        </form>
      </AdminModal>
    </div>
  )
}
