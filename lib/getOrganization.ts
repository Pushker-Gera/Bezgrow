import { supabase } from "./supabase"

export async function getOrganizationId() {
    const {
        data: { user },
        error: userError,
    } = await supabase.auth.getUser()

    if (userError || !user) return null

    const { data, error } = await supabase
        .from("organization_members")
        .select("organization_id")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle()

    if (error || !data) {
        if (error) console.error("Organization lookup failed:", error.message)
        return null
    }

    return data.organization_id
}
