import "server-only"

import { requireAdminControlPlane } from "@/lib/api/auth"
import { adminFail, unexpectedAdminError } from "@/lib/admin/control-plane"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

function filenamePart(value: unknown, fallback: string) {
  const part = String(value || "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return part || fallback
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context

  try {
    const { id } = await params
    const result = await adminSupabase
      .from("licenses")
      .select("id,business_name,device_id,signed_license_key,issuer_key_id,signature_algorithm,updated_at")
      .eq("id", id)
      .maybeSingle()
    if (result.error) throw result.error
    if (!result.data?.signed_license_key) return adminFail(context, "License file is unavailable.", 404)

    const filename = `Bezgrow-license-${filenamePart(result.data.business_name, "business")}-${filenamePart(result.data.device_id, result.data.id)}.json`
    return new Response(
      JSON.stringify(
        {
          app: "Bezgrow",
          type: "offline_license",
          generated_at: result.data.updated_at,
          license_key: result.data.signed_license_key,
          issuer_key_id: result.data.issuer_key_id,
          signature_algorithm: result.data.signature_algorithm,
        },
        null,
        2
      ),
      {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Type": "application/json; charset=utf-8",
          "X-Request-Id": context.requestId,
        },
      }
    )
  } catch (error) {
    return unexpectedAdminError(context, error, "License download failed.")
  }
}
