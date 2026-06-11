export function productMutationErrorMessage(
  fallback: string,
  message?: string | null,
  details?: string | null,
  code?: string | null,
) {
  const text = `${code || ""} ${message || ""} ${details || ""}`.toLowerCase()

  if (text.includes("sku") && (text.includes("duplicate") || text.includes("23505") || text.includes("unique"))) {
    return "A product with this SKU already exists. Use a different SKU."
  }
  if (text.includes("barcode") && (text.includes("duplicate") || text.includes("23505") || text.includes("unique"))) {
    return "A product with this barcode already exists. Use a different barcode."
  }
  if (text.includes("invalid input syntax") && text.includes("date")) {
    return "Use a valid date before saving the product."
  }
  if (text.includes("column") && text.includes("does not exist")) {
    return "Products table is missing required columns. Run the latest Supabase product migration."
  }
  if (text.includes("violates check constraint") && text.includes("stock")) {
    return "Stock cannot be negative."
  }

  return fallback
}
