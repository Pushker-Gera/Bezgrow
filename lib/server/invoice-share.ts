import "server-only"

import { createHash } from "node:crypto"
import { adminSupabase } from "@/lib/supabase/admin"

export type PublicInvoiceShare = {
  id: string
  organization_id: string
  invoice_id: string | null
  document_type: "invoice" | "report"
  title: string
  period: string | null
  invoice_number: string
  customer_name: string
  business_name: string
  filename: string
  content_type: string
  pdf_base64?: string
  expires_at: string
  revoked_at: string | null
  created_at: string
}

export function validShareToken(token: string) {
  return /^[A-Za-z0-9_-]{40,64}$/.test(token)
}

export function hashShareToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

export async function findPublicInvoiceShare(token: string, options: { includePdf?: boolean } = {}) {
  if (!validShareToken(token)) return null
  const columns = [
    "id",
    "organization_id",
    "invoice_id",
    "document_type",
    "title",
    "period",
    "invoice_number",
    "customer_name",
    "business_name",
    "filename",
    "content_type",
    "expires_at",
    "revoked_at",
    "created_at",
    ...(options.includePdf ? ["pdf_base64"] : []),
  ].join(",")
  const { data, error } = await adminSupabase
    .from("invoice_share_links")
    .select(columns)
    .eq("token_hash", hashShareToken(token))
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle()
  if (error || !data) return null
  return data as unknown as PublicInvoiceShare
}
