import "server-only"

import { z } from "zod"
import { requireAdminControlPlane } from "@/lib/api/auth"
import { adminFail, adminOk, controlPlaneErrorMessage, csvResponse, unexpectedAdminError } from "@/lib/admin/control-plane"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const rangeSchema = z.coerce.number().int().min(7).max(365).default(30)

export async function GET(request: Request) {
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context
  const params = new URL(request.url).searchParams
  const parsedDays = rangeSchema.safeParse(params.get("days") || undefined)
  if (!parsedDays.success) return adminFail(context, "Analytics range is invalid.", 422)

  try {
    const result = await adminSupabase.rpc("admin_control_plane_analytics", {
      requesting_admin_id: context.adminUserId,
      range_days: parsedDays.data,
    })
    if (result.error) {
      return adminFail(context, controlPlaneErrorMessage(result.error, "Analytics failed to load."), 500)
    }
    if (params.get("format") === "csv") {
      const rows = Object.entries((result.data || {}) as Record<string, unknown>).flatMap(([metric, values]) =>
        Array.isArray(values)
          ? values.map((value) => ({
              metric,
              label: String((value as { label?: unknown }).label || "Unlabelled"),
              value: Number((value as { value?: unknown }).value || 0),
              range_days: parsedDays.data,
            }))
          : values && typeof values === "object"
            ? Object.entries(values as Record<string, unknown>).map(([label, value]) => ({
                metric,
                label,
                value: Number(value || 0),
                range_days: parsedDays.data,
              }))
            : []
      )
      return csvResponse(
        `bezgrow-platform-analytics-${new Date().toISOString().slice(0, 10)}.csv`,
        ["metric", "label", "value", "range_days"],
        rows
      )
    }

    return adminOk(
      context,
      {
        ...(result.data || {}),
        dataNotice:
          "Analytics includes platform licenses, activations, releases, optional backups, and support only. Local ERP sales and inventory are excluded.",
      },
      { headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=60" } }
    )
  } catch (error) {
    return unexpectedAdminError(context, error, "Analytics failed to load.")
  }
}
