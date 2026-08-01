import { z } from "zod"

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
} as const

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
    allowed_features: z
      .array(z.string().trim().min(1, "Feature names cannot be empty.").max(80, "Feature names must be 80 characters or less."))
      .min(1, "Select at least one feature.")
      .max(80, "Select no more than 80 features."),
    maximum_users: z.coerce.number().int("Enter a whole number.").min(1, "Enter at least 1.").max(10000, "Enter 10,000 or less.").default(1),
    maximum_businesses: z.coerce.number().int("Enter a whole number.").min(1, "Enter at least 1.").max(1000, "Enter 1,000 or less.").default(1),
    maximum_branches: z.coerce.number().int("Enter a whole number.").min(1, "Enter at least 1.").max(10000, "Enter 10,000 or less.").default(1),
    internal_notes: z.string().trim().max(2000, "Enter no more than 2,000 characters.").optional().default(""),
    status: z.enum(["draft", "active", "trial"], { error: "Select draft, active, or trial." }).default("active"),
    idempotency_key: optionalIdempotencyKey,
  })
  .superRefine((value, context) => {
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

export function licenseValidationErrors(error: z.ZodError) {
  return error.issues.reduce<Partial<Record<LicenseFieldName, string>>>((errors, issue) => {
    const detail = licenseValidationIssue(issue)
    if (!errors[detail.field]) errors[detail.field] = detail.message
    return errors
  }, {})
}
