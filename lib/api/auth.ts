import "server-only"
import type { User } from "@supabase/supabase-js"
import { z } from "zod"
import { adminSupabase } from "@/lib/supabase/admin"
import { createServerSupabase } from "@/lib/supabase/server"

const bearerSchema = z.string().min(20)

export type AdminContext = {
  adminUserId: string
  adminEmail: string | null
}

export function getBearerToken(request: Request) {
  const header = request.headers.get("authorization") || ""
  const token = header.replace(/^Bearer\s+/i, "").trim()
  const parsed = bearerSchema.safeParse(token)
  return parsed.success ? parsed.data : null
}

function isSafeMethod(method: string) {
  return ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())
}

export function validateMutationOrigin(request: Request) {
  if (isSafeMethod(request.method)) return true
  if (getBearerToken(request)) return true

  const origin = request.headers.get("origin")
  if (!origin) return false

  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

export async function getAuthenticatedUser(request: Request): Promise<User | null> {
  const token = getBearerToken(request)

  if (token) {
    const { data, error } = await adminSupabase.auth.getUser(token)
    if (!error && data.user) return data.user
  }

  const supabase = await createServerSupabase()
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return null
  return data.user
}

export async function requireAdmin(request: Request): Promise<
  | { ok: true; context: AdminContext }
  | { ok: false; status: number; error: string }
> {
  if (!validateMutationOrigin(request)) {
    return { ok: false, status: 403, error: "Invalid request origin." }
  }

  const user = await getAuthenticatedUser(request)

  if (!user) {
    return { ok: false, status: 401, error: "Authentication required." }
  }

  const { data: profile, error: profileError } = await adminSupabase
    .from("profiles")
    .select("id, role, is_suspended")
    .eq("id", user.id)
    .maybeSingle()

  if (profileError || profile?.role !== "admin") {
    return { ok: false, status: 403, error: "Admin access required." }
  }

  if (profile.is_suspended) {
    return { ok: false, status: 403, error: "Admin account is suspended." }
  }

  return {
    ok: true,
    context: {
      adminUserId: user.id,
      adminEmail: user.email ?? null,
    },
  }
}

export async function writeAdminLog(input: {
  action: string
  description: string
  adminUserId: string
  organizationId?: string | null
  metadata?: Record<string, unknown>
}) {
  await adminSupabase.from("admin_logs").insert({
    action: input.action,
    description: input.description,
    admin_user_id: input.adminUserId,
    organization_id: input.organizationId ?? null,
    metadata: input.metadata ?? {},
  })
}
