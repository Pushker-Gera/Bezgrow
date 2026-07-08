import { z } from "zod"
import { fail, ok } from "@/lib/api/responses"
import { parseLicenseInput } from "@/lib/license/codec"
import { verifyLicenseSignatureNode } from "@/lib/license/node-verify"

export const dynamic = "force-dynamic"

const verifySchema = z.object({
  license: z.unknown(),
  public_key: z.string().optional(),
})

export async function POST(request: Request) {
  const parsedBody = verifySchema.safeParse(await request.json().catch(() => null))
  if (!parsedBody.success) return fail("License verification request is invalid.", 422)

  try {
    const parsed = parseLicenseInput(parsedBody.data.license)
    const valid = verifyLicenseSignatureNode(parsed, parsedBody.data.public_key)
    if (!valid) return fail("License signature is invalid.", 422)

    return ok({
      valid: true,
      payload: parsed.payload,
      signatureText: parsed.signatureText,
    })
  } catch (error) {
    return fail(error instanceof Error ? error.message : "License verification failed.", 422)
  }
}
