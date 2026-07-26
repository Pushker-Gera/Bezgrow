import "server-only"

import { z } from "zod"
import { requireAdminControlPlane, writeAdminAudit } from "@/lib/api/auth"
import {
  adminFail,
  adminOk,
  adminRange,
  adminSort,
  controlPlaneErrorMessage,
  csvResponse,
  parseAdminListQuery,
  unexpectedAdminError,
} from "@/lib/admin/control-plane"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const createCaseSchema = z.object({
  subject: z.string().trim().min(3).max(240),
  description: z.string().trim().max(5000).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  platform_customer_id: z.string().uuid().nullable().optional(),
  registered_device_id: z.string().uuid().nullable().optional(),
  license_id: z.string().trim().max(160).nullable().optional(),
  private_admin_notes: z.string().trim().max(5000).optional(),
})

const updateCaseSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(["mark_in_progress", "resolve", "add_notes", "request_diagnostics"]),
  private_admin_notes: z.string().trim().max(5000).optional(),
})

function caseNumber() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "")
  return `BZ-${date}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
}

export async function GET(request: Request) {
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context

  try {
    const list = parseAdminListQuery(request)
    const { from, to } = adminRange(list)
    const exportMode = list.format === "csv"
    const sort = adminSort(
      list,
      ["updated_at", "created_at", "case_number", "status", "priority", "resolved_at"],
      "updated_at"
    )
    let query = adminSupabase
      .from("support_cases")
      .select("*,diagnostic_uploads(*)", { count: "exact" })
      .order(sort.column, { ascending: sort.ascending })
    if (list.search) {
      const term = list.search.replaceAll(",", " ")
      query = query.or(`case_number.ilike.%${term}%,subject.ilike.%${term}%,description.ilike.%${term}%`)
    }
    if (list.status) query = query.eq("status", list.status)
    query = exportMode ? query.limit(10000) : query.range(from, to)
    const result = await query
    if (result.error) {
      return adminFail(context, controlPlaneErrorMessage(result.error, "Support cases failed to load."), 500)
    }

    if (exportMode) {
      return csvResponse(
        `bezgrow-support-cases-${new Date().toISOString().slice(0, 10)}.csv`,
        [
          "id",
          "case_number",
          "subject",
          "description",
          "status",
          "priority",
          "platform_customer_id",
          "registered_device_id",
          "license_id",
          "diagnostic_requested_at",
          "assigned_admin_id",
          "resolved_at",
          "created_at",
          "updated_at",
        ],
        result.data || []
      )
    }

    return adminOk(context, {
      data: result.data || [],
      pagination: { page: list.page, limit: list.limit, total: result.count || 0 },
      diagnosticPrivacy:
        "Diagnostics are voluntary and sanitized. Passwords, private keys, tokens, and local invoice/customer data are not accepted.",
    })
  } catch (error) {
    return unexpectedAdminError(context, error, "Support cases failed to load.")
  }
}

export async function POST(request: Request) {
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context
  const parsed = createCaseSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return adminFail(context, parsed.error.issues[0]?.message || "Invalid support case.", 422)

  try {
    const result = await adminSupabase
      .from("support_cases")
      .insert({
        ...parsed.data,
        case_number: caseNumber(),
        assigned_admin_id: context.adminUserId,
      })
      .select("*")
      .single()
    if (result.error) throw result.error
    await writeAdminAudit(context, {
      action: "SUPPORT_CASE_CREATED",
      targetType: "support_case",
      targetId: result.data.id,
      newValues: result.data,
    })
    return adminOk(context, { supportCase: result.data }, { status: 201 })
  } catch (error) {
    return unexpectedAdminError(context, error, "Support case could not be created.")
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAdminControlPlane(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context
  const parsed = updateCaseSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return adminFail(context, parsed.error.issues[0]?.message || "Invalid support change.", 422)

  try {
    const input = parsed.data
    const current = await adminSupabase.from("support_cases").select("*").eq("id", input.id).maybeSingle()
    if (current.error) throw current.error
    if (!current.data) return adminFail(context, "Support case was not found.", 404)

    if (input.action === "request_diagnostics") {
      if (!current.data.registered_device_id) {
        return adminFail(context, "Link a device before requesting diagnostics.", 422)
      }
      const requestedAt = new Date().toISOString()
      const requestResult = await adminSupabase
        .from("support_cases")
        .update({ diagnostic_requested_at: requestedAt, updated_at: requestedAt })
        .eq("id", input.id)
      if (requestResult.error) throw requestResult.error
      const deviceRequest = await adminSupabase
        .from("registered_devices")
        .update({ diagnostic_requested_at: requestedAt, updated_at: requestedAt })
        .eq("id", current.data.registered_device_id)
      if (deviceRequest.error) throw deviceRequest.error
      await writeAdminAudit(context, {
        action: "DIAGNOSTICS_REQUESTED",
        targetType: "support_case",
        targetId: input.id,
        previousValues: current.data,
        newValues: { diagnostic_requested: true },
      })
      return adminOk(context, { supportCase: current.data })
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (input.action === "mark_in_progress") updates.status = "in_progress"
    if (input.action === "resolve") {
      updates.status = "resolved"
      updates.resolved_at = new Date().toISOString()
    }
    if (input.action === "add_notes") {
      if (!input.private_admin_notes) return adminFail(context, "Private notes are required.", 422)
      updates.private_admin_notes = [
        current.data.private_admin_notes,
        `[${new Date().toISOString()} · ${context.adminEmail || context.adminUserId}] ${input.private_admin_notes}`,
      ].filter(Boolean).join("\n")
    }
    const result = await adminSupabase.from("support_cases").update(updates).eq("id", input.id).select("*").single()
    if (result.error) throw result.error
    await writeAdminAudit(context, {
      action: "SUPPORT_CASE_UPDATED",
      targetType: "support_case",
      targetId: input.id,
      previousValues: current.data,
      newValues: result.data,
    })
    return adminOk(context, { supportCase: result.data })
  } catch (error) {
    return unexpectedAdminError(context, error, "Support case change failed.")
  }
}
