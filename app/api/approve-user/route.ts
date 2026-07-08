import { fail } from "@/lib/api/responses"

export const dynamic = "force-dynamic"

export async function GET() {
  return fail("This public access endpoint has been retired. Use offline license activation.", 410)
}

export async function POST() {
  return fail("Use the admin license generator for desktop access.", 410)
}
