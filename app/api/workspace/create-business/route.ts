import { z } from "zod"
import { adminSupabase } from "@/lib/supabase/admin"
import { getAuthenticatedUser, validateMutationOrigin, writeAdminLog } from "@/lib/api/auth"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { businessTypeFeatures, categoryFeatures } from "@/lib/business-features"

export const dynamic = "force-dynamic"

type OrganizationInsertPayload = Record<string, string | null>

function missingColumnFromError(error: { message?: string | null } | null) {
  if (!error?.message) return null
  const match =
    error.message.match(/Could not find the '([^']+)' column/i) ||
    error.message.match(/column "([^"]+)" of relation/i) ||
    error.message.match(/column "([^"]+)" does not exist/i)

  return match?.[1] || null
}

async function insertOrganizationWithSchemaFallback(payload: OrganizationInsertPayload) {
  const retryPayload = { ...payload }
  const removedColumns: string[] = []
  const requiredColumns = new Set(["name", "owner_id"])

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await adminSupabase
      .from("organizations")
      .insert(retryPayload)
      .select("id,name")
      .single()

    const missingColumn = missingColumnFromError(result.error)
    if (!result.error || !missingColumn || requiredColumns.has(missingColumn)) {
      return { ...result, removedColumns }
    }

    if (!(missingColumn in retryPayload)) return { ...result, removedColumns }
    delete retryPayload[missingColumn]
    removedColumns.push(missingColumn)
  }

  const result = await adminSupabase
    .from("organizations")
    .insert(retryPayload)
    .select("id,name")
    .single()
  return { ...result, removedColumns }
}

const createBusinessSchema = z.object({
  name: z.string().trim().min(2).max(160),
  industry: z.string().trim().max(120).optional().default(""),
  currency: z.enum(["INR", "USD", "EUR", "GBP", "AED"]).default("INR"),
  business_type: z.string().trim().max(80).optional().default("retail"),
  business_category: z.string().trim().max(80).optional().default("general"),
  gst_number: z.string().trim().max(32).optional().default(""),
  phone: z.string().trim().max(32).optional().default(""),
  email: z.string().trim().email().or(z.literal("")).optional().default(""),
  fssai: z.string().trim().max(32).optional().default(""),
  website: z.string().trim().max(120).optional().default(""),
  address: z.string().trim().max(500).optional().default(""),
  branch_name: z.string().trim().max(120).optional().default("Main Branch"),
})

export async function POST(request: Request) {
  if (!validateMutationOrigin(request)) {
    return fail("Invalid request origin.", 403)
  }

  const user = await getAuthenticatedUser(request)
  if (!user) return fail("Authentication required.", 401)

  const parsed = createBusinessSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message || "Invalid business details.", 422)
  }

  try {
    const { data: profile, error: profileError } = await adminSupabase
      .from("profiles")
      .select("id,email,role,approved,business_created,is_suspended")
      .eq("id", user.id)
      .maybeSingle()

    if (profileError || !profile) return fail("Profile is not ready.", 403)
    if (profile.role === "admin") return fail("Admins do not create customer workspaces here.", 403)
    if (profile.is_suspended) return fail("This account is suspended.", 403)
    if (!profile.approved) return fail("Account approval is pending.", 403)
    if (profile.business_created) return fail("Business is already connected.", 409)

    const { data: existingMembership } = await adminSupabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle()

    if (existingMembership?.organization_id) {
      await adminSupabase.from("profiles").update({ business_created: true }).eq("id", user.id)
      return ok({ organizationId: existingMembership.organization_id, repaired: true })
    }

    const payload = parsed.data
    const { data: organization, error: orgError, removedColumns } = await insertOrganizationWithSchemaFallback({
      name: payload.name,
      industry: payload.industry,
      currency: payload.currency,
      business_type: payload.business_type,
      business_category: payload.business_category,
      gst_number: payload.gst_number,
      phone: payload.phone,
      email: payload.email,
      fssai: payload.fssai,
      website: payload.website,
      address: payload.address,
      branch_name: payload.branch_name || "Main Branch",
      owner_id: user.id,
    })

    if (removedColumns.length > 0) {
      console.warn("[workspace/create-business] organizations legacy schema fallback", {
        removedColumns,
        userId: user.id,
      })
    }

    if (orgError || !organization) {
      console.error("[workspace/create-business] organization insert failed", {
        code: orgError?.code,
        message: orgError?.message,
        details: orgError?.details,
      })
      return fail("Business could not be created.", 400)
    }

    const typeFeatures = businessTypeFeatures[payload.business_type] || []
    const industryFeatures = categoryFeatures[payload.business_category] || []
    const featureKeys = Array.from(new Set([...typeFeatures, ...industryFeatures]))

    if (featureKeys.length) {
      const featureRows = featureKeys.map((feature_key) => ({
        organization_id: organization.id,
        feature_key,
        is_enabled: true,
      }))

      const { error } = await adminSupabase.from("organization_features").insert(featureRows)
      if (error) {
        await adminSupabase.from("organizations").delete().eq("id", organization.id)
        return fail("Business features could not be configured.", 400)
      }
    }

    const { error: memberError } = await adminSupabase.from("organization_members").insert({
      user_id: user.id,
      organization_id: organization.id,
      role: "owner",
    })

    if (memberError) {
      await adminSupabase.from("organizations").delete().eq("id", organization.id)
      return fail("Business membership could not be configured.", 400)
    }

    const { error: updateError } = await adminSupabase
      .from("profiles")
      .update({
        approved: true,
        business_created: true,
        role: "user",
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id)

    if (updateError) return fail("Business profile could not be completed.", 400)

    await writeAdminLog({
      action: "workspace.created",
      description: `Workspace created: ${organization.name}`,
      adminUserId: user.id,
      organizationId: organization.id,
      metadata: { owner_id: user.id },
    })

    return ok({ organizationId: organization.id, organization })
  } catch {
    return serverFail()
  }
}
