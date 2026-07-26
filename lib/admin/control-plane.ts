import "server-only"

import { NextResponse } from "next/server"
import { z } from "zod"
import type { AdminContext } from "@/lib/api/auth"
import { writeAdminAudit } from "@/lib/api/auth"
import { adminSupabase } from "@/lib/supabase/admin"

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(120).default(""),
  status: z.string().trim().max(80).default(""),
  license_status: z.string().trim().max(80).default(""),
  platform: z.enum(["", "macos", "windows"]).default(""),
  channel: z.string().trim().max(40).default(""),
  version: z.string().trim().max(40).default(""),
  cloud: z.enum(["", "local_only", "cloud_backup", "metadata_sync"]).default(""),
  sort: z.string().trim().regex(/^[a-z_]{1,80}$/).default("created_at"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  format: z.enum(["", "csv"]).default(""),
})

export type AdminListQuery = z.infer<typeof listQuerySchema>

export function parseAdminListQuery(request: Request): AdminListQuery {
  const params = new URL(request.url).searchParams
  return listQuerySchema.parse({
    page: params.get("page") || undefined,
    limit: params.get("limit") || undefined,
    search: params.get("search") || undefined,
    status: params.get("status") || undefined,
    license_status: params.get("license_status") || undefined,
    platform: params.get("platform") || undefined,
    channel: params.get("channel") || undefined,
    version: params.get("version") || undefined,
    cloud: params.get("cloud") || undefined,
    sort: params.get("sort") || undefined,
    direction: params.get("direction") || undefined,
    format: params.get("format") || undefined,
  })
}

export function adminRange(query: AdminListQuery) {
  const from = (query.page - 1) * query.limit
  return { from, to: from + query.limit - 1 }
}

export function adminSort(
  query: AdminListQuery,
  allowed: readonly string[],
  fallback: string
) {
  const column = allowed.includes(query.sort) ? query.sort : fallback
  return { column, ascending: query.direction === "asc" }
}

export function requestMeta(context: AdminContext) {
  return {
    requestId: context.requestId,
    headers: {
      "Cache-Control": "no-store",
      "X-Request-Id": context.requestId,
    },
  }
}

export function adminOk(context: AdminContext, payload: Record<string, unknown>, init?: ResponseInit) {
  const meta = requestMeta(context)
  return NextResponse.json(
    { success: true, requestId: context.requestId, ...payload },
    {
      ...init,
      headers: {
        ...meta.headers,
        ...(init?.headers || {}),
      },
    }
  )
}

export function adminFail(
  context: Pick<AdminContext, "requestId"> | { requestId: string },
  message: string,
  status: number,
  details?: Record<string, unknown>
) {
  return NextResponse.json(
    { success: false, error: message, requestId: context.requestId, ...details },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": context.requestId,
      },
    }
  )
}

export function unexpectedAdminError(
  context: Pick<AdminContext, "requestId">,
  error: unknown,
  fallback = "The platform request could not be completed."
) {
  console.error("[platform-admin]", {
    requestId: context.requestId,
    error: error instanceof Error ? error.message : String(error),
  })
  return adminFail(context, `${fallback} Request ID: ${context.requestId}`, 500)
}

export function controlPlaneSchemaIncomplete(error: { code?: string; message?: string } | null | undefined) {
  return Boolean(
    error &&
      (error.code === "42P01" ||
        error.code === "PGRST205" ||
        error.code === "42703" ||
        error.code === "42883" ||
        error.code === "PGRST202" ||
        /could not find the (?:table|function)|relation .* does not exist|column .* does not exist|function .* does not exist/i.test(
          error.message || ""
        ))
  )
}

export function controlPlaneErrorMessage(error: { code?: string; message?: string } | null | undefined, fallback: string) {
  if (controlPlaneSchemaIncomplete(error)) {
    return "The admin control plane is not ready in this Supabase project. Apply the production control-plane migration."
  }
  return fallback
}

export async function recordLicenseEvent(input: {
  context: AdminContext
  licenseId: string
  action: string
  previousValues?: unknown
  newValues?: unknown
  notes?: string | null
}) {
  const { error } = await adminSupabase.from("license_events").insert({
    license_id: input.licenseId,
    action: input.action,
    admin_user_id: input.context.adminUserId,
    admin_email: input.context.adminEmail,
    previous_values: input.previousValues ?? null,
    new_values: input.newValues ?? null,
    notes: input.notes ?? null,
    request_id: input.context.requestId,
  })
  if (error) throw new Error("License history could not be recorded.")

  await writeAdminAudit(input.context, {
    action: input.action,
    targetType: "license",
    targetId: input.licenseId,
    previousValues: input.previousValues,
    newValues: input.newValues,
  })
}

function csvCell(value: unknown) {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value)
  return `"${text.replaceAll('"', '""')}"`
}

export function csvResponse(filename: string, columns: string[], rows: Record<string, unknown>[]) {
  const body = [
    columns.map(csvCell).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n")

  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Type": "text/csv; charset=utf-8",
    },
  })
}

export function effectiveLicenseStatus(license: {
  status?: string | null
  expiry_date?: string | null
  grace_days?: number | null
}) {
  const explicit = String(license.status || "draft")
  if (["draft", "suspended", "revoked", "replaced"].includes(explicit)) return explicit

  const expiryText = license.expiry_date
  if (!expiryText) return explicit

  const now = new Date()
  const expiry = new Date(`${expiryText.slice(0, 10)}T23:59:59.999Z`)
  const graceEnd = new Date(expiry)
  graceEnd.setUTCDate(graceEnd.getUTCDate() + Number(license.grace_days || 0))
  if (now > graceEnd) return "expired"
  if (now > expiry) return "grace_period"

  const days = Math.ceil((expiry.getTime() - now.getTime()) / 86_400_000)
  return days <= 30 ? "expiring" : explicit === "trial" ? "trial" : "active"
}

export function compactRecord(value: unknown) {
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined)
  )
}
