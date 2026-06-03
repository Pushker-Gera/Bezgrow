import { fail } from "@/lib/api/responses"

export const dynamic = "force-dynamic"

export async function GET() {
  return fail("This public approval endpoint has been retired.", 410)
}

export async function POST() {
  return fail("Use the secure admin approval endpoint.", 410)
}
