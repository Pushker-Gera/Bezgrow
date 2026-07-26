import "server-only"

import { requireAdmin } from "@/lib/api/auth"
import {
  adminFail,
  adminOk,
  controlPlaneErrorMessage,
  unexpectedAdminError,
} from "@/lib/admin/control-plane"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context

  try {
    const result = await adminSupabase.rpc("admin_control_plane_dashboard", {
      requesting_admin_id: context.adminUserId,
    })
    if (result.error) {
      return adminFail(
        context,
        controlPlaneErrorMessage(result.error, "Platform dashboard failed to load."),
        500
      )
    }

    return adminOk(
      context,
      {
        summary: result.data || {},
        revenue: {
          licenseValue: null,
          licenseValueLabel: "Not configured",
          subscriptionRevenue: null,
          subscriptionRevenueLabel: "Payment system not connected",
        },
        dataBoundaries: {
          platform: "Available from the Bezgrow control plane",
          license: "Authoritative cloud metadata with offline-verifiable signed files",
          device: "Last reported during authenticated online contact",
          synchronizedTelemetry: "Available only when explicitly enabled and successfully uploaded",
          localErp: "Unavailable to the platform unless the customer explicitly synchronizes it",
        },
      },
      {
        headers: {
          "Cache-Control": "private, max-age=15, stale-while-revalidate=30",
        },
      }
    )
  } catch (error) {
    return unexpectedAdminError(context, error, "Platform dashboard failed to load.")
  }
}
