"use client"

import type { FormEvent } from "react"
import { useMemo, useState } from "react"
import { AdminModal, AdminNotice, displayValue } from "@/components/admin/ControlPlaneUi"
import {
  APP_LOCK_MAX_PASSWORD_LENGTH,
  APP_LOCK_MIN_PASSWORD_LENGTH,
  APP_LOCK_PASSWORD_HELP,
  appPasswordPolicyError,
  generateAppPassword,
} from "@/lib/app-lock/shared"
import {
  addLicenseDays,
  licenseActionStateError,
  renewedExpiry,
} from "@/lib/license/admin-license-actions"
import {
  LICENSE_RENEWAL_MONTHS,
  MODERN_LICENSE_FEATURES,
  licenseMutationValidationMessage,
  updateLicenseSchema,
  type AdminLicenseAction,
  type ValidUpdateLicenseInput,
} from "@/lib/license/admin-license-validation"

type LicenseActionDialogProps = {
  action: AdminLicenseAction
  row: Record<string, unknown>
  onClose: () => void
  onConfirm: (input: ValidUpdateLicenseInput) => Promise<void>
}

const actionTitles: Record<AdminLicenseAction, string> = {
  renew: "Renew licence",
  extend: "Extend licence",
  change_grace: "Change grace period",
  update_features: "Change plan and features",
  replace_device: "Replace licensed device",
  transfer: "Transfer licence to another device",
  suspend: "Suspend licence",
  reactivate: "Reactivate licence",
  revoke: "Revoke licence",
  reset_app_password: "Reset app-access password",
  notes: "Update licence notes",
}

const actionButtons: Record<AdminLicenseAction, string> = {
  renew: "Renew Licence",
  extend: "Extend Licence",
  change_grace: "Update Grace",
  update_features: "Update Plan",
  replace_device: "Replace Device",
  transfer: "Transfer Licence",
  suspend: "Suspend Licence",
  reactivate: "Reactivate Licence",
  revoke: "Revoke Licence",
  reset_app_password: "Authorize Password Reset",
  notes: "Save Notes",
}

function inputClassName(danger = false) {
  return `mt-2 h-11 w-full rounded-xl border bg-black/50 px-3 outline-none focus:border-cyan-400/50 ${danger ? "border-red-400/40" : "border-white/10"}`
}

