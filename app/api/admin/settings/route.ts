import "server-only"

import { z } from "zod"
import { requireAdminControlPlane, writeAdminAudit } from "@/lib/api/auth"
import {
  adminFail,
  adminOk,
  controlPlaneErrorMessage,
  csvResponse,
  unexpectedAdminError,
} from "@/lib/admin/control-plane"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const settingsSchema = z.object({
  platform_name: z.string().trim().min(1).max(120),
  support_email: z.string().trim().email().max(254),
  default_license_duration_days: z.coerce.number().int().min(1).max(3650),
  default_grace_days: z.coerce.number().int().min(0).max(365),
  default_allowed_features: z.array(z.string().trim().min(1).max(80)).max(100),
  license_plans: z.array(
    z.object({
      name: z.string().trim().min(1).max(80),
      features: z.array(z.string().trim().min(1).max(80)).max(100),
      maximum_users: z.number().int().min(1).max(10000),
      maximum_businesses: z.number().int().min(1).max(1000),
      maximum_branches: z.number().int().min(1).max(10000),
    })
  ).max(100),
  update_channels: z.array(z.string().trim().min(1).max(40)).min(1).max(20),
  minimum_supported_version: z.string().trim().max(40).nullable(),
  backup_policies: z.record(z.string(), z.unknown()),
  diagnostic_upload_enabled: z.boolean(),
  diagnostic_retention_days: z.coerce.number().int().min(1).max(3650),
  maintenance_message: z.string().trim().max(1000).nullable(),
  customer_download_urls: z.record(z.string(), z.string().url().or(z.literal(""))),
  mac_release_status: z.enum(["not_configured", "internal_testing", "ready", "paused"]),
  windows_release_status: z.enum(["not_configured", "internal_testing", "ready", "paused"]),
})

export async function GET(request: Request) {
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context

  try {
    const result = await adminSupabase.from("platform_settings").select("*").limit(1).maybeSingle()
    if (result.error) {
      return adminFail(context, controlPlaneErrorMessage(result.error, "Platform settings failed to load."), 500)
    }
    if (new URL(request.url).searchParams.get("format") === "csv") {
      return csvResponse(
        `bezgrow-platform-settings-${new Date().toISOString().slice(0, 10)}.csv`,
        [
          "id",
          "platform_name",
          "support_email",
          "default_license_duration_days",
          "default_grace_days",
          "default_allowed_features",
          "license_plans",
          "update_channels",
          "minimum_supported_version",
          "backup_policies",
          "diagnostic_upload_enabled",
          "diagnostic_retention_days",
          "maintenance_message",
          "customer_download_urls",
          "mac_release_status",
          "windows_release_status",
          "updated_at",
        ],
        result.data ? [result.data] : []
      )
    }
    return adminOk(context, {
      settings: result.data
        ? {
            ...result.data,
            support_email: result.data.support_email || "",
          }
        : null,
    })
  } catch (error) {
    return unexpectedAdminError(context, error, "Platform settings failed to load.")
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context
  const parsed = settingsSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return adminFail(context, parsed.error.issues[0]?.message || "Invalid platform settings.", 422)

  try {
    const current = await adminSupabase.from("platform_settings").select("*").limit(1).maybeSingle()
    if (current.error) throw current.error
    const payload = {
      ...parsed.data,
      support_email: parsed.data.support_email.toLowerCase(),
      default_allowed_features: [...new Set(parsed.data.default_allowed_features)].sort(),
      update_channels: [...new Set(parsed.data.update_channels)].sort(),
      updated_by_admin_id: context.adminUserId,
      updated_at: new Date().toISOString(),
    }
    const result = current.data?.id
      ? await adminSupabase.from("platform_settings").update(payload).eq("id", current.data.id).select("*").single()
      : await adminSupabase.from("platform_settings").insert(payload).select("*").single()
    if (result.error) throw result.error

    await writeAdminAudit(context, {
      action: "PLATFORM_SETTINGS_CHANGED",
      targetType: "platform_settings",
      targetId: result.data.id,
      previousValues: current.data,
      newValues: result.data,
    })
    return adminOk(context, { settings: result.data })
  } catch (error) {
    return unexpectedAdminError(context, error, "Platform settings could not be saved.")
  }
}
