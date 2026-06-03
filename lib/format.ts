export function formatCurrency(
  amount: number,
  currency = "INR",
  locale = "en-IN"
) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount || 0)
}

export function formatDate(
  value: string | Date | null | undefined,
  timezone = "Asia/Kolkata",
  locale = "en-IN"
) {
  if (!value) return "-"

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: timezone,
  }).format(new Date(value))
}

export function formatTaxLabel(taxProfile?: string | null) {
  const normalized = (taxProfile || "GST").toLowerCase()
  if (normalized === "none" || normalized === "no_tax" || normalized === "no gst") return "No Tax"
  if (normalized === "vat") return "VAT"
  if (normalized === "sales_tax") return "Sales Tax"
  return "GST"
}