export function LicenseActionDialog({ action, row, onClose, onConfirm }: LicenseActionDialogProps) {
  const currentFeatures = useMemo(
    () => Array.isArray(row.allowed_features)
      ? row.allowed_features.map(String).filter((feature) => MODERN_LICENSE_FEATURES.includes(feature as (typeof MODERN_LICENSE_FEATURES)[number]))
      : [],
    [row.allowed_features],
  )
  const [renewMonths, setRenewMonths] = useState(12)
  const [extendDays, setExtendDays] = useState(30)
  const [graceDays, setGraceDays] = useState(Number(row.grace_days || 0))
  const [planName, setPlanName] = useState(String(row.plan_name || "Offline ERP"))
  const [features, setFeatures] = useState<string[]>(currentFeatures.length ? currentFeatures : ["billing"])
  const [newDeviceId, setNewDeviceId] = useState("")
  const [confirmedDeviceId, setConfirmedDeviceId] = useState("")
  const [reason, setReason] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [internalNotes, setInternalNotes] = useState(String(row.internal_notes || ""))
  const [appPassword, setAppPassword] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const currentExpiry = String(row.expiry_date || "")
  const stateError = licenseActionStateError(action, row.status)
  const nextExpiry = action === "renew"
    ? renewedExpiry(currentExpiry, renewMonths)
    : action === "extend"
      ? addLicenseDays(currentExpiry, extendDays)
      : ""
  const candidate = {
    id: String(row.id),
    action,
    idempotency_key: idempotencyKey,
    expected_updated_at: String(row.updated_at),
    renew_months: action === "renew" ? renewMonths : undefined,
    extend_days: action === "extend" ? extendDays : undefined,
    grace_days: action === "change_grace" ? graceDays : undefined,
    allowed_features: action === "update_features" ? features : undefined,
    plan_name: action === "update_features" ? planName : undefined,
    new_device_id: action === "replace_device" || action === "transfer" ? newDeviceId : undefined,
    confirmed_device_id: action === "replace_device" || action === "transfer" ? confirmedDeviceId : undefined,
    confirmation: ["suspend", "reactivate", "revoke"].includes(action) ? confirmation : undefined,
    reason: ["replace_device", "transfer", "suspend", "reactivate", "revoke", "reset_app_password"].includes(action) ? reason : undefined,
    app_password: ["replace_device", "transfer", "reset_app_password"].includes(action) ? appPassword : undefined,
    internal_notes: action === "notes" ? internalNotes : undefined,
  }
  const candidateValidation = updateLicenseSchema.safeParse(candidate)
  const appPasswordError = appPassword ? appPasswordPolicyError(appPassword) : null

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending || stateError) return
    setError("")
    if (!candidateValidation.success) {
      const issue = candidateValidation.error.issues[0]
      setError(issue ? licenseMutationValidationMessage(action, issue) : "Check the licence change and try again.")
      return
    }
    setPending(true)
    try {
      await onConfirm(candidateValidation.data)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Licence action failed.")
      setPending(false)
    }
  }

  const destructive = action === "revoke"
  const confirmationWord = action === "suspend" ? "SUSPEND" : action === "reactivate" ? "REACTIVATE" : "REVOKE"

  return (
    <AdminModal open title={actionTitles[action]} onClose={() => { if (!pending) onClose() }}>
      <form data-license-action-form={action} onSubmit={submit} className="desktop-interactive space-y-5">
        <section className="grid gap-3 rounded-2xl border border-white/10 bg-black/35 p-4 text-sm sm:grid-cols-2">
          <div><span className="text-neutral-500">Customer</span><p className="mt-1 font-black">{displayValue(row.customer_name)}</p></div>
          <div><span className="text-neutral-500">Business</span><p className="mt-1 font-black">{displayValue(row.business_name)}</p></div>
          <div><span className="text-neutral-500">Device ID</span><code className="mt-1 block break-all text-xs text-cyan-100">{displayValue(row.device_id)}</code></div>
          <div><span className="text-neutral-500">Current status</span><p className="mt-1 font-black uppercase">{displayValue(row.effective_status || row.status)}</p></div>
        </section>

        {action === "renew" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-bold text-neutral-300">
              Renewal duration
              <select autoFocus value={renewMonths} onChange={(event) => setRenewMonths(Number(event.target.value))} className={inputClassName()}>
                {LICENSE_RENEWAL_MONTHS.map((months) => <option key={months} value={months}>{months} month{months === 1 ? "" : "s"}</option>)}
              </select>
            </label>
            <div className="rounded-2xl border border-cyan-400/20 bg-cyan-500/10 p-4 text-sm">
              <p className="text-neutral-400">Current expiry: <strong className="text-white">{currentExpiry}</strong></p>
              <p className="mt-2 text-neutral-300">New expiry: <strong className="text-cyan-100">{nextExpiry}</strong></p>
            </div>
          </div>
        )}

        {action === "extend" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-bold text-neutral-300">
              Days to add
              <input autoFocus type="number" min={1} max={3650} value={extendDays} onChange={(event) => setExtendDays(Number(event.target.value))} className={inputClassName()} />
            </label>
            <div className="rounded-2xl border border-white/10 bg-black/35 p-4 text-sm">
              <p className="text-neutral-400">Current expiry: <strong className="text-white">{currentExpiry}</strong></p>
              <p className="mt-2 text-neutral-300">Resulting expiry: <strong className="text-cyan-100">{nextExpiry}</strong></p>
            </div>
          </div>
        )}

        {action === "change_grace" && (
          <label className="block text-sm font-bold text-neutral-300">
            Grace period in days (0–365)
            <input autoFocus type="number" min={0} max={365} value={graceDays} onChange={(event) => setGraceDays(Number(event.target.value))} className={inputClassName()} />
            <span className="mt-2 block text-xs font-normal text-neutral-500">Current grace: {displayValue(row.grace_days, "0")} days</span>
          </label>
        )}

        {action === "update_features" && (
          <>
            <label className="block text-sm font-bold text-neutral-300">
              Plan name
              <input autoFocus value={planName} onChange={(event) => setPlanName(event.target.value)} className={inputClassName()} />
            </label>
            <fieldset>
              <legend className="text-sm font-bold text-neutral-300">Current Bezgrow capabilities</legend>
              <div className="mt-3 flex flex-wrap gap-2">
                {MODERN_LICENSE_FEATURES.map((feature) => {
                  const checked = features.includes(feature)
                  return (
                    <label key={feature} className={`desktop-interactive cursor-pointer rounded-xl border px-3 py-2 text-xs font-bold ${checked ? "border-cyan-300/35 bg-cyan-300/10 text-cyan-100" : "border-white/10 text-neutral-400"}`}>
                      <input type="checkbox" checked={checked} onChange={() => setFeatures((current) => checked ? current.filter((item) => item !== feature) : [...current, feature])} className="sr-only" />
                      {feature.replaceAll("_", " ")}
                    </label>
                  )
                })}
              </div>
              {Array.isArray(row.allowed_features) && row.allowed_features.includes("orders") && (
                <p className="mt-3 text-xs text-neutral-500">The legacy orders capability is retained only for backward compatibility and is not offered as a current module.</p>
              )}
            </fieldset>
          </>
        )}

        {(action === "replace_device" || action === "transfer") && (
          <div className="space-y-4">
            <p className="rounded-2xl border border-amber-400/20 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100">
              The old device will stop authorizing protected ERP actions after its next online verification. Its local business data and Device ID will not be deleted.
            </p>
            <label className="block text-sm font-bold text-neutral-300">Target Device ID<input autoFocus value={newDeviceId} onChange={(event) => setNewDeviceId(event.target.value)} className={inputClassName()} /></label>
            <label className="block text-sm font-bold text-neutral-300">Re-enter target Device ID<input value={confirmedDeviceId} onChange={(event) => setConfirmedDeviceId(event.target.value)} className={inputClassName()} /></label>
            <label className="block text-sm font-bold text-neutral-300">
              Initial app-access password
              <input type="password" autoComplete="new-password" minLength={APP_LOCK_MIN_PASSWORD_LENGTH} maxLength={APP_LOCK_MAX_PASSWORD_LENGTH} required value={appPassword} onChange={(event) => setAppPassword(event.target.value)} aria-invalid={Boolean(appPasswordError)} aria-describedby="device-password-help" className={inputClassName(Boolean(appPasswordError))} />
            </label>
            <p id="device-password-help" className={`text-xs leading-5 ${appPasswordError ? "text-red-200" : "text-neutral-500"}`}>{appPasswordError || APP_LOCK_PASSWORD_HELP}</p>
            <button type="button" onClick={() => { setAppPassword(generateAppPassword()); setError("") }} className="h-11 rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-4 text-sm font-black text-emerald-100">Generate strong password</button>
            <label className="block text-sm font-bold text-neutral-300">Reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} className="mt-2 min-h-24 w-full rounded-xl border border-white/10 bg-black/50 p-3 outline-none focus:border-cyan-400/50" /></label>
          </div>
        )}

        {action === "reset_app_password" && (
          <div className="space-y-4">
            <p className="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 p-4 text-sm leading-6 text-emerald-100">
              This creates a signed, device-bound reset authorization valid for 30 minutes. It never reveals the previous password and takes effect when this device next verifies the licence or imports the refreshed key.
            </p>
            <label className="block text-sm font-bold text-neutral-300">
              New app-access password
              <input autoFocus type="password" autoComplete="new-password" minLength={APP_LOCK_MIN_PASSWORD_LENGTH} maxLength={APP_LOCK_MAX_PASSWORD_LENGTH} required value={appPassword} onChange={(event) => setAppPassword(event.target.value)} aria-invalid={Boolean(appPasswordError)} aria-describedby="reset-password-help" className={inputClassName(Boolean(appPasswordError))} />
            </label>
            <p id="reset-password-help" className={`text-xs leading-5 ${appPasswordError ? "text-red-200" : "text-neutral-500"}`}>{appPasswordError || APP_LOCK_PASSWORD_HELP}</p>
            <button type="button" onClick={() => { setAppPassword(generateAppPassword()); setError("") }} className="h-11 rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-4 text-sm font-black text-emerald-100">Generate strong password</button>
            <label className="block text-sm font-bold text-neutral-300">Reset reason<textarea required value={reason} onChange={(event) => setReason(event.target.value)} className="mt-2 min-h-20 w-full rounded-xl border border-white/10 bg-black/50 p-3 outline-none focus:border-emerald-400/50" /></label>
          </div>
        )}

        {action === "notes" && (
          <label className="block text-sm font-bold text-neutral-300">Internal notes<textarea autoFocus value={internalNotes} onChange={(event) => setInternalNotes(event.target.value)} className="mt-2 min-h-28 w-full rounded-xl border border-white/10 bg-black/50 p-3 outline-none focus:border-cyan-400/50" /></label>
        )}

        {(["suspend", "reactivate", "revoke"] as AdminLicenseAction[]).includes(action) && (
          <div className="space-y-4">
            <p className={`rounded-2xl border p-4 text-sm leading-6 ${destructive ? "border-red-400/30 bg-red-500/10 text-red-100" : "border-amber-400/20 bg-amber-500/10 text-amber-100"}`}>
              {action === "suspend"
                ? "Suspension takes effect authoritatively now and on the installed device at its next legitimate online verification. Local ERP data is preserved."
                : action === "reactivate"
                  ? "Reactivation restores the authoritative active state. The installed device will resume after its next online verification."
                  : "Revocation is terminal for this licence. The device will no longer be authorized after online verification, but its local ERP database remains untouched."}
            </p>
            <label className="block text-sm font-bold text-neutral-300">
              {action === "revoke" ? "Reason (required)" : "Reason (optional)"}
              <textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} className="mt-2 min-h-20 w-full rounded-xl border border-white/10 bg-black/50 p-3 outline-none focus:border-cyan-400/50" />
            </label>
            <label className="block text-sm font-bold text-neutral-300">Type {confirmationWord} to confirm<input value={confirmation} onChange={(event) => setConfirmation(event.target.value.toUpperCase())} className={inputClassName(destructive)} /></label>
          </div>
        )}

        {stateError && <AdminNotice tone="danger">{stateError}</AdminNotice>}
        {error && <AdminNotice tone="danger">{error}</AdminNotice>}
        <div className="desktop-interactive flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button type="button" disabled={pending} onClick={onClose} className="h-11 rounded-xl border border-white/10 px-5 text-sm font-black disabled:opacity-40">Cancel</button>
          <button type="submit" disabled={pending || Boolean(stateError) || (action === "reset_app_password" && !candidateValidation.success)} className={`h-11 rounded-xl px-5 text-sm font-black disabled:cursor-not-allowed disabled:opacity-40 ${destructive ? "bg-red-400 text-black" : "bg-cyan-300 text-black"}`}>
            {pending ? "Applying…" : actionButtons[action]}
          </button>
        </div>
      </form>
    </AdminModal>
  )
}
