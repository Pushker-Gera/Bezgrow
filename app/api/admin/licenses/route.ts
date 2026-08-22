import "server-only"

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
import {
  createLicenseSchema,
  licenseValidationIssue,
  updateLicenseSchema,
  type ValidCreateLicenseInput,
} from "@/lib/license/admin-license-validation"
import {
  addLicenseDays,
  effectiveStatusForRow,
  licenseActionStateError,
  licenseAuditSnapshot,
  renewedExpiry,
} from "@/lib/license/admin-license-actions"
import { LICENSE_SCHEMA_VERSION, type LicensePayload } from "@/lib/license/codec"
import { createLicenseId, hasLicenseSigningKey, licenseSigningStatus, signLicensePayload } from "@/lib/license/server"
import { adminSupabase } from "@/lib/supabase/admin"
import { adminRequestTiming } from "@/lib/admin/request-timing"

export const dynamic = "force-dynamic"

const LICENSE_LIST_COLUMNS = "id,platform_customer_id,platform_business_id,customer_name,customer_email,business_name,device_id,platform,architecture,app_version,plan_name,issue_date,expiry_date,grace_days,allowed_features,maximum_users,maximum_businesses,maximum_branches,internal_notes,status,issuer_key_id,signature_algorithm,issued_by_admin_id,issued_by_admin_email,created_at,updated_at,effective_status"

type StoredLicense = {
  id: string
  platform_customer_id: string | null
  platform_business_id: string | null
  subject_customer_id?: string | null
  subject_business_id?: string | null
  customer_name: string
  customer_email: string | null
  business_name: string
  device_id: string
  platform: "macos" | "windows"
  architecture?: "arm64" | "x64" | null
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
  activation_date?: string | null
  renewed_at?: string | null
  revoked_at?: string | null
  suspended_at?: string | null
  created_at: string
  updated_at: string
}

