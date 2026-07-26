import "server-only"

import { z } from "zod"
import { requireAdminControlPlane, writeAdminAudit } from "@/lib/api/auth"
import {
  adminFail,
  adminOk,
  adminRange,
  adminSort,
  controlPlaneErrorMessage,
  csvResponse,
  effectiveLicenseStatus,
  parseAdminListQuery,
  unexpectedAdminError,
} from "@/lib/admin/control-plane"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const deviceActionSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(["revoke", "mark_replaced", "request_diagnostics", "reset_online_session"]),
  replacement_device_id: z.string().trim().min(8).max(180).optional(),
  reason: z.string().trim().min(3).max(500).optional(),
})

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
      ["created_at", "updated_at", "device_id", "activation_date", "last_reported_at", "app_version", "device_status"],
      "created_at"
    )
    let query = adminSupabase
      .from("registered_devices")
      .select("*", { count: "exact" })
      .order(sort.column, { ascending: sort.ascending })
    if (list.search) {
      const term = list.search.replaceAll(",", " ")
      query = query.or(`device_id.ilike.%${term}%,operating_system.ilike.%${term}%,app_version.ilike.%${term}%`)
    }
    if (list.status) query = query.eq("device_status", list.status)
    if (list.platform) query = query.eq("platform", list.platform)
    if (list.channel) query = query.eq("release_channel", list.channel)
    if (list.version) query = query.eq("app_version", list.version)
    query = exportMode ? query.limit(10000) : query.range(from, to)

    const result = await query
    if (result.error) {
      return adminFail(context, controlPlaneErrorMessage(result.error, "Devices failed to load."), 500)
    }
    const rows = result.data || []
    const customerIds = rows.map((row) => row.platform_customer_id).filter(Boolean)
    const businessIds = rows.map((row) => row.platform_business_id).filter(Boolean)
    const licenseIds = rows.map((row) => row.license_id).filter(Boolean)
    const [customers, businesses, licenses] = await Promise.all([
      customerIds.length
        ? adminSupabase.from("platform_customers").select("id,name,email").in("id", customerIds)
        : Promise.resolve({ data: [], error: null }),
      businessIds.length
        ? adminSupabase.from("platform_businesses").select("id,business_name").in("id", businessIds)
        : Promise.resolve({ data: [], error: null }),
      licenseIds.length
        ? adminSupabase.from("licenses").select("id,status,expiry_date,grace_days").in("id", licenseIds)
        : Promise.resolve({ data: [], error: null }),
    ])
    if (customers.error || businesses.error || licenses.error) {
      return adminFail(context, "Device relationships failed to load.", 500)
    }
    const customerMap = new Map((customers.data || []).map((row) => [row.id, row]))
    const businessMap = new Map((businesses.data || []).map((row) => [row.id, row]))
    const licenseMap = new Map(
      (licenses.data || []).map((row) => [row.id, { ...row, effective_status: effectiveLicenseStatus(row) }])
    )

    const data = rows.map((device) => ({
        ...device,
        customer: customerMap.get(device.platform_customer_id) || null,
        business: businessMap.get(device.platform_business_id) || null,
        license: licenseMap.get(device.license_id) || null,
        presence_label: device.last_reported_at ? `Last reported: ${device.last_reported_at}` : "Last reported: Never",
      }))
    if (exportMode) {
      return csvResponse(
        `bezgrow-registered-devices-${new Date().toISOString().slice(0, 10)}.csv`,
        [
          "id",
          "device_id",
          "license_id",
          "platform",
          "architecture",
          "operating_system",
          "app_version",
          "device_status",
          "activation_date",
          "last_reported_at",
          "last_update_check_at",
          "release_channel",
          "diagnostics_available",
          "diagnostic_requested_at",
          "replaced_by_device_id",
          "created_at",
          "updated_at",
        ],
        data
      )
    }

    return adminOk(context, {
      data,
      pagination: { page: list.page, limit: list.limit, total: result.count || 0 },
      monitoringNotice: "Devices report only during authenticated online contact. Offline devices are not monitored in real time.",
    })
  } catch (error) {
    return unexpectedAdminError(context, error, "Devices failed to load.")
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context
  const parsed = deviceActionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return adminFail(context, parsed.error.issues[0]?.message || "Invalid device action.", 422)

  try {
    const input = parsed.data
    const current = await adminSupabase.from("registered_devices").select("*").eq("id", input.id).maybeSingle()
    if (current.error) throw current.error
    if (!current.data) return adminFail(context, "Device was not found.", 404)

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (input.action === "revoke") updates.device_status = "revoked"
    if (input.action === "mark_replaced") {
      if (!input.replacement_device_id || !input.reason) {
        return adminFail(context, "Replacement Device ID and reason are required.", 422)
      }
      updates.device_status = "replaced"
      updates.replaced_by_device_id = input.replacement_device_id
    }
    if (input.action === "request_diagnostics") {
      updates.diagnostic_requested_at = new Date().toISOString()
    }
    if (input.action === "reset_online_session") {
      updates.online_session_version = Number(current.data.online_session_version || 1) + 1
    }

    const result = await adminSupabase.from("registered_devices").update(updates).eq("id", input.id).select("*").single()
    if (result.error) throw result.error

    const actionMap: Record<string, string> = {
      revoke: "DEVICE_REVOKED",
      mark_replaced: "DEVICE_REPLACED",
      request_diagnostics: "DIAGNOSTICS_REQUESTED",
      reset_online_session: "DEVICE_ONLINE_SESSION_RESET",
    }
    await writeAdminAudit(context, {
      action: actionMap[input.action],
      targetType: "device",
      targetId: current.data.device_id,
      previousValues: current.data,
      newValues: result.data,
    })
    return adminOk(context, { device: result.data })
  } catch (error) {
    return unexpectedAdminError(context, error, "Device action failed.")
  }
}
