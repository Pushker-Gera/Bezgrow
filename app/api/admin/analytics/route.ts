import "server-only"

import { z } from "zod"
import { requireAdmin } from "@/lib/api/auth"
import { adminFail, adminOk, controlPlaneErrorMessage, unexpectedAdminError } from "@/lib/admin/control-plane"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const rangeSchema = z.coerce.number().int().min(7).max(365).default(30)

export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context
  const parsedDays = rangeSchema.safeParse(new URL(request.url).searchParams.get("days") || undefined)
  if (!parsedDays.success) return adminFail(context, "Analytics range is invalid.", 422)

  try {
    const result = await adminSupabase.rpc("admin_control_plane_analytics", {
      requesting_admin_id: context.adminUserId,
      range_days: parsedDays.data,
    })
    if (result.error) {
      return adminFail(context, controlPlaneErrorMessage(result.error, "Analytics failed to load."), 500)
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
