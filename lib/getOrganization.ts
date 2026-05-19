import { supabase } from "./supabase"

export async function getOrganizationId() {
    const {
        data: { user },
    } = await supabase.auth.getUser()

    if (!user) return null

    const { data, error } = await supabase
        .from("organization_members")
        .select("organization_id")
        .eq("user_id", user.id)
        .single()

    if (error || !data) {
        console.error(error)
        return null
    }

    return data.organization_id
}