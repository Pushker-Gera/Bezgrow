"use client"

import { exportCsv } from "@/lib/desktop-file-export"
import { getOfflineData } from "@/lib/offline/db"

type DataRow = Record<string, unknown> & { id?: string }

export type InvoiceExportFilters = {
  search?: string
  status?: string
  period?: string
  customerId?: string
  risk?: string
}

function stringFrom(row: DataRow | null | undefined, fields: string[]) {
  if (!row) return ""
  for (const field of fields) {
    const value = row[field]
    if (typeof value === "string" && value.trim()) return value
  }
  return ""
}

function numberFrom(row: DataRow | null | undefined, fields: string[]) {
  if (!row) return 0
  for (const field of fields) {
    const value = row[field]
    if (value !== null && value !== undefined && value !== "") {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return 0
}

function dateOnly(value: string) {
  if (!value) return ""
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value.slice(0, 10) : parsed.toISOString().slice(0, 10)
}

function inPeriod(invoice: DataRow, period: string) {
  if (!period || period === "all") return true
  const value = stringFrom(invoice, ["invoice_date", "date", "created_at"])
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return false
  const now = new Date()
  if (period === "today") return date.toDateString() === now.toDateString()
  if (period === "week") return date.getTime() >= now.getTime() - 7 * 24 * 60 * 60 * 1000
  if (period === "month") return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()
  return true
}

function riskState(invoice: DataRow) {
  const status = stringFrom(invoice, ["payment_status", "status"]).toLowerCase()
  if (status === "paid") return "paid"
  const value = stringFrom(invoice, ["due_date"])
  if (!value) return "open"
  const due = new Date(value)
  if (Number.isNaN(due.getTime())) return "open"
  const now = new Date()
  if (due < now) return "overdue"
  if (due.getTime() <= now.getTime() + 7 * 24 * 60 * 60 * 1000) return "due-soon"
  return "open"
}

export function buildInvoiceExportRows(
  invoices: DataRow[],
  customers: DataRow[],
  items: DataRow[],
  filters: InvoiceExportFilters = {}
) {
  const customerById = new Map(customers.map((customer) => [String(customer.id || ""), customer]))
  const itemsByInvoice = new Map<string, DataRow[]>()
  for (const item of items) {
    const invoiceId = stringFrom(item, ["invoice_id"])
    if (!invoiceId) continue
    itemsByInvoice.set(invoiceId, [...(itemsByInvoice.get(invoiceId) || []), item])
  }
  const term = filters.search?.trim().toLowerCase() || ""

  return invoices
    .filter((invoice) => !invoice.deleted_at)
    .filter((invoice) => {
      const status = stringFrom(invoice, ["payment_status", "status"]).toLowerCase() || "unpaid"
      if (filters.status && filters.status !== "all" && status !== filters.status) return false
      if (filters.customerId && filters.customerId !== "all" && stringFrom(invoice, ["customer_id"]) !== filters.customerId) return false
      if (!inPeriod(invoice, filters.period || "all")) return false
      if (filters.risk && filters.risk !== "all" && riskState(invoice) !== filters.risk) return false
      if (!term) return true
      const customer = customerById.get(stringFrom(invoice, ["customer_id"]))
      return [
        stringFrom(invoice, ["invoice_number"]),
        stringFrom(invoice, ["customer_name"]),
        stringFrom(customer, ["name"]),
        stringFrom(customer, ["phone"]),
        stringFrom(customer, ["email"]),
      ]
        .join(" ")
        .toLowerCase()
        .includes(term)
    })
    .map((invoice) => {
      const customer = customerById.get(stringFrom(invoice, ["customer_id"]))
      const invoiceItems = itemsByInvoice.get(String(invoice.id || "")) || []
      const subtotal = numberFrom(invoice, ["subtotal", "sub_total"])
      const discount = numberFrom(invoice, ["discount_amount", "discount_total"])
      const taxableValue = numberFrom(invoice, ["taxable_amount"]) || Math.max(0, subtotal - discount)
      const totalTax = numberFrom(invoice, ["tax_amount", "tax_total"])
      const cgst = invoiceItems.reduce((sum, item) => sum + numberFrom(item, ["cgst_amount"]), 0) || totalTax / 2
      const sgst = invoiceItems.reduce((sum, item) => sum + numberFrom(item, ["sgst_amount"]), 0) || totalTax / 2
      const igst = invoiceItems.reduce((sum, item) => sum + numberFrom(item, ["igst_amount"]), 0)
      const grandTotal = numberFrom(invoice, ["grand_total", "total_amount", "total"])
      const paidAmount = numberFrom(invoice, ["paid_amount"]) ||
        (stringFrom(invoice, ["payment_status", "status"]).toLowerCase() === "paid" ? grandTotal : 0)
      const dueAmount = numberFrom(invoice, ["outstanding_amount"]) || Math.max(0, grandTotal - paidAmount)

      return {
        invoiceNumber: stringFrom(invoice, ["invoice_number"]),
        invoiceDate: dateOnly(stringFrom(invoice, ["invoice_date", "date", "created_at"])),
        dueDate: dateOnly(stringFrom(invoice, ["due_date"])),
        customerName: stringFrom(customer, ["name"]) || stringFrom(invoice, ["customer_name"]),
        customerPhone: stringFrom(customer, ["phone"]),
        customerEmail: stringFrom(customer, ["email"]),
        customerGstin: stringFrom(customer, ["gst_number", "gstin", "tax_id"]),
        invoiceStatus: stringFrom(invoice, ["status"]),
        paymentStatus: stringFrom(invoice, ["payment_status", "status"]),
        paymentMethod: stringFrom(invoice, ["payment_method"]),
        subtotal,
        discount,
        taxableValue,
        cgst,
        sgst,
        igst,
        roundOff: numberFrom(invoice, ["round_off"]),
        grandTotal,
        paidAmount,
        dueAmount,
        notes: stringFrom(invoice, ["notes"]),
        createdAt: stringFrom(invoice, ["created_at"]),
        updatedAt: stringFrom(invoice, ["updated_at"]),
      }
    })
}

export async function exportInvoicesCsv(organizationId: string, filters: InvoiceExportFilters = {}) {
  const [invoices, customers, items] = await Promise.all([
    getOfflineData<DataRow[]>(organizationId, "invoices", []),
    getOfflineData<DataRow[]>(organizationId, "customers", []),
    getOfflineData<DataRow[]>(organizationId, "invoice_items", []),
  ])
  const rows = buildInvoiceExportRows(invoices, customers, items, filters)
  const filename = `bezgrow-invoices-${new Date().toISOString().slice(0, 10)}.csv`
  const result = await exportCsv(filename, [
    { header: "Invoice number", value: "invoiceNumber", preserveLeadingZeros: true },
    { header: "Invoice date", value: "invoiceDate" },
    { header: "Due date", value: "dueDate" },
    { header: "Customer name", value: "customerName" },
    { header: "Customer phone", value: "customerPhone", preserveLeadingZeros: true },
    { header: "Customer email", value: "customerEmail" },
    { header: "Customer GSTIN", value: "customerGstin", preserveLeadingZeros: true },
    { header: "Invoice status", value: "invoiceStatus" },
    { header: "Payment status", value: "paymentStatus" },
    { header: "Payment method", value: "paymentMethod" },
    { header: "Subtotal", value: "subtotal" },
    { header: "Discount", value: "discount" },
    { header: "Taxable value", value: "taxableValue" },
    { header: "CGST", value: "cgst" },
    { header: "SGST", value: "sgst" },
    { header: "IGST", value: "igst" },
    { header: "Round off", value: "roundOff" },
    { header: "Grand total", value: "grandTotal" },
    { header: "Paid amount", value: "paidAmount" },
    { header: "Due amount", value: "dueAmount" },
    { header: "Notes", value: "notes" },
    { header: "Created timestamp", value: "createdAt" },
    { header: "Updated timestamp", value: "updatedAt" },
  ], rows)
  return { result, rowCount: rows.length }
}

