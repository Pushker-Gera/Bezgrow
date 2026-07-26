import "server-only"

import { requireAdminControlPlane } from "@/lib/api/auth"
import {
  adminFail,
  adminOk,
  controlPlaneErrorMessage,
  csvResponse,
  unexpectedAdminError,
} from "@/lib/admin/control-plane"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

function flattenSummary(value: unknown, prefix = ""): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [{ metric: prefix, value }]
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const metric = prefix ? `${prefix}.${key}` : key
    return child && typeof child === "object" && !Array.isArray(child)
      ? flattenSummary(child, metric)
      : [{ metric, value: Array.isArray(child) ? JSON.stringify(child) : child }]
  })
}

export async function GET(request: Request) {
  const auth = await requireAdminControlPlane(request)
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
    if (new URL(request.url).searchParams.get("format") === "csv") {
      return csvResponse(
        `bezgrow-admin-dashboard-${new Date().toISOString().slice(0, 10)}.csv`,
        ["metric", "value"],
        flattenSummary(result.data || {})
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
