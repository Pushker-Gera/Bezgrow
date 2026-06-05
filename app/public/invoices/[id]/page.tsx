import { PrintEngine } from "@/components/print/PrintEngine"
import { buildPrintInvoice, stringFrom, type PrintRow } from "@/lib/print-invoice-builder"
import { adminSupabase } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

type PageProps = {
  params: Promise<{ id: string }>
}

export default async function PublicInvoicePage({ params }: PageProps) {
  const { id } = await params

  const { data: invoiceData, error: invoiceError } = await adminSupabase
    .from("invoices")
    .select("*")
    .eq("id", id)
    .single()

  if (invoiceError || !invoiceData) {
    return <PublicInvoiceError message="Invoice not found." />
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
    origin: process.env.NEXT_PUBLIC_SITE_URL || "https://bezgrow.com",
  })

  return <PrintEngine invoice={printInvoice} publicMode />
}

function PublicInvoiceError({ message }: { message: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-black px-6 text-white">
      <div className="max-w-md rounded-[24px] border border-white/10 bg-white/5 p-8 text-center">
        <p className="text-sm font-black uppercase tracking-[0.2em] text-cyan-200">Invoice</p>
        <h1 className="mt-3 text-3xl font-black">{message}</h1>
        <p className="mt-3 text-sm text-neutral-400">Please check the invoice link or ask the business to share it again.</p>
      </div>
    </main>
  )
}
