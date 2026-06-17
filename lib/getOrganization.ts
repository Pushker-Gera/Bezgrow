import { getWorkspaceBootstrap } from "@/lib/workspaceBootstrapClient"

export async function getOrganizationId() {
    const cacheKey = "bezgrow:organization-id"
    const now = Date.now()

    if (typeof window !== "undefined") {
        try {
            const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null") as { value?: string | null; expiresAt?: number } | null
            if (cached?.expiresAt && cached.expiresAt > now && cached.value) return cached.value
        } catch {
            sessionStorage.removeItem(cacheKey)
        }
    }

    try {
        let payload = await getWorkspaceBootstrap()
        if (!payload?.success) return null

        let organizationId = payload.organization?.id || payload.membership?.organization_id || null

        if (!organizationId) {
            payload = await getWorkspaceBootstrap({ forceFresh: true })
            organizationId = payload?.organization?.id || payload?.membership?.organization_id || null
        }

        if (organizationId && typeof window !== "undefined") {
            sessionStorage.setItem(cacheKey, JSON.stringify({ value: organizationId, expiresAt: now + 120000 }))
        }

        return organizationId
    } catch {
        return null
    }
}
