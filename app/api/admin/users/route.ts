import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/api/auth"
import { fail } from "@/lib/api/responses"
import { parsePagination, paginationRange } from "@/lib/api/tenant"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const admin = await requireAdmin(request)
  if (!admin.ok) return fail(admin.error, admin.status)

  const pagination = parsePagination(request)
  const { from, to } = paginationRange(pagination)
  const { adminSupabase } = await import("@/lib/supabase/admin")

  let query = adminSupabase
    .from("profiles")
    .select("id,email,full_name,role,approved,business_created,is_suspended,suspended_at,last_login_at,created_at,updated_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to)

  if (pagination.search) {
    const term = pagination.search.replaceAll(",", " ")
    query = query.or(`email.ilike.%${term}%,full_name.ilike.%${term}%`)
  }

  const { data, error, count } = await query
  if (error) return fail("Users failed to load.", 500)

  const profileRows = data || []
  const userIds = profileRows.map((profile) => profile.id)

  const [memberResult, ownedOrganizationResult, statusResult] = await Promise.all([
    userIds.length
      ? adminSupabase
          .from("organization_members")
          .select("user_id,organization_id,role")
          .in("user_id", userIds)
      : Promise.resolve({ data: [], error: null }),
    userIds.length
      ? adminSupabase
          .from("organizations")
          .select("id,owner_id")
          .in("owner_id", userIds)
      : Promise.resolve({ data: [], error: null }),
    adminSupabase
      .from("profiles")
      .select("id,approved,is_suspended")
      .limit(10000),
  ])

  if (memberResult.error || ownedOrganizationResult.error || statusResult.error) {
    return fail("User metrics failed to load.", 500)
  }

  const memberByUser = new Map<string, { organization_id: string; role: string | null }>()
  ;(memberResult.data || []).forEach((member) => {
    if (!memberByUser.has(member.user_id) || member.role === "owner") {
      memberByUser.set(member.user_id, {
        organization_id: member.organization_id,
        role: member.role,
      })
    }
  })

  ;(ownedOrganizationResult.data || []).forEach((organization) => {
    if (organization.owner_id && organization.id && !memberByUser.has(organization.owner_id)) {
      memberByUser.set(organization.owner_id, {
        organization_id: organization.id,
        role: "owner",
      })
    }
  })

  const organizationIds = Array.from(new Set(Array.from(memberByUser.values()).map((member) => member.organization_id)))
  const organizationResult = organizationIds.length
    ? await adminSupabase
        .from("organizations")
        .select("id,name")
        .in("id", organizationIds)
    : { data: [], error: null }

  if (organizationResult.error) {
    return fail("User organizations failed to load.", 500)
  }

  const organizations = organizationResult.data || []
  const statusRows = statusResult.data || []
  const stats = {
    total: count || statusRows.length,
    approved: statusRows.filter((profile) => profile.approved === true && !profile.is_suspended).length,
    pending: statusRows.filter((profile) => profile.approved !== true && !profile.is_suspended).length,
    suspended: statusRows.filter((profile) => profile.is_suspended).length,
  }

  const enrichedProfiles = profileRows.map((profile) => {
    const membership = memberByUser.get(profile.id)
    return {
      ...profile,
      organization_id: membership?.organization_id ?? null,
      organization_member_role: membership?.role ?? null,
    }
  })

  return NextResponse.json(
    {
      success: true,
      data: enrichedProfiles,
      profiles: enrichedProfiles,
      organizations,
      stats,
      pagination: { ...pagination, total: count || 0 },
    },
    { headers: { "Cache-Control": "no-store" } }
  )
}
