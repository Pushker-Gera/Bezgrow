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

type PrintLayoutSpec = {
  pageSize: string
  pageMargin: string
  previewWidth: string
}

type PrintableLine = {
  id: string
  name: string
  quantity: number
  quantityText: string
  unitPrice: number
  taxPercent: number
  amount: number
}

const layoutOptions: Array<[BillLayout, string, string]> = [
  ["a4", "A4 Global Invoice", "Full professional tax invoice"],
  ["compact", "Half A4 / Compact", "A5 portrait single-page bill"],
  ["register", "Half A4 Top Sheet", "Wide half-page ledger bill"],
  ["thermal", "Thermal POS", "80mm receipt for retail counters"],
]

const printLayoutSpecs: Record<BillLayout, PrintLayoutSpec> = {
  a4: {
    pageSize: "210mm 297mm",
    pageMargin: "10mm",
    previewWidth: "w-[820px]",
  },
  compact: {
    pageSize: "148mm 210mm",
    pageMargin: "7mm",
    previewWidth: "w-[640px]",
  },
  register: {
    pageSize: "210mm 148mm",
    pageMargin: "6mm",
    previewWidth: "w-[940px]",
  },
  thermal: {
    pageSize: "80mm 297mm",
    pageMargin: "2mm",
    previewWidth: "w-[360px]",
  },
}

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

  useEffect(() => {
    const setPrintLayout = () => {
      document.documentElement.dataset.billLayout = billLayout
    }

    const clearPrintLayout = () => {
      delete document.documentElement.dataset.billLayout
    }

    window.addEventListener("beforeprint", setPrintLayout)
    window.addEventListener("afterprint", clearPrintLayout)

    return () => {
      window.removeEventListener("beforeprint", setPrintLayout)
      window.removeEventListener("afterprint", clearPrintLayout)
    }
  }, [billLayout])

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-black text-white">
        <div className="flex items-center gap-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-600 border-t-white" />
          <p className="text-lg">Preparing global invoice layout...</p>
        </div>
      </div>
    )
  }

  if (!invoice) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-black text-white">
        Invoice not found.
      </div>
    )
  }

  const currency = stringFrom(organization, ["currency"]) || "INR"
  const symbol = currencySymbol(currency)
  const businessName = stringFrom(organization, ["name", "business_name"]) || "Bezgrow ERP"
  const businessIndustry = stringFrom(organization, ["industry", "business_category"]) || "Global Business"
  const businessEmail = stringFrom(organization, ["email", "support_email"]) || "-"
  const businessPhone = stringFrom(organization, ["phone", "contact_phone"]) || "-"
  const businessAddress = stringFrom(organization, ["address", "business_address"]) || ""
  const businessGst = stringFrom(organization, ["gst_number", "gstin", "tax_id"]) || "-"
  const customerName = stringFrom(customer, ["name"]) || stringFrom(invoice, ["customer_name"]) || "Walk-in customer"
  const customerPhone = stringFrom(customer, ["phone"]) || "-"
  const customerEmail = stringFrom(customer, ["email"]) || "-"
  const customerGst = stringFrom(customer, ["gst_number", "gstin", "tax_id"]) || "-"
  const productMap = new Map(products.map((product) => [product.id, product.name || "Product"]))
  const invoiceType = stringFrom(invoice, ["invoice_type"])
  const isNoGst = invoiceType === "no_gst" || totals.tax === 0
  const status = stringFrom(invoice, ["payment_status"]) || "unpaid"
  const paymentMethod = stringFrom(invoice, ["payment_method"]) || "Cash"
  const dueDate = dateText(stringFrom(invoice, ["due_date"]))
  const notes = stringFrom(invoice, ["notes"]) || "Thank you for your business."
  const totalQuantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
  const activePrintLayout = printLayoutSpecs[billLayout]
  const previewWidth = activePrintLayout.previewWidth

  const lineItems: PrintableLine[] = items.map((item, index) => {
    const base = Number(item.quantity || 0) * Number(item.unit_price || 0)
    const discount = (base * Number(item.discount_percent || 0)) / 100
    const amount = Number(item.line_total || base - discount) + Number(item.gst_amount || 0)
    const name = item.product_name || (item.product_id ? productMap.get(item.product_id) : "") || item.product_id || "Product"
    const quantity = Number(item.quantity || 0)

    return {
      id: item.id || `${invoice.id}-${index}`,
      name,
      quantity,
      quantityText: quantity.toFixed(quantity % 1 ? 2 : 0),
      unitPrice: Number(item.unit_price || 0),
      taxPercent: isNoGst ? 0 : Number(item.tax_percent || 0),
      amount,
    }
  })

  const openPrintDialog = () => {
    document.documentElement.dataset.billLayout = billLayout
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.print())
    })
  }

  const summaryBlock = (compact = false) => (
    <div className={compact ? "print-total-card compact" : "print-total-card"}>
      <div className="print-total-row">
        <span>Subtotal</span>
        <strong>{symbol} {totals.subtotal.toFixed(2)}</strong>
      </div>
      <div className="print-total-row">
        <span>Discount</span>
        <strong>- {symbol} {totals.discount.toFixed(2)}</strong>
      </div>
      <div className="print-total-row">
        <span>{isNoGst ? "GST not charged" : "GST/Tax"}</span>
        <strong>{symbol} {totals.tax.toFixed(2)}</strong>
      </div>
      <div className="print-grand-row">
        <span>Total</span>
        <strong>{symbol} {totals.grandTotal.toFixed(2)}</strong>
      </div>
    </div>
  )

  const detailCard = (title: string, rows: Array<[string, string]>) => (
    <div className="print-info-card">
      <p className="print-card-title">{title}</p>
      <div className="print-card-grid">
        {rows.map(([label, value]) => (
          <div key={`${title}-${label}`}>
            <span>{label}</span>
            <strong>{value || "-"}</strong>
          </div>
        ))}
      </div>
    </div>
  )

  const signatureBlock = (
    showSignature && (
      <div className="print-signature">
        <span>Authorized Signature</span>
        <div />
      </div>
    )
  )

  return (
    <>
      <style jsx global>{`
        @page {
          size: ${activePrintLayout.pageSize};
          margin: ${activePrintLayout.pageMargin};
        }

        .invoice-paper {
          color: #07111f;
          font-family: Arial, Helvetica, sans-serif;
          overflow: hidden;
          background: #ffffff;
          print-color-adjust: exact;
          -webkit-print-color-adjust: exact;
        }

        .invoice-paper * {
          box-sizing: border-box;
        }

        .paper-a4 {
          width: 210mm;
          min-height: 297mm;
          padding: 16mm;
        }

        .paper-compact {
          width: 148mm;
          min-height: 210mm;
          padding: 10mm;
        }

        .paper-register {
          width: 210mm;
          height: 148mm;
          padding: 7mm;
          border: 2px solid #07111f;
        }

        .paper-thermal {
          width: 80mm;
          min-height: 160mm;
          padding: 4mm;
          font-family: "Courier New", monospace;
        }

        .print-header {
          display: grid;
          grid-template-columns: 1.1fr 0.9fr;
          gap: 24px;
          border-bottom: 2px solid #0f172a;
          padding-bottom: 18px;
        }

        .print-eyebrow,
        .print-card-title {
          color: #2563eb;
          font-size: 10px;
          font-weight: 900;
          letter-spacing: 0.22em;
          text-transform: uppercase;
        }

        .print-business {
          margin-top: 8px;
          font-size: 32px;
          font-weight: 900;
          line-height: 1;
        }

        .print-muted {
          color: #64748b;
          font-size: 12px;
          line-height: 1.55;
        }

        .print-invoice-meta {
          text-align: right;
        }

        .print-invoice-meta h2 {
          color: #1d4ed8;
          font-size: 24px;
          font-weight: 900;
          line-height: 1.1;
          word-break: break-word;
        }

        .print-status {
          display: inline-flex;
          margin-top: 10px;
          border-radius: 999px;
          background: #eef2f7;
          padding: 7px 14px;
          color: #1f2937;
          font-size: 10px;
          font-weight: 900;
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }

        .print-info-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 14px;
          margin-top: 18px;
        }

        .print-info-card {
          border: 1px solid #d8e0ea;
          border-radius: 12px;
          padding: 14px;
          background: #f8fafc;
        }

        .print-card-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px 14px;
          margin-top: 10px;
        }

        .print-card-grid span {
          display: block;
          color: #64748b;
          font-size: 11px;
        }

        .print-card-grid strong {
          display: block;
          margin-top: 3px;
          font-size: 12px;
          word-break: break-word;
        }

        .print-table {
          width: 100%;
          margin-top: 20px;
          border-collapse: separate;
          border-spacing: 0;
          overflow: hidden;
          border: 1px solid #d8e0ea;
          border-radius: 12px;
        }

        .print-table th {
          background: #07111f;
          color: #ffffff;
          font-size: 10px;
          font-weight: 900;
          letter-spacing: 0.16em;
          padding: 11px 12px;
          text-align: left;
          text-transform: uppercase;
        }

        .print-table td {
          border-bottom: 1px solid #e2e8f0;
          padding: 11px 12px;
          font-size: 12px;
          vertical-align: top;
        }

        .print-table tr:last-child td {
          border-bottom: 0;
        }

        .text-right {
          text-align: right !important;
        }

        .text-center {
          text-align: center !important;
        }

        .print-bottom-grid {
          display: grid;
          grid-template-columns: 1fr 270px;
          gap: 18px;
          margin-top: 18px;
          align-items: start;
        }

        .print-notes {
          min-height: 98px;
          border: 1px solid #d8e0ea;
          border-radius: 12px;
          padding: 14px;
          background: #f8fafc;
        }

        .print-total-card {
          border: 1px solid #d8e0ea;
          border-radius: 12px;
          padding: 14px;
          background: #f8fafc;
        }

        .print-total-row,
        .print-grand-row {
          display: flex;
          justify-content: space-between;
          gap: 14px;
          font-size: 12px;
          line-height: 2;
        }

        .print-total-row span {
          color: #64748b;
        }

        .print-grand-row {
          margin-top: 8px;
          border-top: 1px solid #cbd5e1;
          padding-top: 10px;
          font-size: 20px;
          font-weight: 900;
        }

        .print-grand-row strong {
          color: #1d4ed8;
        }

        .print-footer {
          display: flex;
          justify-content: space-between;
          gap: 24px;
          margin-top: 24px;
          border-top: 1px solid #d8e0ea;
          padding-top: 18px;
        }

        .print-footer strong {
          display: block;
          margin-bottom: 4px;
          font-size: 13px;
        }

        .print-signature {
          min-width: 190px;
          text-align: center;
        }

        .print-signature span {
          color: #64748b;
          font-size: 11px;
        }

        .print-signature div {
          margin-top: 36px;
          border-top: 1px solid #94a3b8;
        }

        .compact-layout .print-business {
          font-size: 24px;
        }

        .compact-layout .print-header {
          gap: 16px;
          padding-bottom: 14px;
        }

        .compact-layout .print-invoice-meta h2 {
          font-size: 18px;
        }

        .compact-layout .print-info-grid {
          grid-template-columns: 1fr;
          gap: 10px;
          margin-top: 14px;
        }

        .compact-layout .print-info-card,
        .compact-layout .print-notes,
        .compact-layout .print-total-card {
          border-radius: 9px;
          padding: 10px;
        }

        .compact-layout .print-card-grid {
          gap: 6px 10px;
        }

        .compact-layout .print-table {
          margin-top: 14px;
          border-radius: 9px;
        }

        .compact-layout .print-table th,
        .compact-layout .print-table td {
          padding: 8px;
          font-size: 10px;
        }

        .compact-layout .print-bottom-grid {
          grid-template-columns: 1fr;
          gap: 10px;
          margin-top: 12px;
        }

        .compact-layout .print-grand-row {
          font-size: 16px;
        }

        .register-layout {
          display: grid;
          grid-template-rows: auto auto 1fr auto;
          gap: 7px;
        }

        .register-layout .print-header {
          grid-template-columns: 1fr 1fr 0.85fr;
          gap: 8px;
          padding-bottom: 7px;
        }

        .register-layout .print-business {
          font-size: 18px;
        }

        .register-layout .print-invoice-meta {
          border: 1px solid #d8e0ea;
          border-radius: 8px;
          padding: 7px;
          background: #f8fafc;
        }

        .register-layout .print-invoice-meta h2 {
          font-size: 12px;
        }

        .register-total-panel {
          border-radius: 8px;
          background: #07111f;
          padding: 9px;
          color: white;
        }

        .register-total-panel p {
          color: #a5f3fc;
          font-size: 9px;
          font-weight: 900;
          letter-spacing: 0.22em;
          text-transform: uppercase;
        }

        .register-total-panel strong {
          display: block;
          margin-top: 6px;
          font-size: 19px;
          line-height: 1;
        }

        .register-layout .print-info-grid {
          grid-template-columns: 1fr 1fr 0.8fr;
          gap: 7px;
          margin-top: 0;
        }

        .register-layout .print-info-card {
          border-radius: 8px;
          padding: 7px;
        }

        .register-layout .print-muted,
        .register-layout .print-card-grid span,
        .register-layout .print-card-grid strong {
          font-size: 7.8px;
          line-height: 1.35;
        }

        .register-layout .print-card-title,
        .register-layout .print-eyebrow {
          font-size: 7px;
          letter-spacing: 0.18em;
        }

        .register-layout .print-card-grid {
          gap: 4px 7px;
          margin-top: 5px;
        }

        .register-layout .print-table {
          margin-top: 0;
          border-radius: 8px;
        }

        .register-layout .print-table th,
        .register-layout .print-table td {
          padding: 4px 6px;
          font-size: 7.5px;
        }

        .register-layout .print-bottom-grid {
          grid-template-columns: 1fr 190px;
          gap: 7px;
          margin-top: 0;
        }

        .register-layout .print-notes,
        .register-layout .print-total-card {
          min-height: auto;
          border-radius: 8px;
          padding: 7px;
        }

        .register-layout .print-total-row {
          font-size: 8px;
          line-height: 1.35;
        }

        .register-layout .print-grand-row {
          font-size: 10px;
          margin-top: 4px;
          padding-top: 5px;
        }

        .register-layout .print-footer {
          margin-top: 0;
          padding-top: 8px;
        }

        .thermal-layout {
          color: #000000;
        }

        .thermal-layout .thermal-center {
          text-align: center;
        }

        .thermal-layout h1 {
          margin: 4px 0 0;
          font-size: 17px;
          line-height: 1.15;
        }

        .thermal-layout p,
        .thermal-layout td,
        .thermal-layout th,
        .thermal-layout span,
        .thermal-layout strong {
          font-size: 10px;
          line-height: 1.35;
        }

        .thermal-rule {
          margin: 8px 0;
          border-top: 1px dashed #000000;
        }

        .thermal-row {
          display: flex;
          justify-content: space-between;
          gap: 8px;
        }

        .thermal-table {
          width: 100%;
          border-collapse: collapse;
        }

        .thermal-table th {
          border-bottom: 1px solid #000000;
          padding: 4px 0;
          text-align: left;
          font-size: 9px;
        }

        .thermal-table td {
          padding: 4px 0;
          border-bottom: 1px dotted #cbd5e1;
          vertical-align: top;
        }

        .thermal-total {
          margin-top: 8px;
          border-top: 1px solid #000000;
          padding-top: 8px;
          font-size: 15px !important;
          font-weight: 900;
        }

        @media print {
          html,
          body {
            width: auto !important;
            height: auto !important;
            min-height: 0 !important;
            overflow: visible !important;
            background: #ffffff !important;
          }

          body * {
            visibility: hidden !important;
          }

          .print-preview-shell,
          .print-sheet,
          .print-sheet * {
            visibility: visible !important;
          }

          .print-preview-shell {
            display: flex !important;
            justify-content: center !important;
            align-items: flex-start !important;
            width: 100% !important;
            min-height: 0 !important;
            padding: 0 !important;
            margin: 0 !important;
            background: #ffffff !important;
          }

          .print-sheet {
            position: static !important;
            width: auto !important;
            max-width: none !important;
            margin: 0 auto !important;
            overflow: visible !important;
            border: 0 !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            transform: none !important;
          }

          .invoice-paper {
            margin: 0 auto !important;
            box-shadow: none !important;
            break-after: avoid !important;
            page-break-after: avoid !important;
            break-inside: avoid !important;
            page-break-inside: avoid !important;
          }

          .paper-a4 {
            width: 190mm !important;
            min-height: 277mm !important;
            padding: 0 !important;
          }

          .paper-compact {
            width: 134mm !important;
            min-height: 196mm !important;
            padding: 0 !important;
          }

          .paper-register {
            width: 198mm !important;
            height: 136mm !important;
            padding: 5mm !important;
            overflow: hidden !important;
            border: 1px solid #07111f !important;
          }

          .paper-thermal {
            width: 76mm !important;
            min-height: 0 !important;
            padding: 0 !important;
          }

          html[data-bill-layout="a4"] .print-sheet,
          html[data-bill-layout="a4"] .invoice-paper {
            width: 190mm !important;
          }

          html[data-bill-layout="compact"] .print-sheet,
          html[data-bill-layout="compact"] .invoice-paper {
            width: 134mm !important;
          }

          html[data-bill-layout="register"] .print-sheet,
          html[data-bill-layout="register"] .invoice-paper {
            width: 198mm !important;
            height: 136mm !important;
            max-height: 136mm !important;
          }

          html[data-bill-layout="thermal"] .print-sheet,
          html[data-bill-layout="thermal"] .invoice-paper {
            width: 76mm !important;
          }

          .print-table,
          .print-table tr,
          .print-info-card,
          .print-total-card,
          .print-notes,
          .print-footer {
            break-inside: avoid !important;
            page-break-inside: avoid !important;
          }

          .no-print {
            display: none !important;
          }
        }
      `}</style>

      <div className="min-h-dvh bg-[#eef3f8] text-slate-950">
        <aside className="no-print fixed left-0 top-0 z-40 hidden h-screen w-[300px] flex-col border-r border-white/10 bg-[#07111f] text-white xl:flex">
          <div className="border-b border-white/10 p-7">
            <p className="text-xs uppercase tracking-[0.22em] text-cyan-200">Invoice Print</p>
            <h1 className="mt-3 text-2xl font-black">{businessName}</h1>
            <p className="mt-2 text-sm text-white/55">{businessIndustry}</p>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-5">
            {layoutOptions.map(([value, label, description]) => (
              <button
                key={value}
                onClick={() => setBillLayout(value)}
                className={`w-full rounded-2xl px-5 py-4 text-left transition-all ${billLayout === value ? "bg-blue-600 text-white" : "bg-white/5 text-white/80 hover:bg-white/10"}`}
              >
                <span className="block text-base font-black">{label}</span>
                <span className="mt-1 block text-xs text-white/55">{description}</span>
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
            <button onClick={openPrintDialog} className="h-14 w-full rounded-2xl bg-white font-black text-black">
              Print Bill
            </button>
            <button onClick={openPrintDialog} className="h-14 w-full rounded-2xl border border-white/15 bg-white/5 font-black text-white">
              Save PDF
            </button>
          </div>
        </aside>

        <main className="xl:pl-[300px]">
          <div className="no-print sticky top-0 z-30 border-b border-black/10 bg-white/90 px-3 py-3 backdrop-blur-xl sm:px-5 sm:py-4 lg:px-10">
            <div className="mx-auto flex max-w-6xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <h2 className="truncate text-xl font-black sm:text-3xl">Professional Bill Preview</h2>
                <p className="mt-1 line-clamp-2 text-sm text-slate-500 sm:line-clamp-none">Four dedicated global invoice layouts with print-safe sizing and real invoice data.</p>
              </div>
              <button onClick={openPrintDialog} className="hidden h-12 shrink-0 rounded-2xl bg-black px-7 font-bold text-white sm:inline-flex sm:items-center">
                Print
              </button>
            </div>
          </div>

          <div className="no-print border-b border-slate-200 bg-white px-3 py-3 shadow-sm xl:hidden">
            <div className="mx-auto grid max-w-3xl gap-3">
              <label className="grid gap-1 text-xs font-black uppercase tracking-[0.14em] text-slate-500">
                Bill Layout
                <select
                  value={billLayout}
                  onChange={(event) => setBillLayout(event.target.value as BillLayout)}
                  className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-base font-black normal-case tracking-normal text-slate-950 outline-none"
                >
                  {layoutOptions.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setShowTaxBreakdown((value) => !value)}
                  className="min-h-12 rounded-2xl border border-slate-200 bg-slate-50 px-3 text-sm font-black text-slate-950"
                >
                  {showTaxBreakdown ? "Hide Tax" : "Show Tax"}
                </button>
                <button
                  onClick={() => setShowSignature((value) => !value)}
                  className="min-h-12 rounded-2xl border border-slate-200 bg-slate-50 px-3 text-sm font-black text-slate-950"
                >
                  {showSignature ? "Hide Sign" : "Show Sign"}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button onClick={openPrintDialog} className="min-h-12 rounded-2xl bg-black px-3 text-sm font-black text-white">
                  Print Bill
                </button>
                <button onClick={openPrintDialog} className="min-h-12 rounded-2xl border border-slate-300 bg-white px-3 text-sm font-black text-slate-950">
                  Save PDF
                </button>
              </div>
            </div>
          </div>

          <div className="print-preview-shell flex justify-start overflow-x-auto px-3 py-6 sm:px-4 xl:justify-center xl:py-8">
            <div key={billLayout} data-layout={billLayout} className={`print-sheet ${previewWidth}`}>
              {billLayout === "thermal" ? (
                <div className="invoice-paper paper-thermal thermal-layout rounded-xl border border-slate-200 shadow-[0_24px_80px_rgba(15,23,42,0.14)]">
                  <div className="thermal-center">
                    <strong>{businessName}</strong>
                    <h1>{isNoGst ? "Retail Bill" : "Tax Invoice"}</h1>
                    <p>{businessAddress || businessIndustry}</p>
                    <p>Phone: {businessPhone} | GST: {businessGst}</p>
                  </div>
                  <div className="thermal-rule" />
                  <div className="thermal-row"><span>Invoice</span><strong>{invoice.invoice_number}</strong></div>
                  <div className="thermal-row"><span>Date</span><strong>{dateText(invoice.created_at)}</strong></div>
                  <div className="thermal-row"><span>Customer</span><strong>{shortText(customerName, 22)}</strong></div>
                  <div className="thermal-row"><span>Payment</span><strong>{paymentMethod}</strong></div>
                  <div className="thermal-rule" />
                  <table className="thermal-table">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th className="text-center">Qty</th>
                        {showTaxBreakdown && <th className="text-center">Tax</th>}
                        <th className="text-right">Amt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lineItems.map((item) => (
                        <tr key={item.id}>
                          <td>{shortText(item.name, 24)}</td>
                          <td className="text-center">{item.quantityText}</td>
                          {showTaxBreakdown && <td className="text-center">{item.taxPercent}%</td>}
                          <td className="text-right">{symbol} {item.amount.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="thermal-rule" />
                  <div className="thermal-row"><span>Subtotal</span><strong>{symbol} {totals.subtotal.toFixed(2)}</strong></div>
                  <div className="thermal-row"><span>Discount</span><strong>- {symbol} {totals.discount.toFixed(2)}</strong></div>
                  <div className="thermal-row"><span>{isNoGst ? "GST not charged" : "GST/Tax"}</span><strong>{symbol} {totals.tax.toFixed(2)}</strong></div>
                  <div className="thermal-row thermal-total"><span>Total</span><strong>{symbol} {totals.grandTotal.toFixed(2)}</strong></div>
                  <div className="thermal-rule" />
                  <p className="thermal-center">{notes}</p>
                  <p className="thermal-center">Digitally generated by Bezgrow</p>
                </div>
              ) : billLayout === "register" ? (
                <div className="invoice-paper paper-register register-layout rounded-[18px] bg-white shadow-[0_24px_80px_rgba(15,23,42,0.14)]">
                  <header className="print-header">
                    <div>
                      <p className="print-eyebrow">{businessIndustry}</p>
                      <h1 className="print-business">{businessName}</h1>
                      <p className="print-muted">Professional full-width half-A4 invoice generated by Bezgrow.</p>
                    </div>
                    <div className="print-invoice-meta">
                      <p className="print-card-title">Invoice Details</p>
                      <h2>{invoice.invoice_number}</h2>
                      <p className="print-muted">{dateText(invoice.created_at)} | {isNoGst ? "No GST" : "GST"} | {status.toUpperCase()}</p>
                    </div>
                    <div className="register-total-panel">
                      <p>Grand Total</p>
                      <strong>{symbol} {totals.grandTotal.toFixed(2)}</strong>
                      <span>Currency {currency}</span>
                    </div>
                  </header>
                  <section className="print-info-grid">
                    {detailCard("Bill To", [["Name", customerName], ["Phone", customerPhone], ["Email", customerEmail], ["GSTIN", customerGst]])}
                    {detailCard("Tax & Payment", [["Payment", paymentMethod], ["Due Date", dueDate], ["Mode", isNoGst ? "No GST" : "GST"], ["Currency", currency]])}
                    {detailCard("Summary", [["Lines", String(lineItems.length)], ["Quantity", totalQuantity.toFixed(totalQuantity % 1 ? 2 : 0)], ["Tax", `${symbol} ${totals.tax.toFixed(2)}`], ["Status", status]])}
                  </section>
                  <table className="print-table">
                    <thead>
                      <tr>
                        <th style={{ width: "34px" }}>No</th>
                        <th>Item</th>
                        <th className="text-right" style={{ width: "72px" }}>Qty</th>
                        <th className="text-right" style={{ width: "86px" }}>Rate</th>
                        {showTaxBreakdown && <th className="text-right" style={{ width: "70px" }}>Tax</th>}
                        <th className="text-right" style={{ width: "100px" }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lineItems.map((item, index) => (
                        <tr key={item.id}>
                          <td>{index + 1}</td>
                          <td><strong>{shortText(item.name, 46)}</strong></td>
                          <td className="text-right">{item.quantityText}</td>
                          <td className="text-right">{symbol} {item.unitPrice.toFixed(2)}</td>
                          {showTaxBreakdown && <td className="text-right">{item.taxPercent}%</td>}
                          <td className="text-right"><strong>{symbol} {item.amount.toFixed(2)}</strong></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <footer className="print-bottom-grid">
                    <div className="print-notes">
                      <p className="print-card-title">Notes</p>
                      <p className="print-muted">{notes}</p>
                      <p className="print-muted">Digitally generated invoice. Verify local tax compliance before statutory filing.</p>
                    </div>
                    {summaryBlock(true)}
                  </footer>
                </div>
              ) : (
                <div className={`invoice-paper ${billLayout === "compact" ? "paper-compact compact-layout" : "paper-a4"} rounded-[22px] bg-white shadow-[0_24px_80px_rgba(15,23,42,0.14)]`}>
                  <header className="print-header">
                    <div>
                      <p className="print-eyebrow">{businessIndustry}</p>
                      <h1 className="print-business">{businessName}</h1>
                      <p className="print-muted">
                        {businessAddress || "Professional invoice generated by Bezgrow."}
                      </p>
                      <p className="print-muted">Phone: {businessPhone} | Email: {businessEmail} | GST: {businessGst}</p>
                    </div>
                    <div className="print-invoice-meta">
                      <p className="print-card-title">{isNoGst ? "Bill of Supply" : "Tax Invoice"}</p>
                      <h2>{invoice.invoice_number}</h2>
                      <p className="print-muted">{dateText(invoice.created_at)}</p>
                      <span className="print-status">{status}</span>
                    </div>
                  </header>

                  <section className="print-info-grid">
                    {detailCard("Bill To", [["Name", customerName], ["Phone", customerPhone], ["Email", customerEmail], ["GSTIN", customerGst]])}
                    {detailCard("Billing Details", [["Payment", paymentMethod], ["Due Date", dueDate], ["Mode", isNoGst ? "No GST" : "GST"], ["Currency", currency]])}
                  </section>

                  <table className="print-table">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th className="text-center" style={{ width: billLayout === "compact" ? "46px" : "64px" }}>Qty</th>
                        <th className="text-right" style={{ width: billLayout === "compact" ? "72px" : "96px" }}>Rate</th>
                        {showTaxBreakdown && <th className="text-right" style={{ width: billLayout === "compact" ? "54px" : "70px" }}>Tax</th>}
                        <th className="text-right" style={{ width: billLayout === "compact" ? "84px" : "112px" }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lineItems.map((item) => (
                        <tr key={item.id}>
                          <td><strong>{shortText(item.name, billLayout === "compact" ? 28 : 54)}</strong></td>
                          <td className="text-center">{item.quantityText}</td>
                          <td className="text-right">{symbol} {item.unitPrice.toFixed(2)}</td>
                          {showTaxBreakdown && <td className="text-right">{item.taxPercent}%</td>}
                          <td className="text-right"><strong>{symbol} {item.amount.toFixed(2)}</strong></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <section className="print-bottom-grid">
                    <div className="print-notes">
                      <p className="print-card-title">Notes</p>
                      <p className="print-muted">{notes}</p>
                    </div>
                    {summaryBlock(billLayout === "compact")}
                  </section>

                  <footer className="print-footer">
                    <div>
                      <strong>Globally valid professional bill</strong>
                      <p className="print-muted">
                        Generated digitally through Bezgrow. Please verify local tax compliance before statutory filing.
                      </p>
                    </div>
                    {signatureBlock}
                  </footer>
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </>
  )
}
