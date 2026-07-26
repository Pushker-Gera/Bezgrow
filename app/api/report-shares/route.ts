import { randomBytes } from "node:crypto"
import { NextResponse } from "next/server"
import { z } from "zod"
import { fail } from "@/lib/api/responses"
import { requireWorkspace } from "@/lib/api/tenant"
import { adminSupabase } from "@/lib/supabase/admin"
import { hashShareToken } from "@/lib/server/invoice-share"

export const dynamic = "force-dynamic"

const createSchema = z.object({
  title: z.string().trim().min(1).max(180),
  period: z.string().trim().min(1).max(180),
  filename: z.string().trim().min(1).max(180),
  pdfBase64: z.string().min(8).max(12_000_000),
  expiresInDays: z.union([z.literal(7), z.literal(30)]).default(7),
})

const revokeSchema = z.object({ shareId: z.string().uuid() })
const buckets = new Map<string, number[]>()

function allowed(userId: string) {
  const now = Date.now()
  const recent = (buckets.get(userId) || []).filter((time) => now - time < 5 * 60_000)
  if (recent.length >= 10) return false
  buckets.set(userId, [...recent, now])
  return true
}

function origin(request: Request) {
  try {
    const configured = new URL(process.env.NEXT_PUBLIC_SITE_URL || request.url)
    if (configured.protocol === "https:" || ["localhost", "127.0.0.1"].includes(configured.hostname)) return configured.origin
  } catch {
    // The request origin below is always syntactically valid.
  }
  return new URL(request.url).origin
}

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)
  if (!allowed(workspace.context.userId)) return fail("Too many secure links were requested. Try again in a few minutes.", 429)
  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return fail("The secure report request is invalid.", 422)
  const bytes = Buffer.from(parsed.data.pdfBase64, "base64")
  if (bytes.length < 5 || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) return fail("The generated report is not a valid PDF.", 422)
  if (bytes.length > 8 * 1024 * 1024) return fail("The report PDF exceeds the 8 MB sharing limit.", 413)
  const token = randomBytes(32).toString("base64url")
  const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
  const filename = parsed.data.filename.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 180)
  const { data, error } = await adminSupabase
    .from("invoice_share_links")
    .insert({
      organization_id: workspace.context.organizationId,
      created_by: workspace.context.userId,
      document_type: "report",
      token_hash: hashShareToken(token),
      title: parsed.data.title,
      period: parsed.data.period,
      invoice_number: "REPORT",
      customer_name: "Report recipient",
      business_name: workspace.context.organizationName,
      filename: filename.toLowerCase().endsWith(".pdf") ? filename : `${filename}.pdf`,
      content_type: "application/pdf",
      pdf_base64: parsed.data.pdfBase64,
      byte_size: bytes.length,
      expires_at: expiresAt,
    })
    .select("id,expires_at,filename")
    .single()
  if (error || !data) {
    return fail(
      /invoice_share_links|schema cache|does not exist/i.test(error?.message || "")
        ? "Secure report sharing is not configured on the hosted backend. Apply the invoice-share migration first."
        : "The secure report link could not be stored.",
      503,
    )
  }
  return NextResponse.json({ id: data.id, url: `${origin(request)}/r/${token}`, expiresAt: data.expires_at, filename: data.filename })
}

export async function DELETE(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)
  const parsed = revokeSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return fail("A valid secure-link id is required.", 422)
  const { data, error } = await adminSupabase
    .from("invoice_share_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", parsed.data.shareId)
    .eq("organization_id", workspace.context.organizationId)
    .eq("document_type", "report")
    .is("revoked_at", null)
    .select("id")
    .maybeSingle()
  if (error) return fail("The secure report link could not be revoked.", 500)
  if (!data) return fail("The secure report link was not found or was already revoked.", 404)
  return NextResponse.json({ success: true })
}
