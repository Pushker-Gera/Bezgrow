import "server-only"

type WhatsAppBusinessConfiguration = {
  phoneNumberId: string
  accessToken: string
  graphApiVersion: string
  senderLabel: string
}

type MetaResponse = {
  id?: string
  messages?: Array<{ id?: string }>
  error?: { message?: string; code?: number; error_subcode?: number }
}

const CONFIGURATION_ENV = "BEZGROW_WHATSAPP_BUSINESS_CONFIG_JSON"
const MAX_INVOICE_PDF_BYTES = 20 * 1024 * 1024

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function configuredBusinesses() {
  const raw = process.env[CONFIGURATION_ENV]
  if (!raw) return new Map<string, WhatsAppBusinessConfiguration>()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${CONFIGURATION_ENV} is not valid JSON.`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${CONFIGURATION_ENV} must be an object keyed by signed business ID.`)
  }

  const configurations = new Map<string, WhatsAppBusinessConfiguration>()
  for (const [businessId, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    const phoneNumberId = text(record.phoneNumberId || record.phone_number_id)
    const accessToken = text(record.accessToken || record.access_token)
    const graphApiVersion = text(record.graphApiVersion || record.graph_api_version)
    const senderLabel = text(record.senderLabel || record.sender_label) || "WhatsApp Business"
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(businessId)) continue
    if (!/^\d{6,32}$/.test(phoneNumberId) || !accessToken || !/^v\d+\.\d+$/.test(graphApiVersion)) continue
    configurations.set(businessId, { phoneNumberId, accessToken, graphApiVersion, senderLabel })
  }
  return configurations
}

export function whatsappBusinessAvailability(businessId: string) {
  const configuration = configuredBusinesses().get(businessId)
  return configuration
    ? { configured: true as const, senderLabel: configuration.senderLabel }
    : { configured: false as const }
}

function configurationFor(businessId: string) {
  const configuration = configuredBusinesses().get(businessId)
  if (!configuration) {
    throw new Error("Automatic WhatsApp delivery is not configured for this business.")
  }
  return configuration
}

function metaError(result: MetaResponse | null, fallback: string) {
  const message = text(result?.error?.message)
  return message ? `${fallback}: ${message}` : fallback
}

async function metaJson(response: Response) {
  return await response.json().catch(() => null) as MetaResponse | null
}

export async function sendInvoiceWithWhatsAppBusiness(input: {
  businessId: string
  destination: string
  filename: string
  message: string
  pdfBytes: Uint8Array
}) {
  const configuration = configurationFor(input.businessId)
  if (!/^[1-9]\d{7,14}$/.test(input.destination)) {
    throw new Error("The WhatsApp destination must be a valid international phone number.")
  }
  if (input.pdfBytes.byteLength < 1_500 || input.pdfBytes.byteLength > MAX_INVOICE_PDF_BYTES) {
    throw new Error("The selected invoice PDF is empty or exceeds the 20 MB delivery limit.")
  }
  if (new TextDecoder().decode(input.pdfBytes.slice(0, 5)) !== "%PDF-") {
    throw new Error("The selected invoice attachment is not a valid PDF.")
  }
  const tail = input.pdfBytes.slice(Math.max(0, input.pdfBytes.byteLength - 2_048))
  if (!new TextDecoder().decode(tail).includes("%%EOF")) {
    throw new Error("The selected invoice PDF is incomplete.")
  }
  const filename = input.filename.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "Invoice.pdf"
  const safeFilename = filename.toLowerCase().endsWith(".pdf") ? filename : `${filename}.pdf`
  const caption = input.message.trim()
  if (!caption || caption.length > 1_024) {
    throw new Error("The WhatsApp invoice message must contain between 1 and 1,024 characters.")
  }

  const baseUrl = `https://graph.facebook.com/${configuration.graphApiVersion}`
  const authorization = `Bearer ${configuration.accessToken}`
  const upload = new FormData()
  upload.set("messaging_product", "whatsapp")
  upload.set("file", new Blob([input.pdfBytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }), safeFilename)
  const uploadResponse = await fetch(`${baseUrl}/${configuration.phoneNumberId}/media`, {
    method: "POST",
    headers: { authorization },
    body: upload,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  })
  const uploadResult = await metaJson(uploadResponse)
  const mediaId = text(uploadResult?.id)
  if (!uploadResponse.ok || !mediaId) {
    throw new Error(metaError(uploadResult, "WhatsApp rejected the invoice PDF upload"))
  }

  const sendResponse = await fetch(`${baseUrl}/${configuration.phoneNumberId}/messages`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.destination,
      type: "document",
      document: { id: mediaId, caption, filename: safeFilename },
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  })
  const sendResult = await metaJson(sendResponse)
  const messageId = text(sendResult?.messages?.[0]?.id)
  if (!sendResponse.ok || !messageId) {
    throw new Error(metaError(sendResult, "WhatsApp did not accept the invoice message"))
  }
  return { messageId, mediaId, senderLabel: configuration.senderLabel }
}
