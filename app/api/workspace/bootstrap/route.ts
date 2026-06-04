import { adminSupabase } from "@/lib/supabase/admin"
import { getAuthenticatedUser } from "@/lib/api/auth"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { isConfiguredAdmin } from "@/lib/admin-role"

export const dynamic = "force-dynamic"

type OrganizationPayload = {
  id: string
  name: string | null
  currency: string | null
  timezone: string | null
  locale: string | null
  business_type: string | null
  business_category: string | null
}

type FeaturePayload = {
  feature_key: string
}

export async function GET(request: Request) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return fail("Authentication required.", 401)

    const { data: profile, error: profileError } = await adminSupabase
      .from("profiles")
      .select("id, email, role, approved, business_created, is_suspended")
      .eq("id", user.id)
      .maybeSingle()

    if (profileError || !profile) {
      if (!isConfiguredAdmin(user.email, null)) return fail("Profile not found.", 404)
    }

    const { data: membershipRow } = await adminSupabase
      .from("organization_members")
      .select("organization_id, role")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle()

    let organization: OrganizationPayload | null = null
    let membershipRole = membershipRow?.role || null

    if (membershipRow?.organization_id) {
      const { data } = await adminSupabase
        .from("organizations")
        .select("id, name, currency, timezone, locale, business_type, business_category")
        .eq("id", membershipRow.organization_id)
        .maybeSingle()

      organization = data as OrganizationPayload | null
    }

    if (!organization) {
      const { data } = await adminSupabase
        .from("organizations")
        .select("id, name, currency, timezone, locale, business_type, business_category")
        .eq("owner_id", user.id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle()

      organization = data as OrganizationPayload | null
      if (organization) membershipRole ||= "owner"
    }

    const isAdmin = isConfiguredAdmin(user.email ?? profile?.email, profile?.role)
    const organizationId = organization?.id || null
    const hasCompletedBusiness = isAdmin || Boolean(profile?.business_created || organizationId)

    if (organizationId && profile && profile.business_created === false) {
      await adminSupabase
        .from("profiles")
        .update({ business_created: true, updated_at: new Date().toISOString() })
        .eq("id", user.id)
    }

    const [{ data: features }, { data: settings }] = await Promise.all([
      organizationId
        ? adminSupabase
            .from("organization_features")
            .select("feature_key")
            .eq("organization_id", organizationId)
            .eq("is_enabled", true)
        : Promise.resolve({ data: [] }),
      adminSupabase
        .from("platform_settings")
        .select("platform_name, support_email, maintenance_mode")
        .limit(1)
        .maybeSingle(),
    ])

    const currency = organization?.currency || "INR"
    const timezone = organization?.timezone || "Asia/Kolkata"
    const locale = organization?.locale || "en-IN"

    return ok({
      user: {
        id: user.id,
        email: user.email ?? profile?.email ?? null,
      },
      profile: {
        id: profile?.id ?? user.id,
        role: isAdmin ? "admin" : profile?.role || "user",
        approved: isAdmin || Boolean(profile?.approved),
        is_suspended: Boolean(profile?.is_suspended),
        business_created: hasCompletedBusiness,
      },
      organization,
      membership: organization
        ? { organization_id: organization.id, role: membershipRole || (isAdmin ? "admin" : "member") }
        : null,
      features: ((features || []) as FeaturePayload[]).map((feature) => feature.feature_key),
      platform: settings || {
        platform_name: "Bezgrow",
        support_email: null,
        maintenance_mode: false,
      },
      currency,
      timezone,
      locale,
      permissions: {
        admin: isAdmin,
        canAccessDashboard: Boolean((isAdmin || profile?.approved) && hasCompletedBusiness && !profile?.is_suspended),
        canManageBilling: isAdmin || Boolean(profile?.approved && !profile.is_suspended),
      },
    })
  } catch {
    return serverFail()
  }
}
