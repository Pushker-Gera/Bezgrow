import "server-only"

import { adminSupabase } from "@/lib/supabase/admin"

export const ADMIN_CONTROL_PLANE_SCHEMA_VERSION = 2026082102
export const ADMIN_CONTROL_PLANE_SCHEMA_STATUS_RPC = "admin_control_plane_current_schema_status"

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
    functions: ["public.admin_control_plane_current_schema_status()"],
  },
}

let cachedSchemaStatus: { value: AdminControlPlaneSchemaStatus; expiresAt: number } | null = null
let schemaRequest: Promise<AdminControlPlaneSchemaStatus> | null = null

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
  if (cachedSchemaStatus && cachedSchemaStatus.expiresAt > Date.now()) return cachedSchemaStatus.value
  if (schemaRequest) return schemaRequest

  schemaRequest = (async () => {
  const result = await adminSupabase.rpc(ADMIN_CONTROL_PLANE_SCHEMA_STATUS_RPC)

  if (result.error) {
    console.error("[admin-control-plane-schema]", {
      requestId,
      code: result.error.code,
      message: result.error.message,
      expectedVersion: ADMIN_CONTROL_PLANE_SCHEMA_VERSION,
      missingObject: "public.admin_control_plane_current_schema_status()",
    })
    cachedSchemaStatus = { value: unavailableStatus, expiresAt: Date.now() + 5_000 }
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
  cachedSchemaStatus = { value: status, expiresAt: Date.now() + (status.ready ? 60_000 : 5_000) }
  return status
  })()
  try {
    return await schemaRequest
  } finally {
    schemaRequest = null
  }
}

export function adminControlPlaneUnavailableMessage() {
  return "The admin control plane is not ready in this Supabase project. Apply the production control-plane migration."
}
