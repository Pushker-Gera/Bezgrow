import "server-only"

import { z } from "zod"
import { requireAdminControlPlane } from "@/lib/api/auth"
import {
  adminFail,
  adminOk,
  adminRange,
  adminSort,
  compactRecord,
  controlPlaneErrorMessage,
  csvResponse,
  effectiveLicenseStatus,
  parseAdminListQuery,
  recordLicenseEvent,
  unexpectedAdminError,
} from "@/lib/admin/control-plane"
import { LICENSE_SCHEMA_VERSION, type LicensePayload } from "@/lib/license/codec"
import { createLicenseId, hasLicenseSigningKey, licenseSigningStatus, signLicensePayload } from "@/lib/license/server"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const featureSchema = z.array(z.string().trim().min(1).max(80)).min(1).max(80)

export const createLicenseSchema = z.object({
  customer_name: z.string().trim().min(2).max(160),
  customer_email: z.string().trim().email().max(254),
  customer_phone: z.string().trim().max(30).optional().default(""),
  customer_company: z.string().trim().max(160).optional().default(""),
  customer_country: z.string().trim().max(80).optional().default(""),
  business_name: z.string().trim().min(2).max(160),
  workspace_id: z.string().trim().min(3).max(160).optional(),
  device_id: z.string().trim().min(8).max(180),
  platform: z.enum(["macos", "windows"]),
  app_version: z.string().trim().max(40).optional().default(""),
  plan_name: z.string().trim().min(2).max(80),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  grace_days: z.coerce.number().int().min(0).max(365).default(7),
  allowed_features: featureSchema,
  maximum_users: z.coerce.number().int().min(1).max(10000).default(1),
  maximum_businesses: z.coerce.number().int().min(1).max(1000).default(1),
  maximum_branches: z.coerce.number().int().min(1).max(10000).default(1),
  internal_notes: z.string().trim().max(2000).optional().default(""),
  status: z.enum(["draft", "active", "trial"]).default("active"),
  idempotency_key: z.string().trim().min(8).max(160).optional(),
})

const updateLicenseSchema = z.object({
  id: z.string().trim().min(8).max(160),
  action: z.enum([
    "renew",
    "extend",
    "change_grace",
    "update_features",
    "suspend",
    "revoke",
    "replace_device",
    "transfer",
    "notes",
  ]),
  expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  extend_days: z.coerce.number().int().min(1).max(3650).optional(),
  grace_days: z.coerce.number().int().min(0).max(365).optional(),
  allowed_features: featureSchema.optional(),
  plan_name: z.string().trim().min(2).max(80).optional(),
  maximum_users: z.coerce.number().int().min(1).max(10000).optional(),
  maximum_businesses: z.coerce.number().int().min(1).max(1000).optional(),
  maximum_branches: z.coerce.number().int().min(1).max(10000).optional(),
  internal_notes: z.string().trim().max(2000).optional(),
  new_device_id: z.string().trim().min(8).max(180).optional(),
  reason: z.string().trim().min(3).max(500).optional(),
})

type StoredLicense = {
  id: string
  platform_customer_id: string | null
  platform_business_id: string | null
  customer_name: string
  customer_email: string | null
  business_name: string
  device_id: string
  platform: "macos" | "windows"
  app_version: string | null
  plan_name: string
  issue_date: string
  expiry_date: string
  grace_days: number
  allowed_features: string[]
  maximum_users: number
  maximum_businesses: number
  maximum_branches: number
  internal_notes: string | null
  status: string
  signed_license_key: string | null
  issuer_key_id: string | null
  signature_algorithm: string | null
  issued_by_admin_id: string | null
  issued_by_admin_email: string | null
  created_at: string
  updated_at: string
}

