"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useParams } from "next/navigation"
import { PrintEngine } from "@/components/print/PrintEngine"
import { readStoredPrintSettings } from "@/components/print/settings/defaults"
import type { PrintInvoice, PrintInvoiceItem } from "@/components/print/types"
import { amountInIndianWords } from "@/components/print/utils"
import { supabase } from "@/lib/supabase"

type Row = Record<string, unknown> & { id: string }

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

function dateValue(row: Record<string, unknown> | null, fields: string[]) {
  return stringFrom(row, fields) || "-"
}

export default function PrintInvoicePage() {
  const params = useParams()
  const invoiceId = Array.isArray(params.id) ? params.id[0] : params.id
  const [invoice, setInvoice] = useState<Row | null>(null)
  const [items, setItems] = useState<Row[]>([])
  const [organization, setOrganization] = useState<Row | null>(null)
  const [customer, setCustomer] = useState<Row | null>(null)
  const [products, setProducts] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  const fetchInvoice = useCallback(async () => {
    if (!invoiceId) {
      setLoading(false)
      return
    }

    const { data: invoiceData } = await supabase.from("invoices").select("*").eq("id", invoiceId).single()
    const typedInvoice = invoiceData as Row | null
    setInvoice(typedInvoice)

    const { data: itemRows } = await supabase.from("invoice_items").select("*").eq("invoice_id", invoiceId)
    const typedItems = (itemRows || []) as Row[]
    setItems(typedItems)

    if (typedInvoice?.organization_id) {
      const { data } = await supabase.from("organizations").select("*").eq("id", typedInvoice.organization_id).single()
      setOrganization(data as Row | null)
    }

    if (typedInvoice?.customer_id) {
      const { data } = await supabase.from("customers").select("*").eq("id", typedInvoice.customer_id).single()
      setCustomer(data as Row | null)
    }

    const productIds = Array.from(new Set(typedItems.map((item) => stringFrom(item, ["product_id"])).filter(Boolean)))
    if (productIds.length) {
      const { data } = await supabase.from("products").select("*").in("id", productIds)
      setProducts((data || []) as Row[])
    }

    setLoading(false)
  }, [invoiceId])

  useEffect(() => {
    queueMicrotask(() => {
      void fetchInvoice()
    })
  }, [fetchInvoice])

  const printInvoice = useMemo<PrintInvoice | null>(() => {
    if (!invoice) return null

    const productMap = new Map(products.map((product) => [product.id, product]))
    const taxTotal = numberFrom(invoice, ["tax_amount", "tax_total"])
    const grandTotal = numberFrom(invoice, ["grand_total", "total_amount", "total"])
    const subtotal = numberFrom(invoice, ["subtotal", "sub_total"]) || items.reduce((sum, item) => {
      return sum + numberFrom(item, ["line_total"]) || numberFrom(item, ["quantity"]) * numberFrom(item, ["unit_price"])
    }, 0)
    const discount = numberFrom(invoice, ["discount_amount", "discount_total"])
    const gstSplit = taxTotal / 2
    const paid = stringFrom(invoice, ["payment_status", "status"]).toLowerCase() === "paid" ? grandTotal : 0

    const mappedItems: PrintInvoiceItem[] = items.map((item, index) => {
      const product = productMap.get(stringFrom(item, ["product_id"])) || null
      const quantity = numberFrom(item, ["quantity"])
      const rate = numberFrom(item, ["unit_price", "rate"])
      const base = quantity * rate
      const discountPercent = numberFrom(item, ["discount_percent"])
      const discountAmount = (base * discountPercent) / 100
      const taxableValue = numberFrom(item, ["line_total"]) || base - discountAmount
      const itemTax = numberFrom(item, ["gst_amount", "tax_amount"])
      const taxPercent = numberFrom(item, ["tax_percent", "gst"])
      const isInterstate = false

      return {
        id: item.id || `${invoice.id}-${index}`,
        name: stringFrom(item, ["product_name", "name"]) || stringFrom(product, ["name"]) || "Product",
        batchNumber: stringFrom(item, ["batch_no", "batch_number"]) || stringFrom(product, ["batch_no", "batch_number"]) || "-",
        manufacturingDate: dateValue(item, ["manufacturing_date", "mfg_date"]) || dateValue(product, ["manufacturing_date", "mfg_date"]),
        expiryDate: dateValue(item, ["expiry_date"]) || dateValue(product, ["expiry_date"]),
        scheduleType: stringFrom(item, ["schedule_type"]) || stringFrom(product, ["schedule_type"]) || "-",
        hsnCode: stringFrom(item, ["hsn_code", "hsn"]) || stringFrom(product, ["hsn_code", "hsn"]) || "-",
        quantity,
        freeQuantity: numberFrom(item, ["free_quantity", "free_qty"]),
        unit: stringFrom(item, ["unit"]) || stringFrom(product, ["unit"]) || "PCS",
        mrp: numberFrom(item, ["mrp"]) || numberFrom(product, ["mrp", "price", "sale_rate"]) || rate,
        rate,
        discountPercent,
        discountAmount,
        taxableValue,
        cgstPercent: isInterstate ? 0 : taxPercent / 2,
        cgstAmount: isInterstate ? 0 : itemTax / 2,
        sgstPercent: isInterstate ? 0 : taxPercent / 2,
        sgstAmount: isInterstate ? 0 : itemTax / 2,
        igstPercent: isInterstate ? taxPercent : 0,
        igstAmount: isInterstate ? itemTax : 0,
        finalAmount: taxableValue + itemTax,
      }
    })

    const origin = typeof window === "undefined" ? "https://bezgrow.com" : window.location.origin

    return {
      id: invoice.id,
      invoiceNumber: stringFrom(invoice, ["invoice_number"]) || invoice.id,
      invoiceTitle: stringFrom(invoice, ["invoice_type"]) === "no_gst" ? "Bill of Supply" : "Tax Invoice",
      invoiceDate: dateValue(invoice, ["created_at", "invoice_date"]),
      dueDate: dateValue(invoice, ["due_date"]),
      salesperson: stringFrom(invoice, ["salesperson", "salesperson_name"]) || "-",
      enterprise: {
        name: stringFrom(organization, ["name", "business_name"]) || "Bezgrow ERP",
        businessType: stringFrom(organization, ["business_type", "industry", "business_category"]) || "Enterprise",
        gstNumber: stringFrom(organization, ["gst_number", "gstin", "tax_id"]) || "-",
        drugLicense: stringFrom(organization, ["drug_license", "drug_license_number"]) || "-",
        fssai: stringFrom(organization, ["fssai", "fssai_number"]) || "-",
        phone: stringFrom(organization, ["phone", "contact_phone"]) || "-",
        email: stringFrom(organization, ["email", "support_email"]) || "-",
        website: stringFrom(organization, ["website"]) || "bezgrow.com",
        address: stringFrom(organization, ["address", "business_address"]) || "-",
        logoUrl: stringFrom(organization, ["logo_url", "logo"]),
        branchName: stringFrom(organization, ["branch_name"]) || "Main Branch",
      },
      customer: {
        id: stringFrom(customer, ["customer_code", "id"]) || stringFrom(invoice, ["customer_id"]) || "-",
        name: stringFrom(customer, ["name"]) || stringFrom(invoice, ["customer_name"]) || "Walk-in customer",
        address: stringFrom(customer, ["address", "billing_address"]) || "-",
        phone: stringFrom(customer, ["phone"]) || "-",
        email: stringFrom(customer, ["email"]) || "-",
        gstin: stringFrom(customer, ["gst_number", "gstin", "tax_id"]) || "-",
        state: stringFrom(customer, ["state"]) || "-",
        stateCode: stringFrom(customer, ["state_code"]) || "-",
      },
      items: mappedItems,
      payment: {
        mode: stringFrom(invoice, ["payment_method"]) || "Cash",
        paidAmount: paid,
        dueAmount: Math.max(0, grandTotal - paid),
        balanceAmount: Math.max(0, paid - grandTotal),
        cashReceived: paid,
      },
      totals: {
        subtotal,
        discount,
        taxableAmount: subtotal - discount,
        cgst: gstSplit,
        sgst: gstSplit,
        igst: 0,
        roundOff: numberFrom(invoice, ["round_off"]),
        grandTotal,
        amountInWords: amountInIndianWords(grandTotal),
      },
      terms: [
        "Goods once sold will not be taken back unless agreed in writing.",
        "Interest may apply on overdue credit invoices.",
        "This is a computer-generated invoice.",
      ],
      notes: stringFrom(invoice, ["notes"]) || "Thank you for your business.",
      qrValue: `${origin}/dashboard/invoices/${invoice.id}`,
      barcodeValue: stringFrom(invoice, ["invoice_number"]) || invoice.id,
      watermark: stringFrom(organization, ["name", "business_name"]) || "BEZGROW",
    }
  }, [customer, invoice, items, organization, products])

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-black text-white">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-neutral-800 border-t-cyan-300" />
      </div>
    )
  }

  if (!printInvoice) {
    return <div className="flex min-h-dvh items-center justify-center bg-black text-white">Invoice not found.</div>
  }

  return <PrintEngine invoice={printInvoice} initialSettings={readStoredPrintSettings()} />
}
