import { z } from "zod"

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/
const INDIA_MOBILE_PATTERN = /^[6-9][0-9]{9}$/
const INDIA_POSTAL_CODE_PATTERN = /^[1-9][0-9]{5}$/

function gstinChecksumValid(gstin: string) {
  if (!GSTIN_PATTERN.test(gstin)) return false
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  let factor = 2
  let sum = 0
  for (let index = gstin.length - 2; index >= 0; index -= 1) {
    const codePoint = alphabet.indexOf(gstin[index])
    const product = codePoint * factor
    factor = factor === 2 ? 1 : 2
    sum += Math.floor(product / 36) + (product % 36)
  }
  const checkCodePoint = (36 - (sum % 36)) % 36
  return alphabet[checkCodePoint] === gstin[gstin.length - 1]
}

export function normalizeIndianMobile(value: string) {
  return value.replace(/[^0-9]/g, "").replace(/^91(?=[6-9][0-9]{9}$)/, "")
}

export const phase1BusinessOnboardingSchema = z.object({
  localBusinessId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  ownerName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  mobile: z.string().transform(normalizeIndianMobile).refine((value) => INDIA_MOBILE_PATTERN.test(value), "Enter a valid 10-digit Indian mobile number."),
  password: z.string().min(8).max(128).regex(/[A-Za-z]/, "Password must include a letter.").regex(/[0-9]/, "Password must include a number."),
  businessName: z.string().trim().min(2).max(160),
  businessType: z.string().trim().min(2).max(80),
  industry: z.string().trim().min(2).max(100),
  gstRegistered: z.boolean(),
  gstin: z.string().trim().toUpperCase().max(15).optional().default(""),
  pan: z.string().trim().toUpperCase().max(10).optional().default(""),
  address: z.string().trim().min(4).max(300),
  city: z.string().trim().min(2).max(100),
  state: z.string().trim().min(2).max(100),
  postalCode: z.string().trim().refine((value) => INDIA_POSTAL_CODE_PATTERN.test(value), "Enter a valid 6-digit Indian PIN code."),
  financialYearStartMonth: z.number().int().min(1).max(12).default(4),
  invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9/-]{1,12}$/).default("INV"),
  deviceId: z.string().trim().min(8).max(240),
  platform: z.enum(["macos", "windows"]),
  architecture: z.enum(["arm64", "x86_64"]),
  appVersion: z.string().trim().min(1).max(40),
  termsAccepted: z.literal(true),
}).superRefine((value, context) => {
  if (value.gstRegistered && !value.gstin) {
    context.addIssue({ code: "custom", path: ["gstin"], message: "GSTIN is required for a GST-registered business." })
  } else if (value.gstin && !gstinChecksumValid(value.gstin)) {
    context.addIssue({ code: "custom", path: ["gstin"], message: "Enter a valid GSTIN, including its checksum." })
  }
  if (value.pan && !PAN_PATTERN.test(value.pan)) {
    context.addIssue({ code: "custom", path: ["pan"], message: "Enter a valid PAN." })
  }
  if (value.gstin && value.pan && value.gstin.slice(2, 12) !== value.pan) {
    context.addIssue({ code: "custom", path: ["pan"], message: "PAN must match the PAN embedded in GSTIN." })
  }
})

export type Phase1BusinessOnboardingInput = z.input<typeof phase1BusinessOnboardingSchema>
export type ValidPhase1BusinessOnboarding = z.output<typeof phase1BusinessOnboardingSchema>

export function onboardingValidationMessage(error: z.ZodError) {
  const issue = error.issues[0]
  return issue?.message || "Review the business details and try again."
}
