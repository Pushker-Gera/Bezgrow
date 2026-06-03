import { supabase } from "./supabase"

type WorkspaceBootstrapResponse = {
    success: boolean
    organization?: {
        id?: string | null
    } | null
}

export async function getOrganizationId() {
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

        return payload.organization?.id || null
    } catch {
        return null
    }
}
