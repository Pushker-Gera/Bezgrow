import { supabase } from "./supabase"

type WorkspaceBootstrapResponse = {
    success: boolean
    organization?: {
        id?: string | null
    } | null
}

export async function getOrganizationId() {
    const cacheKey = "bezgrow:organization-id"
    const now = Date.now()

    if (typeof window !== "undefined") {
        try {
            const cached = JSON.parse(sessionStorage.getItem(cacheKey) || "null") as { value?: string | null; expiresAt?: number } | null
            if (cached?.expiresAt && cached.expiresAt > now) return cached.value || null
        } catch {
            sessionStorage.removeItem(cacheKey)
        }
    }

    const {
        data: { session },
    } = await supabase.auth.getSession()

    const headers: HeadersInit = session?.access_token
        ? { Authorization: `Bearer ${session.access_token}` }
        : {}

    try {
        const response = await fetch("/api/workspace/bootstrap", {
            headers,
            cache: "no-store",
            credentials: "include",
        })

        if (!response.ok) return null

        const payload = (await response.json()) as WorkspaceBootstrapResponse
        if (!payload.success) return null

        const organizationId = payload.organization?.id || null

        if (typeof window !== "undefined") {
            sessionStorage.setItem(cacheKey, JSON.stringify({ value: organizationId, expiresAt: now + 120000 }))
        }

        return organizationId
    } catch {
        return null
    }
}
