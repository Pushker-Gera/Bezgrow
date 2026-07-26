import "server-only"

import { requireAdmin } from "@/lib/api/auth"
import {
  adminFail,
  adminOk,
  adminRange,
  controlPlaneErrorMessage,
  parseAdminListQuery,
  unexpectedAdminError,
} from "@/lib/admin/control-plane"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context

  try {
    const list = parseAdminListQuery(request)
    const { from, to } = adminRange(list)
    let query = adminSupabase
      .from("backup_status")
      .select("*", { count: "exact" })
      .order("updated_at", { ascending: false })
      .range(from, to)
    if (list.status === "enabled") query = query.eq("cloud_backup_enabled", true)
    if (list.status === "disabled") query = query.eq("cloud_backup_enabled", false)
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

    return adminOk(context, {
      data: (result.data || []).map((backup) => ({
        ...backup,
        business: businessMap.get(backup.platform_business_id) || null,
      })),
      pagination: { page: list.page, limit: list.limit, total: result.count || 0 },
      privacyNotice:
        "Only customer-enabled encrypted backup metadata is visible. Local invoices, products, and customers are not uploaded or inspected.",
    })
  } catch (error) {
    return unexpectedAdminError(context, error, "Backup status failed to load.")
  }
}
