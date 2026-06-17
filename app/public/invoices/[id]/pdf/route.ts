import { createInvoicePdf } from "@/lib/pdf-invoice"
import { buildPrintInvoice, stringFrom, type PrintRow } from "@/lib/print-invoice-builder"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

type RouteContext = {
  params: Promise<{ id: string }>
}

function safeFilename(value: string) {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "invoice"
}

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params
  const download = new URL(request.url).searchParams.get("download") === "1"

  const { data: invoiceData, error: invoiceError } = await adminSupabase
    .from("invoices")
    .select("*")
    .eq("id", id)
    .single()

  if (invoiceError || !invoiceData) {
    return new Response("Invoice not found.", { status: 404 })
  }

  const invoice = invoiceData as PrintRow

  const [{ data: itemRows }, { data: organizationData }, { data: customerData }] = await Promise.all([
    adminSupabase.from("invoice_items").select("*").eq("invoice_id", id),
    invoice.organization_id
      ? adminSupabase.from("organizations").select("*").eq("id", invoice.organization_id).single()
      : Promise.resolve({ data: null }),
    invoice.customer_id
      ? adminSupabase.from("customers").select("*").eq("id", invoice.customer_id).single()
      : Promise.resolve({ data: null }),
  ])

  const items = (itemRows || []) as PrintRow[]
  const productIds = Array.from(new Set(items.map((item) => stringFrom(item, ["product_id"])).filter(Boolean)))
  const { data: productRows } = productIds.length
    ? await adminSupabase.from("products").select("*").in("id", productIds)
    : { data: [] }

  const printInvoice = buildPrintInvoice({
    invoice,
    items,
    organization: organizationData as PrintRow | null,
    customer: customerData as PrintRow | null,
    products: (productRows || []) as PrintRow[],
    origin: process.env.NEXT_PUBLIC_SITE_URL || "https://www.bezgrow.com",
  })

  const pdf = createInvoicePdf(printInvoice)
  const filename = `${safeFilename(printInvoice.invoiceNumber)}.pdf`

  return new Response(pdf, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
      "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
