"use client"

import type { AdminLicenseAction } from "@/lib/license/admin-license-validation"

type LicenseActionButtonsProps = {
  row: Record<string, unknown>
  busy?: boolean
  onAction: (action: AdminLicenseAction) => void
  onCopy: () => void
  onDownload: () => void
  onHistory: () => void
}

export function LicenseActionButtons({
  row,
  busy = false,
  onAction,
  onCopy,
  onDownload,
  onHistory,
}: LicenseActionButtonsProps) {
  const status = String(row.status || "")
  const terminal = ["revoked", "replaced"].includes(status)
  const common = "desktop-interactive rounded-lg border px-2.5 py-1.5 text-xs font-bold disabled:opacity-30"
  return (
    <div data-license-actions={String(row.id || "")} className="desktop-interactive flex min-w-[360px] flex-wrap gap-2">
      <button type="button" data-license-action="copy" onClick={onCopy} disabled={busy || !row.issuer_key_id} className={`${common} border-white/10`}>Copy key</button>
      <button type="button" data-license-action="download" disabled={busy} onClick={onDownload} className={`${common} border-white/10`}>Download</button>
      <button type="button" data-license-action="history" disabled={busy} onClick={onHistory} className={`${common} border-white/10`}>History</button>
      <button type="button" data-license-action="renew" disabled={busy || terminal} onClick={() => onAction("renew")} className={`${common} border-cyan-400/25 text-cyan-100`}>Renew</button>
      <button type="button" data-license-action="extend" disabled={busy || terminal} onClick={() => onAction("extend")} className={`${common} border-white/10`}>Extend</button>
      <button type="button" data-license-action="change_grace" disabled={busy || terminal} onClick={() => onAction("change_grace")} className={`${common} border-white/10`}>Grace</button>
      <button type="button" data-license-action="update_features" disabled={busy || terminal} onClick={() => onAction("update_features")} className={`${common} border-white/10`}>Plan/features</button>
      <button type="button" data-license-action="replace_device" disabled={busy || terminal} onClick={() => onAction("replace_device")} className={`${common} border-amber-400/20 text-amber-100`}>Replace device</button>
      <button type="button" data-license-action="transfer" disabled={busy || terminal} onClick={() => onAction("transfer")} className={`${common} border-amber-400/20 text-amber-100`}>Transfer</button>
      {status === "suspended" ? (
        <button type="button" data-license-action="reactivate" disabled={busy} onClick={() => onAction("reactivate")} className={`${common} border-emerald-400/25 text-emerald-100`}>Reactivate</button>
      ) : (
        <button type="button" data-license-action="suspend" disabled={busy || terminal} onClick={() => onAction("suspend")} className={`${common} border-amber-400/20 text-amber-100`}>Suspend</button>
      )}
      <button type="button" data-license-action="revoke" disabled={busy || status === "revoked"} onClick={() => onAction("revoke")} className={`${common} border-red-400/20 text-red-200`}>Revoke</button>
    </div>
  )
}
