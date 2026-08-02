import "server-only"

import { requireAdminControlPlane } from "@/lib/api/auth"
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
      ["created_at", "updated_at", "business_name", "status", "platform", "app_version"],
      "created_at"
    )
    let licensedBusinessIds: string[] | null = null
    if (list.license_status) {
      const licenseFilter = await adminSupabase
        .from("license_control_plane")
        .select("platform_business_id,effective_status")
        .eq("effective_status", list.license_status)
        .limit(10000)
      if (licenseFilter.error) {
        return adminFail(context, "License filters failed to load.", 500)
      }
      licensedBusinessIds = Array.from(
        new Set(
          (licenseFilter.data || [])
            .map((license) => license.platform_business_id)
            .filter(Boolean)
        )
      )
      if (licensedBusinessIds.length === 0) {
        return adminOk(context, {
          data: [],
          pagination: { page: list.page, limit: list.limit, total: 0 },
          unavailableFields: ["invoice revenue", "product count", "stock health", "retail customer count", "local billing activity"],
        })
      }
    }
    let query = adminSupabase
      .from("platform_businesses")
      .select("*", { count: "exact" })
      .order(sort.column, { ascending: sort.ascending })
    if (list.search) {
      const term = list.search.replaceAll(",", " ")
      query = query.or(`business_name.ilike.%${term}%,workspace_id.ilike.%${term}%,app_version.ilike.%${term}%`)
    }
    if (list.status) query = query.eq("status", list.status)
    if (list.platform) query = query.eq("platform", list.platform)
    if (list.channel) query = query.eq("update_channel", list.channel)
    if (list.version) query = query.eq("app_version", list.version)
    if (list.cloud) query = query.eq("cloud_mode", list.cloud)
    if (licensedBusinessIds) query = query.in("id", licensedBusinessIds)
    query = exportMode ? query.limit(10000) : query.range(from, to)

    const result = await query
    if (result.error) {
      return adminFail(context, controlPlaneErrorMessage(result.error, "Businesses failed to load."), 500)
    }

    const rows = result.data || []
    const customerIds = rows.map((row) => row.platform_customer_id).filter(Boolean)
    const businessIds = rows.map((row) => row.id)
    const [customers, licenses, devices] = await Promise.all([
      customerIds.length
        ? adminSupabase.from("platform_customers").select("id,name,email").in("id", customerIds)
        : Promise.resolve({ data: [], error: null }),
      businessIds.length
        ? adminSupabase
            .from("licenses")
            .select("id,platform_business_id,device_id,status,expiry_date,grace_days,plan_name")
            .in("platform_business_id", businessIds)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      businessIds.length
        ? adminSupabase
            .from("registered_devices")
            .select("id,platform_business_id,device_id,last_reported_at")
            .in("platform_business_id", businessIds)
        : Promise.resolve({ data: [], error: null }),
    ])
    if (customers.error || licenses.error || devices.error) {
      return adminFail(context, "Business metadata relationships failed to load.", 500)
    }

    const customerMap = new Map((customers.data || []).map((row) => [row.id, row]))
    const licenseMap = new Map<string, Record<string, unknown>>()
    for (const license of licenses.data || []) {
      if (license.platform_business_id && !licenseMap.has(license.platform_business_id)) {
        licenseMap.set(license.platform_business_id, {
          ...license,
          effective_status: effectiveLicenseStatus(license),
        })
      }
    }
    const deviceMap = new Map<string, Record<string, unknown>>()
    for (const device of devices.data || []) {
      if (device.platform_business_id && !deviceMap.has(device.platform_business_id)) {
        deviceMap.set(device.platform_business_id, device)
      }
    }

    const data = rows.map((business) => ({
        ...business,
        customer: customerMap.get(business.platform_customer_id) || null,
        license: licenseMap.get(business.id) || null,
        device: deviceMap.get(business.id) || null,
        local_data_state:
          business.cloud_backup_enabled
            ? "ERP local-only; backup customer-controlled"
            : "Local-only",
        last_reported_label: deviceMap.get(business.id)?.last_reported_at || "Never",
      }))
    if (exportMode) {
      return csvResponse(
        `bezgrow-platform-businesses-${new Date().toISOString().slice(0, 10)}.csv`,
        [
          "id",
          "workspace_id",
          "business_name",
          "plan_name",
          "status",
          "platform",
          "app_version",
          "update_channel",
          "cloud_mode",
          "cloud_backup_enabled",
          "last_backup_at",
          "local_data_state",
          "created_at",
          "updated_at",
        ],
        data
      )
    }

    return adminOk(context, {
      data,
      pagination: { page: list.page, limit: list.limit, total: result.count || 0 },
      unavailableFields: ["invoice revenue", "product count", "stock health", "retail customer count", "local billing activity"],
    })
  } catch (error) {
    return unexpectedAdminError(context, error, "Businesses failed to load.")
  }
}
