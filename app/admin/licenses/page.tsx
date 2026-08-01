"use client"

import type { FormEvent } from "react"
import { useMemo, useRef, useState } from "react"
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
import {
  createLicenseSchema,
  licenseValidationErrors,
  licenseValidationIssue,
  type LicenseFieldName,
} from "@/lib/license/admin-license-validation"

const availableFeatures = ["billing", "customers", "inventory", "products", "reports", "orders", "backup", "multi_branch"]

function today() {
  return new Date().toISOString().slice(0, 10)
}

function oneYearFromNow() {
  const date = new Date()
  date.setUTCFullYear(date.getUTCFullYear() + 1)
  return date.toISOString().slice(0, 10)
}

const initialForm = {
  customer_name: "",
  customer_email: "",
  customer_phone: "",
  customer_company: "",
  customer_country: "",
  business_name: "",
  workspace_id: "",
  device_id: "",
  platform: "macos",
  architecture: "arm64",
  app_version: "",
  plan_name: "Offline ERP",
  issue_date: today(),
  expiry_date: oneYearFromNow(),
  grace_days: "7",
  maximum_users: "1",
  maximum_businesses: "1",
  maximum_branches: "1",
  internal_notes: "",
}

export default function LicensesPage() {
  const [status, setStatus] = useState("")
  const [platform, setPlatform] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState(initialForm)
  const [features, setFeatures] = useState(["billing", "customers", "inventory", "products", "reports"])
  const [saving, setSaving] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<Array<Record<string, unknown>>>([])
  const [historyTitle, setHistoryTitle] = useState("")
  const [notice, setNotice] = useState("")
  const [actionError, setActionError] = useState("")
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<LicenseFieldName, string>>>({})
  const createRequestKey = useRef("")
  const filters = useMemo(() => ({ status, platform }), [platform, status])
  const list = useAdminList<Record<string, unknown>>("/api/admin/licenses", filters)

  async function submitLicense(event: FormEvent) {
    event.preventDefault()
    setActionError("")
    setNotice("")
    const validation = createLicenseSchema.safeParse({
      ...form,
      grace_days: Number(form.grace_days),
      maximum_users: Number(form.maximum_users),
      maximum_businesses: Number(form.maximum_businesses),
      maximum_branches: Number(form.maximum_branches),
      allowed_features: features,
      status: "active",
      idempotency_key: createRequestKey.current || undefined,
    })
    if (!validation.success) {
      const firstIssue = licenseValidationIssue(validation.error.issues[0])
      setFieldErrors(licenseValidationErrors(validation.error))
      setActionError(firstIssue.error)
      return
    }

    setFieldErrors({})
    setSaving(true)
    try {
      if (!createRequestKey.current) createRequestKey.current = crypto.randomUUID()
      const payload = await adminMutation<{ license?: Record<string, unknown> }>("/api/admin/licenses", "POST", {
        ...validation.data,
        idempotency_key: createRequestKey.current,
      })
      const key = String(payload.license?.signed_license_key || "")
      if (key) await navigator.clipboard.writeText(key)
      setNotice("License generated, stored, audited, and copied to the clipboard.")
      setCreateOpen(false)
      setForm(initialForm)
      setFieldErrors({})
      createRequestKey.current = ""
      list.reload()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "License generation failed.")
    } finally {
      setSaving(false)
    }
  }

  async function runAction(row: Record<string, unknown>, action: string) {
    setActionError("")
    setNotice("")
    const id = String(row.id)
    let body: Record<string, unknown> = { id, action }

    if (action === "renew") {
      const expiry = window.prompt("New expiry date (YYYY-MM-DD)", oneYearFromNow())
      if (!expiry) return
      body.expiry_date = expiry
    }
    if (action === "extend") {
      const days = window.prompt("Number of days to extend", "30")
      if (!days) return
      body.extend_days = Number(days)
    }
    if (action === "change_grace") {
      const days = window.prompt("New grace period in days", String(row.grace_days || 7))
      if (days === null) return
      body.grace_days = Number(days)
    }
    if (action === "update_features") {
      const value = window.prompt(
        "Comma-separated allowed features",
        Array.isArray(row.allowed_features) ? row.allowed_features.join(",") : ""
      )
      if (!value) return
      body.allowed_features = value.split(",").map((item) => item.trim()).filter(Boolean)
      const plan = window.prompt("Plan name", String(row.plan_name || "Offline ERP"))
      if (plan) body.plan_name = plan
    }
    if (action === "replace_device" || action === "transfer") {
      const deviceId = window.prompt("Replacement Device ID")
      if (!deviceId) return
      const reason = window.prompt("Required transfer/replacement reason")
      if (!reason) return
      body = { ...body, new_device_id: deviceId, reason }
    }
    if (action === "suspend" || action === "revoke") {
      if (!window.confirm(`${action === "revoke" ? "Revoke" : "Suspend"} license ${id}?`)) return
      const reason = window.prompt("Internal reason (optional)")
      if (reason) body.reason = reason
    }

    try {
      const result = await adminMutation<{ license?: Record<string, unknown> }>("/api/admin/licenses", "PATCH", body)
      if ((action === "renew" || action === "extend" || action === "update_features" || action === "replace_device" || action === "transfer") && result.license?.signed_license_key) {
        await navigator.clipboard.writeText(String(result.license.signed_license_key))
        setNotice("License updated and the new signed key was copied.")
      } else {
        setNotice("License status updated and audited.")
      }
      list.reload()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "License action failed.")
    }
  }

  async function viewHistory(row: Record<string, unknown>) {
    setActionError("")
    try {
      const response = await fetch(`/api/admin/licenses/${row.id}/events`, { cache: "no-store", credentials: "include" })
      const payload = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: Array<Record<string, unknown>> }
      if (!response.ok || !payload.success) throw new Error(payload.error || "License history failed to load.")
      setHistory(payload.data || [])
      setHistoryTitle(`License history · ${row.id}`)
      setHistoryOpen(true)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "License history failed to load.")
    }
  }

  const exportParams = new URLSearchParams({ format: "csv", search: list.search, status, platform })

  return (
    <div className="space-y-6">
      <AdminPageHeader
        eyebrow="Authoritative licensing"
        title="Licenses"
        description="Generate and manage server-signed licenses that remain verifiable offline. Signing uses the server-only private key; desktop and browser bundles receive only the public verification key."
        action={
          <button type="button" onClick={() => { createRequestKey.current = ""; setFieldErrors({}); setActionError(""); setCreateOpen(true) }} className="h-12 rounded-2xl bg-cyan-300 px-5 text-sm font-black text-black">
            Generate license
          </button>
        }
      />

      {notice && <AdminNotice tone="success">{notice}</AdminNotice>}
      {actionError && <AdminNotice tone="danger">{actionError}</AdminNotice>}
      {Boolean(list.metadata.licenseSigning) && !(list.metadata.licenseSigning as { configured?: boolean }).configured && (
        <AdminNotice tone="warning">License signing is not configured on this server. Generation and signed-field changes are disabled.</AdminNotice>
      )}

      <AdminListControls
        search={list.search}
        onSearch={list.setSearch}
        exportHref={`/api/admin/licenses?${exportParams}`}
        filters={
          <>
            <select value={status} onChange={(event) => setStatus(event.target.value)} className="h-11 rounded-2xl border border-white/10 bg-black px-4 text-sm">
              <option value="">All statuses</option>
              {["draft", "active", "trial", "suspended", "revoked", "replaced", "expired"].map((value) => (
                <option key={value} value={value}>{value.replaceAll("_", " ")}</option>
              ))}
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
        empty="No license records match these filters. Generate a license after receiving a customer Device ID."
        rows={list.data}
        columns={[
          {
            key: "customer_name",
            label: "Customer / Business",
            render: (row) => (
              <div>
                <p className="font-black text-white">{displayValue(row.customer_name)}</p>
                <p className="mt-1 text-xs text-neutral-500">{displayValue(row.business_name)}</p>
                <p className="mt-1 text-xs text-neutral-600">{displayValue(row.customer_email)}</p>
              </div>
            ),
          },
          {
            key: "device_id",
            label: "Device",
            render: (row) => (
              <div>
                <code className="text-xs text-cyan-100">{displayValue(row.device_id)}</code>
                <p className="mt-1 text-xs text-neutral-500">{displayValue(row.platform)} · {displayValue(row.architecture, "Architecture not reported")} · {displayValue(row.app_version, "Version not reported")}</p>
              </div>
            ),
          },
          {
            key: "plan_name",
            label: "Plan",
            render: (row) => (
              <div>
                <p className="font-bold text-white">{displayValue(row.plan_name)}</p>
                <p className="mt-1 text-xs text-neutral-500">{Array.isArray(row.allowed_features) ? row.allowed_features.join(", ") : "Features not configured"}</p>
              </div>
            ),
          },
          {
            key: "expiry_date",
            label: "Validity",
            render: (row) => (
              <div>
                <p>{displayValue(row.expiry_date)}</p>
                <p className="mt-1 text-xs text-neutral-500">{displayValue(row.grace_days, "0")} grace days</p>
                <p className="mt-1 text-xs text-neutral-600">Issued {formatAdminDate(row.created_at)}</p>
              </div>
            ),
          },
          {
            key: "effective_status",
            label: "Status",
            render: (row) => <StatusPill value={row.effective_status} />,
          },
          {
            key: "actions",
            label: "Actions",
            render: (row) => (
              <div className="flex min-w-[270px] flex-wrap gap-2">
                <button type="button" onClick={() => void navigator.clipboard.writeText(String(row.signed_license_key || ""))} disabled={!row.signed_license_key} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold disabled:opacity-30">Copy key</button>
                <a href={`/api/admin/licenses/${row.id}/download`} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold">Download</a>
                <button type="button" onClick={() => void viewHistory(row)} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold">History</button>
                <button type="button" onClick={() => void runAction(row, "renew")} className="rounded-lg border border-cyan-400/25 px-2.5 py-1.5 text-xs font-bold text-cyan-100">Renew</button>
                <button type="button" onClick={() => void runAction(row, "extend")} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold">Extend</button>
                <button type="button" onClick={() => void runAction(row, "change_grace")} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold">Grace</button>
                <button type="button" onClick={() => void runAction(row, "update_features")} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-bold">Plan/features</button>
                <button type="button" onClick={() => void runAction(row, "replace_device")} className="rounded-lg border border-amber-400/20 px-2.5 py-1.5 text-xs font-bold text-amber-100">Replace device</button>
                <button type="button" onClick={() => void runAction(row, "transfer")} className="rounded-lg border border-amber-400/20 px-2.5 py-1.5 text-xs font-bold text-amber-100">Transfer</button>
                <button type="button" onClick={() => void runAction(row, "suspend")} className="rounded-lg border border-amber-400/20 px-2.5 py-1.5 text-xs font-bold text-amber-100">Suspend</button>
                <button type="button" onClick={() => void runAction(row, "revoke")} className="rounded-lg border border-red-400/20 px-2.5 py-1.5 text-xs font-bold text-red-200">Revoke</button>
              </div>
            ),
          },
        ]}
      />
      <AdminPagination page={list.page} total={list.total} onPage={list.setPage} />

      <AdminModal open={createOpen} title="Generate signed license" onClose={() => setCreateOpen(false)}>
        <form onSubmit={submitLicense} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              ["customer_name", "Customer name", "text"],
              ["customer_email", "Customer email", "email"],
              ["customer_phone", "Customer phone", "tel"],
              ["customer_company", "Company", "text"],
              ["customer_country", "Country", "text"],
              ["business_name", "Business name", "text"],
              ["workspace_id", "Workspace ID (optional)", "text"],
              ["device_id", "Device ID", "text"],
              ["app_version", "App version", "text"],
              ["plan_name", "Plan name", "text"],
              ["issue_date", "Issue date", "date"],
              ["expiry_date", "Expiry date", "date"],
              ["grace_days", "Grace days", "number"],
              ["maximum_users", "Maximum users", "number"],
              ["maximum_businesses", "Maximum businesses", "number"],
              ["maximum_branches", "Maximum branches", "number"],
            ].map(([key, label, type]) => (
              <label key={key} className="text-sm font-bold text-neutral-300">
                {label}
                <input
                  type={type}
                  value={form[key as keyof typeof form]}
                  required={!["customer_phone", "customer_company", "customer_country", "workspace_id", "app_version"].includes(key)}
                  aria-invalid={Boolean(fieldErrors[key as LicenseFieldName])}
                  aria-describedby={fieldErrors[key as LicenseFieldName] ? `${key}-error` : undefined}
                  onChange={(event) => {
                    setForm((current) => ({ ...current, [key]: event.target.value }))
                    setFieldErrors((current) => ({ ...current, [key]: undefined }))
                  }}
                  className={`mt-2 h-11 w-full rounded-xl border bg-black/50 px-3 outline-none focus:border-cyan-400/40 ${fieldErrors[key as LicenseFieldName] ? "border-red-400/60" : "border-white/10"}`}
                />
                {fieldErrors[key as LicenseFieldName] && <span id={`${key}-error`} className="mt-1 block text-xs text-red-200">{fieldErrors[key as LicenseFieldName]}</span>}
              </label>
            ))}
            <label className="text-sm font-bold text-neutral-300">
              Platform
              <select value={form.platform} onChange={(event) => { const nextPlatform = event.target.value; setForm((current) => ({ ...current, platform: nextPlatform, architecture: nextPlatform === "windows" ? "x86_64" : "arm64" })); setFieldErrors((current) => ({ ...current, platform: undefined, architecture: undefined })) }} className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black px-3">
                <option value="macos">macOS</option>
                <option value="windows">Windows</option>
              </select>
            </label>
            <label className="text-sm font-bold text-neutral-300">
              Architecture
              <select value={form.architecture} onChange={(event) => { setForm((current) => ({ ...current, architecture: event.target.value })); setFieldErrors((current) => ({ ...current, architecture: undefined })) }} className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black px-3">
                <option value="arm64">ARM64</option>
                <option value="x86_64">x86_64 (Windows x64)</option>
              </select>
            </label>
          </div>
          <fieldset>
            <legend className="text-sm font-bold text-neutral-300">Allowed features</legend>
            <div className="mt-3 flex flex-wrap gap-2">
              {availableFeatures.map((feature) => {
                const checked = features.includes(feature)
                return (
                  <label key={feature} className={`cursor-pointer rounded-xl border px-3 py-2 text-xs font-bold ${checked ? "border-cyan-300/35 bg-cyan-300/10 text-cyan-100" : "border-white/10 text-neutral-400"}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setFeatures((current) => checked ? current.filter((item) => item !== feature) : [...current, feature])
                        setFieldErrors((current) => ({ ...current, allowed_features: undefined }))
                      }}
                      className="sr-only"
                    />
                    {feature.replaceAll("_", " ")}
                  </label>
                )
              })}
            </div>
            {fieldErrors.allowed_features && <p className="mt-2 text-xs text-red-200">{fieldErrors.allowed_features}</p>}
          </fieldset>
          <label className="block text-sm font-bold text-neutral-300">
            Internal notes (optional)
            <textarea value={form.internal_notes} aria-invalid={Boolean(fieldErrors.internal_notes)} onChange={(event) => { setForm((current) => ({ ...current, internal_notes: event.target.value })); setFieldErrors((current) => ({ ...current, internal_notes: undefined })) }} className={`mt-2 min-h-24 w-full rounded-xl border bg-black/50 p-3 outline-none focus:border-cyan-400/40 ${fieldErrors.internal_notes ? "border-red-400/60" : "border-white/10"}`} />
            {fieldErrors.internal_notes && <span className="mt-1 block text-xs text-red-200">{fieldErrors.internal_notes}</span>}
          </label>
          {actionError && <AdminNotice tone="danger">{actionError}</AdminNotice>}
          <button type="submit" disabled={saving || features.length === 0} className="h-12 w-full rounded-2xl bg-cyan-300 text-sm font-black text-black disabled:opacity-40">
            {saving ? "Signing and storing…" : "Generate signed license"}
          </button>
        </form>
      </AdminModal>
      <AdminModal open={historyOpen} title={historyTitle || "License history"} onClose={() => setHistoryOpen(false)}>
        <div className="space-y-3">
          {history.length ? history.map((event) => (
            <article key={String(event.id)} className="rounded-2xl border border-white/10 bg-black/30 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-black">{displayValue(event.action)}</p>
                  <p className="mt-1 text-xs text-neutral-500">{displayValue(event.admin_email, "Administrator unavailable")} · {formatAdminDate(event.created_at)}</p>
                </div>
                <code className="text-[10px] text-neutral-600">{displayValue(event.request_id, "")}</code>
              </div>
              {Boolean(event.notes) && <p className="mt-3 text-sm text-neutral-300">{String(event.notes)}</p>}
              <details className="mt-3"><summary className="cursor-pointer text-xs font-bold text-cyan-100">Change details</summary><pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded-xl bg-black/40 p-3 text-[10px] text-neutral-400">{JSON.stringify({ previous: event.previous_values, next: event.new_values }, null, 2)}</pre></details>
            </article>
          )) : <p className="rounded-2xl border border-dashed border-white/10 py-10 text-center text-sm text-neutral-500">No history recorded.</p>}
        </div>
      </AdminModal>
    </div>
  )
}
