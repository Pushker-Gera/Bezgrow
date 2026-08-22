import type { AdminLicenseAction } from "@/lib/license/admin-license-validation"

const DAY_MS = 86_400_000

function validDate(value: unknown) {
  const text = String(value || "").slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error("The licence expiry date is invalid.")
  const date = new Date(`${text}T12:00:00.000Z`)
  if (Number.isNaN(date.getTime())) throw new Error("The licence expiry date is invalid.")
  return date
}

export function addLicenseDays(dateText: string, days: number) {
  const date = validDate(dateText)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function addLicenseMonths(dateText: string, months: number) {
  const date = validDate(dateText)
  const originalDay = date.getUTCDate()
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + months)
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 12)).getUTCDate()
  date.setUTCDate(Math.min(originalDay, lastDay))
  return date.toISOString().slice(0, 10)
}

export function renewalBase(expiryDate: string, today = new Date().toISOString().slice(0, 10)) {
  validDate(expiryDate)
  validDate(today)
  return expiryDate > today ? expiryDate : today
}

export function renewedExpiry(expiryDate: string, months: number, today?: string) {
  return addLicenseMonths(renewalBase(expiryDate, today), months)
}

export function daysBetween(left: string, right: string) {
  return Math.round((validDate(right).getTime() - validDate(left).getTime()) / DAY_MS)
}

export function effectiveStatusForRow(row: Record<string, unknown>, now = new Date()) {
  const explicit = String(row.status || "draft").toLowerCase()
  if (["draft", "suspended", "revoked", "replaced"].includes(explicit)) return explicit
  const expiryText = String(row.expiry_date || "")
  if (!expiryText) return explicit
  const expiry = new Date(`${expiryText.slice(0, 10)}T23:59:59.999Z`)
  const graceEnd = new Date(expiry)
  graceEnd.setUTCDate(graceEnd.getUTCDate() + Number(row.grace_days || 0))
  if (now > graceEnd) return "expired"
  if (now > expiry) return "grace_period"
  const days = Math.ceil((expiry.getTime() - now.getTime()) / DAY_MS)
  return days <= 30 ? "expiring" : explicit === "trial" ? "trial" : "active"
}

const terminalActions = new Set<AdminLicenseAction>([
  "renew",
  "extend",
  "change_grace",
  "update_features",
  "replace_device",
  "transfer",
  "suspend",
  "reactivate",
])

export function licenseActionStateError(action: AdminLicenseAction, statusValue: unknown) {
  const status = String(statusValue || "draft").toLowerCase()
  if (status === "revoked" && terminalActions.has(action)) {
    return "A revoked licence cannot be changed or reactivated. Issue a supported replacement licence instead."
  }
  if (status === "replaced" && terminalActions.has(action)) {
    return "A replaced licence is immutable. Manage its replacement licence instead."
  }
  if (status === "draft" && action !== "notes" && action !== "revoke") {
    return "A draft licence must be issued before this action is available."
  }
  if (action === "suspend" && status === "suspended") return "Licence is already suspended."
  if (action === "reactivate" && status !== "suspended") return "Only a suspended licence can be reactivated."
  if (action === "revoke" && status === "revoked") return "Licence is already revoked."
  return null
}

export function licenseAuditSnapshot(row: Record<string, unknown>) {
  const allowed = [
    "id",
    "platform_customer_id",
    "platform_business_id",
    "subject_customer_id",
    "subject_business_id",
    "customer_name",
    "customer_email",
    "business_name",
    "device_id",
    "platform",
    "architecture",
    "app_version",
    "plan_name",
    "issue_date",
    "expiry_date",
    "grace_days",
    "allowed_features",
    "maximum_users",
    "maximum_businesses",
    "maximum_branches",
    "status",
    "replaced_by_license_id",
    "renewed_at",
    "revoked_at",
    "suspended_at",
    "updated_at",
  ]
  return Object.fromEntries(allowed.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]))
}
