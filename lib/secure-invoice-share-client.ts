"use client"

import { authHeaders } from "@/lib/api/client-fetch"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { readCachedDesktopSession } from "@/lib/desktop/session"

export type SecureInvoiceShareRequest = {
  organizationId: string
  invoiceId: string
  invoiceNumber: string
  customerName: string
  filename: string
  pdfBytes: Uint8Array
  expiresInDays?: 7 | 30
}

export type SecureInvoiceShareResult = {
  id: string
  url: string
  expiresAt: string
  filename: string
}

export class InvoiceShareOfflineError extends Error {
  constructor() {
    super("Internet is required to create a mobile invoice link.")
    this.name = "InvoiceShareOfflineError"
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function onlineApiOrigin() {
  const configured = process.env.NEXT_PUBLIC_DESKTOP_API_ORIGIN?.trim() || process.env.NEXT_PUBLIC_SITE_URL?.trim() || ""
  if (!configured) return ""
  try {
    const url = new URL(configured)
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) return ""
    return url.origin
  } catch {
    return ""
  }
}

async function onlineActionRequest(path: string, init: RequestInit) {
  if (typeof navigator !== "undefined" && !navigator.onLine) throw new InvoiceShareOfflineError()
  const desktop = await isTauriRuntimeAsync()
  const origin = desktop ? onlineApiOrigin() : ""
  if (desktop && !origin) {
    throw new Error("Secure invoice sharing is not configured. Set NEXT_PUBLIC_DESKTOP_API_ORIGIN to the hosted Bezgrow API.")
  }
  const headers = new Headers(init.headers)
  if (desktop) {
    const session = await readCachedDesktopSession()
    if (!session?.access_token) throw new Error("Sign in while online before creating a secure invoice link.")
    headers.set("Authorization", `Bearer ${session.access_token}`)
  } else {
    const authenticated = await authHeaders(headers)
    authenticated.forEach((value, key) => headers.set(key, value))
  }
  try {
    return await fetch(`${origin}${path}`, { ...init, headers, cache: "no-store" })
  } catch (error) {
    if (typeof navigator !== "undefined" && !navigator.onLine) throw new InvoiceShareOfflineError()
    throw new Error(error instanceof Error ? `The secure invoice service could not be reached: ${error.message}` : "The secure invoice service could not be reached.")
  }
}

export async function createSecureInvoiceShare(input: SecureInvoiceShareRequest): Promise<SecureInvoiceShareResult> {
  if (input.pdfBytes.length < 5 || new TextDecoder().decode(input.pdfBytes.slice(0, 5)) !== "%PDF-") {
    throw new Error("The generated invoice PDF is invalid and was not uploaded.")
  }
  if (input.pdfBytes.length > 8 * 1024 * 1024) {
    throw new Error("The generated invoice PDF is larger than the 8 MB secure-sharing limit.")
  }
  const query = new URLSearchParams({ organization_id: input.organizationId })
  const response = await onlineActionRequest(`/api/invoice-shares?${query.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      invoiceId: input.invoiceId,
      invoiceNumber: input.invoiceNumber,
      customerName: input.customerName,
      filename: input.filename,
      pdfBase64: bytesToBase64(input.pdfBytes),
      expiresInDays: input.expiresInDays || 7,
    }),
  })
  const payload = (await response.json().catch(() => null)) as (SecureInvoiceShareResult & { error?: string }) | null
  if (!response.ok || !payload?.url) {
    throw new Error(payload?.error || `Secure invoice link creation failed (${response.status}).`)
  }
  return payload
}

export async function revokeSecureInvoiceShare(organizationId: string, shareId: string) {
  const query = new URLSearchParams({ organization_id: organizationId })
  const response = await onlineActionRequest(`/api/invoice-shares?${query.toString()}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shareId }),
  })
  const payload = (await response.json().catch(() => null)) as { success?: boolean; error?: string } | null
  if (!response.ok || !payload?.success) throw new Error(payload?.error || "The secure invoice link could not be revoked.")
}

export async function createSecureReportShare(input: {
  organizationId: string
  title: string
  period: string
  filename: string
  pdfBytes: Uint8Array
  expiresInDays?: 7 | 30
}): Promise<SecureInvoiceShareResult> {
  if (input.pdfBytes.length < 5 || new TextDecoder().decode(input.pdfBytes.slice(0, 5)) !== "%PDF-") {
    throw new Error("The generated report PDF is invalid and was not uploaded.")
  }
  if (input.pdfBytes.length > 8 * 1024 * 1024) throw new Error("The report PDF exceeds the 8 MB secure-sharing limit.")
  const query = new URLSearchParams({ organization_id: input.organizationId })
  const response = await onlineActionRequest(`/api/report-shares?${query.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: input.title,
      period: input.period,
      filename: input.filename,
      pdfBase64: bytesToBase64(input.pdfBytes),
      expiresInDays: input.expiresInDays || 7,
    }),
  })
  const payload = (await response.json().catch(() => null)) as (SecureInvoiceShareResult & { error?: string }) | null
  if (!response.ok || !payload?.url) throw new Error(payload?.error || `Secure report link creation failed (${response.status}).`)
  return payload
}

export async function revokeSecureReportShare(organizationId: string, shareId: string) {
  const query = new URLSearchParams({ organization_id: organizationId })
  const response = await onlineActionRequest(`/api/report-shares?${query.toString()}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shareId }),
  })
  const payload = (await response.json().catch(() => null)) as { success?: boolean; error?: string } | null
  if (!response.ok || !payload?.success) throw new Error(payload?.error || "The secure report link could not be revoked.")
}
