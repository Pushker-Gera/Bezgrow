import { runAdminUserAction } from "@/lib/api/admin-user-actions"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  return runAdminUserAction(request, "approve")
}
