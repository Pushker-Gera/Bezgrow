import "server-only"

import { requireAdminControlPlane } from "@/lib/api/auth"
import { adminFail, adminOk, unexpectedAdminError } from "@/lib/admin/control-plane"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context
  try {
    const { id } = await params
    const result = await adminSupabase
      .from("license_events")
      .select("*")
      .eq("license_id", id)
      .order("created_at", { ascending: false })
      .limit(200)
    if (result.error) throw result.error
    return adminOk(context, { data: result.data || [] })
  } catch (error) {
    return unexpectedAdminError(context, error, "License history failed to load.")
  }
}
