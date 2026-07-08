import { z } from "zod"
import { requireAdmin, writeAdminLog } from "@/lib/api/auth"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { LICENSE_SCHEMA_VERSION, type LicensePayload } from "@/lib/license/codec"
import { createLicenseId, hasLicenseSigningKey, licenseSigningStatus, signLicensePayload } from "@/lib/license/server"

export const dynamic = "force-dynamic"

const licenseSchema = z.object({
  customer_name: z.string().trim().min(2).max(160),
  customer_email: z.string().trim().email().max(254).optional().or(z.literal("")),
  customer_id: z.string().trim().min(1).max(120).optional(),
  business_name: z.string().trim().min(2).max(160),
  business_id: z.string().trim().min(1).max(120).optional(),
  device_id: z.string().trim().min(8).max(180),
  plan_name: z.string().trim().min(2).max(80),
  expiry_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  grace_period_days: z.coerce.number().int().min(0).max(365).default(7),
  allowed_features: z.array(z.string().trim().min(1).max(80)).min(1).max(80),
  notes: z.string().trim().max(1000).optional(),
})

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
}

export async function GET(request: Request) {
  const admin = await requireAdmin(request)
  if (!admin.ok) return fail(admin.error, admin.status)

  return ok({ licenseSigning: licenseSigningStatus() }, { headers: { "Cache-Control": "no-store" } })
}

export async function POST(request: Request) {
  const admin = await requireAdmin(request)
  if (!admin.ok) return fail(admin.error, admin.status)

  if (!hasLicenseSigningKey()) {
    const status = licenseSigningStatus()
    return fail(status.message, status.production ? 500 : 503, { licenseSigning: status })
  }

  const parsed = licenseSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message || "Invalid license request.", 422)
  }

  try {
    const now = new Date().toISOString()
    const data = parsed.data
    const licenseId = createLicenseId()
    const payload: LicensePayload = {
      schema_version: LICENSE_SCHEMA_VERSION,
      license_id: licenseId,
      customer_id: data.customer_id || `cust_${slug(data.customer_name) || "customer"}`,
      customer_name: data.customer_name,
      customer_email: data.customer_email || null,
      business_id: data.business_id || `biz_${slug(data.business_name) || "business"}`,
      business_name: data.business_name,
      device_id: data.device_id,
      plan_name: data.plan_name,
      expiry_date: data.expiry_date,
      grace_period_days: data.grace_period_days,
      allowed_features: [...new Set(data.allowed_features)].sort(),
      issued_by_admin: admin.context.adminEmail || admin.context.adminUserId,
      issued_at: now,
      notes: data.notes || null,
    }

    const signed = signLicensePayload(payload)
    const licenseFile = {
      app: "Bezgrow",
      type: "offline_license",
      generated_at: now,
      license_key: signed.license_key,
      payload,
    }

    await writeAdminLog({
      action: "LICENSE_GENERATED",
      description: `Offline license generated for ${payload.business_name} on device ${payload.device_id}.`,
      adminUserId: admin.context.adminUserId,
      organizationId: payload.business_id,
      metadata: {
        license_id: licenseId,
        customer_id: payload.customer_id,
        customer_email: payload.customer_email || null,
        plan_name: payload.plan_name,
        expiry_date: payload.expiry_date,
        grace_period_days: payload.grace_period_days,
      },
    })

    return ok({ license_key: signed.license_key, license_file: licenseFile })
  } catch (error) {
    if (error instanceof Error && error.message.includes("BEZGROW_LICENSE_PRIVATE_KEY")) {
      return fail(error.message, 500, { licenseSigning: licenseSigningStatus() })
    }
    return serverFail()
  }
}
