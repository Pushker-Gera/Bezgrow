import { supabase } from "@/lib/supabase"
import { getOfflineData } from "@/lib/offline/db"

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
        const cachedSettings = await getOfflineData<Record<string, unknown>>(organizationId, "settings", {})
        const cachedFeatures = cachedSettings.features

        if (Array.isArray(cachedFeatures)) {
            return Array.from(
                new Set(
                    cachedFeatures
                        .map((feature) => typeof feature === "string" ? feature : (feature as { feature_key?: unknown; is_enabled?: unknown }).is_enabled === false ? null : (feature as { feature_key?: unknown }).feature_key)
                        .filter((feature): feature is string => typeof feature === "string" && feature.length > 0)
                )
            )
        }

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
