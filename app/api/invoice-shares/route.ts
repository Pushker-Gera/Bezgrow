import { randomBytes } from "node:crypto"
import { z } from "zod"
import { NextResponse } from "next/server"
import { requireWorkspace } from "@/lib/api/tenant"
import { fail } from "@/lib/api/responses"
import { adminSupabase } from "@/lib/supabase/admin"
import { hashShareToken } from "@/lib/server/invoice-share"

export const dynamic = "force-dynamic"

const createSchema = z.object({
  invoiceId: z.string().min(1).max(160),
  invoiceNumber: z.string().trim().min(1).max(120),
  customerName: z.string().trim().min(1).max(200),
  filename: z.string().trim().min(1).max(180),
  pdfBase64: z.string().min(8).max(12_000_000),
  expiresInDays: z.union([z.literal(7), z.literal(30)]).default(7),
})

const revokeSchema = z.object({
  shareId: z.string().uuid(),
})

const rateBuckets = new Map<string, number[]>()

function allowCreate(userId: string) {
  const now = Date.now()
  const recent = (rateBuckets.get(userId) || []).filter((time) => now - time < 5 * 60_000)
  if (recent.length >= 10) return false
  recent.push(now)
  rateBuckets.set(userId, recent)
  return true
}

function safeFilename(value: string) {
  const base = value
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 170) || "Invoice.pdf"
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`
}

function publicOrigin(request: Request) {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (configured) {
    try {
      const url = new URL(configured)
      if (url.protocol === "https:" || ["localhost", "127.0.0.1"].includes(url.hostname)) return url.origin
    } catch {
      // Fall back to the hosted request origin below.
    }
  }
  return new URL(request.url).origin
}

export async function POST(request: Request) {
  const workspace = await requireWorkspace(request)
  if (!workspace.ok) return fail(workspace.error, workspace.status)
  if (!allowCreate(workspace.context.userId)) return fail("Too many secure links were requested. Try again in a few minutes.", 429)

  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return fail("The secure invoice request is invalid.", 422)
  let pdfBytes: Buffer
  try {
    pdfBytes = Buffer.from(parsed.data.pdfBase64, "base64")
  } catch {
    return fail("The invoice PDF could not be decoded.", 422)
  }
  if (pdfBytes.length < 5 || !pdfBytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    return fail("The generated invoice is not a valid PDF.", 422)
  }
  if (pdfBytes.length > 8 * 1024 * 1024) return fail("The invoice PDF exceeds the 8 MB sharing limit.", 413)

  const organizationId = workspace.context.organizationId
  const { data: invoice, error: invoiceError } = await adminSupabase
    .from("invoices")
    .select("id,organization_id,invoice_number")
    .eq("id", parsed.data.invoiceId)
    .eq("organization_id", organizationId)
    .maybeSingle()
  if (invoiceError || !invoice) return fail("The invoice was not found in this workspace.", 404)
  if (invoice.invoice_number && invoice.invoice_number !== parsed.data.invoiceNumber) {
    return fail("The invoice reference does not match the selected invoice.", 409)
  }

  const token = randomBytes(32).toString("base64url")
  const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
  const filename = safeFilename(parsed.data.filename)
  const { data, error } = await adminSupabase
    .from("invoice_share_links")
    .insert({
      organization_id: organizationId,
      invoice_id: invoice.id,
      created_by: workspace.context.userId,
      document_type: "invoice",
      title: `Invoice ${parsed.data.invoiceNumber}`,
      token_hash: hashShareToken(token),
      invoice_number: parsed.data.invoiceNumber,
      customer_name: parsed.data.customerName,
      business_name: workspace.context.organizationName,
      filename,
      content_type: "application/pdf",
      pdf_base64: parsed.data.pdfBase64,
      byte_size: pdfBytes.length,
      expires_at: expiresAt,
    })
    .select("id,expires_at,filename")
    .single()
  if (error || !data) {
    const missingTable = /invoice_share_links|schema cache|does not exist/i.test(error?.message || "")
    return fail(
      missingTable
        ? "Secure invoice sharing is not configured on the hosted backend. Apply the invoice-share migration first."
        : "The secure invoice link could not be stored.",
      503,
    )
  }
  return NextResponse.json({
    id: data.id,
    url: `${publicOrigin(request)}/i/${token}`,
    expiresAt: data.expires_at,
    filename: data.filename,
  })
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
    .is("revoked_at", null)
    .select("id")
    .maybeSingle()
  if (error) return fail("The secure invoice link could not be revoked.", 500)
  if (!data) return fail("The secure invoice link was not found or was already revoked.", 404)
  return NextResponse.json({ success: true })
}