function licensePayload(row: StoredLicense, adminLabel: string): LicensePayload {
  return {
    schema_version: LICENSE_SCHEMA_VERSION,
    license_id: row.id,
    customer_id:
      row.subject_customer_id ||
      row.platform_customer_id ||
      `customer:${row.customer_email || row.customer_name}`,
    customer_name: row.customer_name,
    customer_email: row.customer_email,
    business_id:
      row.subject_business_id ||
      row.platform_business_id ||
      `business:${row.business_name}`,
    business_name: row.business_name,
    device_id: row.device_id,
    platform: row.platform,
    architecture: row.architecture === "x64" ? "x86_64" : row.architecture,
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

async function ensureCustomer(input: ValidCreateLicenseInput) {
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

async function ensureBusiness(input: ValidCreateLicenseInput, customerId: string) {
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
  const timing = adminRequestTiming("/api/admin/licenses", "GET")
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context
  timing.mark("authorization")

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
      .select(LICENSE_LIST_COLUMNS, { count: "exact" })
      .order(sort.column, { ascending: sort.ascending })

    if (list.search) {
      const term = list.search.replaceAll(",", " ")
      query = query.or(
        `id.ilike.%${term}%,customer_name.ilike.%${term}%,customer_email.ilike.%${term}%,business_name.ilike.%${term}%,device_id.ilike.%${term}%`
      )
    }
    if (["draft", "suspended", "revoked", "replaced"].includes(list.status)) query = query.eq("status", list.status)
    else if (list.status) query = query.eq("effective_status", list.status)
    if (list.platform) query = query.eq("platform", list.platform)
    query = exportMode ? query.limit(10000) : query.range(from, to)

    const result = await query
    timing.mark("license_query")
    if (result.error) {
      return adminFail(context, controlPlaneErrorMessage(result.error, "Licenses failed to load."), 500)
    }

    const rows = ((result.data || []) as unknown as StoredLicense[]).map((license) => ({
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

    const response = adminOk(context, {
      data: rows,
      pagination: { page: list.page, limit: list.limit, total: result.count || 0 },
      licenseSigning: licenseSigningStatus(),
    })
    timing.finish(context.requestId)
    return response
  } catch (error) {
    return unexpectedAdminError(context, error, "Licenses failed to load.")
  }
}

export async function POST(request: Request) {
  const timing = adminRequestTiming("/api/admin/licenses", "POST")
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context
  timing.mark("authorization")

  if (!hasLicenseSigningKey()) {
    return adminFail(context, "License generation failed because the server signing key is not configured.", 503, {
      licenseSigning: licenseSigningStatus(),
    })
  }

  const parsed = createLicenseSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    const validation = licenseValidationIssue(parsed.error.issues[0])
    return adminFail(context, validation.error, 422, {
      field: validation.field,
      fieldName: validation.fieldName,
      validationMessage: validation.message,
    })
  }

  try {
    const input = parsed.data
    timing.mark("validation")
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
        const [device, event] = await Promise.all([
          adminSupabase.from("registered_devices").upsert(
            {
              device_id: existingLicense.device_id,
              platform_customer_id: existingLicense.platform_customer_id,
              platform_business_id: existingLicense.platform_business_id,
              license_id: existingLicense.id,
              platform: existingLicense.platform,
              architecture: existingLicense.architecture,
              app_version: existingLicense.app_version,
              device_status: "registered",
              updated_at: new Date().toISOString(),
            },
            { onConflict: "device_id" }
          ),
          adminSupabase
            .from("license_events")
            .select("id")
            .eq("license_id", existingLicense.id)
            .eq("action", "LICENSE_GENERATED")
            .limit(1)
            .maybeSingle(),
        ])
        if (device.error) throw device.error
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
        timing.mark("idempotent_recovery")
        const response = adminOk(context, {
          license: existingLicense,
          license_key: existingLicense.signed_license_key,
          license_file: signedFile(existingLicense),
          duplicate: true,
        })
        timing.finish(context.requestId)
        return response
      }
    }

    const customerId = await ensureCustomer(input)
    timing.mark("customer")
    const businessId = await ensureBusiness(input, customerId)
    timing.mark("business")
    const licenseId = createLicenseId()
    const adminLabel = context.adminEmail || context.adminUserId
    const row = await persistSignedLicense(
      {
        id: licenseId,
        platform_customer_id: customerId,
        platform_business_id: businessId,
        subject_customer_id: customerId,
        subject_business_id: businessId,
        customer_name: input.customer_name,
        customer_email: input.customer_email.toLowerCase(),
        business_name: input.business_name,
        device_id: input.device_id,
        platform: input.platform,
        architecture: input.architecture || null,
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
    timing.mark("sign_and_store")

    const [device] = await Promise.all([
      adminSupabase.from("registered_devices").upsert(
        {
          device_id: input.device_id,
          platform_customer_id: customerId,
          platform_business_id: businessId,
          license_id: row.id,
          platform: input.platform,
          architecture: input.architecture || null,
          app_version: input.app_version || null,
          activation_date: null,
          device_status: "registered",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "device_id" }
      ),
      recordLicenseEvent({
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
      }),
    ])
    if (device.error) throw device.error
    timing.mark("device_and_audit")

    const response = adminOk(context, {
      license: row,
      license_key: row.signed_license_key,
      license_file: signedFile(row),
    })
    timing.finish(context.requestId)
    return response
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
    // Fresh requests get a precise transition error before signing. A retry
    // intentionally reaches the RPC when the row timestamp moved so its
    // idempotency ledger can return the exact first response.
    if (input.expected_updated_at === current.updated_at) {
      const stateError = licenseActionStateError(input.action, current.status)
      if (stateError) return adminFail(context, stateError, 409, { code: "INVALID_LICENSE_TRANSITION" })
    }

    const changedAt = new Date().toISOString()
    const adminLabel = context.adminEmail || context.adminUserId
    const updates: Record<string, unknown> = { updated_at: changedAt }
    if (input.action === "suspend") Object.assign(updates, { status: "suspended", suspended_at: changedAt })
    if (input.action === "reactivate") Object.assign(updates, { status: "active", suspended_at: null })
    if (input.action === "revoke") Object.assign(updates, { status: "revoked", revoked_at: changedAt })
    if (input.action === "notes") updates.internal_notes = input.internal_notes ?? ""
    if (input.action === "change_grace") updates.grace_days = input.grace_days
    if (input.action === "update_features") {
      updates.allowed_features = input.allowed_features
      updates.plan_name = input.plan_name
      if (input.maximum_users !== undefined) updates.maximum_users = input.maximum_users
      if (input.maximum_businesses !== undefined) updates.maximum_businesses = input.maximum_businesses
      if (input.maximum_branches !== undefined) updates.maximum_branches = input.maximum_branches
    }
    if (input.action === "renew") {
      updates.expiry_date = renewedExpiry(current.expiry_date, input.renew_months as number)
      updates.issue_date = changedAt.slice(0, 10)
      updates.status = "active"
      updates.renewed_at = changedAt
      updates.suspended_at = null
    }
    if (input.action === "extend") {
      updates.expiry_date = addLicenseDays(current.expiry_date, input.extend_days as number)
      updates.renewed_at = changedAt
    }

    const signatureChanges = ["renew", "extend", "change_grace", "update_features"].includes(input.action)
    if (signatureChanges && !hasLicenseSigningKey()) {
      return adminFail(context, "Licence signing failed because the server signing key is not configured. Existing licence remains unchanged.", 503)
    }
    if (signatureChanges) {
      const next = { ...current, ...updates } as StoredLicense
      const signed = signLicensePayload(licensePayload(next, adminLabel))
      updates.signed_license_key = signed.license_key
      updates.issuer_key_id = signed.payload.issuer_key_id
      updates.signature_algorithm = signed.payload.signature_algorithm
      updates.issued_by_admin_id = context.adminUserId
      updates.issued_by_admin_email = context.adminEmail
    }

    let replacement: StoredLicense | null = null
    if (input.action === "replace_device" || input.action === "transfer") {
      if (!hasLicenseSigningKey()) {
        return adminFail(context, "Licence signing failed because the server signing key is not configured. Existing licence remains unchanged.", 503)
      }
      const replacementId = createLicenseId()
      const replacementBase = {
        ...current,
        id: replacementId,
        device_id: input.new_device_id as string,
        issue_date: changedAt.slice(0, 10),
        status: "active",
        internal_notes: [current.internal_notes, input.reason].filter(Boolean).join("\n"),
        signed_license_key: null,
        issuer_key_id: null,
        signature_algorithm: null,
        issued_by_admin_id: context.adminUserId,
        issued_by_admin_email: context.adminEmail,
        activation_date: null,
        renewed_at: null,
        revoked_at: null,
        suspended_at: null,
        created_at: changedAt,
        updated_at: changedAt,
      } satisfies StoredLicense
      const signed = signLicensePayload(licensePayload(replacementBase, adminLabel))
      replacement = {
        ...replacementBase,
        signed_license_key: signed.license_key,
        issuer_key_id: signed.payload.issuer_key_id || null,
        signature_algorithm: signed.payload.signature_algorithm || null,
      }
    }

    const actionNames: Record<typeof input.action, string> = {
      renew: "LICENSE_RENEWED",
      extend: "LICENSE_EXTENDED",
      change_grace: "LICENSE_GRACE_CHANGED",
      update_features: "LICENSE_FEATURES_CHANGED",
      suspend: "LICENSE_SUSPENDED",
      reactivate: "LICENSE_REACTIVATED",
      revoke: "LICENSE_REVOKED",
      replace_device: "DEVICE_REPLACED",
      transfer: "LICENSE_TRANSFERRED",
      notes: "LICENSE_NOTES_UPDATED",
    }
    const nextSnapshot = replacement
      ? { ...licenseAuditSnapshot(current), status: "replaced", replaced_by_license_id: replacement.id, updated_at: changedAt }
      : licenseAuditSnapshot({ ...current, ...updates })
    const mutation = await adminSupabase.rpc("admin_mutate_license", {
      p_license_id: current.id,
      p_action: input.action,
      p_action_name: actionNames[input.action],
      p_expected_updated_at: input.expected_updated_at,
      p_changed_at: changedAt,
      p_updates: updates,
      p_replacement: replacement,
      p_new_device_id: input.new_device_id || null,
      p_reason: input.reason || input.internal_notes || null,
      p_idempotency_key: input.idempotency_key,
      p_request_id: context.requestId,
      p_admin_user_id: context.adminUserId,
      p_admin_email: context.adminEmail,
      p_ip_address: context.ipAddress,
      p_user_agent: context.userAgent,
      p_previous_values: licenseAuditSnapshot(current),
      p_new_values: nextSnapshot,
    })
    if (mutation.error) {
      const message = mutation.error.message || ""
      if (/already revoked/i.test(message)) return adminFail(context, "Licence is already revoked.", 409, { code: "INVALID_LICENSE_TRANSITION" })
      if (/already suspended/i.test(message)) return adminFail(context, "Licence is already suspended.", 409, { code: "INVALID_LICENSE_TRANSITION" })
      if (/changed concurrently/i.test(message)) return adminFail(context, "This licence changed concurrently. Refresh the row before retrying.", 409, { code: "LICENSE_CHANGED" })
      if (/target device is already assigned/i.test(message)) return adminFail(context, "The target Device ID is already assigned to another licence.", 409, { code: "DEVICE_ALREADY_ASSIGNED" })
      if (/invalid licence transition/i.test(message)) return adminFail(context, "This licence state does not permit the requested action.", 409, { code: "INVALID_LICENSE_TRANSITION" })
      throw mutation.error
    }
    const mutationResult = mutation.data as {
      license?: StoredLicense
      replacedLicense?: StoredLicense
      replacedLicenseId?: string
      duplicate?: boolean
    } | null
    if (!mutationResult?.license) throw new Error("Atomic licence mutation returned no licence row.")
    const responseLicense = {
      ...mutationResult.license,
      effective_status: effectiveStatusForRow(mutationResult.license as unknown as Record<string, unknown>),
    }
    const replacedLicense = mutationResult.replacedLicense
      ? {
          ...mutationResult.replacedLicense,
          effective_status: effectiveStatusForRow(mutationResult.replacedLicense as unknown as Record<string, unknown>),
        }
      : undefined
    return adminOk(context, {
      ...mutationResult,
      license: responseLicense,
      replacedLicense,
    })
  } catch (error) {
    return unexpectedAdminError(context, error, "License change failed.")
  }
}