function dateAfter(dateText: string, days: number) {
  const date = new Date(`${dateText.slice(0, 10)}T12:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function licensePayload(row: StoredLicense, adminLabel: string): LicensePayload {
  return {
    schema_version: LICENSE_SCHEMA_VERSION,
    license_id: row.id,
    customer_id: row.platform_customer_id || `customer:${row.customer_email || row.customer_name}`,
    customer_name: row.customer_name,
    customer_email: row.customer_email,
    business_id: row.platform_business_id || `business:${row.business_name}`,
    business_name: row.business_name,
    device_id: row.device_id,
    platform: row.platform,
    app_version: row.app_version,
    plan_name: row.plan_name,
    issue_date: row.issue_date,
    expiry_date: row.expiry_date,
    grace_period_days: row.grace_days,
    allowed_features: [...new Set(row.allowed_features || [])].sort(),
    maximum_users: row.maximum_users,
    maximum_businesses: row.maximum_businesses,
    maximum_branches: row.maximum_branches,
    issued_by_admin: adminLabel,
    issued_at: new Date().toISOString(),
    notes: row.internal_notes,
  }
}

function signedFile(row: StoredLicense) {
  return {
    app: "Bezgrow",
    type: "offline_license",
    generated_at: row.updated_at,
    license_key: row.signed_license_key,
    issuer_key_id: row.issuer_key_id,
    signature_algorithm: row.signature_algorithm,
    payload: row.signed_license_key ? undefined : null,
  }
}

async function ensureCustomer(input: z.infer<typeof createLicenseSchema>) {
  const email = input.customer_email.toLowerCase()
  const existing = await adminSupabase
    .from("platform_customers")
    .select("id")
    .ilike("email", email)
    .limit(1)
    .maybeSingle()
  if (existing.error) throw existing.error

  if (existing.data?.id) {
    const result = await adminSupabase
      .from("platform_customers")
      .update({
        name: input.customer_name,
        phone: input.customer_phone || null,
        company: input.customer_company || null,
        country: input.customer_country || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.data.id)
      .select("id")
      .single()
    if (result.error) throw result.error
    return result.data.id as string
  }

  const created = await adminSupabase
    .from("platform_customers")
    .insert({
      name: input.customer_name,
      email,
      phone: input.customer_phone || null,
      company: input.customer_company || null,
      country: input.customer_country || null,
    })
    .select("id")
    .single()
  if (created.error) throw created.error
  return created.data.id as string
}

async function ensureBusiness(input: z.infer<typeof createLicenseSchema>, customerId: string) {
  const workspaceId = input.workspace_id || `workspace:${input.device_id}`
  const existing = await adminSupabase
    .from("platform_businesses")
    .select("id")
    .eq("workspace_id", workspaceId)
    .maybeSingle()
  if (existing.error) throw existing.error

  if (existing.data?.id) {
    const result = await adminSupabase
      .from("platform_businesses")
      .update({
        platform_customer_id: customerId,
        business_name: input.business_name,
        plan_name: input.plan_name,
        platform: input.platform,
        app_version: input.app_version || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.data.id)
      .select("id")
      .single()
    if (result.error) throw result.error
    return result.data.id as string
  }

  const created = await adminSupabase
    .from("platform_businesses")
    .insert({
      platform_customer_id: customerId,
      workspace_id: workspaceId,
      business_name: input.business_name,
      plan_name: input.plan_name,
      platform: input.platform,
      app_version: input.app_version || null,
      cloud_mode: "local_only",
      cloud_backup_enabled: false,
    })
    .select("id")
    .single()
  if (created.error) throw created.error
  return created.data.id as string
}

async function persistSignedLicense(
  row: Omit<StoredLicense, "signed_license_key" | "issuer_key_id" | "signature_algorithm" | "created_at" | "updated_at">,
  adminLabel: string,
  idempotencyKey?: string
) {
  const timestamp = new Date().toISOString()
  const rowForSigning = {
    ...row,
    signed_license_key: null,
    issuer_key_id: null,
    signature_algorithm: null,
    created_at: timestamp,
    updated_at: timestamp,
  } satisfies StoredLicense
  const signed = signLicensePayload(licensePayload(rowForSigning, adminLabel))
  const inserted = await adminSupabase
    .from("licenses")
    .insert({
      ...row,
      signed_license_key: signed.license_key,
      issuer_key_id: signed.payload.issuer_key_id,
      signature_algorithm: signed.payload.signature_algorithm,
      idempotency_key: idempotencyKey || null,
      updated_at: timestamp,
    })
    .select("*")
    .single()
  if (inserted.error) throw inserted.error
  return inserted.data as StoredLicense
}

export async function GET(request: Request) {
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context

  try {
    const list = parseAdminListQuery(request)
    const { from, to } = adminRange(list)
    const exportMode = list.format === "csv"
    const sort = adminSort(
      list,
      ["created_at", "updated_at", "expiry_date", "customer_name", "business_name", "platform", "status"],
      "created_at"
    )
    let query = adminSupabase
      .from("license_control_plane")
      .select("*", { count: "exact" })
      .order(sort.column, { ascending: sort.ascending })

    if (list.search) {
      const term = list.search.replaceAll(",", " ")
      query = query.or(
        `id.ilike.%${term}%,customer_name.ilike.%${term}%,customer_email.ilike.%${term}%,business_name.ilike.%${term}%,device_id.ilike.%${term}%`
      )
    }
    if (list.status) query = query.eq("effective_status", list.status)
    if (list.platform) query = query.eq("platform", list.platform)
    query = exportMode ? query.limit(10000) : query.range(from, to)

    const result = await query
    if (result.error) {
      return adminFail(context, controlPlaneErrorMessage(result.error, "Licenses failed to load."), 500)
    }

    const rows = ((result.data || []) as StoredLicense[]).map((license) => ({
      ...license,
      effective_status: effectiveLicenseStatus(license),
    }))
    if (exportMode) {
      return csvResponse(
        `bezgrow-licenses-${new Date().toISOString().slice(0, 10)}.csv`,
        [
          "id",
          "customer_name",
          "customer_email",
          "business_name",
          "device_id",
          "platform",
          "app_version",
          "plan_name",
          "issue_date",
          "expiry_date",
          "grace_days",
          "effective_status",
          "allowed_features",
          "issued_by_admin_email",
          "created_at",
        ],
        rows
      )
    }

    return adminOk(context, {
      data: rows,
      pagination: { page: list.page, limit: list.limit, total: result.count || 0 },
      licenseSigning: licenseSigningStatus(),
    })
  } catch (error) {
    return unexpectedAdminError(context, error, "Licenses failed to load.")
  }
}

export async function POST(request: Request) {
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context

  if (!hasLicenseSigningKey()) {
    return adminFail(context, "License generation failed because the server signing key is not configured.", 503, {
      licenseSigning: licenseSigningStatus(),
    })
  }

  const parsed = createLicenseSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return adminFail(context, parsed.error.issues[0]?.message || "Invalid license request.", 422)
  }

  try {
    const input = parsed.data
    const idempotencyKey = input.idempotency_key || request.headers.get("idempotency-key")?.trim() || undefined
    if (idempotencyKey) {
      const existing = await adminSupabase
        .from("licenses")
        .select("*")
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle()
      if (existing.error) throw existing.error
      if (existing.data) {
        const existingLicense = existing.data as StoredLicense
        const device = await adminSupabase
          .from("registered_devices")
          .upsert(
            {
              device_id: existingLicense.device_id,
              platform_customer_id: existingLicense.platform_customer_id,
              platform_business_id: existingLicense.platform_business_id,
              license_id: existingLicense.id,
              platform: existingLicense.platform,
              app_version: existingLicense.app_version,
              device_status: "registered",
              updated_at: new Date().toISOString(),
            },
            { onConflict: "device_id" }
          )
        if (device.error) throw device.error

        const event = await adminSupabase
          .from("license_events")
          .select("id")
          .eq("license_id", existingLicense.id)
          .eq("action", "LICENSE_GENERATED")
          .limit(1)
          .maybeSingle()
        if (event.error) throw event.error
        if (!event.data) {
          await recordLicenseEvent({
            context,
            licenseId: existingLicense.id,
            action: "LICENSE_GENERATED",
            newValues: compactRecord({
              status: existingLicense.status,
              device_id: existingLicense.device_id,
              plan_name: existingLicense.plan_name,
              expiry_date: existingLicense.expiry_date,
              recovered_idempotent_request: true,
            }),
          })
        }
        return adminOk(context, {
          license: existingLicense,
          license_key: existingLicense.signed_license_key,
          license_file: signedFile(existingLicense),
          duplicate: true,
        })
      }
    }

    const customerId = await ensureCustomer(input)
    const businessId = await ensureBusiness(input, customerId)
    const licenseId = createLicenseId()
    const adminLabel = context.adminEmail || context.adminUserId
    const row = await persistSignedLicense(
      {
        id: licenseId,
        platform_customer_id: customerId,
        platform_business_id: businessId,
        customer_name: input.customer_name,
        customer_email: input.customer_email.toLowerCase(),
        business_name: input.business_name,
        device_id: input.device_id,
        platform: input.platform,
        app_version: input.app_version || null,
        plan_name: input.plan_name,
        issue_date: input.issue_date,
        expiry_date: input.expiry_date,
        grace_days: input.grace_days,
        allowed_features: [...new Set(input.allowed_features)].sort(),
        maximum_users: input.maximum_users,
        maximum_businesses: input.maximum_businesses,
        maximum_branches: input.maximum_branches,
        internal_notes: input.internal_notes || null,
        status: input.status,
        issued_by_admin_id: context.adminUserId,
        issued_by_admin_email: context.adminEmail,
      },
      adminLabel,
      idempotencyKey
    )

    const device = await adminSupabase
      .from("registered_devices")
      .upsert(
        {
          device_id: input.device_id,
          platform_customer_id: customerId,
          platform_business_id: businessId,
          license_id: row.id,
          platform: input.platform,
          app_version: input.app_version || null,
          activation_date: null,
          device_status: "registered",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "device_id" }
      )
    if (device.error) throw device.error

    await recordLicenseEvent({
      context,
      licenseId: row.id,
      action: "LICENSE_GENERATED",
      newValues: compactRecord({
        status: row.status,
        device_id: row.device_id,
        plan_name: row.plan_name,
        expiry_date: row.expiry_date,
        grace_days: row.grace_days,
        allowed_features: row.allowed_features,
      }),
      notes: row.internal_notes,
    })

    return adminOk(context, {
      license: row,
      license_key: row.signed_license_key,
      license_file: signedFile(row),
    })
  } catch (error) {
    return unexpectedAdminError(context, error, "License generation failed.")
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context
  const parsed = updateLicenseSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return adminFail(context, parsed.error.issues[0]?.message || "Invalid license change.", 422)
  }

  try {
    const input = parsed.data
    const currentResult = await adminSupabase.from("licenses").select("*").eq("id", input.id).maybeSingle()
    if (currentResult.error) throw currentResult.error
    if (!currentResult.data) return adminFail(context, "License was not found.", 404)
    const current = currentResult.data as StoredLicense

    if (["replace_device", "transfer"].includes(input.action)) {
      if (!input.new_device_id || !input.reason) {
        return adminFail(context, "A new Device ID and transfer reason are required.", 422)
      }
      if (!hasLicenseSigningKey()) {
        return adminFail(context, "License generation failed because the server signing key is not configured.", 503)
      }

      const replacementId = createLicenseId()
      const replacement = await persistSignedLicense(
        {
          id: replacementId,
          platform_customer_id: current.platform_customer_id,
          platform_business_id: current.platform_business_id,
          customer_name: current.customer_name,
          customer_email: current.customer_email,
          business_name: current.business_name,
          device_id: input.new_device_id,
          platform: current.platform,
          app_version: current.app_version,
          plan_name: current.plan_name,
          issue_date: new Date().toISOString().slice(0, 10),
          expiry_date: current.expiry_date,
          grace_days: current.grace_days,
          allowed_features: current.allowed_features,
          maximum_users: current.maximum_users,
          maximum_businesses: current.maximum_businesses,
          maximum_branches: current.maximum_branches,
          status: "active",
          internal_notes: [current.internal_notes, input.reason].filter(Boolean).join("\n"),
          issued_by_admin_id: context.adminUserId,
          issued_by_admin_email: context.adminEmail,
        },
        context.adminEmail || context.adminUserId
      )

      const updatedOld = await adminSupabase
        .from("licenses")
        .update({
          status: "replaced",
          replaced_by_license_id: replacement.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", current.id)
      if (updatedOld.error) throw updatedOld.error

      const oldDevice = await adminSupabase
        .from("registered_devices")
        .update({
          device_status: "replaced",
          replaced_by_device_id: input.new_device_id,
          updated_at: new Date().toISOString(),
        })
        .eq("device_id", current.device_id)
      if (oldDevice.error) throw oldDevice.error
      const newDevice = await adminSupabase.from("registered_devices").upsert(
        {
          device_id: input.new_device_id,
          platform_customer_id: current.platform_customer_id,
          platform_business_id: current.platform_business_id,
          license_id: replacement.id,
          platform: current.platform,
          app_version: current.app_version,
          device_status: "registered",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "device_id" }
      )
      if (newDevice.error) throw newDevice.error

      await recordLicenseEvent({
        context,
        licenseId: current.id,
        action: input.action === "transfer" ? "LICENSE_TRANSFERRED" : "DEVICE_REPLACED",
        previousValues: { device_id: current.device_id, status: current.status },
        newValues: { device_id: replacement.device_id, status: "replaced", replacement_license_id: replacement.id },
        notes: input.reason,
      })
      await recordLicenseEvent({
        context,
        licenseId: replacement.id,
        action: "REPLACEMENT_LICENSE_GENERATED",
        newValues: { device_id: replacement.device_id, replaces_license_id: current.id },
        notes: input.reason,
      })
      return adminOk(context, { license: replacement, replacedLicenseId: current.id })
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (input.action === "suspend") updates.status = "suspended"
    if (input.action === "revoke") updates.status = "revoked"
    if (input.action === "notes") updates.internal_notes = input.internal_notes ?? ""
    if (input.action === "change_grace") {
      if (input.grace_days === undefined) return adminFail(context, "Grace days are required.", 422)
      updates.grace_days = input.grace_days
    }
    if (input.action === "update_features") {
      if (!input.allowed_features) return adminFail(context, "Allowed features are required.", 422)
      updates.allowed_features = [...new Set(input.allowed_features)].sort()
      if (input.plan_name) updates.plan_name = input.plan_name
      if (input.maximum_users) updates.maximum_users = input.maximum_users
      if (input.maximum_businesses) updates.maximum_businesses = input.maximum_businesses
      if (input.maximum_branches) updates.maximum_branches = input.maximum_branches
    }
    if (input.action === "renew") {
      if (!input.expiry_date) return adminFail(context, "A renewal expiry date is required.", 422)
      updates.expiry_date = input.expiry_date
      updates.issue_date = new Date().toISOString().slice(0, 10)
      updates.status = "active"
    }
    if (input.action === "extend") {
      if (!input.extend_days) return adminFail(context, "Extension days are required.", 422)
      updates.expiry_date = dateAfter(current.expiry_date, input.extend_days)
      updates.status = "active"
    }

    const signatureChanges = ["renew", "extend", "change_grace", "update_features"].includes(input.action)
    if (signatureChanges) {
      if (!hasLicenseSigningKey()) {
        return adminFail(context, "License update failed because the server signing key is not configured.", 503)
      }
      const next = { ...current, ...updates } as StoredLicense
      const signed = signLicensePayload(licensePayload(next, context.adminEmail || context.adminUserId))
      updates.signed_license_key = signed.license_key
      updates.issuer_key_id = signed.payload.issuer_key_id
      updates.signature_algorithm = signed.payload.signature_algorithm
    }

    const result = await adminSupabase.from("licenses").update(updates).eq("id", current.id).select("*").single()
    if (result.error) throw result.error
    const changed = result.data as StoredLicense
    const actionNames: Record<typeof input.action, string> = {
      renew: "LICENSE_RENEWED",
      extend: "LICENSE_EXTENDED",
      change_grace: "LICENSE_GRACE_CHANGED",
      update_features: "LICENSE_FEATURES_CHANGED",
      suspend: "LICENSE_SUSPENDED",
      revoke: "LICENSE_REVOKED",
      replace_device: "DEVICE_REPLACED",
      transfer: "LICENSE_TRANSFERRED",
      notes: "LICENSE_NOTES_UPDATED",
    }
    await recordLicenseEvent({
      context,
      licenseId: current.id,
      action: actionNames[input.action],
      previousValues: compactRecord(current),
      newValues: compactRecord(changed),
      notes: input.reason || input.internal_notes || null,
    })
    return adminOk(context, { license: changed })
  } catch (error) {
    return unexpectedAdminError(context, error, "License change failed.")
  }
}
