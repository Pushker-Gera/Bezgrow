import "server-only"

import { requireAdminControlPlane } from "@/lib/api/auth"
import { adminFail, adminOk, unexpectedAdminError } from "@/lib/admin/control-plane"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const hiddenHistoryKeys = new Set([
  "signed_license_key",
  "license_key",
  "signature",
  "private_key",
  "service_role_key",
])

function sanitizeHistoryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeHistoryValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !hiddenHistoryKeys.has(key.toLowerCase()))
      .map(([key, entry]) => [key, sanitizeHistoryValue(entry)])
  )
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context
  try {
    const { id } = await params
    const result = await adminSupabase
      .from("license_events")
      .select("id,license_id,action,admin_email,previous_values,new_values,notes,request_id,created_at")
      .eq("license_id", id)
      .order("created_at", { ascending: false })
      .limit(200)
    if (result.error) throw result.error
    return adminOk(context, { data: sanitizeHistoryValue(result.data || []) })
  } catch (error) {
    return unexpectedAdminError(context, error, "License history failed to load.")
  }
}
