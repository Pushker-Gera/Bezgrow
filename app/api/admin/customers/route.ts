import "server-only"

import { z } from "zod"
import { requireAdmin, writeAdminAudit } from "@/lib/api/auth"
import {
  adminFail,
  adminOk,
  adminRange,
  controlPlaneErrorMessage,
  parseAdminListQuery,
  unexpectedAdminError,
} from "@/lib/admin/control-plane"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const updateCustomerSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(2).max(160).optional(),
  email: z.string().trim().email().max(254).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  company: z.string().trim().max(160).nullable().optional(),
  country: z.string().trim().max(80).nullable().optional(),
  account_status: z.enum(["active", "suspended", "closed"]).optional(),
  support_status: z.enum(["none", "open", "attention", "resolved"]).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context

  try {
    const list = parseAdminListQuery(request)
    const { from, to } = adminRange(list)
    let query = adminSupabase
      .from("platform_customers")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to)
    if (list.search) {
      const term = list.search.replaceAll(",", " ")
      query = query.or(`name.ilike.%${term}%,email.ilike.%${term}%,company.ilike.%${term}%,phone.ilike.%${term}%`)
    }
    if (list.status) query = query.eq("account_status", list.status)

    const result = await query
    if (result.error) {
      return adminFail(context, controlPlaneErrorMessage(result.error, "Customers failed to load."), 500)
    }

    const ids = (result.data || []).map((row) => row.id)
    const [licenses, devices, businesses, support] = await Promise.all([
      ids.length
        ? adminSupabase.from("licenses").select("platform_customer_id").in("platform_customer_id", ids)
        : Promise.resolve({ data: [], error: null }),
      ids.length
        ? adminSupabase.from("registered_devices").select("platform_customer_id").in("platform_customer_id", ids)
        : Promise.resolve({ data: [], error: null }),
      ids.length
        ? adminSupabase.from("platform_businesses").select("platform_customer_id").in("platform_customer_id", ids)
        : Promise.resolve({ data: [], error: null }),
      ids.length
        ? adminSupabase
            .from("support_cases")
            .select("platform_customer_id,status")
            .in("platform_customer_id", ids)
            .neq("status", "resolved")
        : Promise.resolve({ data: [], error: null }),
    ])
    if (licenses.error || devices.error || businesses.error || support.error) {
      return adminFail(context, "Customer totals failed to load.", 500)
    }

    const countBy = (rows: Array<{ platform_customer_id: string | null }> | null) => {
      const counts = new Map<string, number>()
      for (const row of rows || []) {
        if (row.platform_customer_id) {
          counts.set(row.platform_customer_id, (counts.get(row.platform_customer_id) || 0) + 1)
        }
      }
      return counts
    }
    const licenseCounts = countBy(licenses.data)
    const deviceCounts = countBy(devices.data)
    const businessCounts = countBy(businesses.data)
    const supportCounts = countBy(support.data)

    return adminOk(context, {
      data: (result.data || []).map((customer) => ({
        ...customer,
        license_count: licenseCounts.get(customer.id) || 0,
        device_count: deviceCounts.get(customer.id) || 0,
        business_count: businessCounts.get(customer.id) || 0,
        open_support_count: supportCounts.get(customer.id) || 0,
      })),
      pagination: { page: list.page, limit: list.limit, total: result.count || 0 },
      dataNotice: "Platform customers are separate from retail customers stored in local ERP workspaces.",
    })
  } catch (error) {
    return unexpectedAdminError(context, error, "Customers failed to load.")
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)
  const context = auth.context
  const parsed = updateCustomerSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return adminFail(context, parsed.error.issues[0]?.message || "Invalid customer change.", 422)
  }

  try {
    const { id, ...changes } = parsed.data
    const current = await adminSupabase.from("platform_customers").select("*").eq("id", id).maybeSingle()
    if (current.error) throw current.error
    if (!current.data) return adminFail(context, "Platform customer was not found.", 404)

    const result = await adminSupabase
      .from("platform_customers")
      .update({ ...changes, email: changes.email?.toLowerCase(), updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("*")
      .single()
    if (result.error) throw result.error
    await writeAdminAudit(context, {
      action: "CUSTOMER_EDITED",
      targetType: "platform_customer",
      targetId: id,
      previousValues: current.data,
      newValues: result.data,
    })
    return adminOk(context, { customer: result.data })
  } catch (error) {
    return unexpectedAdminError(context, error, "Customer change failed.")
  }
}
