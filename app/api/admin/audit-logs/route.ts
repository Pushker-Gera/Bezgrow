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
      ["created_at", "admin_email", "action", "target_type", "result"],
      "created_at"
    )
    let query = adminSupabase
      .from("admin_audit_logs")
      .select("*", { count: "exact" })
      .order(sort.column, { ascending: sort.ascending })
    if (list.search) {
      const term = list.search.replaceAll(",", " ")
      query = query.or(
        `admin_email.ilike.%${term}%,action.ilike.%${term}%,target_type.ilike.%${term}%,target_id.ilike.%${term}%,request_id.ilike.%${term}%`
      )
    }
    if (list.status) query = query.eq("result", list.status)
    query = exportMode ? query.limit(10000) : query.range(from, to)
    const result = await query
    if (result.error) {
      return adminFail(context, controlPlaneErrorMessage(result.error, "Audit logs failed to load."), 500)
    }
    if (exportMode) {
      return csvResponse(
        `bezgrow-admin-audit-${new Date().toISOString().slice(0, 10)}.csv`,
        [
          "id",
          "admin_user_id",
          "admin_email",
          "action",
          "target_type",
          "target_id",
          "created_at",
          "ip_address",
          "user_agent",
          "previous_values",
          "new_values",
          "request_id",
          "result",
        ],
        result.data || []
      )
    }
    return adminOk(context, {
      data: result.data || [],
      pagination: { page: list.page, limit: list.limit, total: result.count || 0 },
      immutable: true,
    })
  } catch (error) {
    return unexpectedAdminError(context, error, "Audit logs failed to load.")
  }
}
