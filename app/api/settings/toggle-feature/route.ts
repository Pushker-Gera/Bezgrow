import { z } from "zod"
import { featureKeys } from "@/lib/features"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { writeAdminLog } from "@/lib/api/auth"
import { requireWorkspace } from "@/lib/api/tenant"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const toggleSchema = z.object({
  feature_key: z.custom<(typeof featureKeys)[number]>(
    (value) => typeof value === "string" && featureKeys.includes(value as (typeof featureKeys)[number]),
    "Unknown feature."
  ),
  is_enabled: z.boolean(),
})

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)

  if (!workspace.ok) {
    return fail(workspace.error, workspace.status)
  }

  if (!["owner", "admin"].includes(workspace.context.memberRole) && workspace.context.profileRole !== "admin") {
    return fail("Workspace admin access required.", 403)
  }

  const parsed = toggleSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return fail("Invalid feature toggle.", 422)
  }

  try {
    const { error } = await adminSupabase.from("organization_features").upsert(
      {
        organization_id: workspace.context.organizationId,
        feature_key: parsed.data.feature_key,
        is_enabled: parsed.data.is_enabled,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,feature_key" }
    )

    if (error) return fail("Feature could not be updated.", 500)

    await writeAdminLog({
      action: parsed.data.is_enabled ? "feature.enabled" : "feature.disabled",
      description: "Organization feature changed.",
      adminUserId: workspace.context.userId,
      organizationId: workspace.context.organizationId,
      metadata: parsed.data,
    })

    return ok(parsed.data)
  } catch {
    return serverFail()
  }
}
