import type { PrintFormat, PrintInvoice } from "@/components/print/types"

const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]

function wordsUnderHundred(value: number) {
  if (value < 20) return ones[value]
  return `${tens[Math.floor(value / 10)]} ${ones[value % 10]}`.trim()
}

function wordsUnderThousand(value: number) {
  const hundred = Math.floor(value / 100)
  const rest = value % 100
  return `${hundred ? `${ones[hundred]} Hundred` : ""} ${rest ? wordsUnderHundred(rest) : ""}`.trim()
}

export function amountInIndianWords(input: number) {
  const value = Math.round(Math.abs(input))
  if (!value) return "Rupees Zero Only"

  const crore = Math.floor(value / 10000000)
  const lakh = Math.floor((value % 10000000) / 100000)
  const thousand = Math.floor((value % 100000) / 1000)
  const rest = value % 1000
  const parts = [
    crore ? `${wordsUnderThousand(crore)} Crore` : "",
    lakh ? `${wordsUnderThousand(lakh)} Lakh` : "",
    thousand ? `${wordsUnderThousand(thousand)} Thousand` : "",
    rest ? wordsUnderThousand(rest) : "",
  ].filter(Boolean)

  return `Rupees ${parts.join(" ")} Only`
}

export function formatMoney(value: number) {
  return `₹${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
}

export function formatDate(value: string) {
  if (!value || value === "-") return "-"
  return new Date(value).toLocaleDateString("en-IN")
}

export function rememberReprint(invoice: PrintInvoice, format: PrintFormat) {
  if (typeof window === "undefined") return
  const entry = {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    format,
    printedAt: new Date().toISOString(),
  }
  const stored = window.localStorage.getItem("bezgrow.reprint-history")
  const history = stored ? JSON.parse(stored) as typeof entry[] : []
  window.localStorage.setItem("bezgrow.reprint-history", JSON.stringify([entry, ...history].slice(0, 50)))
}

export function getReprintHistory() {
  if (typeof window === "undefined") return []
  try {
    return JSON.parse(window.localStorage.getItem("bezgrow.reprint-history") || "[]") as Array<{
      invoiceId: string
      invoiceNumber: string
      format: PrintFormat
      printedAt: string
    }>
  } catch {
    return []
  }
}
