import "server-only"
import { z } from "zod"
import { adminSupabase } from "@/lib/supabase/admin"
import { getAuthenticatedUser, validateMutationOrigin } from "@/lib/api/auth"

export type WorkspaceContext = {
  userId: string
  email: string | null
  organizationId: string
  organizationName: string
  memberRole: string
  profileRole: string
  currency: string
  timezone: string
  locale: string
  features: string[]
}

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).optional().default(""),
  sort: z.string().trim().max(60).optional().default("created_at"),
  direction: z.enum(["asc", "desc"]).optional().default("desc"),
})

export type PaginationParams = z.infer<typeof paginationSchema>

export function parsePagination(request: Request) {
  const url = new URL(request.url)
  return paginationSchema.parse({
    page: url.searchParams.get("page") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
    sort: url.searchParams.get("sort") ?? undefined,
    direction: url.searchParams.get("direction") ?? undefined,
  })
}

export function paginationRange(input: PaginationParams) {
  const from = (input.page - 1) * input.limit
  return { from, to: from + input.limit - 1 }
}

export async function requireWorkspace(request: Request): Promise<
  | { ok: true; context: WorkspaceContext }
  | { ok: false; status: number; error: string }
> {
  if (!validateMutationOrigin(request)) {
    return { ok: false, status: 403, error: "Invalid request origin." }
  }

  const user = await getAuthenticatedUser(request)

  if (!user) {
    return { ok: false, status: 401, error: "Authentication required." }
  }

  const userId = user.id
  const requestedOrganizationId = new URL(request.url).searchParams.get("organization_id")

  const { data: profile, error: profileError } = await adminSupabase
    .from("profiles")
    .select("id, role, approved, business_created, is_suspended")
    .eq("id", userId)
    .maybeSingle()

  if (profileError || !profile) {
    return { ok: false, status: 403, error: "Profile is not ready." }
  }

  if (profile.is_suspended) {
    return { ok: false, status: 403, error: "This account is suspended." }
  }

  if (profile.approved === false) {
    return { ok: false, status: 403, error: "Account approval is pending." }
  }

  let membershipQuery = adminSupabase
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", userId)

  if (requestedOrganizationId) {
    membershipQuery = membershipQuery.eq("organization_id", requestedOrganizationId)
  }

  const { data: membership, error: membershipError } = await membershipQuery.limit(1).maybeSingle()

  let workspaceOrganizationId = membership?.organization_id || null
  let workspaceRole = membership?.role || "member"

  if (membershipError) {
    return { ok: false, status: 403, error: "No workspace is connected to this account." }
  }

  if (!workspaceOrganizationId) {
    let ownedOrganizationQuery = adminSupabase
      .from("organizations")
      .select("id")
      .eq("owner_id", userId)
      .order("created_at", { ascending: true })
      .limit(1)

    if (requestedOrganizationId) {
      ownedOrganizationQuery = ownedOrganizationQuery.eq("id", requestedOrganizationId)
    }

    const { data: ownedOrganization } = await ownedOrganizationQuery.maybeSingle()

    if (ownedOrganization?.id) {
      workspaceOrganizationId = ownedOrganization.id
      workspaceRole = "owner"

      await adminSupabase
        .from("organization_members")
        .upsert(
          {
            user_id: userId,
            organization_id: workspaceOrganizationId,
            role: "owner",
          },
          { onConflict: "user_id,organization_id", ignoreDuplicates: true }
        )

      if (profile.business_created === false) {
        await adminSupabase
          .from("profiles")
          .update({ business_created: true, updated_at: new Date().toISOString() })
          .eq("id", userId)
      }
    }
  }

  if (!workspaceOrganizationId) {
    if (profile.business_created === false && profile.role !== "admin") {
      return { ok: false, status: 403, error: "Business setup is required." }
    }

    return { ok: false, status: 403, error: "No workspace is connected to this account." }
  }

  const { data: organization, error: organizationError } = await adminSupabase
    .from("organizations")
    .select("id, name, currency, timezone, locale")
    .eq("id", workspaceOrganizationId)
    .maybeSingle()

  if (organizationError || !organization) {
    return { ok: false, status: 403, error: "Workspace was not found." }
  }

  const { data: featureRows } = await adminSupabase
    .from("organization_features")
    .select("feature_key")
    .eq("organization_id", workspaceOrganizationId)
    .eq("is_enabled", true)

  return {
    ok: true,
    context: {
      userId,
      email: user.email ?? null,
      organizationId: workspaceOrganizationId,
      organizationName: organization.name || "Business",
      memberRole: workspaceRole,
      profileRole: profile.role || "user",
      currency: organization.currency || "INR",
      timezone: organization.timezone || "Asia/Kolkata",
      locale: organization.locale || "en-IN",
      features: Array.from(new Set((featureRows || []).map((row) => row.feature_key).filter(Boolean))),
    },
  }
}
