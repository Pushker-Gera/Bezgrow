import "server-only"

import { requireAdmin } from "@/lib/api/auth"
import { adminFail, adminOk } from "@/lib/admin/control-plane"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const auth = await requireAdmin(request)
  if (!auth.ok) return adminFail({ requestId: crypto.randomUUID() }, auth.error, auth.status)

  return adminOk(auth.context, {
    admin: {
      id: auth.context.adminUserId,
      email: auth.context.adminEmail,
      role: auth.context.adminRole,
    },
    onlineOnly: true,
  })
}
