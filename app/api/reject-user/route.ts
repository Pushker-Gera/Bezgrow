import { fail } from "@/lib/api/responses"

export const dynamic = "force-dynamic"

export async function GET() {
  return fail("This public rejection endpoint has been retired.", 410)
}

export async function POST() {
  return fail("Use the secure admin rejection endpoint.", 410)
}
