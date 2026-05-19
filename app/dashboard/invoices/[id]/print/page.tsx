"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams } from "next/navigation"
import { supabase } from "@/lib/supabase"

type InvoicePrintRow = Record<string, unknown> & {
  id: string
  invoice_number: string
  created_at: string
  organization_id?: string | null
  customer_id?: string | null
}

type InvoicePrintItem = {
  id: string
  product_id?: string | null
  quantity: number
  unit_price: number
  tax_percent?: number | null
  line_total?: number | null
  gst_amount?: number | null
  discount_percent?: number | null
  product_name?: string | null
}

type OrgRow = Record<string, unknown> & {
  id: string
}

type CustomerRow = Record<string, unknown> & {
  id: string
}

type ProductRow = {
  id: string
  name: string | null
}

type BillLayout = "a4" | "compact" | "thermal"

function stringFrom(row: Record<string, unknown> | null, fields: string[]) {
  if (!row) return ""
  for (const field of fields) {
    const value = row[field]
    if (typeof value === "string" && value.trim()) return value
  }
  return ""
}

function numberFrom(row: Record<string, unknown> | null, fields: string[]) {
  if (!row) return 0
  for (const field of fields) {
    const value = row[field]
    if (value !== null && value !== undefined && value !== "") return Number(value || 0)
  }
  return 0
}

function currencySymbol(currency: string) {
  if (currency === "USD") return "$"
  if (currency === "EUR") return "€"
  if (currency === "GBP") return "£"
  return "₹"
}

function dateText(value: string | null | undefined) {
  if (!value) return "-"
  return new Date(value).toLocaleDateString()
}

