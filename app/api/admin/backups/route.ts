import "server-only"

import { requireAdminControlPlane } from "@/lib/api/auth"
import {
  adminFail,
  adminOk,
  adminRange,
  adminSort,
  controlPlaneErrorMessage,
  csvResponse,
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
      ["updated_at", "last_successful_backup_at", "last_failed_backup_at", "backup_size"],
      "updated_at"
    )
    let query = adminSupabase
      .from("backup_status")
      .select("*", { count: "exact" })
      .order(sort.column, { ascending: sort.ascending })
    if (list.search) {
      const term = list.search.replaceAll(",", " ")
      query = query.or(
        `last_failure_code.ilike.%${term}%,encryption_status.ilike.%${term}%,retention_policy.ilike.%${term}%,restore_request_status.ilike.%${term}%`
      )
    }
    if (list.status === "enabled") query = query.eq("cloud_backup_enabled", true)
    if (list.status === "disabled") query = query.eq("cloud_backup_enabled", false)
    query = exportMode ? query.limit(10000) : query.range(from, to)
    const result = await query
    if (result.error) {
      return adminFail(context, controlPlaneErrorMessage(result.error, "Backup status failed to load."), 500)
    }

    const businessIds = (result.data || []).map((row) => row.platform_business_id)
    const businesses = businessIds.length
      ? await adminSupabase
          .from("platform_businesses")
          .select("id,business_name,workspace_id,cloud_mode")
          .in("id", businessIds)
      : { data: [], error: null }
    if (businesses.error) return adminFail(context, "Backup business metadata failed to load.", 500)
    const businessMap = new Map((businesses.data || []).map((row) => [row.id, row]))

    const data = (result.data || []).map((backup) => ({
        ...backup,
        business: businessMap.get(backup.platform_business_id) || null,
      }))
    if (exportMode) {
      return csvResponse(
        `bezgrow-backup-status-${new Date().toISOString().slice(0, 10)}.csv`,
        [
          "id",
          "platform_business_id",
          "cloud_backup_enabled",
          "last_successful_backup_at",
          "last_failed_backup_at",
          "last_failure_code",
          "backup_size",
          "encryption_status",
          "retention_policy",
          "restore_request_status",
          "sync_conflict_count",
          "updated_at",
        ],
        data
      )
    }

    return adminOk(context, {
      data,
      pagination: { page: list.page, limit: list.limit, total: result.count || 0 },
      privacyNotice:
        "Only customer-enabled encrypted backup metadata is visible. Local invoices, products, and customers are not uploaded or inspected.",
    })
  } catch (error) {
    return unexpectedAdminError(context, error, "Backup status failed to load.")
  }
}
