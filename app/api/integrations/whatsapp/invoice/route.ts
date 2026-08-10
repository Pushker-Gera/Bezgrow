import { NextResponse } from "next/server"
import { authenticateDeviceReport } from "@/lib/device/report-auth"
import { checkRateLimit, rateLimitKey } from "@/lib/security/rate-limit"
import {
  sendInvoiceWithWhatsAppBusiness,
  whatsappBusinessAvailability,
} from "@/lib/server/whatsapp-business"

export const dynamic = "force-dynamic"

type RequestBody = {
  action?: unknown
  license_key?: unknown
  device_id?: unknown
  business_id?: unknown
  destination?: unknown
  filename?: unknown
  message?: unknown
  pdf_base64?: unknown
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function response(error: string, status: number, requestId?: string) {
  return NextResponse.json({ success: false, error, requestId }, {
    status,
    headers: { "cache-control": "no-store" },
  })
}

export async function POST(request: Request) {
  let body: RequestBody
  try {
    body = await request.json() as RequestBody
  } catch {
    return response("The WhatsApp request body is invalid.", 400)
  }

  const action = stringValue(body.action)
  const licenseKey = stringValue(body.license_key)
  const deviceId = stringValue(body.device_id)
  const businessId = stringValue(body.business_id)
  if (!licenseKey || !deviceId || !businessId || !["status", "send"].includes(action)) {
    return response("The authenticated WhatsApp request is incomplete.", 400)
  }

  const auth = await authenticateDeviceReport(request, { licenseKey, deviceId })
  if (!auth.ok) return response(auth.error, auth.status, auth.requestId)
  if (auth.context.payload.business_id !== businessId) {
    return response("The signed licence does not match this business.", 403, auth.context.requestId)
  }

  try {
    const availability = whatsappBusinessAvailability(businessId)
    if (action === "status") {
      return NextResponse.json({
        success: true,
        configured: availability.configured,
        senderLabel: availability.configured ? availability.senderLabel : null,
        requestId: auth.context.requestId,
      }, { headers: { "cache-control": "no-store" } })
    }
    if (!availability.configured) {
      return response("Automatic WhatsApp delivery is not configured for this business.", 409, auth.context.requestId)
    }
    const sendLimit = checkRateLimit({
      key: rateLimitKey(request, `whatsapp-invoice:${businessId}:${deviceId}`),
      limit: 12,
      windowMs: 60 * 60 * 1_000,
    })
    if (!sendLimit.allowed) {
      return response("Too many invoice delivery attempts. Please try again later.", 429, auth.context.requestId)
    }

    const encoded = stringValue(body.pdf_base64)
    if (!encoded || encoded.length > 28_000_000) {
      return response("The selected invoice PDF is missing or too large.", 413, auth.context.requestId)
    }
    let pdfBytes: Uint8Array
    try {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
        throw new Error("invalid base64")
      }
      const decoded = Buffer.from(encoded, "base64")
      if (decoded.toString("base64") !== encoded) throw new Error("invalid base64")
      pdfBytes = new Uint8Array(decoded)
    } catch {
      return response("The selected invoice PDF encoding is invalid.", 400, auth.context.requestId)
    }
    const result = await sendInvoiceWithWhatsAppBusiness({
      businessId,
      destination: stringValue(body.destination),
      filename: stringValue(body.filename),
      message: stringValue(body.message),
      pdfBytes,
    })
    return NextResponse.json({
      success: true,
      messageId: result.messageId,
      senderLabel: result.senderLabel,
      requestId: auth.context.requestId,
    }, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return response(
      error instanceof Error ? error.message : "WhatsApp could not deliver the selected invoice.",
      502,
      auth.context.requestId,
    )
  }
}
