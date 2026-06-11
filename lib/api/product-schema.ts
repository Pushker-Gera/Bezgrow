import { z } from "zod"

const fieldLabels: Record<string, string> = {
  name: "Product name",
  description: "Description",
  manufacturer: "Manufacturer",
  sku: "SKU",
  barcode: "Barcode",
  category: "Category",
  unit: "Unit",
  supplier: "Supplier",
  warehouse: "Warehouse",
  price: "Fallback price",
  stock: "Stock",
  min_stock: "Minimum stock",
  batch_no: "Batch number",
  mrp: "MRP",
  purchase_rate: "Purchase rate",
  sale_rate: "Sale rate",
  gst: "GST",
  expiry_date: "Expiry date",
  purchase_date: "Purchase date",
}

const nullableText = z
  .string()
  .trim()
  .max(255)
  .nullable()
  .optional()
  .transform((value) => (value ? value : null))

function nullableNumber(label: string) {
  return z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((value, context) => {
      if (value === undefined || value === null || value === "") return null
      const number = Number(value)
      if (Number.isFinite(number)) return number

      context.addIssue({
        code: "custom",
        message: `${label} must be a valid number.`,
      })
      return z.NEVER
    })
}

function isValidIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function nullableDate(label: string) {
  return z
    .union([z.string(), z.null()])
    .optional()
    .transform((value, context) => {
      if (value === undefined || value === null) return null

      const trimmed = value.trim()
      if (!trimmed) return null

      if (isValidIsoDate(trimmed)) return trimmed

      context.addIssue({
        code: "custom",
        message: `${label} must be a valid date.`,
      })
      return z.NEVER
    })
}

export const productPayloadSchema = z
  .object({
    name: z.string().trim().min(1).max(180),
    description: z.string().trim().max(2000).nullable().optional().transform((value) => value || null),
    manufacturer: nullableText,
    sku: nullableText,
    barcode: nullableText,
    category: nullableText,
    unit: z.string().trim().max(40).optional().default("pcs"),
    supplier: nullableText,
    warehouse: z.string().trim().max(120).optional().default("Main Warehouse"),
    price: nullableNumber(fieldLabels.price),
    stock: nullableNumber(fieldLabels.stock),
    min_stock: nullableNumber(fieldLabels.min_stock),
    batch_no: nullableText,
    mrp: nullableNumber(fieldLabels.mrp),
    purchase_rate: nullableNumber(fieldLabels.purchase_rate),
    sale_rate: nullableNumber(fieldLabels.sale_rate),
    gst: nullableNumber(fieldLabels.gst),
    expiry_date: nullableDate(fieldLabels.expiry_date),
    purchase_date: nullableDate(fieldLabels.purchase_date),
  })
  .refine((product) => !product.expiry_date || !product.purchase_date || product.purchase_date <= product.expiry_date, {
    message: "Purchase date cannot be after expiry date.",
    path: ["purchase_date"],
  })

export const productUpdateSchema = productPayloadSchema.extend({
  id: z.string().uuid(),
})

export function productValidationMessage(error: z.ZodError) {
  const issue = error.issues[0]
  if (!issue) return "Invalid product."

  if (issue.message) return issue.message

  const fieldName = String(issue.path[0] || "Product")
  return `${fieldLabels[fieldName] || fieldName} is invalid.`
}
