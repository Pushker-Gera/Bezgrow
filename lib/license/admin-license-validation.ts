import { z } from "zod"
import { APP_LOCK_MIN_PASSWORD_LENGTH, appPasswordPolicyError } from "@/lib/app-lock/shared"
import { databaseDateTimeSchema } from "@/lib/time/canonical"

export const licenseFieldLabels = {
  customer_name: "Customer name",
  customer_email: "Customer email",
  customer_phone: "Customer phone",
  customer_company: "Company",
  customer_country: "Country",
  business_name: "Business name",
  workspace_id: "Workspace ID",
  device_id: "Device ID",
  platform: "Platform",
  architecture: "Architecture",
  app_version: "App version",
  plan_name: "Plan name",
  issue_date: "Issue date",
  expiry_date: "Expiry date",
  grace_days: "Grace days",
  allowed_features: "Allowed features",
  maximum_users: "Maximum users",
  maximum_businesses: "Maximum businesses",
  maximum_branches: "Maximum branches",
  internal_notes: "Internal notes",
  status: "Status",
  idempotency_key: "Idempotency key",
  app_password: "App-access password",
  expected_updated_at: "Server update timestamp",
} as const

export const MODERN_LICENSE_FEATURES = [
  "backup",
  "billing",
  "customers",
  "inventory",
  "multi_branch",
  "products",
  "reports",
] as const

export const LICENSE_RENEWAL_MONTHS = [1, 3, 6, 12, 24] as const

export type AdminLicenseAction =
  | "renew"
  | "extend"
  | "change_grace"
  | "update_features"
  | "replace_device"
  | "transfer"
  | "suspend"
  | "reactivate"
  | "revoke"
  | "reset_app_password"
  | "notes"

export type LicenseFieldName = keyof typeof licenseFieldLabels

const optionalWorkspaceId = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(3, "Enter at least 3 characters.").max(160, "Enter no more than 160 characters.").optional()
)

const optionalIdempotencyKey = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(8, "Enter at least 8 characters.").max(160, "Enter no more than 160 characters.").optional()
)

const licenseArchitecture = z.preprocess(
  (value) => (value === "x86_64" ? "x64" : value),
  z.enum(["arm64", "x64"], { error: "Select ARM64 or x86_64 (x64)." })
)

const modernLicenseFeature = z.enum(MODERN_LICENSE_FEATURES, {
  error: "Select only a current Bezgrow licence capability.",
})

const featureSchema = z
  .array(modernLicenseFeature)
  .min(1, "Select at least one feature.")
  .max(MODERN_LICENSE_FEATURES.length, "Too many features were selected.")
  .transform((features) => [...new Set(features)].sort())

export const updateLicenseSchema = z
  .object({
    id: z.string().trim().min(8).max(160),
    action: z.enum([
      "renew",
      "extend",
      "change_grace",
      "update_features",
      "suspend",
      "reactivate",
      "revoke",
      "reset_app_password",
      "replace_device",
      "transfer",
      "notes",
    ]),
    idempotency_key: z.string().trim().min(8).max(160),
    expected_updated_at: databaseDateTimeSchema,
    renew_months: z.coerce.number().int().refine(
      (value) => LICENSE_RENEWAL_MONTHS.includes(value as (typeof LICENSE_RENEWAL_MONTHS)[number]),
      "Select a supported renewal duration.",
    ).optional(),
    extend_days: z.coerce.number().int().min(1).max(3650).optional(),
    grace_days: z.coerce.number().int().min(0).max(365).optional(),
    allowed_features: featureSchema.optional(),
    plan_name: z.string().trim().min(2).max(80).optional(),
    maximum_users: z.coerce.number().int().min(1).max(10000).optional(),
    maximum_businesses: z.coerce.number().int().min(1).max(1000).optional(),
    maximum_branches: z.coerce.number().int().min(1).max(10000).optional(),
    internal_notes: z.string().trim().max(2000).optional(),
    new_device_id: z.string().trim().min(8).max(180).optional(),
    confirmed_device_id: z.string().trim().min(8).max(180).optional(),
    confirmation: z.enum(["SUSPEND", "REACTIVATE", "REVOKE"]).optional(),
    reason: z.string().trim().max(500).optional(),
    app_password: z.string().min(APP_LOCK_MIN_PASSWORD_LENGTH).max(256).optional(),
  })
  .superRefine((value, context) => {
    const required = (condition: boolean, path: string, message: string) => {
      if (!condition) context.addIssue({ code: "custom", path: [path], message })
    }
    if (value.app_password) {
      const passwordError = appPasswordPolicyError(value.app_password)
      if (passwordError) context.addIssue({ code: "custom", path: ["app_password"], message: passwordError })
    }
    if (value.action === "renew") {
      required(Boolean(value.renew_months), "renew_months", "Select a renewal duration.")
    }
    if (value.action === "extend") {
      required(Boolean(value.extend_days), "extend_days", "Enter the number of extension days.")
    }
    if (value.action === "change_grace") {
      required(value.grace_days !== undefined, "grace_days", "Enter the new grace period.")
    }
    if (value.action === "update_features") {
      required(Boolean(value.allowed_features?.length), "allowed_features", "Select at least one feature.")
      required(Boolean(value.plan_name), "plan_name", "Enter the plan name.")
    }
    if (value.action === "replace_device" || value.action === "transfer") {
      required(Boolean(value.new_device_id), "new_device_id", "Enter the target Device ID.")
      required(value.confirmed_device_id === value.new_device_id, "confirmed_device_id", "Re-enter the exact target Device ID.")
      required(Boolean(value.reason?.trim()), "reason", "Enter a reason for this device change.")
      required(Boolean(value.app_password), "app_password", "Enter or generate the initial app-access password for the target device.")
    }
    if (value.action === "suspend") {
      required(value.confirmation === "SUSPEND", "confirmation", "Type SUSPEND to confirm.")
    }
    if (value.action === "reactivate") {
      required(value.confirmation === "REACTIVATE", "confirmation", "Type REACTIVATE to confirm.")
    }
    if (value.action === "revoke") {
      required(value.confirmation === "REVOKE", "confirmation", "Type REVOKE to confirm.")
      required(Boolean(value.reason?.trim()), "reason", "Enter a revocation reason.")
    }
    if (value.action === "reset_app_password") {
      required(Boolean(value.app_password), "app_password", "Enter or generate the replacement app-access password.")
      required(Boolean(value.reason?.trim()), "reason", "Enter a reason for the password reset.")
    }
  })

