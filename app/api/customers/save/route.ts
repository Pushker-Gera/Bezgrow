import { z } from "zod"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { writeAdminLog } from "@/lib/api/auth"
import { requireWorkspace } from "@/lib/api/tenant"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const customerSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(160),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().nullable().optional().or(z.literal("")),
  address: z.string().trim().max(500).nullable().optional(),
  gst_number: z.string().trim().max(40).nullable().optional(),
  customer_type: z.string().trim().max(40).optional().default("retail"),
})

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)

  const parsed = customerSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return fail(parsed.error.issues[0]?.message || "Invalid customer.", 422)

  const payload = {
    name: parsed.data.name,
    phone: parsed.data.phone || null,
    email: parsed.data.email || null,
    address: parsed.data.address || null,
    gst_number: parsed.data.gst_number || null,
    customer_type: parsed.data.customer_type || "retail",
    updated_at: new Date().toISOString(),
  }

  try {
    if (parsed.data.id) {
      const { data, error } = await adminSupabase
        .from("customers")
        .update(payload)
        .eq("id", parsed.data.id)
        .eq("organization_id", workspace.context.organizationId)
        .select("id")
        .maybeSingle()

      if (error || !data) return fail("Customer could not be updated.", 404)

      await writeAdminLog({
        action: "customer.updated",
        description: "Customer updated.",
        adminUserId: workspace.context.userId,
        organizationId: workspace.context.organizationId,
        metadata: { customer_id: parsed.data.id },
      })

      return ok({ id: parsed.data.id })
    }

    const { data, error } = await adminSupabase
      .from("customers")
      .insert({
        ...payload,
        organization_id: workspace.context.organizationId,
        is_active: true,
        total_sales: 0,
      })
      .select("id")
      .single()

    if (error || !data) return fail("Customer could not be created.", 500)

    await writeAdminLog({
      action: "customer.created",
      description: "Customer created.",
      adminUserId: workspace.context.userId,
      organizationId: workspace.context.organizationId,
      metadata: { customer_id: data.id },
    })

    return ok({ id: data.id })
  } catch {
    return serverFail()
  }
}
