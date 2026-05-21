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

type BillLayout = "a4" | "compact" | "register" | "thermal"

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

function compactDateText(value: string | null | undefined) {
  if (!value) return "-"
  return new Date(value).toLocaleDateString("en-GB")
}

function shortText(value: string, length: number) {
  if (!value) return "-"
  return value.length > length ? `${value.slice(0, length - 1)}.` : value
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
  const previewWidth = billLayout === "thermal" ? "w-[360px]" : billLayout === "compact" ? "w-[680px]" : billLayout === "register" ? "w-[560px]" : "w-[820px]"
  const sheetPadding = billLayout === "thermal" ? "p-4" : "p-6"
  const printPageSize = billLayout === "thermal" ? "80mm 297mm" : billLayout === "register" ? "148mm 210mm" : "A4"
  const printPageMargin = billLayout === "thermal" ? "3mm" : billLayout === "register" ? "6mm" : "8mm"

  return (
    <>
      <style jsx global>{`
        @page {
          size: ${printPageSize};
          margin: ${printPageMargin};
        }

        @media print {
          html,
          body {
            width: auto !important;
            height: auto !important;
            min-height: 0 !important;
            overflow: visible !important;
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
            position: absolute !important;
            left: 50% !important;
            top: 0 !important;
            width: 186mm !important;
            max-width: 186mm !important;
            height: auto !important;
            max-height: none !important;
            min-height: 0 !important;
            overflow: visible !important;
            transform: translateX(-50%) !important;
            transform-origin: top center !important;
            box-shadow: none !important;
            border: 0 !important;
            border-radius: 0 !important;
            color: #020617 !important;
            page-break-after: avoid !important;
            break-after: avoid !important;
          }
          .print-sheet[data-layout="compact"] {
            width: 150mm !important;
            max-width: 150mm !important;
            transform: translateX(-50%) !important;
          }
          .print-sheet[data-layout="register"] {
            width: 136mm !important;
            max-width: 136mm !important;
            min-height: 198mm !important;
            transform: translateX(-50%) !important;
          }
          .print-sheet[data-layout="register"] .register-print {
            min-height: 198mm !important;
            font-size: 7.8px !important;
            line-height: 1.16 !important;
          }
          .print-sheet[data-layout="register"] .register-print th,
          .print-sheet[data-layout="register"] .register-print td,
          .print-sheet[data-layout="register"] .register-print p,
          .print-sheet[data-layout="register"] .register-print span {
            font-size: 7.8px !important;
            line-height: 1.16 !important;
          }
          .print-sheet[data-layout="register"] .register-print h1 {
            font-size: 16px !important;
            line-height: 1.05 !important;
          }
          .print-sheet[data-layout="register"] .register-print h2 {
            font-size: 16px !important;
            line-height: 1.05 !important;
          }
          .print-sheet[data-layout="register"] .register-card {
            border-radius: 6px !important;
            padding: 6px !important;
          }
          .print-sheet[data-layout="thermal"] {
            left: 50% !important;
            width: 72mm !important;
            max-width: 72mm !important;
            transform: translateX(-50%) !important;
            font-size: 9px !important;
            line-height: 1.25 !important;
          }
          .print-sheet[data-layout="thermal"] header,
          .print-sheet[data-layout="thermal"] section {
            padding: 3mm !important;
          }
          .print-sheet[data-layout="thermal"] h1 {
            font-size: 16px !important;
            line-height: 1.15 !important;
          }
          .print-sheet[data-layout="thermal"] h2 {
            font-size: 11px !important;
            line-height: 1.2 !important;
          }
          .print-sheet[data-layout="thermal"] p,
          .print-sheet[data-layout="thermal"] td,
          .print-sheet[data-layout="thermal"] th,
          .print-sheet[data-layout="thermal"] span {
            font-size: 9px !important;
            line-height: 1.25 !important;
          }
          .print-sheet[data-layout="thermal"] .thermal-hide-print {
            display: none !important;
          }
          .print-sheet[data-layout="thermal"] .thermal-card {
            border-radius: 6px !important;
            padding: 8px !important;
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
          .print-preview-shell {
            display: block !important;
            padding: 0 !important;
            margin: 0 !important;
            background: white !important;
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
              ["register", "Half A4 Portrait"],
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
                <p className="mt-1 text-sm text-slate-500">A4, compact, half-A4 portrait, and thermal layouts for global billing workflows.</p>
              </div>
              <button onClick={() => window.print()} className="h-12 rounded-2xl bg-black px-7 font-bold text-white">
                Print
              </button>
            </div>
          </div>

          <div className="print-preview-shell flex justify-center px-4 py-8">
            <div data-layout={billLayout} className={`print-sheet ${previewWidth} overflow-hidden rounded-[22px] border border-slate-200 bg-white shadow-[0_24px_100px_rgba(15,23,42,0.12)]`}>
              {billLayout === "register" ? (
                <div className="register-print flex min-h-[794px] flex-col bg-white p-6 font-sans text-[11px] leading-tight text-slate-950">
                  <header className="grid grid-cols-[1.1fr_0.9fr] gap-3 border-b-2 border-slate-950 pb-3">
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-[0.24em] text-blue-700">{businessIndustry}</p>
                      <h1 className="mt-1 text-2xl font-black leading-none">{businessName}</h1>
                      <p className="mt-2 max-w-[280px] text-[10px] leading-4 text-slate-600">
                        Professional half-A4 portrait invoice generated by Bezgrow.
                      </p>
                    </div>
                    <div className="register-card rounded-xl border border-slate-300 bg-slate-50 p-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500">Invoice Details</p>
                      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                        <span className="text-slate-500">Invoice</span>
                        <span className="break-words text-right font-black">{invoice.invoice_number}</span>
                        <span className="text-slate-500">Date</span>
                        <span className="text-right font-bold">{compactDateText(invoice.created_at)}</span>
                        <span className="text-slate-500">Mode</span>
                        <span className="text-right font-bold">{isNoGst ? "No GST" : "GST"}</span>
                        <span className="text-slate-500">Status</span>
                        <span className="text-right font-bold uppercase">{stringFrom(invoice, ["payment_status"]) || "unpaid"}</span>
                      </div>
                    </div>
                    <div className="register-card col-span-2 grid grid-cols-[1fr_auto] items-center rounded-xl bg-slate-950 p-3 text-white">
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-200">Grand Total</p>
                      <h2 className="text-2xl font-black leading-none">{symbol} {totals.grandTotal.toFixed(2)}</h2>
                      <p className="col-span-2 mt-1 text-[10px] text-white/65">Currency {currency}</p>
                    </div>
                  </header>

                  <section className="mt-3 grid grid-cols-2 gap-3">
                    <div className="register-card rounded-xl border border-slate-300 bg-white p-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">Bill To</p>
                      <h3 className="mt-1 text-base font-black">{customerName}</h3>
                      <p className="mt-1 text-[11px] text-slate-600">Phone: {customerPhone}</p>
                      <p className="text-[11px] text-slate-600">Email: {customerEmail}</p>
                    </div>
                    <div className="register-card rounded-xl border border-slate-300 bg-white p-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">Tax & Payment</p>
                      <div className="mt-2 grid grid-cols-2 gap-y-1 text-[11px]">
                        <span className="text-slate-500">GSTIN</span>
                        <span className="text-right font-bold">{customerGst}</span>
                        <span className="text-slate-500">Payment</span>
                        <span className="text-right font-bold">{stringFrom(invoice, ["payment_method"]) || "Cash"}</span>
                        <span className="text-slate-500">Due Date</span>
                        <span className="text-right font-bold">{dateText(stringFrom(invoice, ["due_date"]))}</span>
                      </div>
                    </div>
                    <div className="register-card col-span-2 rounded-xl border border-slate-300 bg-slate-50 p-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">Summary</p>
                      <div className="mt-2 grid grid-cols-3 gap-3 text-[11px]">
                        <div>
                        <span className="text-slate-500">Lines</span>
                        <p className="font-bold">{items.length}</p>
                        </div>
                        <div>
                        <span className="text-slate-500">Quantity</span>
                        <p className="font-bold">{items.reduce((sum, item) => sum + Number(item.quantity || 0), 0).toFixed(2)}</p>
                        </div>
                        <div>
                        <span className="text-slate-500">Tax</span>
                        <p className="font-bold">{symbol} {totals.tax.toFixed(2)}</p>
                        </div>
                      </div>
                    </div>
                  </section>

                  <table className="mt-3 w-full table-fixed border-collapse overflow-hidden rounded-xl border border-slate-300">
                    <thead>
                      <tr className="bg-slate-950 text-[10px] font-black uppercase tracking-[0.12em] text-white">
                        <th className="w-[28px] px-2 py-2 text-left">No</th>
                        <th className="px-2 py-2 text-left">Item</th>
                        <th className="w-[58px] px-2 py-2 text-right">Qty</th>
                        <th className="w-[72px] px-2 py-2 text-right">Rate</th>
                        <th className="w-[54px] px-2 py-2 text-right">Tax</th>
                        <th className="w-[84px] px-2 py-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item, index) => {
                        const base = Number(item.quantity || 0) * Number(item.unit_price || 0)
                        const discount = (base * Number(item.discount_percent || 0)) / 100
                        const amount = Number(item.line_total || base - discount) + Number(item.gst_amount || 0)
                        const productName = item.product_name || (item.product_id ? productMap.get(item.product_id) : "") || item.product_id || "Product"

                        return (
                          <tr key={item.id || `${invoice.id}-${index}`} className="border-b border-slate-200 align-top last:border-none">
                            <td className="px-2 py-2 font-bold text-slate-500">{index + 1}</td>
                            <td className="px-2 py-2 font-bold">{shortText(productName, 42)}</td>
                            <td className="px-2 py-2 text-right font-bold">{Number(item.quantity || 0).toFixed(Number(item.quantity || 0) % 1 ? 2 : 0)}</td>
                            <td className="px-2 py-2 text-right">{symbol} {Number(item.unit_price || 0).toFixed(2)}</td>
                            <td className="px-2 py-2 text-right">{isNoGst ? "0" : item.tax_percent || 0}%</td>
                            <td className="px-2 py-2 text-right font-black">{symbol} {amount.toFixed(2)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>

                  <footer className="mt-auto grid grid-cols-[1fr_210px] gap-3 pt-3">
                    <div className="register-card rounded-xl border border-slate-300 bg-slate-50 p-3">
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">Notes</p>
                      <p className="mt-2 text-[11px] leading-5 text-slate-600">{stringFrom(invoice, ["notes"]) || "Thank you for your business."}</p>
                      <p className="mt-3 text-[10px] text-slate-500">Digitally generated invoice. Verify local tax compliance before statutory filing.</p>
                    </div>
                    <div className="register-card rounded-xl border border-slate-300 bg-white p-3">
                      <div className="space-y-1 text-[11px]">
                        <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="font-bold">{symbol} {totals.subtotal.toFixed(2)}</span></div>
                        <div className="flex justify-between"><span className="text-slate-500">Discount</span><span className="font-bold">- {symbol} {totals.discount.toFixed(2)}</span></div>
                        <div className="flex justify-between"><span className="text-slate-500">{isNoGst ? "GST not charged" : "GST/Tax"}</span><span className="font-bold">{symbol} {totals.tax.toFixed(2)}</span></div>
                        <div className="mt-2 flex justify-between border-t border-slate-300 pt-2 text-base font-black">
                          <span>Total</span>
                          <span className="text-blue-700">{symbol} {totals.grandTotal.toFixed(2)}</span>
                        </div>
                      </div>
                    </div>
                  </footer>
                </div>
              ) : (
                <>
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
                  <div className="thermal-card rounded-2xl border border-slate-200 bg-slate-50 p-4">
                    <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-400">Bill To</p>
                    <h3 className="mt-2 text-xl font-black">{customerName}</h3>
                    <div className="mt-3 space-y-1 text-sm text-slate-600">
                      <p>Phone: {customerPhone}</p>
                      <p>Email: {customerEmail}</p>
                      <p>GST: {customerGst}</p>
                    </div>
                  </div>
                  <div className="thermal-card rounded-2xl border border-slate-200 bg-slate-50 p-4">
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
                </>
              )}
            </div>
          </div>
        </main>
      </div>
    </>
  )
}
