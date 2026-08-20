import "server-only"
import type { User } from "@supabase/supabase-js"
import { z } from "zod"
import { isConfiguredAdmin } from "@/lib/admin-role"
import {
  adminControlPlaneUnavailableMessage,
  verifyAdminControlPlaneSchema,
} from "@/lib/admin/schema-readiness"
import { checkRateLimit, rateLimitKey } from "@/lib/security/rate-limit"
import { adminSupabase } from "@/lib/supabase/admin"
import {
  PLATFORM_ADMIN_DEVICE_DENIED,
  verifyPlatformAdminDeviceRequest,
} from "@/lib/platform-admin/device-authorization"

const bearerSchema = z.string().min(20)

export type AdminContext = {
  adminUserId: string
  adminEmail: string | null
  adminRole: "admin" | "platform_admin"
  requestId: string
  ipAddress: string | null
  userAgent: string | null
  deviceId: string
  registeredDeviceId: string
}

export type AdminAuditInput = {
  action: string
  targetType?: string | null
  targetId?: string | null
  previousValues?: unknown
  newValues?: unknown
  result?: "success" | "failure"
}

export function requestId(request: Request) {
  const supplied = request.headers.get("x-request-id")?.trim()
  if (supplied && /^[a-zA-Z0-9._:-]{8,120}$/.test(supplied)) return supplied
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
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

  const origin = request.headers.get("origin")
  if (!origin) return Boolean(getBearerToken(request))

  try {
    const normalizedOrigin = new URL(origin).origin
    const requestOrigin = new URL(request.url).origin
    if (normalizedOrigin === requestOrigin) return true

    const configuredOrigins = [
      process.env.NEXT_PUBLIC_SITE_URL,
      process.env.BEZGROW_ADMIN_ORIGIN,
      "https://bezgrow.com",
      "https://www.bezgrow.com",
    ]
      .map((value) => value?.trim())
      .filter(Boolean)
      .map((value) => new URL(value as string).origin)

    if (configuredOrigins.includes(normalizedOrigin)) return true

    const desktopOrigin = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(normalizedOrigin)
    return Boolean(
      desktopOrigin &&
      getBearerToken(request) &&
      request.headers.get("x-bezgrow-desktop-admin") === "1"
    )
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
  return null
}

export async function requireAdmin(request: Request): Promise<
  | { ok: true; context: AdminContext }
  | { ok: false; status: number; error: string }
> {
  const currentRequestId = requestId(request)
  if (!getBearerToken(request)) {
    return { ok: false, status: 403, error: PLATFORM_ADMIN_DEVICE_DENIED }
  }
  if (!validateMutationOrigin(request)) {
    return { ok: false, status: 403, error: "Invalid request origin." }
  }

  if (!isSafeMethod(request.method)) {
    const limit = checkRateLimit({
      key: rateLimitKey(request, "platform-admin.mutation"),
      limit: 120,
      windowMs: 60 * 1000,
    })
    if (!limit.allowed) {
      return { ok: false, status: 429, error: "Too many admin changes. Please wait and try again." }
    }
  }

  const user = await getAuthenticatedUser(request)

  if (!user) {
    return { ok: false, status: 401, error: "Authentication required." }
  }

  const [profileResult, device] = await Promise.all([
    adminSupabase
      .from("profiles")
      .select("id, role, is_suspended")
      .eq("id", user.id)
      .maybeSingle(),
    verifyPlatformAdminDeviceRequest(request, { adminUserId: user.id }),
  ])
  const { data: profile, error: profileError } = profileResult

  const isAdmin = isConfiguredAdmin(user.email, profile?.role)

  if (profileError || !profile || !isAdmin) {
    return { ok: false, status: 403, error: "Admin access required." }
  }

  if (profile?.is_suspended) {
    return { ok: false, status: 403, error: "Admin account is suspended." }
  }

  if (!device.ok) return device

  return {
    ok: true,
    context: {
      adminUserId: user.id,
      adminEmail: user.email ?? null,
      adminRole: profile.role as "admin" | "platform_admin",
      requestId: currentRequestId,
      ipAddress:
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        request.headers.get("x-real-ip") ||
        null,
      userAgent: request.headers.get("user-agent"),
      deviceId: device.context.deviceId,
      registeredDeviceId: device.context.registeredDeviceId,
    },
  }
}

export async function requireAdminControlPlane(request: Request): Promise<
  | { ok: true; context: AdminContext }
  | { ok: false; status: number; error: string }
> {
  const auth = await requireAdmin(request)
  if (!auth.ok) return auth

  const schema = await verifyAdminControlPlaneSchema(auth.context.requestId)
  if (!schema.ready) {
    return {
      ok: false,
      status: 503,
      error: adminControlPlaneUnavailableMessage(),
    }
  }
  return auth
}

export async function writeAdminAudit(context: AdminContext, input: AdminAuditInput) {
  const payload = {
    admin_user_id: context.adminUserId,
    admin_email: context.adminEmail,
    action: input.action,
    target_type: input.targetType ?? null,
    target_id: input.targetId ?? null,
    ip_address: context.ipAddress,
    user_agent: context.userAgent,
    previous_values: input.previousValues ?? null,
    new_values: input.newValues ?? null,
    request_id: context.requestId,
    result: input.result ?? "success",
  }

  const { error } = await adminSupabase.from("admin_audit_logs").insert(payload)
  if (error) throw new Error("Admin action could not be audited.")
}

export async function writeAdminLog(input: {
  action: string
  description: string
  adminUserId: string
  organizationId?: string | null
  metadata?: Record<string, unknown>
}) {
  const { error } = await adminSupabase.from("admin_logs").insert({
    action: input.action,
    description: input.description,
    admin_user_id: input.adminUserId,
    organization_id: input.organizationId ?? null,
    metadata: input.metadata ?? {},
  })
  if (error) throw new Error("Legacy admin log could not be written.")
}
