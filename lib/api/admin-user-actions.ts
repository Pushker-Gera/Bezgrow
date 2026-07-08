import "server-only"

import { z } from "zod"
import { adminSupabase } from "@/lib/supabase/admin"
import { requireAdmin, writeAdminLog } from "@/lib/api/auth"
import { fail, ok, serverFail } from "@/lib/api/responses"

const userActionSchema = z.object({
  userId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
})

type AdminUserAction = "approve" | "reject" | "suspend" | "activate"

const actionConfig: Record<
  AdminUserAction,
  { action: string; success: string; log: string }
> = {
  approve: {
    action: "USER_ACTIVATED",
    success: "User activated successfully.",
    log: "Admin activated legacy user access.",
  },
  reject: {
    action: "USER_REJECTED",
    success: "User rejected successfully.",
    log: "Admin rejected user access.",
  },
  suspend: {
    action: "USER_SUSPENDED",
    success: "User suspended successfully.",
    log: "Admin suspended user access.",
  },
  activate: {
    action: "USER_ACTIVATED",
    success: "User activated successfully.",
    log: "Admin activated user access.",
  },
}

export async function runAdminUserAction(request: Request, action: AdminUserAction) {
  const admin = await requireAdmin(request)
  if (!admin.ok) return fail(admin.error, admin.status)

  let parsed: z.infer<typeof userActionSchema>
  try {
    parsed = userActionSchema.parse(await request.json())
  } catch {
    return fail("Invalid user action request.", 400)
  }

  const now = new Date().toISOString()
  const { userId, reason } = parsed

  try {
    const { data: profile } = await adminSupabase
      .from("profiles")
      .select("id, email, business_created")
      .eq("id", userId)
      .maybeSingle()

    const { data: membership } = await adminSupabase
      .from("organization_members")
      .select("organization_id")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle()

    const { data: ownedOrganization } = await adminSupabase
      .from("organizations")
      .select("id")
      .eq("owner_id", userId)
      .limit(1)
      .maybeSingle()

    const { data: pendingUser } = await adminSupabase
      .from("pending_users")
      .select("id, email, full_name, business_name, phone")
      .eq("id", userId)
      .maybeSingle()

    if (!profile && !pendingUser) {
      return fail("User was not found.", 404)
    }

    if (action === "approve") {
      const { error } = await adminSupabase.from("profiles").upsert({
        id: userId,
        email: profile?.email ?? pendingUser?.email ?? null,
        full_name: pendingUser?.full_name ?? null,
        approved: true,
        business_created: Boolean(profile?.business_created || membership?.organization_id || ownedOrganization?.id),
        role: "user",
        is_suspended: false,
        suspended_at: null,
        suspended_by: null,
        updated_at: now,
      })
      if (error) return fail("Unable to activate user.", 400)

      await adminSupabase
        .from("pending_users")
        .update({ status: "approved", updated_at: now })
        .eq("id", userId)
    }

    if (action === "reject") {
      await adminSupabase
        .from("pending_users")
        .update({ status: "rejected", updated_at: now })
        .eq("id", userId)

      if (profile) {
        await adminSupabase
          .from("profiles")
          .update({
            approved: false,
            is_suspended: false,
            suspended_at: null,
            suspended_by: null,
            updated_at: now,
          })
          .eq("id", userId)
      }
    }

    if (action === "suspend") {
      const { error } = await adminSupabase
        .from("profiles")
        .update({
          is_suspended: true,
          suspended_at: now,
          suspended_by: admin.context.adminUserId,
          updated_at: now,
        })
        .eq("id", userId)
      if (error) return fail("Unable to suspend user.", 400)
    }

    if (action === "activate") {
      const { error } = await adminSupabase
        .from("profiles")
        .update({
          approved: true,
          is_suspended: false,
          suspended_at: null,
          suspended_by: null,
          updated_at: now,
        })
        .eq("id", userId)
      if (error) return fail("Unable to activate user.", 400)
    }

    const config = actionConfig[action]

    await writeAdminLog({
      action: config.action,
      description: config.log,
      adminUserId: admin.context.adminUserId,
      organizationId: membership?.organization_id ?? ownedOrganization?.id ?? null,
      metadata: {
        target_user_id: userId,
        target_email: profile?.email ?? pendingUser?.email ?? null,
        reason: reason ?? null,
      },
    })

    return ok({ message: config.success })
  } catch {
    return serverFail()
  }
}
