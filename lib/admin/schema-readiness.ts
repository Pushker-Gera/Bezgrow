import "server-only"

import { adminSupabase } from "@/lib/supabase/admin"

export const ADMIN_CONTROL_PLANE_SCHEMA_VERSION = 2026072701

export type AdminControlPlaneSchemaStatus = {
  ready: boolean
  expectedVersion: number
  actualVersion: number | null
  missing: Record<string, string[]>
}

const unavailableStatus: AdminControlPlaneSchemaStatus = {
  ready: false,
  expectedVersion: ADMIN_CONTROL_PLANE_SCHEMA_VERSION,
  actualVersion: null,
  missing: {
    functions: ["public.admin_control_plane_schema_status()"],
  },
}

function normalizeStatus(value: unknown): AdminControlPlaneSchemaStatus {
  if (!value || typeof value !== "object") return unavailableStatus
  const raw = value as {
    ready?: unknown
    expectedVersion?: unknown
    actualVersion?: unknown
    missing?: unknown
  }
  const missing =
    raw.missing && typeof raw.missing === "object"
      ? Object.fromEntries(
          Object.entries(raw.missing as Record<string, unknown>).map(([kind, objects]) => [
            kind,
            Array.isArray(objects) ? objects.map(String) : [],
          ])
        )
      : unavailableStatus.missing

  return {
    ready: raw.ready === true,
    expectedVersion: Number(raw.expectedVersion || ADMIN_CONTROL_PLANE_SCHEMA_VERSION),
    actualVersion:
      raw.actualVersion === null || raw.actualVersion === undefined
        ? null
        : Number(raw.actualVersion),
    missing,
  }
}

export async function verifyAdminControlPlaneSchema(requestId: string) {
  const result = await adminSupabase.rpc("admin_control_plane_schema_status")

  if (result.error) {
    console.error("[admin-control-plane-schema]", {
      requestId,
      code: result.error.code,
      message: result.error.message,
      expectedVersion: ADMIN_CONTROL_PLANE_SCHEMA_VERSION,
      missingObject: "public.admin_control_plane_schema_status()",
    })
    return unavailableStatus
  }

  const status = normalizeStatus(result.data)
  if (!status.ready) {
    console.error("[admin-control-plane-schema]", {
      requestId,
      expectedVersion: status.expectedVersion,
      actualVersion: status.actualVersion,
      missing: status.missing,
    })
  }
  return status
}

export function adminControlPlaneUnavailableMessage() {
  return "The admin control plane is not ready in this Supabase project. Apply the production control-plane migration."
}
