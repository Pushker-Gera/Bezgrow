import { supabase } from "@/lib/supabase"

export async function getOrganizationFeatures(
    organizationId: string
) {

    const { data, error } = await supabase
        .from("organization_features")
        .select("feature_key")
        .eq("organization_id", organizationId)
        .eq("is_enabled", true)

    if (error) {
        console.error(error)
        return []
    }

    return Array.from(
        new Set(
            data
                ?.map((item) => item.feature_key)
                .filter(Boolean) || []
        )
    )
}
