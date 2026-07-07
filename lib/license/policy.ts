import type { OfflineAction, OfflineCollection } from "@/lib/offline/db"

export type StoredLicenseRow = Record<string, unknown> & {
  id?: string
  license_key?: string | null
  status?: string | null
  device_id?: string | null
  expiry_date?: string | null
  expires_at?: string | null
  grace_period_days?: number | string | null
  grace_until?: string | null
  last_verified_at?: string | null
  allowed_features?: string | null
  issued_at?: string | null
}

export type LicensePolicyStatus =
  | "valid"
  | "missing"
  | "expired"
  | "tampered"
  | "wrong_device"
  | "clock_rollback"

export type LicensePolicyResult = {
  allowed: boolean
  status: LicensePolicyStatus
  reason: string
  license?: StoredLicenseRow | null
  expiresAt?: string | null
  graceUntil?: string | null
  allowedFeatures: string[]
}

const restrictedCollections = new Set<OfflineCollection>([
  "products",
  "inventory_items",
  "customers",
  "suppliers",
  "invoices",
  "invoice_items",
  "purchase_invoices",
  "purchase_items",
  "orders",
  "order_items",
  "quotations",
  "quotation_items",
  "delivery_challans",
  "delivery_challan_items",
  "credit_notes",
  "credit_note_items",
  "debit_notes",
  "debit_note_items",
  "expenses",
  "payments",
  "payment_receipts",
  "ledger_entries",
  "chart_of_accounts",
  "accounting_vouchers",
  "accounting_voucher_entries",
  "bank_accounts",
  "stock_movements",
  "stock_batches",
  "print_templates",
])

const restrictedActions = new Set<OfflineAction["type"]>([
  "create_invoice",
  "save_customer",
  "customer_status",
  "save_product",
  "archive_product",
  "stock_movement",
  "update_invoice_status",
  "delete_invoice",
  "create_order",
  "save_supplier",
  "delete_supplier",
  "create_purchase",
  "create_purchase_return",
  "create_purchase_order",
  "create_goods_received",
  "create_payment",
  "create_quotation",
  "create_delivery_challan",
  "create_proforma_invoice",
  "create_credit_note",
  "create_debit_note",
  "create_expense",
  "create_accounting_voucher",
])

const restrictedEndpoints = [
  /^\/api\/products\/(create|update|archive)$/,
  /^\/api\/customers\/(save|status)$/,
  /^\/api\/suppliers\/(save|status)$/,
  /^\/api\/invoices\/(create|update-status|delete-with-stock-restore)$/,
  /^\/api\/purchases\/(create|return|order|goods-received|supplier-payment)$/,
  /^\/api\/orders\/create$/,
  /^\/api\/payments\/create$/,
  /^\/api\/quotations\/create$/,
  /^\/api\/delivery-challans\/create$/,
  /^\/api\/sales\/(proforma|returns)\/create$/,
  /^\/api\/notes\/(credit|debit)$/,
  /^\/api\/expenses\/create$/,
  /^\/api\/accounting\/(vouchers\/create|chart\/save|bank-accounts\/save)$/,
  /^\/api\/inventory\/(simple-movement|professional-movement)$/,
  /^\/api\/settings\/(update-organization|toggle-feature)$/,
]

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : ""
}

function numberValue(value: unknown, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback
  const next = Number(value)
  return Number.isFinite(next) ? next : fallback
}

function parseDate(value: unknown) {
  const text = stringValue(value)
  if (!text) return null
  const date = new Date(text.length <= 10 ? `${text}T23:59:59.999` : text)
  return Number.isNaN(date.getTime()) ? null : date
}

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function parseFeatures(row: StoredLicenseRow | null | undefined) {
  const raw = row?.allowed_features
  if (!raw) return []
  try {
    const parsed = JSON.parse(String(raw)) as unknown
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean).sort() : []
  } catch {
    return String(raw)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .sort()
  }
}

function newestLicense(rows: StoredLicenseRow[]) {
  return [...rows]
    .filter((row) => !row.deleted_at)
    .sort((a, b) => {
      const left = parseDate(a.issued_at) || parseDate(a.created_at) || new Date(0)
      const right = parseDate(b.issued_at) || parseDate(b.created_at) || new Date(0)
      return right.getTime() - left.getTime()
    })[0]
}

export function isLicenseRestrictedCollection(collection: OfflineCollection) {
  return restrictedCollections.has(collection)
}

export function isLicenseRestrictedAction(type: OfflineAction["type"]) {
  return restrictedActions.has(type)
}

export function isLicenseRestrictedEndpoint(pathname: string, method: string) {
  if (method.toUpperCase() !== "POST" && method.toUpperCase() !== "PATCH" && method.toUpperCase() !== "DELETE") return false
  return restrictedEndpoints.some((pattern) => pattern.test(pathname))
}

export function evaluateStoredLicense(
  rows: StoredLicenseRow[],
  options: { now?: Date; deviceId?: string | null } = {}
): LicensePolicyResult {
  const now = options.now || new Date()
  const license = newestLicense(rows)

  if (!license) {
    return {
      allowed: false,
      status: "missing",
      reason: "Activation required. Enter a valid Bezgrow license to use write actions.",
      license: null,
      allowedFeatures: [],
    }
  }

  const allowedFeatures = parseFeatures(license)
  const status = stringValue(license.status).toLowerCase()
  const deviceId = stringValue(options.deviceId)
  const licenseDeviceId = stringValue(license.device_id)
  if (deviceId && licenseDeviceId && deviceId !== licenseDeviceId) {
    return {
      allowed: false,
      status: "wrong_device",
      reason: "This license was issued for another device.",
      license,
      allowedFeatures,
    }
  }

  if (status === "tampered" || status === "revoked" || status === "invalid") {
    return {
      allowed: false,
      status: "tampered",
      reason: "License validation failed. Reactivation is required.",
      license,
      allowedFeatures,
    }
  }

  const lastVerified = parseDate(license.last_verified_at)
  if (lastVerified && now.getTime() + 10 * 60 * 1000 < lastVerified.getTime()) {
    return {
      allowed: false,
      status: "clock_rollback",
      reason: "System clock rollback detected. Reactivation is required.",
      license,
      allowedFeatures,
    }
  }

  const expiry = parseDate(license.expiry_date || license.expires_at)
  if (!expiry) {
    return {
      allowed: false,
      status: "tampered",
      reason: "License expiry is missing or invalid.",
      license,
      allowedFeatures,
    }
  }

  const explicitGrace = parseDate(license.grace_until)
  const graceUntil = explicitGrace || addDays(expiry, numberValue(license.grace_period_days))
  if (now.getTime() > graceUntil.getTime()) {
    return {
      allowed: false,
      status: "expired",
      reason: "License expired. Import a renewed license to unlock billing and inventory actions.",
      license,
      expiresAt: expiry.toISOString(),
      graceUntil: graceUntil.toISOString(),
      allowedFeatures,
    }
  }

  if (status && status !== "active" && status !== "trial" && status !== "grace") {
    return {
      allowed: false,
      status: "tampered",
      reason: "License status is invalid.",
      license,
      expiresAt: expiry.toISOString(),
      graceUntil: graceUntil.toISOString(),
      allowedFeatures,
    }
  }

  return {
    allowed: true,
    status: "valid",
    reason: now.getTime() > expiry.getTime() ? "License is inside the grace period." : "License is valid.",
    license,
    expiresAt: expiry.toISOString(),
    graceUntil: graceUntil.toISOString(),
    allowedFeatures,
  }
}
