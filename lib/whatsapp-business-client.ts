"use client"

import type { CanonicalInvoiceDocument } from "@/lib/invoice-document"
import { isTauriRuntimeAsync } from "@/lib/desktop/tauri"
import { getExplicitControlPlaneActionAuth } from "@/lib/offline/local/license"

type WhatsAppApiResponse = {
  success?: boolean
  configured?: boolean
  senderLabel?: string | null
  messageId?: string
  requestId?: string
  error?: string
}

const API_PATH = "/api/integrations/whatsapp/invoice"

function bytesToBase64(bytes: Uint8Array) {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

async function endpoint() {
  return await isTauriRuntimeAsync().catch(() => false)
    ? `/api/desktop-proxy?path=${encodeURIComponent(API_PATH)}`
    : API_PATH
}

async function whatsappRequest(
  organizationId: string,
  payload: Record<string, unknown>,
): Promise<WhatsAppApiResponse> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new Error("Internet is required only for this explicit WhatsApp delivery action.")
  }
  const auth = await getExplicitControlPlaneActionAuth(organizationId)
  const response = await fetch(await endpoint(), {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(payload.action === "send" ? 75_000 : 12_000),
    body: JSON.stringify({
      ...payload,
      license_key: auth.licenseKey,
      device_id: auth.deviceId,
      business_id: auth.businessId,
    }),
  })
  const result = await response.json().catch(() => null) as WhatsAppApiResponse | null
  if (!response.ok || !result?.success) {
    const requestReference = result?.requestId ? ` Reference: ${result.requestId}.` : ""
    throw new Error(`${result?.error || "WhatsApp delivery is unavailable."}${requestReference}`)
  }
  return result
}

export async function getWhatsAppBusinessAvailability(organizationId: string) {
  const result = await whatsappRequest(organizationId, { action: "status" })
  return {
    configured: Boolean(result.configured),
    senderLabel: result.senderLabel || "WhatsApp Business",
  }
}

export async function sendCanonicalInvoiceWithWhatsAppBusiness(input: {
  organizationId: string
  destination: string
  message: string
  artifact: CanonicalInvoiceDocument
}) {
  const result = await whatsappRequest(input.organizationId, {
    action: "send",
    destination: input.destination,
    filename: input.artifact.filename,
    message: input.message,
    pdf_base64: bytesToBase64(input.artifact.bytes),
  })
  if (!result.messageId) throw new Error("WhatsApp accepted no message identifier; delivery was not confirmed.")
  return {
    messageId: result.messageId,
    senderLabel: result.senderLabel || "WhatsApp Business",
    requestId: result.requestId || "",
  }
}
