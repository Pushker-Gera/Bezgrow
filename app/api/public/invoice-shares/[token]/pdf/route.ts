import { findPublicInvoiceShare } from "@/lib/server/invoice-share"

export const dynamic = "force-dynamic"

type RouteProps = {
  params: Promise<{ token: string }>
}

export async function GET(request: Request, { params }: RouteProps) {
  const { token } = await params
  const share = await findPublicInvoiceShare(token, { includePdf: true })
  if (!share?.pdf_base64) return new Response("This invoice link is invalid, expired, or revoked.", { status: 404 })
  const bytes = Buffer.from(share.pdf_base64, "base64")
  const download = new URL(request.url).searchParams.get("download") === "1"
  return new Response(bytes, {
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${share.filename.replaceAll("\"", "")}"`,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "no-referrer",
    },
  })
}
