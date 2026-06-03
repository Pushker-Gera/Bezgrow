import { z } from "zod"
import { fail, ok, serverFail } from "@/lib/api/responses"
import { writeAdminLog } from "@/lib/api/auth"
import { requireWorkspace } from "@/lib/api/tenant"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const statusSchema = z.object({
  invoice_id: z.string().uuid(),
  payment_status: z.enum(["unpaid", "partial", "paid", "overdue", "cancelled"]).optional(),
  status: z.enum(["draft", "sent", "paid", "partial", "cancelled", "void"]).optional(),
})

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)

  if (!workspace.ok) {
    return fail(workspace.error, workspace.status)
  }

  const parsed = statusSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success || (!parsed.data.payment_status && !parsed.data.status)) {
    return fail("Invalid invoice status update.", 422)
  }

  try {
    const patch: Record<string, string> = {}
    if (parsed.data.payment_status) patch.payment_status = parsed.data.payment_status
    if (parsed.data.status) patch.status = parsed.data.status

    const { error } = await adminSupabase
      .from("invoices")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", parsed.data.invoice_id)
      .eq("organization_id", workspace.context.organizationId)

    if (error) return fail("Invoice status could not be updated.", 500)

    await writeAdminLog({
      action: "invoice.status_updated",
      description: "Invoice status updated.",
      adminUserId: workspace.context.userId,
      organizationId: workspace.context.organizationId,
      metadata: parsed.data,
    })

    return ok({ invoiceId: parsed.data.invoice_id, ...patch })
  } catch {
    return serverFail()
  }
}
