import { supabase } from "@/lib/supabase"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { getOfflineData } from "@/lib/offline/db"
import { localLicenseSnapshot } from "@/lib/offline/local/license"

export async function getOrganizationFeatures(
    organizationId: string
) {
    const cachedSettings = await getOfflineData<Record<string, unknown>>(organizationId, "settings", {})
    const cachedFeatures = cachedSettings.features

    if (Array.isArray(cachedFeatures) && cachedFeatures.length > 0) {
        return Array.from(
            new Set(
                cachedFeatures
                    .map((feature) => typeof feature === "string" ? feature : (feature as { feature_key?: unknown; is_enabled?: unknown }).is_enabled === false ? null : (feature as { feature_key?: unknown }).feature_key)
                    .filter((feature): feature is string => typeof feature === "string" && feature.length > 0)
            )
        )
    }

    if (await isTauriRuntimeAsync().catch(() => false)) {
        const license = await localLicenseSnapshot(organizationId).catch(() => null)
        if (license?.allowed) return license.allowedFeatures
    }

    const { data, error } = await supabase
        .from("organization_features")
        .select("feature_key")
        .eq("organization_id", organizationId)
        .eq("is_enabled", true)

    if (error) {
        console.warn(error)
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