export default function PrintInvoicePage() {
  const params = useParams()
  const invoiceId = Array.isArray(params.id) ? params.id[0] : params.id

  const [invoice, setInvoice] = useState<InvoicePrintRow | null>(null)
  const [items, setItems] = useState<InvoicePrintItem[]>([])
  const [organization, setOrganization] = useState<OrgRow | null>(null)
  const [customer, setCustomer] = useState<CustomerRow | null>(null)
  const [products, setProducts] = useState<ProductRow[]>([])
  const [loading, setLoading] = useState(true)
  const [billLayout, setBillLayout] = useState<BillLayout>("a4")
  const [showTaxBreakdown, setShowTaxBreakdown] = useState(true)
  const [showSignature, setShowSignature] = useState(true)

  const fetchInvoice = useCallback(async () => {
    if (!invoiceId) {
      setLoading(false)
      return
    }

    const { data: invoiceData } = await supabase
      .from("invoices")
      .select("*")
      .eq("id", invoiceId)
      .single()

    const { data: itemsData } = await supabase
      .from("invoice_items")
      .select("id,product_id,quantity,unit_price,tax_percent,line_total,gst_amount,discount_percent,product_name")
      .eq("invoice_id", invoiceId)

    if (invoiceData) {
      const typedInvoice = invoiceData as InvoicePrintRow
      setInvoice(typedInvoice)

      if (typedInvoice.organization_id) {
        const { data: orgData } = await supabase
          .from("organizations")
          .select("*")
          .eq("id", typedInvoice.organization_id)
          .single()
        if (orgData) setOrganization(orgData as OrgRow)
      }

      if (typedInvoice.customer_id) {
        const { data: customerData } = await supabase
          .from("customers")
          .select("*")
          .eq("id", typedInvoice.customer_id)
          .single()
        if (customerData) setCustomer(customerData as CustomerRow)
      }
    }

    if (itemsData) {
      const typedItems = itemsData as InvoicePrintItem[]
      setItems(typedItems)

      const productIds = Array.from(new Set(typedItems.map((item) => item.product_id).filter(Boolean))) as string[]
      if (productIds.length) {
        const { data: productData } = await supabase
          .from("products")
          .select("id,name")
          .in("id", productIds)
        if (productData) setProducts(productData as ProductRow[])
      }
    }
    setLoading(false)
  }, [invoiceId])

  useEffect(() => {
    queueMicrotask(() => {
      void fetchInvoice()
    })
  }, [fetchInvoice])

  const totals = useMemo(() => {
    const subtotal = items.reduce((sum, item) => {
      const base = Number(item.quantity || 0) * Number(item.unit_price || 0)
      const discount = (base * Number(item.discount_percent || 0)) / 100
      return sum + base - discount
    }, 0)
    const tax = items.reduce((sum, item) => sum + Number(item.gst_amount || 0), 0)
    const discount = items.reduce((sum, item) => {
      const base = Number(item.quantity || 0) * Number(item.unit_price || 0)
      return sum + (base * Number(item.discount_percent || 0)) / 100
    }, 0)
    return {
      subtotal,
      discount,
      tax,
      grandTotal: numberFrom(invoice, ["total_amount", "grand_total", "total"]) || subtotal + tax,
    }
  }, [invoice, items])

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-white">
        <div className="flex items-center gap-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-600 border-t-white" />
          <p className="text-lg">Preparing global invoice layout...</p>
        </div>
      </div>
    )
  }

  if (!invoice) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-black text-white">
        Invoice not found.
      </div>
    )
  }

  const currency = stringFrom(organization, ["currency"]) || "INR"
  const symbol = currencySymbol(currency)
  const businessName = stringFrom(organization, ["name", "business_name"]) || "Bezgrow ERP"
  const businessIndustry = stringFrom(organization, ["industry", "business_category"]) || "Global Business"
  const customerName = stringFrom(customer, ["name"]) || stringFrom(invoice, ["customer_name"]) || "Walk-in customer"
  const customerPhone = stringFrom(customer, ["phone"]) || "-"
  const customerEmail = stringFrom(customer, ["email"]) || "-"
  const customerGst = stringFrom(customer, ["gst_number"]) || "-"
  const productMap = new Map(products.map((product) => [product.id, product.name || "Product"]))
  const invoiceType = stringFrom(invoice, ["invoice_type"])
  const isNoGst = invoiceType === "no_gst" || totals.tax === 0
  const previewWidth = billLayout === "thermal" ? "w-[360px]" : billLayout === "compact" ? "w-[680px]" : "w-[820px]"
  const sheetPadding = billLayout === "thermal" ? "p-4" : "p-6"

  return (
    <>
      <style jsx global>{`
        @page {
          size: A4;
          margin: 8mm;
        }

        @media print {
          html,
          body {
            width: 210mm !important;
            height: 297mm !important;
            overflow: hidden !important;
            background: white !important;
          }
          body * {
            visibility: hidden !important;
          }
          .print-sheet,
          .print-sheet * {
            visibility: visible !important;
          }
          .print-sheet {
            position: fixed !important;
            left: 50% !important;
            top: 50% !important;
            width: 186mm !important;
            max-height: 277mm !important;
            overflow: hidden !important;
            transform: translate(-50%, -50%) scale(0.98) !important;
            transform-origin: center center !important;
            box-shadow: none !important;
            border: 0 !important;
            border-radius: 0 !important;
            page-break-after: avoid !important;
            break-after: avoid !important;
          }
          .print-sheet[data-layout="compact"] {
            width: 150mm !important;
            max-height: 277mm !important;
            transform: translate(-50%, -50%) scale(1) !important;
          }
          .print-sheet[data-layout="thermal"] {
            width: 82mm !important;
            max-height: 277mm !important;
            transform: translate(-50%, -50%) scale(0.78) !important;
          }
          .print-items-table,
          .print-items-table tr,
          .print-summary,
          .print-footer {
            page-break-inside: avoid !important;
            break-inside: avoid !important;
          }
          .print-sheet[data-layout="thermal"] .print-signature {
            display: none !important;
          }
          .print-sheet[data-layout="thermal"] .print-footer {
            margin-top: 10px !important;
            padding-top: 10px !important;
          }
          .no-print {
            display: none !important;
          }
        }
      `}</style>

      <div className="min-h-screen bg-[#eef3f8] text-slate-950">
        <aside className="no-print fixed left-0 top-0 z-40 hidden h-screen w-[280px] flex-col border-r border-white/10 bg-[#07111f] text-white xl:flex">
          <div className="border-b border-white/10 p-7">
            <p className="text-xs uppercase tracking-[0.22em] text-cyan-200">Invoice Print</p>
            <h1 className="mt-3 text-2xl font-black">{businessName}</h1>
            <p className="mt-2 text-sm text-white/55">{businessIndustry}</p>
          </div>
          <div className="flex-1 space-y-3 p-5">
            {[
              ["a4", "A4 Global Invoice"],
              ["compact", "Half A4 / Compact"],
              ["thermal", "Thermal POS"],
            ].map(([value, label]) => (
              <button
                key={value}
                onClick={() => setBillLayout(value as BillLayout)}
                className={`h-14 w-full rounded-2xl px-5 text-left font-semibold transition-all ${billLayout === value ? "bg-blue-600 text-white" : "bg-white/5 text-white/80 hover:bg-white/10"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="space-y-3 border-t border-white/10 p-5">
            <button onClick={() => setShowTaxBreakdown((value) => !value)} className="h-12 w-full rounded-2xl bg-white/5 px-5 text-left text-sm">
              {showTaxBreakdown ? "Hide Tax Breakdown" : "Show Tax Breakdown"}
            </button>
            <button onClick={() => setShowSignature((value) => !value)} className="h-12 w-full rounded-2xl bg-white/5 px-5 text-left text-sm">
              {showSignature ? "Hide Signature" : "Show Signature"}
            </button>
            <button onClick={() => window.print()} className="h-14 w-full rounded-2xl bg-white font-black text-black">
              Print Bill
            </button>
          </div>
        </aside>

        <main className="xl:pl-[280px]">
          <div className="no-print sticky top-0 z-30 border-b border-black/10 bg-white/90 px-5 py-4 backdrop-blur-xl lg:px-10">
            <div className="mx-auto flex max-w-6xl flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-3xl font-black">Professional Bill Preview</h2>
                <p className="mt-1 text-sm text-slate-500">A4, compact, and thermal layouts for global billing workflows.</p>
              </div>
              <button onClick={() => window.print()} className="h-12 rounded-2xl bg-black px-7 font-bold text-white">
                Print
              </button>
            </div>
          </div>

          <div className="flex justify-center px-4 py-8">
            <div data-layout={billLayout} className={`print-sheet ${previewWidth} overflow-hidden rounded-[22px] border border-slate-200 bg-white shadow-[0_24px_100px_rgba(15,23,42,0.12)]`}>
              <header className={`${sheetPadding} border-b border-slate-200`}>
                <div className={`flex gap-6 ${billLayout === "thermal" ? "flex-col text-center" : "items-start justify-between"}`}>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold uppercase tracking-[0.24em] text-blue-700">{businessIndustry}</p>
                    <h1 className={`${billLayout === "thermal" ? "text-2xl" : "text-3xl"} mt-2 font-black text-slate-950`}>{businessName}</h1>
                    <p className="mt-2 max-w-[440px] text-sm leading-6 text-slate-500">
                      Professional invoice generated by Bezgrow ERP. Currency: {currency}. Invoice mode: {isNoGst ? "Without GST" : "GST/tax invoice"}.
                    </p>
                  </div>
                  <div className={billLayout === "thermal" ? "" : "min-w-[270px] shrink-0 text-right"}>
                    <p className="text-xs font-bold uppercase tracking-[0.24em] text-slate-400">Tax Invoice</p>
                    <h2 className="mt-2 break-words text-2xl font-black leading-tight text-blue-700">{invoice.invoice_number}</h2>
                    <p className="mt-2 text-sm text-slate-500">{dateText(invoice.created_at)}</p>
                    <p className="mt-2 inline-flex rounded-full bg-slate-100 px-4 py-2 text-xs font-bold uppercase tracking-[0.16em] text-slate-700">
                      {stringFrom(invoice, ["payment_status"]) || "unpaid"}
                    </p>
                  </div>
                </div>
              </header>

              <section className={`${sheetPadding} border-b border-slate-200`}>
                <div className={`grid gap-5 ${billLayout === "thermal" ? "grid-cols-1" : "grid-cols-2"}`}>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">Bill To</p>
                    <h3 className="mt-2 text-xl font-black">{customerName}</h3>
                    <div className="mt-3 space-y-1 text-sm text-slate-600">
                      <p>Phone: {customerPhone}</p>
                      <p>Email: {customerEmail}</p>
                      <p>GST: {customerGst}</p>
                    </div>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">Billing Details</p>
                    <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                      <div><p className="text-slate-400">Payment</p><p className="mt-1 font-bold">{stringFrom(invoice, ["payment_method"]) || "Cash"}</p></div>
                      <div><p className="text-slate-400">Due Date</p><p className="mt-1 font-bold">{dateText(stringFrom(invoice, ["due_date"]))}</p></div>
                      <div><p className="text-slate-400">Mode</p><p className="mt-1 font-bold">{isNoGst ? "No GST" : "GST"}</p></div>
                      <div><p className="text-slate-400">Currency</p><p className="mt-1 font-bold">{currency}</p></div>
                    </div>
                  </div>
                </div>
              </section>

              <section className={sheetPadding}>
                <div className="overflow-hidden rounded-2xl border border-slate-200">
                  <table className="print-items-table w-full">
                    <thead className="bg-slate-950 text-white">
                      <tr className="text-xs uppercase tracking-[0.16em]">
                        <th className="px-3 py-3 text-left">Item</th>
                        <th className="px-2 py-3 text-center">Qty</th>
                        {billLayout !== "thermal" && <th className="px-2 py-3 text-right">Rate</th>}
                        {showTaxBreakdown && <th className="px-2 py-3 text-right">{billLayout === "thermal" ? "Tax" : "GST"}</th>}
                        <th className="px-3 py-3 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => {
                        const base = Number(item.quantity || 0) * Number(item.unit_price || 0)
                        const discount = (base * Number(item.discount_percent || 0)) / 100
                        const amount = Number(item.line_total || base - discount) + Number(item.gst_amount || 0)

                        return (
                          <tr key={item.id} className="border-b border-slate-200 last:border-none">
                            <td className="px-3 py-3 font-semibold">{item.product_name || (item.product_id ? productMap.get(item.product_id) : "") || item.product_id || "Product"}</td>
                            <td className="px-2 py-3 text-center">{item.quantity}</td>
                            {billLayout !== "thermal" && <td className="px-2 py-3 text-right">{symbol} {Number(item.unit_price || 0).toFixed(2)}</td>}
                            {showTaxBreakdown && <td className="px-2 py-3 text-right">{isNoGst ? "0" : item.tax_percent || 0}%</td>}
                            <td className="px-3 py-3 text-right font-bold">{symbol} {amount.toFixed(2)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <div className={`mt-5 grid gap-5 ${billLayout === "thermal" ? "grid-cols-1" : "grid-cols-[1fr,300px]"}`}>
                  <div className="print-summary rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <p className="font-bold">Notes</p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{stringFrom(invoice, ["notes"]) || "Thank you for your business."}</p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <div className="space-y-3 text-sm">
                      <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="font-bold">{symbol} {totals.subtotal.toFixed(2)}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">Discount</span><span className="font-bold">- {symbol} {totals.discount.toFixed(2)}</span></div>
                      <div className="flex justify-between"><span className="text-slate-500">{isNoGst ? "GST (not charged)" : "GST/Tax"}</span><span className="font-bold">{symbol} {totals.tax.toFixed(2)}</span></div>
                      <div className="flex justify-between border-t border-slate-300 pt-4 text-xl font-black"><span>Total</span><span className="text-blue-700">{symbol} {totals.grandTotal.toFixed(2)}</span></div>
                    </div>
                  </div>
                </div>

                <footer className={`print-footer mt-6 border-t border-slate-200 pt-5 ${billLayout === "thermal" ? "text-center" : "flex items-end justify-between gap-8"}`}>
                  <div>
                    <p className="text-base font-black">Globally valid professional bill</p>
                    <p className="mt-1 max-w-xl text-xs leading-5 text-slate-500">
                      Generated digitally through Bezgrow ERP. Please verify local tax compliance before statutory filing.
                    </p>
                  </div>
                  {showSignature && (
                    <div className={`print-signature ${billLayout === "thermal" ? "mt-7" : "min-w-[200px] text-right"}`}>
                      <p className="mb-10 text-xs text-slate-500">Authorized Signature</p>
                      <div className="border-t border-slate-400" />
                    </div>
                  )}
                </footer>
              </section>
            </div>
          </div>
        </main>
      </div>
    </>
  )
}
