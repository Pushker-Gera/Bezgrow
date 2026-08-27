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
import { LicenseActionDialog } from "@/components/admin/LicenseActionDialog"
import { LicenseActionButtons } from "@/components/admin/LicenseActionButtons"
import { APP_LOCK_MIN_PASSWORD_LENGTH } from "@/lib/app-lock/shared"
import { copyAdminText, downloadAdminFile, secureAdminFetch } from "@/lib/platform-admin/client"
import {
  createLicenseSchema,
  licenseValidationErrors,
  licenseValidationIssue,
  MODERN_LICENSE_FEATURES,
  type AdminLicenseAction,
  type LicenseFieldName,
  type ValidUpdateLicenseInput,
} from "@/lib/license/admin-license-validation"

const availableFeatures = [...MODERN_LICENSE_FEATURES]

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
  app_password: "",
}

function generateAppPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  return `Bg9-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`
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
  const [activeAction, setActiveAction] = useState<{ action: AdminLicenseAction; row: Record<string, unknown> } | null>(null)
  const [pendingActionId, setPendingActionId] = useState("")
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<LicenseFieldName, string>>>({})
  const [oneTimeCredential, setOneTimeCredential] = useState<{ password: string; licenseKey?: string; title: string } | null>(null)
  const createRequestKey = useRef("")
  const createInFlight = useRef(false)
  const filters = useMemo(() => ({ status, platform }), [platform, status])
  const list = useAdminList<Record<string, unknown>>("/api/admin/licenses", filters)

  async function submitLicense(event: FormEvent) {
    event.preventDefault()
    if (createInFlight.current) return
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
    createInFlight.current = true
    setSaving(true)
    try {
      if (!createRequestKey.current) createRequestKey.current = crypto.randomUUID()
      const payload = await adminMutation<{ license?: Record<string, unknown> }>("/api/admin/licenses", "POST", {
        ...validation.data,
        idempotency_key: createRequestKey.current,
      })
      const key = String(payload.license?.signed_license_key || "")
      setOneTimeCredential({
        password: validation.data.app_password,
        licenseKey: key,
        title: "Initial app-access credential",
      })
      setNotice("Licence generated, hashed app-access credential provisioned, and audit recorded.")
      setCreateOpen(false)
      setForm(initialForm)
      setFieldErrors({})
      createRequestKey.current = ""
      if (payload.license) list.prepend({ ...payload.license, effective_status: payload.license.status })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "License generation failed.")
    } finally {
      createInFlight.current = false
      setSaving(false)
    }
  }

  function openAction(row: Record<string, unknown>, action: AdminLicenseAction) {
    setActionError("")
    setNotice("")
    setActiveAction({ row, action })
  }

  async function runAction(input: ValidUpdateLicenseInput) {
    const mutationKey = `${input.id}:${input.action}`
    if (pendingActionId) throw new Error("Another licence action is already being applied.")
    setPendingActionId(mutationKey)
    setActionError("")
    setNotice("")
    try {
      const result = await adminMutation<{
        license?: Record<string, unknown>
        replacedLicense?: Record<string, unknown>
        replacedLicenseId?: string
        duplicate?: boolean
      }>("/api/admin/licenses", "PATCH", input)
      if (!result.license) throw new Error("The control plane did not return the updated licence row.")
      if (result.replacedLicense) list.upsert(result.replacedLicense)
      if (result.replacedLicenseId) list.prepend(result.license)
      else list.upsert(result.license)
      const labels: Partial<Record<AdminLicenseAction, string>> = {
        renew: "Licence renewed, re-signed, audited, and queued for device refresh.",
        extend: "Licence extended, re-signed, audited, and queued for device refresh.",
        change_grace: "Grace period updated, re-signed, and audited.",
        update_features: "Plan and features updated, re-signed, and audited.",
        replace_device: "Replacement licence issued; the previous device binding is now replaced.",
        transfer: "Licence transferred atomically to the target device.",
        suspend: "Licence suspended. The installed device will enforce it at the next online verification.",
        reactivate: "Licence reactivated. The installed device will resume at the next online verification.",
        revoke: "Licence revoked. Local ERP data remains untouched.",
        reset_app_password: "A signed, device-bound app-password reset was authorized for 30 minutes.",
      }
      setNotice(`${labels[input.action] || "Licence updated and audited."}${result.duplicate ? " The original idempotent result was returned." : ""}`)
      if (input.app_password) {
        setOneTimeCredential({
          password: input.app_password,
          title: input.action === "reset_app_password" ? "Replacement app-access credential" : "Target-device app-access credential",
        })
      }
      setActiveAction(null)
    } finally {
      setPendingActionId("")
    }
  }

  async function copyCurrentKey(row: Record<string, unknown>) {
    const id = String(row.id)
    const mutationKey = `${id}:copy`
    if (pendingActionId) return
    setPendingActionId(mutationKey)
    setActionError("")
    setNotice("")
    try {
      const response = await secureAdminFetch(`/api/admin/licenses/${encodeURIComponent(id)}/download`, { cache: "no-store", signal: AbortSignal.timeout(15_000) })
      const payload = await response.json().catch(() => null) as { license_key?: string; error?: string } | null
      if (!response.ok || !payload?.license_key) throw new Error(payload?.error || "The current signed licence key is unavailable.")
      await copyAdminText(payload.license_key)
      setNotice("Current signed licence key copied.")
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Licence key could not be copied.")
    } finally {
      setPendingActionId("")
    }
  }

  async function viewHistory(row: Record<string, unknown>) {
    setActionError("")
    try {
      const response = await secureAdminFetch(`/api/admin/licenses/${row.id}/events`, { cache: "no-store" })
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
              <LicenseActionButtons
                row={row}
                busy={Boolean(pendingActionId)}
                onAction={(action) => openAction(row, action)}
                onCopy={() => void copyCurrentKey(row)}
                onDownload={() => void downloadAdminFile(`/api/admin/licenses/${row.id}/download`).then((saved) => { if (saved) setNotice(`Current licence saved as ${saved.filename}.`) }).catch((error) => setActionError(error instanceof Error ? error.message : "License download failed."))}
                onHistory={() => void viewHistory(row)}
              />
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
              ["app_password", "Initial app-access password", "password"],
            ].map(([key, label, type]) => (
              <label key={key} className="text-sm font-bold text-neutral-300">
                {label}
                <input
                  type={type}
                  value={form[key as keyof typeof form]}
                  minLength={key === "app_password" ? APP_LOCK_MIN_PASSWORD_LENGTH : undefined}
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
          <button type="button" onClick={() => { setForm((current) => ({ ...current, app_password: generateAppPassword() })); setFieldErrors((current) => ({ ...current, app_password: undefined })) }} className="h-11 rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-4 text-sm font-black text-emerald-100">
            Generate strong app password
          </button>
          <p className="text-xs leading-5 text-neutral-500">App-access passwords require at least {APP_LOCK_MIN_PASSWORD_LENGTH} characters with uppercase, lowercase, and a number.</p>
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
      <AdminModal open={Boolean(oneTimeCredential)} title={oneTimeCredential?.title || "App-access credential"} onClose={() => setOneTimeCredential(null)}>
        {oneTimeCredential && (
          <div className="space-y-5">
            <AdminNotice tone="warning">Copy this password now. Bezgrow stores only a one-way verifier and cannot show this plaintext value again.</AdminNotice>
            <div className="rounded-2xl border border-emerald-400/20 bg-black/40 p-5">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-neutral-500">App-access password</p>
              <code className="mt-3 block break-all text-lg font-black text-emerald-100">{oneTimeCredential.password}</code>
              <button type="button" onClick={() => void copyAdminText(oneTimeCredential.password)} className="mt-4 h-11 rounded-xl bg-emerald-300 px-4 text-sm font-black text-black">Copy password</button>
            </div>
            {oneTimeCredential.licenseKey && (
              <button type="button" onClick={() => void copyAdminText(oneTimeCredential.licenseKey as string)} className="h-11 w-full rounded-xl border border-cyan-400/25 bg-cyan-400/10 px-4 text-sm font-black text-cyan-100">Copy signed licence key</button>
            )}
            <button type="button" onClick={() => setOneTimeCredential(null)} className="h-11 w-full rounded-xl border border-white/10 px-4 text-sm font-black">I have stored it safely</button>
          </div>
        )}
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
      {activeAction && (
        <LicenseActionDialog
          key={`${activeAction.row.id}:${activeAction.action}:${activeAction.row.updated_at}`}
          action={activeAction.action}
          row={activeAction.row}
          onClose={() => setActiveAction(null)}
          onConfirm={runAction}
        />
      )}
    </div>
  )
}