export type UpdateLicenseInput = z.input<typeof updateLicenseSchema>
export type ValidUpdateLicenseInput = z.output<typeof updateLicenseSchema>

export const createLicenseSchema = z
  .object({
    customer_name: z.string().trim().min(2, "Enter at least 2 characters.").max(160, "Enter no more than 160 characters."),
    customer_email: z.string().trim().email("Enter a valid email address.").max(254, "Enter no more than 254 characters."),
    customer_phone: z.string().trim().max(30, "Enter no more than 30 characters.").optional().default(""),
    customer_company: z.string().trim().max(160, "Enter no more than 160 characters.").optional().default(""),
    customer_country: z.string().trim().max(80, "Enter no more than 80 characters.").optional().default(""),
    business_name: z.string().trim().min(2, "Enter at least 2 characters.").max(160, "Enter no more than 160 characters."),
    workspace_id: optionalWorkspaceId,
    device_id: z.string().trim().min(8, "Enter at least 8 characters.").max(180, "Enter no more than 180 characters."),
    platform: z.enum(["macos", "windows"], { error: "Select macOS or Windows." }),
    architecture: licenseArchitecture.optional(),
    app_version: z.string().trim().max(40, "Enter no more than 40 characters.").optional().default(""),
    plan_name: z.string().trim().min(2, "Enter at least 2 characters.").max(80, "Enter no more than 80 characters."),
    issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid issue date."),
    expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid expiry date."),
    grace_days: z.coerce.number().int("Enter a whole number.").min(0, "Enter 0 or more.").max(365, "Enter 365 or less.").default(7),
    allowed_features: featureSchema,
    maximum_users: z.coerce.number().int("Enter a whole number.").min(1, "Enter at least 1.").max(10000, "Enter 10,000 or less.").default(1),
    maximum_businesses: z.coerce.number().int("Enter a whole number.").min(1, "Enter at least 1.").max(1000, "Enter 1,000 or less.").default(1),
    maximum_branches: z.coerce.number().int("Enter a whole number.").min(1, "Enter at least 1.").max(10000, "Enter 10,000 or less.").default(1),
    internal_notes: z.string().trim().max(2000, "Enter no more than 2,000 characters.").optional().default(""),
    status: z.enum(["draft", "active", "trial"], { error: "Select draft, active, or trial." }).default("active"),
    idempotency_key: optionalIdempotencyKey,
    app_password: z.string().min(APP_LOCK_MIN_PASSWORD_LENGTH, `Use at least ${APP_LOCK_MIN_PASSWORD_LENGTH} characters.`).max(256),
  })
  .superRefine((value, context) => {
    const passwordError = appPasswordPolicyError(value.app_password)
    if (passwordError) {
      context.addIssue({ code: "custom", path: ["app_password"], message: passwordError })
    }
    if (value.issue_date && value.expiry_date && value.expiry_date <= value.issue_date) {
      context.addIssue({
        code: "custom",
        path: ["expiry_date"],
        message: "Expiry date must be after the issue date.",
      })
    }
  })

export type CreateLicenseInput = z.input<typeof createLicenseSchema>
export type ValidCreateLicenseInput = z.output<typeof createLicenseSchema>

export function licenseValidationIssue(issue: z.core.$ZodIssue) {
  const field = String(issue.path[0] || "license") as LicenseFieldName
  const fieldName = licenseFieldLabels[field] || "License"
  return {
    field,
    fieldName,
    message: issue.message,
    error: `${fieldName}: ${issue.message}`,
  }
}

export function licenseMutationValidationMessage(action: unknown, issue: z.core.$ZodIssue) {
  const detail = licenseValidationIssue(issue)
  if (detail.field === "expected_updated_at") {
    const operation = action === "reset_app_password" ? "Password reset" : "Licence change"
    return `${operation} could not be authorized because the server returned an invalid licence update timestamp. Refresh Licenses and try again. Field: expected_updated_at; expected RFC3339.`
  }
  return detail.message
}

export function licenseValidationErrors(error: z.ZodError) {
  return error.issues.reduce<Partial<Record<LicenseFieldName, string>>>((errors, issue) => {
    const detail = licenseValidationIssue(issue)
    if (!errors[detail.field]) errors[detail.field] = detail.message
    return errors
  }, {})
}
